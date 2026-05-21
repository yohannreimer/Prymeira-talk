import type { PrismaClient } from "@prisma/client";
import type {
  ContactBoardDto,
  ContactBoardMembershipDto,
  ContactBoardStageDto,
  ContactDto
} from "@prymeira-talk/shared";
import { toContactDto } from "../contacts/contacts.service.js";

type DateLike = Date | string;

interface BoardRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdAt: DateLike;
}

interface StageRecord {
  id: string;
  workspaceId: string;
  boardId: string;
  name: string;
  color: string;
  order: number;
}

interface MembershipRecord {
  id: string;
  workspaceId: string;
  contactId: string;
  boardId: string;
  stageId: string;
  isPrimary: boolean;
  updatedAt: DateLike;
}

type ContactRecord = Parameters<typeof toContactDto>[0];

interface BoardWithStagesRecord extends BoardRecord {
  stages: StageRecord[];
}

interface MembershipWithContactRecord extends MembershipRecord {
  contact: ContactRecord;
}

type BoardFindManyArgs = Parameters<PrismaClient["contactBoard"]["findMany"]>[0];
type BoardCreateArgs = Parameters<PrismaClient["contactBoard"]["create"]>[0];
type BoardFindFirstArgs = Parameters<PrismaClient["contactBoard"]["findFirst"]>[0];
type StageCreateArgs = Parameters<PrismaClient["contactBoardStage"]["create"]>[0];
type StageFindFirstArgs = Parameters<PrismaClient["contactBoardStage"]["findFirst"]>[0];
type MembershipFindManyArgs = Parameters<PrismaClient["contactBoardMembership"]["findMany"]>[0];
type MembershipFindFirstArgs = Parameters<PrismaClient["contactBoardMembership"]["findFirst"]>[0];
type MembershipUpsertArgs = Parameters<PrismaClient["contactBoardMembership"]["upsert"]>[0];
type MembershipUpdateArgs = Parameters<PrismaClient["contactBoardMembership"]["update"]>[0];
type MembershipUpdateManyArgs = Parameters<PrismaClient["contactBoardMembership"]["updateMany"]>[0];
type ContactFindUniqueArgs = Parameters<PrismaClient["contact"]["findUnique"]>[0];

interface BoardPersistenceLike {
  contactBoard: {
    findMany(args: BoardFindManyArgs): Promise<BoardWithStagesRecord[]>;
    create(args: BoardCreateArgs): Promise<BoardRecord>;
    findFirst(args: BoardFindFirstArgs): Promise<BoardWithStagesRecord | null>;
  };
  contactBoardStage: {
    create(args: StageCreateArgs): Promise<StageRecord>;
    findFirst(args: StageFindFirstArgs): Promise<StageRecord | null>;
  };
  contactBoardMembership: {
    findMany(args: MembershipFindManyArgs): Promise<MembershipWithContactRecord[]>;
    findFirst(args: MembershipFindFirstArgs): Promise<MembershipWithContactRecord | null>;
    upsert(args: MembershipUpsertArgs): Promise<MembershipWithContactRecord>;
    update(args: MembershipUpdateArgs): Promise<MembershipWithContactRecord>;
    updateMany(args: MembershipUpdateManyArgs): Promise<{ count: number }>;
  };
  contact: {
    findUnique(args: ContactFindUniqueArgs): Promise<{ id: string } | null>;
  };
}

export interface PrismaLike extends BoardPersistenceLike {
  $transaction<T>(callback: (tx: BoardPersistenceLike) => Promise<T>): Promise<T>;
}

export interface ContactBoardWithStagesDto extends ContactBoardDto {
  stages: ContactBoardStageDto[];
}

export interface BoardContactCardDto extends ContactBoardMembershipDto {
  contact: ContactDto;
}

export interface BoardContactsDto {
  board: ContactBoardDto;
  stages: ContactBoardStageDto[];
  memberships: BoardContactCardDto[];
}

export class BoardsServiceError extends Error {
  constructor(
    public code:
      | "BOARD_NOT_FOUND"
      | "STAGE_NOT_FOUND"
      | "CONTACT_NOT_FOUND"
      | "MEMBERSHIP_NOT_FOUND",
    message: string
  ) {
    super(message);
  }
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeOptional(value: string | undefined) {
  if (value === undefined) return undefined;

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toBoardDto(record: BoardRecord): ContactBoardDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description,
    createdAt: toIsoString(record.createdAt)
  };
}

function toStageDto(record: StageRecord): ContactBoardStageDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    boardId: record.boardId,
    name: record.name,
    color: record.color,
    order: record.order
  };
}

function toMembershipDto(record: MembershipRecord): ContactBoardMembershipDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    contactId: record.contactId,
    boardId: record.boardId,
    stageId: record.stageId,
    isPrimary: record.isPrimary,
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toBoardWithStagesDto(record: BoardWithStagesRecord): ContactBoardWithStagesDto {
  return {
    ...toBoardDto(record),
    stages: record.stages.map(toStageDto)
  };
}

function toBoardContactCardDto(record: MembershipWithContactRecord): BoardContactCardDto {
  return {
    ...toMembershipDto(record),
    contact: toContactDto(record.contact)
  };
}

