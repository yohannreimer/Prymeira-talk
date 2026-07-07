import type { PrismaClient } from "@prisma/client";
import type {
  ChannelProvider,
  ContactBoardMoveSource,
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
  isPrimaryPipeline: boolean;
  channels?: BoardChannelRecord[];
  createdAt: DateLike;
}

interface BoardChannelRecord {
  channel: {
    id: string;
    displayName: string | null;
    provider: ChannelProvider;
    phoneNumber: string | null;
  };
}

interface StageRecord {
  id: string;
  workspaceId: string;
  boardId: string;
  name: string;
  color: string;
  order: number;
  tagTriggers?: StageTagRecord[];
}

interface StageTagRecord {
  tag: {
    id: string;
    name: string;
    color: string;
    isActive: boolean;
  };
}

interface MembershipRecord {
  id: string;
  workspaceId: string;
  contactId: string;
  boardId: string;
  stageId: string;
  isPrimary: boolean;
  lastMovedBy?: ContactBoardMoveSource | null;
  lastRuleAppliedAt?: DateLike | null;
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
type BoardUpdateArgs = Parameters<PrismaClient["contactBoard"]["update"]>[0];
type BoardDeleteArgs = Parameters<PrismaClient["contactBoard"]["delete"]>[0];
type BoardChannelDeleteManyArgs = Parameters<
  PrismaClient["contactBoardChannel"]["deleteMany"]
>[0];
type BoardChannelCreateManyArgs = Parameters<
  PrismaClient["contactBoardChannel"]["createMany"]
>[0];
type StageCreateArgs = Parameters<PrismaClient["contactBoardStage"]["create"]>[0];
type StageFindManyArgs = Parameters<PrismaClient["contactBoardStage"]["findMany"]>[0];
type StageFindFirstArgs = Parameters<PrismaClient["contactBoardStage"]["findFirst"]>[0];
type StageUpdateArgs = Parameters<PrismaClient["contactBoardStage"]["update"]>[0];
type StageDeleteArgs = Parameters<PrismaClient["contactBoardStage"]["delete"]>[0];
type StageTagDeleteManyArgs = Parameters<
  PrismaClient["contactBoardStageTag"]["deleteMany"]
>[0];
type StageTagCreateManyArgs = Parameters<
  PrismaClient["contactBoardStageTag"]["createMany"]
>[0];
type MembershipFindManyArgs = Parameters<PrismaClient["contactBoardMembership"]["findMany"]>[0];
type MembershipFindFirstArgs = Parameters<PrismaClient["contactBoardMembership"]["findFirst"]>[0];
type MembershipUpsertArgs = Parameters<PrismaClient["contactBoardMembership"]["upsert"]>[0];
type MembershipUpdateArgs = Parameters<PrismaClient["contactBoardMembership"]["update"]>[0];
type MembershipUpdateManyArgs = Parameters<PrismaClient["contactBoardMembership"]["updateMany"]>[0];
type MembershipDeleteArgs = Parameters<PrismaClient["contactBoardMembership"]["delete"]>[0];
type MembershipCountArgs = Parameters<PrismaClient["contactBoardMembership"]["count"]>[0];
type ContactFindUniqueArgs = Parameters<PrismaClient["contact"]["findUnique"]>[0];

interface BoardPersistenceLike {
  contactBoard: {
    findMany(args: BoardFindManyArgs): Promise<BoardWithStagesRecord[]>;
    create(args: BoardCreateArgs): Promise<BoardWithStagesRecord>;
    findFirst(args: BoardFindFirstArgs): Promise<BoardWithStagesRecord | null>;
    update(args: BoardUpdateArgs): Promise<BoardWithStagesRecord>;
    delete(args: BoardDeleteArgs): Promise<BoardRecord>;
  };
  contactBoardChannel: {
    deleteMany(args: BoardChannelDeleteManyArgs): Promise<{ count: number }>;
    createMany(args: BoardChannelCreateManyArgs): Promise<{ count: number }>;
  };
  contactBoardStage: {
    create(args: StageCreateArgs): Promise<StageRecord>;
    findMany(args: StageFindManyArgs): Promise<StageRecord[]>;
    findFirst(args: StageFindFirstArgs): Promise<StageRecord | null>;
    update(args: StageUpdateArgs): Promise<StageRecord>;
    delete(args: StageDeleteArgs): Promise<StageRecord>;
  };
  contactBoardStageTag: {
    deleteMany(args: StageTagDeleteManyArgs): Promise<{ count: number }>;
    createMany(args: StageTagCreateManyArgs): Promise<{ count: number }>;
  };
  contactBoardMembership: {
    findMany(args: MembershipFindManyArgs): Promise<MembershipWithContactRecord[]>;
    findFirst(args: MembershipFindFirstArgs): Promise<MembershipWithContactRecord | null>;
    upsert(args: MembershipUpsertArgs): Promise<MembershipWithContactRecord>;
    update(args: MembershipUpdateArgs): Promise<MembershipWithContactRecord>;
    updateMany(args: MembershipUpdateManyArgs): Promise<{ count: number }>;
    delete(args: MembershipDeleteArgs): Promise<MembershipRecord>;
    count(args: MembershipCountArgs): Promise<number>;
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

export interface BoardDeleteResultDto {
  ok: true;
  boardId: string;
}

export interface BoardStageDeleteResultDto {
  ok: true;
  stageId: string;
}

export interface BoardMembershipDeleteResultDto {
  ok: true;
  membershipId: string;
  boardId: string;
  contactId: string;
}

export class BoardsServiceError extends Error {
  constructor(
    public code:
      | "BOARD_NOT_FOUND"
      | "STAGE_NOT_FOUND"
      | "STAGE_NOT_EMPTY"
      | "STAGE_ORDER_INVALID"
      | "CONTACT_NOT_FOUND"
      | "MEMBERSHIP_NOT_FOUND",
    message: string
  ) {
    super(message);
  }
}

function toIsoString(value: DateLike): string;
function toIsoString(value: DateLike | null): string | null;
function toIsoString(value: DateLike | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeOptional(value: string | undefined) {
  if (value === undefined) return undefined;

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

const tagTriggerInclude = {
  tagTriggers: {
    include: {
      tag: {
        select: {
          id: true,
          name: true,
          color: true,
          isActive: true
        }
      }
    }
  }
};

const boardRuleInclude = {
  channels: {
    include: {
      channel: {
        select: {
          id: true,
          displayName: true,
          provider: true,
          phoneNumber: true
        }
      }
    }
  },
  stages: {
    orderBy: { order: "asc" as const },
    include: tagTriggerInclude
  }
};

function toBoardDto(record: BoardRecord): ContactBoardDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description,
    isPrimaryPipeline: record.isPrimaryPipeline,
    channels:
      record.channels?.map((link) => ({
        id: link.channel.id,
        displayName: link.channel.displayName,
        provider: link.channel.provider,
        phoneNumber: link.channel.phoneNumber
      })) ?? [],
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
    order: record.order,
    tagTriggers:
      record.tagTriggers?.map((link) => ({
        id: link.tag.id,
        name: link.tag.name,
        color: link.tag.color,
        isActive: link.tag.isActive
      })) ?? []
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
    lastMovedBy: record.lastMovedBy ?? "manual",
    lastRuleAppliedAt: toIsoString(record.lastRuleAppliedAt ?? null),
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
        include: boardRuleInclude,
        orderBy: { createdAt: "asc" }
      });

      return boards.map(toBoardWithStagesDto);
    },

