import type { ConversationStatus, PrismaClient } from "@prisma/client";
import type { ContactBoardMembershipDto, RealtimeEvent } from "@prymeira-talk/shared";
import { BoardsServiceError } from "./boards.service.js";

type DateLike = Date | string;

type BoardFindManyArgs = Parameters<PrismaClient["contactBoard"]["findMany"]>[0];
type BoardFindFirstArgs = Parameters<PrismaClient["contactBoard"]["findFirst"]>[0];
type MembershipFindFirstArgs = Parameters<
  PrismaClient["contactBoardMembership"]["findFirst"]
>[0];
type MembershipUpsertArgs = Parameters<PrismaClient["contactBoardMembership"]["upsert"]>[0];
type MembershipUpdateArgs = Parameters<PrismaClient["contactBoardMembership"]["update"]>[0];
type MembershipUpdateManyArgs = Parameters<
  PrismaClient["contactBoardMembership"]["updateMany"]
>[0];
type ConversationFindUniqueArgs = Parameters<PrismaClient["conversation"]["findUnique"]>[0];
type ConversationFindManyArgs = Parameters<PrismaClient["conversation"]["findMany"]>[0];

interface BoardRuleRecord {
  id: string;
  workspaceId: string;
  isPrimaryPipeline: boolean;
  channels: Array<{ channelId: string }>;
  stages: StageRuleRecord[];
}

interface StageRuleRecord {
  id: string;
  workspaceId: string;
  boardId: string;
  order: number;
  tagTriggers: Array<{ tagId: string }>;
}

interface ConversationRuleRecord {
  id: string;
  workspaceId: string;
  channelId: string;
  contactId: string;
  status?: ConversationStatus;
  tags: Array<{ tagId: string }>;
}

interface MembershipRuleRecord {
  id: string;
  workspaceId: string;
  contactId: string;
  boardId: string;
  stageId: string;
  isPrimary: boolean;
  lastMovedBy?: "manual" | "rule" | null;
  lastRuleAppliedAt?: DateLike | null;
  updatedAt: DateLike;
  stage?: { order: number } | null;
}

interface BoardRulesPersistenceLike {
  contactBoard: {
    findMany(args: BoardFindManyArgs): Promise<BoardRuleRecord[]>;
    findFirst(args: BoardFindFirstArgs): Promise<BoardRuleRecord | null>;
  };
  contactBoardMembership: {
    findFirst(args: MembershipFindFirstArgs): Promise<MembershipRuleRecord | null>;
    upsert(args: MembershipUpsertArgs): Promise<MembershipRuleRecord>;
    update(args: MembershipUpdateArgs): Promise<MembershipRuleRecord>;
    updateMany(args: MembershipUpdateManyArgs): Promise<{ count: number }>;
  };
  conversation: {
    findUnique(args: ConversationFindUniqueArgs): Promise<ConversationRuleRecord | null>;
    findMany(args: ConversationFindManyArgs): Promise<ConversationRuleRecord[]>;
  };
}

export interface BoardRulesPrismaLike extends BoardRulesPersistenceLike {
  $transaction<T>(callback: (tx: BoardRulesPersistenceLike) => Promise<T>): Promise<T>;
}

export type BoardSyncScope = "active" | "closed" | "all";

export interface BoardRulesResultDto {
  evaluated: number;
  added: number;
  moved: number;
  ignored: number;
  conflicts: number;
}

interface BoardRulesServiceOptions {
  now?: () => Date;
}

type BoardMembershipUpdatedEvent = Extract<
  RealtimeEvent,
  { type: "board_membership.updated" }
>;

type PublishBoardMembership = (event: BoardMembershipUpdatedEvent) => void;

const boardRuleInclude = {
  channels: {
    select: { channelId: true }
  },
  stages: {
    orderBy: { order: "asc" as const },
    select: {
      id: true,
      workspaceId: true,
      boardId: true,
      order: true,
      tagTriggers: {
        select: { tagId: true }
      }
    }
  }
};