export function createBoardsService(prisma: PrismaLike) {
  return {
    async listBoards(input: { workspaceId: string }): Promise<ContactBoardWithStagesDto[]> {
      const boards = await prisma.contactBoard.findMany({
        where: { workspaceId: input.workspaceId },
        include: {
          stages: {
            orderBy: { order: "asc" }
          }
        },
        orderBy: { createdAt: "asc" }
      });

      return boards.map(toBoardWithStagesDto);
    },

    async createBoard(input: {
      workspaceId: string;
      name: string;
      description?: string;
    }): Promise<ContactBoardDto> {
      const board = await prisma.contactBoard.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          description: normalizeOptional(input.description) ?? null
        }
      });

      return toBoardDto(board);
    },

    async createStage(input: {
      workspaceId: string;
      boardId: string;
      name: string;
      color: string;
      order: number;
    }): Promise<ContactBoardStageDto> {
      const board = await prisma.contactBoard.findFirst({
        where: { workspaceId: input.workspaceId, id: input.boardId },
        include: {
          stages: {
            orderBy: { order: "asc" }
          }
        }
      });

      if (!board) {
        throw new BoardsServiceError("BOARD_NOT_FOUND", "Board not found.");
      }

      const stage = await prisma.contactBoardStage.create({
        data: {
          workspaceId: input.workspaceId,
          boardId: input.boardId,
          name: input.name.trim(),
          color: input.color.trim(),
          order: input.order
        }
      });

      return toStageDto(stage);
    },

    async listBoardContacts(input: {
      workspaceId: string;
      boardId: string;
    }): Promise<BoardContactsDto> {
      const board = await prisma.contactBoard.findFirst({
        where: { workspaceId: input.workspaceId, id: input.boardId },
        include: {
          stages: {
            orderBy: { order: "asc" }
          }
        }
      });

      if (!board) {
        throw new BoardsServiceError("BOARD_NOT_FOUND", "Board not found.");
      }

      const memberships = await prisma.contactBoardMembership.findMany({
        where: { workspaceId: input.workspaceId, boardId: input.boardId },
        include: { contact: true },
        orderBy: [{ updatedAt: "desc" }]
      });

      return {
        board: toBoardDto(board),
        stages: board.stages.map(toStageDto),
        memberships: memberships.map(toBoardContactCardDto)
      };
    },

    async addContactToBoard(input: {
      workspaceId: string;
      boardId: string;
      stageId: string;
      contactId: string;
      isPrimary?: boolean;
    }): Promise<BoardContactCardDto> {
      const stage = await prisma.contactBoardStage.findFirst({
        where: {
          workspaceId: input.workspaceId,
          boardId: input.boardId,
          id: input.stageId
        }
      });

      if (!stage) {
        throw new BoardsServiceError("STAGE_NOT_FOUND", "Stage not found.");
      }

      const contact = await prisma.contact.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.contactId
          }
        },
        select: { id: true }
      });

      if (!contact) {
        throw new BoardsServiceError("CONTACT_NOT_FOUND", "Contact not found.");
      }

      const isPrimary = input.isPrimary ?? false;

      const upsertMembership = (client: BoardPersistenceLike) =>
        client.contactBoardMembership.upsert({
          where: {
            workspaceId_contactId_boardId: {
              workspaceId: input.workspaceId,
              contactId: input.contactId,
              boardId: input.boardId
            }
          },
          create: {
            workspaceId: input.workspaceId,
            contactId: input.contactId,
            boardId: input.boardId,
            stageId: input.stageId,
            isPrimary
          },
          update: {
            stageId: input.stageId,
            isPrimary
          },
          include: { contact: true }
        });

      const membership = isPrimary
        ? await prisma.$transaction(async (tx) => {
            await tx.contactBoardMembership.updateMany({
              where: {
                workspaceId: input.workspaceId,
                contactId: input.contactId,
                isPrimary: true
              },
              data: { isPrimary: false }
            });

            return upsertMembership(tx);
          })
        : await upsertMembership(prisma);

      return toBoardContactCardDto(membership);
    },

    async moveContactToStage(input: {
      workspaceId: string;
      membershipId: string;
      stageId: string;
      isPrimary?: boolean;
    }): Promise<BoardContactCardDto> {
      const currentMembership = await prisma.contactBoardMembership.findFirst({
        where: { workspaceId: input.workspaceId, id: input.membershipId },
        include: { contact: true }
      });

      if (!currentMembership) {
        throw new BoardsServiceError("MEMBERSHIP_NOT_FOUND", "Membership not found.");
      }

      const stage = await prisma.contactBoardStage.findFirst({
        where: {
          workspaceId: input.workspaceId,
          boardId: currentMembership.boardId,
          id: input.stageId
        }
      });

      if (!stage) {
        throw new BoardsServiceError("STAGE_NOT_FOUND", "Stage not found.");
      }

      const updateMembership = (client: BoardPersistenceLike) =>
        client.contactBoardMembership.update({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.membershipId
            }
          },
          data:
            input.isPrimary === undefined
              ? { stageId: input.stageId }
              : { stageId: input.stageId, isPrimary: input.isPrimary },
          include: { contact: true }
        });

      const membership =
        input.isPrimary === true
          ? await prisma.$transaction(async (tx) => {
              await tx.contactBoardMembership.updateMany({
                where: {
                  workspaceId: input.workspaceId,
                  contactId: currentMembership.contactId,
                  isPrimary: true
                },
                data: { isPrimary: false }
              });

              return updateMembership(tx);
            })
          : await updateMembership(prisma);

      return toBoardContactCardDto(membership);
    }
  };
}