    async createBoard(input: {
      workspaceId: string;
      name: string;
      description?: string;
      channelIds?: string[];
      isPrimaryPipeline?: boolean;
    }): Promise<ContactBoardWithStagesDto> {
      const channelIds = [...new Set(input.channelIds ?? [])];
      const board = await prisma.contactBoard.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          description: normalizeOptional(input.description) ?? null,
          isPrimaryPipeline: input.isPrimaryPipeline ?? false,
          channels:
            channelIds.length > 0
              ? {
                  createMany: {
                    data: channelIds.map((channelId) => ({
                      workspaceId: input.workspaceId,
                      channelId
                    })),
                    skipDuplicates: true
                  }
                }
              : undefined
        },
        include: boardRuleInclude
      });

      return toBoardWithStagesDto(board);
    },

    async updateBoard(input: {
      workspaceId: string;
      boardId: string;
      name?: string;
      description?: string;
      channelIds?: string[];
      isPrimaryPipeline?: boolean;
    }): Promise<ContactBoardWithStagesDto> {
      const data: {
        name?: string;
        description?: string | null;
        isPrimaryPipeline?: boolean;
      } = {};

      if (input.name !== undefined) {
        data.name = input.name.trim();
      }

      if (input.description !== undefined) {
        data.description = normalizeOptional(input.description) ?? null;
      }

      if (input.isPrimaryPipeline !== undefined) {
        data.isPrimaryPipeline = input.isPrimaryPipeline;
      }

      const board = await prisma.contactBoard.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.boardId
          }
        },
        data,
        include: boardRuleInclude
      });

      if (input.channelIds !== undefined) {
        const channelIds = [...new Set(input.channelIds)];
        await prisma.$transaction(async (tx) => {
          await tx.contactBoardChannel.deleteMany({
            where: { workspaceId: input.workspaceId, boardId: input.boardId }
          });
          if (channelIds.length > 0) {
            await tx.contactBoardChannel.createMany({
              data: channelIds.map((channelId) => ({
                workspaceId: input.workspaceId,
                boardId: input.boardId,
                channelId
              })),
              skipDuplicates: true
            });
          }
        });

        const refreshedBoard = await prisma.contactBoard.findFirst({
          where: { workspaceId: input.workspaceId, id: input.boardId },
          include: boardRuleInclude
        });

        if (!refreshedBoard) {
          throw new BoardsServiceError("BOARD_NOT_FOUND", "Board not found.");
        }

        return toBoardWithStagesDto(refreshedBoard);
      }

      return toBoardWithStagesDto(board);
    },

    async deleteBoard(input: {
      workspaceId: string;
      boardId: string;
    }): Promise<BoardDeleteResultDto> {
      const board = await prisma.contactBoard.findFirst({
        where: { workspaceId: input.workspaceId, id: input.boardId },
        include: boardRuleInclude
      });

      if (!board) {
        throw new BoardsServiceError("BOARD_NOT_FOUND", "Board not found.");
      }

      await prisma.contactBoard.delete({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.boardId
          }
        }
      });

      return { ok: true, boardId: input.boardId };
    },

    async createStage(input: {
      workspaceId: string;
      boardId: string;
      name: string;
      color: string;
      order: number;
      tagIds?: string[];
    }): Promise<ContactBoardStageDto> {
      const board = await prisma.contactBoard.findFirst({
        where: { workspaceId: input.workspaceId, id: input.boardId },
        include: boardRuleInclude
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
        },
        include: tagTriggerInclude
      });

      const tagIds = [...new Set(input.tagIds ?? [])];
      if (tagIds.length > 0) {
        await prisma.contactBoardStageTag.createMany({
          data: tagIds.map((tagId) => ({
            workspaceId: input.workspaceId,
            boardId: input.boardId,
            stageId: stage.id,
            tagId
          })),
          skipDuplicates: true
        });

        const stageWithTags = await prisma.contactBoardStage.findFirst({
          where: {
            workspaceId: input.workspaceId,
            boardId: input.boardId,
            id: stage.id
          },
          include: tagTriggerInclude
        });

        if (!stageWithTags) {
          throw new BoardsServiceError("STAGE_NOT_FOUND", "Stage not found.");
        }

        return toStageDto(stageWithTags);
      }

      return toStageDto(stage);
    },

    async updateStage(input: {
      workspaceId: string;
      boardId: string;
      stageId: string;
      name?: string;
      color?: string;
      tagIds?: string[];
    }): Promise<ContactBoardStageDto> {
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

      const data: { name?: string; color?: string } = {};

      if (input.name !== undefined) {
        data.name = input.name.trim();
      }

      if (input.color !== undefined) {
        data.color = input.color.trim();
      }

      const updatedStage = await prisma.contactBoardStage.update({
        where: {
          workspaceId_boardId_id: {
            workspaceId: input.workspaceId,
            boardId: input.boardId,
            id: input.stageId
          }
        },
        data,
        include: tagTriggerInclude
      });

      if (input.tagIds !== undefined) {
        const tagIds = [...new Set(input.tagIds)];
        await prisma.$transaction(async (tx) => {
          await tx.contactBoardStageTag.deleteMany({
            where: {
              workspaceId: input.workspaceId,
              boardId: input.boardId,
              stageId: input.stageId
            }
          });
          if (tagIds.length > 0) {
            await tx.contactBoardStageTag.createMany({
              data: tagIds.map((tagId) => ({
                workspaceId: input.workspaceId,
                boardId: input.boardId,
                stageId: input.stageId,
                tagId
              })),
              skipDuplicates: true
            });
          }
        });

        const refreshedStage = await prisma.contactBoardStage.findFirst({
          where: {
            workspaceId: input.workspaceId,
            boardId: input.boardId,
            id: input.stageId
          },
          include: tagTriggerInclude
        });

        if (!refreshedStage) {
          throw new BoardsServiceError("STAGE_NOT_FOUND", "Stage not found.");
        }

        return toStageDto(refreshedStage);
      }

      return toStageDto(updatedStage);
    },

    async reorderStages(input: {
      workspaceId: string;
      boardId: string;
      stageIds: string[];
    }): Promise<ContactBoardStageDto[]> {
      const board = await prisma.contactBoard.findFirst({
        where: { workspaceId: input.workspaceId, id: input.boardId },
        include: boardRuleInclude
      });

      if (!board) {
        throw new BoardsServiceError("BOARD_NOT_FOUND", "Board not found.");
      }

      const stages = await prisma.contactBoardStage.findMany({
        where: {
          workspaceId: input.workspaceId,
          boardId: input.boardId
        },
        orderBy: { order: "asc" }
      });
      const expectedStageIds = new Set(stages.map((stage) => stage.id));
      const requestedStageIds = new Set(input.stageIds);

      if (
        input.stageIds.length !== stages.length ||
        requestedStageIds.size !== input.stageIds.length ||
        input.stageIds.some((stageId) => !expectedStageIds.has(stageId))
      ) {
        throw new BoardsServiceError(
          "STAGE_ORDER_INVALID",
          "Stage order must include every stage from this board once."
        );
      }

      await prisma.$transaction(async (tx) => {
        for (const [order, stageId] of input.stageIds.entries()) {
          await tx.contactBoardStage.update({
            where: {
              workspaceId_boardId_id: {
                workspaceId: input.workspaceId,
                boardId: input.boardId,
                id: stageId
              }
            },
            data: { order }
          });
        }
      });

      return input.stageIds.map((stageId, order) => ({
        ...toStageDto(stages.find((stage) => stage.id === stageId) as StageRecord),
        order
      }));
    },

    async deleteStage(input: {
      workspaceId: string;
      boardId: string;
      stageId: string;
    }): Promise<BoardStageDeleteResultDto> {
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

      const membershipCount = await prisma.contactBoardMembership.count({
        where: {
          workspaceId: input.workspaceId,
          boardId: input.boardId,
          stageId: input.stageId
        }
      });

      if (membershipCount > 0) {
        throw new BoardsServiceError(
          "STAGE_NOT_EMPTY",
          "Move or remove contacts before deleting this stage."
        );
      }

      await prisma.contactBoardStage.delete({
        where: {
          workspaceId_boardId_id: {
            workspaceId: input.workspaceId,
            boardId: input.boardId,
            id: input.stageId
          }
        }
      });

      return { ok: true, stageId: input.stageId };
    },

    async listBoardContacts(input: {
      workspaceId: string;
      boardId: string;
    }): Promise<BoardContactsDto> {
      const board = await prisma.contactBoard.findFirst({
        where: { workspaceId: input.workspaceId, id: input.boardId },
        include: boardRuleInclude
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
            isPrimary,
            lastMovedBy: "manual",
            lastRuleAppliedAt: null
          },
          update: {
            stageId: input.stageId,
            isPrimary,
            lastMovedBy: "manual",
            lastRuleAppliedAt: null
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
              ? {
                  stageId: input.stageId,
                  lastMovedBy: "manual",
                  lastRuleAppliedAt: null
                }
              : {
                  stageId: input.stageId,
                  isPrimary: input.isPrimary,
                  lastMovedBy: "manual",
                  lastRuleAppliedAt: null
                },
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
    },

    async removeContactFromBoard(input: {
      workspaceId: string;
      membershipId: string;
    }): Promise<BoardMembershipDeleteResultDto> {
      const membership = await prisma.contactBoardMembership.findFirst({
        where: { workspaceId: input.workspaceId, id: input.membershipId },
        include: { contact: true }
      });

      if (!membership) {
        throw new BoardsServiceError("MEMBERSHIP_NOT_FOUND", "Membership not found.");
      }

      await prisma.contactBoardMembership.delete({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.membershipId
          }
        }
      });

      return {
        ok: true,
        membershipId: input.membershipId,
        boardId: membership.boardId,
        contactId: membership.contactId
      };
    }
  };
}