const conversationRuleInclude = {
  tags: {
    select: { tagId: true }
  }
};

function toIsoString(value: DateLike): string;
function toIsoString(value: DateLike | null): string | null;
function toIsoString(value: DateLike | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function emptyResult(): BoardRulesResultDto {
  return { evaluated: 0, added: 0, moved: 0, ignored: 0, conflicts: 0 };
}

function toMembershipDto(record: MembershipRuleRecord): ContactBoardMembershipDto {
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

function matchStage(board: BoardRuleRecord, tagIds: Set<string>): StageRuleRecord | null {
  let matchedStage: StageRuleRecord | null = null;

  for (const stage of board.stages) {
    const hasMatchingTag = stage.tagTriggers.some((trigger) => tagIds.has(trigger.tagId));
    if (hasMatchingTag && (!matchedStage || stage.order > matchedStage.order)) {
      matchedStage = stage;
    }
  }

  return matchedStage;
}

function mergeResult(target: BoardRulesResultDto, source: BoardRulesResultDto) {
  target.evaluated += source.evaluated;
  target.added += source.added;
  target.moved += source.moved;
  target.ignored += source.ignored;
  target.conflicts += source.conflicts;
}

function statusFilter(scope: BoardSyncScope) {
  if (scope === "active") {
    return { in: ["open", "pending"] satisfies ConversationStatus[] };
  }

  if (scope === "closed") {
    return "closed" satisfies ConversationStatus;
  }

  return undefined;
}

export function createBoardRulesService(
  prisma: BoardRulesPrismaLike,
  options: BoardRulesServiceOptions = {}
) {
  const now = () => options.now?.() ?? new Date();

  async function writeMembership(input: {
    client: BoardRulesPersistenceLike;
    workspaceId: string;
    contactId: string;
    board: BoardRuleRecord;
    stage: StageRuleRecord;
    currentMembership: MembershipRuleRecord | null;
    appliedAt: Date;
  }) {
    const isPrimary = input.board.isPrimaryPipeline;

    if (isPrimary) {
      await input.client.contactBoardMembership.updateMany({
        where: {
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          isPrimary: true,
          NOT: { boardId: input.board.id }
        },
        data: { isPrimary: false }
      });
    }

    if (input.currentMembership) {
      return input.client.contactBoardMembership.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.currentMembership.id
          }
        },
        data: {
          stageId: input.stage.id,
          ...(isPrimary ? { isPrimary: true } : {}),
          lastMovedBy: "rule",
          lastRuleAppliedAt: input.appliedAt
        }
      });
    }

    return input.client.contactBoardMembership.upsert({
      where: {
        workspaceId_contactId_boardId: {
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          boardId: input.board.id
        }
      },
      create: {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        boardId: input.board.id,
        stageId: input.stage.id,
        isPrimary,
        lastMovedBy: "rule",
        lastRuleAppliedAt: input.appliedAt
      },
      update: {
        stageId: input.stage.id,
        ...(isPrimary ? { isPrimary: true } : {}),
        lastMovedBy: "rule",
        lastRuleAppliedAt: input.appliedAt
      }
    });
  }

  async function applyBoardRule(input: {
    workspaceId: string;
    conversation: ConversationRuleRecord;
    board: BoardRuleRecord;
    publish?: PublishBoardMembership;
  }): Promise<BoardRulesResultDto> {
    const result = emptyResult();
    const selectedChannelIds = new Set(input.board.channels.map((channel) => channel.channelId));

    if (!selectedChannelIds.has(input.conversation.channelId)) {
      return result;
    }

    result.evaluated = 1;
    const tagIds = new Set(input.conversation.tags.map((tag) => tag.tagId));
    const targetStage = matchStage(input.board, tagIds);

    if (!targetStage) {
      result.ignored = 1;
      return result;
    }

    const currentMembership = await prisma.contactBoardMembership.findFirst({
      where: {
        workspaceId: input.workspaceId,
        contactId: input.conversation.contactId,
        boardId: input.board.id
      },
      include: {
        stage: {
          select: { order: true }
        }
      }
    });

    if (currentMembership && (currentMembership.stage?.order ?? -1) >= targetStage.order) {
      result.ignored = 1;
      return result;
    }

    const appliedAt = now();
    const membership = input.board.isPrimaryPipeline
      ? await prisma.$transaction((tx) =>
          writeMembership({
            client: tx,
            workspaceId: input.workspaceId,
            contactId: input.conversation.contactId,
            board: input.board,
            stage: targetStage,
            currentMembership,
            appliedAt
          })
        )
      : await writeMembership({
          client: prisma,
          workspaceId: input.workspaceId,
          contactId: input.conversation.contactId,
          board: input.board,
          stage: targetStage,
          currentMembership,
          appliedAt
        });

    if (currentMembership) {
      result.moved = 1;
    } else {
      result.added = 1;
    }

    input.publish?.({
      type: "board_membership.updated",
      workspaceId: input.workspaceId,
      payload: toMembershipDto(membership)
    });

    return result;
  }

  async function applyBoardsForConversation(input: {
    workspaceId: string;
    conversation: ConversationRuleRecord;
    boards: BoardRuleRecord[];
    publish?: PublishBoardMembership;
  }) {
    const result = emptyResult();

    for (const board of input.boards) {
      try {
        mergeResult(
          result,
          await applyBoardRule({
            workspaceId: input.workspaceId,
            conversation: input.conversation,
            board,
            publish: input.publish
          })
        );
      } catch {
        result.conflicts += 1;
      }
    }

    return result;
  }

  return {
    async applyBoardRulesForConversationTags(input: {
      workspaceId: string;
      conversationId: string;
      publish?: PublishBoardMembership;
    }): Promise<BoardRulesResultDto> {
      const conversation = await prisma.conversation.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.conversationId
          }
        },
        include: conversationRuleInclude
      });

      if (!conversation) {
        return emptyResult();
      }

      const tagIds = conversation.tags.map((tag) => tag.tagId);
      if (tagIds.length === 0) {
        return emptyResult();
      }

      const boards = await prisma.contactBoard.findMany({
        where: {
          workspaceId: input.workspaceId,
          channels: {
            some: { channelId: conversation.channelId }
          },
          stages: {
            some: {
              tagTriggers: {
                some: {
                  tagId: { in: tagIds }
                }
              }
            }
          }
        },
        include: boardRuleInclude
      });

      return applyBoardsForConversation({
        workspaceId: input.workspaceId,
        conversation,
        boards,
        publish: input.publish
      });
    },

    async syncBoardRules(input: {
      workspaceId: string;
      boardId: string;
      scope: BoardSyncScope;
      publish?: PublishBoardMembership;
    }): Promise<BoardRulesResultDto> {
      const board = await prisma.contactBoard.findFirst({
        where: { workspaceId: input.workspaceId, id: input.boardId },
        include: boardRuleInclude
      });

      if (!board) {
        throw new BoardsServiceError("BOARD_NOT_FOUND", "Board not found.");
      }

      const channelIds = board.channels.map((channel) => channel.channelId);
      if (channelIds.length === 0) {
        return emptyResult();
      }

      const status = statusFilter(input.scope);
      const conversations = await prisma.conversation.findMany({
        where: {
          workspaceId: input.workspaceId,
          channelId: { in: channelIds },
          ...(status ? { status } : {})
        },
        include: conversationRuleInclude
      });

      const result = emptyResult();
      for (const conversation of conversations) {
        mergeResult(
          result,
          await applyBoardsForConversation({
            workspaceId: input.workspaceId,
            conversation,
            boards: [board],
            publish: input.publish
          })
        );
      }

      return result;
    }
  };
}
