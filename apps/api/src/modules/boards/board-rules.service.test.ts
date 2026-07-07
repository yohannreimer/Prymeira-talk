import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { BoardsServiceError } from "./boards.service.js";
import {
  createBoardRulesService,
  type BoardRulesPrismaLike
} from "./board-rules.service.js";
import { boardsRoutes } from "./boards.routes.js";

type MockPrisma = {
  $transaction: BoardRulesPrismaLike["$transaction"] & ReturnType<typeof vi.fn>;
  contactBoard: {
    findMany: ReturnType<typeof vi.fn<BoardRulesPrismaLike["contactBoard"]["findMany"]>>;
    findFirst: ReturnType<typeof vi.fn<BoardRulesPrismaLike["contactBoard"]["findFirst"]>>;
  };
  contactBoardMembership: {
    findFirst: ReturnType<
      typeof vi.fn<BoardRulesPrismaLike["contactBoardMembership"]["findFirst"]>
    >;
    upsert: ReturnType<typeof vi.fn<BoardRulesPrismaLike["contactBoardMembership"]["upsert"]>>;
    update: ReturnType<typeof vi.fn<BoardRulesPrismaLike["contactBoardMembership"]["update"]>>;
    updateMany: ReturnType<
      typeof vi.fn<BoardRulesPrismaLike["contactBoardMembership"]["updateMany"]>
    >;
  };
  conversation: {
    findUnique: ReturnType<typeof vi.fn<BoardRulesPrismaLike["conversation"]["findUnique"]>>;
    findMany: ReturnType<typeof vi.fn<BoardRulesPrismaLike["conversation"]["findMany"]>>;
  };
};

const workspaceId = "workspace_a";
const boardId = "00000000-0000-4000-8000-000000000010";
const otherBoardId = "00000000-0000-4000-8000-000000000011";
const stageEarlyId = "00000000-0000-4000-8000-000000000020";
const stageLaterId = "00000000-0000-4000-8000-000000000021";
const stageLastId = "00000000-0000-4000-8000-000000000022";
const membershipId = "00000000-0000-4000-8000-000000000030";
const conversationId = "00000000-0000-4000-8000-000000000040";
const secondConversationId = "00000000-0000-4000-8000-000000000041";
const thirdConversationId = "00000000-0000-4000-8000-000000000042";
const contactId = "00000000-0000-4000-8000-000000000050";
const secondContactId = "00000000-0000-4000-8000-000000000051";
const thirdContactId = "00000000-0000-4000-8000-000000000052";
const channelId = "00000000-0000-4000-8000-000000000060";
const otherChannelId = "00000000-0000-4000-8000-000000000061";
const tagId = "00000000-0000-4000-8000-000000000070";
const otherTagId = "00000000-0000-4000-8000-000000000071";
const updatedAt = new Date("2026-07-07T12:00:00.000Z");
const ruleAppliedAt = new Date("2026-07-07T12:30:00.000Z");

interface BoardRecordFixture {
  id: string;
  workspaceId: string;
  isPrimaryPipeline: boolean;
  channels: Array<{ channelId: string }>;
  stages: Array<{
    id: string;
    workspaceId: string;
    boardId: string;
    order: number;
    tagTriggers: Array<{ tagId: string }>;
  }>;
}

interface ConversationFixture {
  id: string;
  workspaceId: string;
  contactId: string;
  channelId: string;
  status: "open" | "pending" | "closed";
  tags: Array<{ tagId: string }>;
}

interface MembershipFixture {
  id: string;
  workspaceId: string;
  contactId: string;
  boardId: string;
  stageId: string;
  isPrimary: boolean;
  lastMovedBy: "manual" | "rule";
  lastRuleAppliedAt: Date | null;
  updatedAt: Date;
  stage: { order: number };
}

function tagTrigger(id: string) {
  return { tagId: id };
}

function board(overrides: Partial<BoardRecordFixture> = {}): BoardRecordFixture {
  return {
    id: boardId,
    workspaceId,
    isPrimaryPipeline: false,
    channels: [{ channelId }],
    stages: [
      {
        id: stageEarlyId,
        workspaceId,
        boardId,
        order: 0,
        tagTriggers: [tagTrigger(tagId)]
      },
      {
        id: stageLaterId,
        workspaceId,
        boardId,
        order: 2,
        tagTriggers: [tagTrigger(tagId)]
      },
      {
        id: stageLastId,
        workspaceId,
        boardId,
        order: 3,
        tagTriggers: [tagTrigger(otherTagId)]
      }
    ],
    ...overrides
  };
}

function conversation(overrides: Partial<ConversationFixture> = {}): ConversationFixture {
  return {
    id: conversationId,
    workspaceId,
    contactId,
    channelId,
    status: "open" as const,
    tags: [{ tagId }],
    ...overrides
  };
}

function membership(overrides: Partial<MembershipFixture> = {}): MembershipFixture {
  return {
    id: membershipId,
    workspaceId,
    contactId,
    boardId,
    stageId: stageEarlyId,
    isPrimary: false,
    lastMovedBy: "manual" as const,
    lastRuleAppliedAt: null,
    updatedAt,
    stage: { order: 0 },
    ...overrides
  };
}

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & BoardRulesPrismaLike {
  let prisma: MockPrisma & BoardRulesPrismaLike;
  const transaction = vi.fn(
    <T,>(callback: Parameters<BoardRulesPrismaLike["$transaction"]>[0]) => callback(prisma)
  ) as BoardRulesPrismaLike["$transaction"] & ReturnType<typeof vi.fn>;

  prisma = {
    $transaction: overrides.$transaction ?? transaction,
    contactBoard: {
      findMany:
        overrides.contactBoard?.findMany ??
        vi.fn<BoardRulesPrismaLike["contactBoard"]["findMany"]>().mockResolvedValue([board()]),
      findFirst:
        overrides.contactBoard?.findFirst ??
        vi.fn<BoardRulesPrismaLike["contactBoard"]["findFirst"]>().mockResolvedValue(board())
    },
    contactBoardMembership: {
      findFirst:
        overrides.contactBoardMembership?.findFirst ??
        vi.fn<BoardRulesPrismaLike["contactBoardMembership"]["findFirst"]>().mockResolvedValue(
          null
        ),
      upsert:
        overrides.contactBoardMembership?.upsert ??
        vi.fn<BoardRulesPrismaLike["contactBoardMembership"]["upsert"]>().mockResolvedValue(
          membership({ stageId: stageLaterId, lastMovedBy: "rule", lastRuleAppliedAt: ruleAppliedAt })
        ),
      update:
        overrides.contactBoardMembership?.update ??
        vi.fn<BoardRulesPrismaLike["contactBoardMembership"]["update"]>().mockResolvedValue(
          membership({ stageId: stageLaterId, lastMovedBy: "rule", lastRuleAppliedAt: ruleAppliedAt })
        ),
      updateMany:
        overrides.contactBoardMembership?.updateMany ??
        vi.fn<BoardRulesPrismaLike["contactBoardMembership"]["updateMany"]>().mockResolvedValue({
          count: 1
        })
    },
    conversation: {
      findUnique:
        overrides.conversation?.findUnique ??
        vi.fn<BoardRulesPrismaLike["conversation"]["findUnique"]>().mockResolvedValue(
          conversation()
        ),
      findMany:
        overrides.conversation?.findMany ??
        vi.fn<BoardRulesPrismaLike["conversation"]["findMany"]>().mockResolvedValue([
          conversation()
        ])
    }
  } as MockPrisma & BoardRulesPrismaLike;

  return prisma;
}

async function buildBoardsApp(prisma = createMockPrisma()) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId, role: "agent" };
  });
  await app.register(boardsRoutes);

  return { app, publish };
}

describe("board rules service", () => {
  it("adds a membership only for matching channels and chooses the rightmost matching stage", async () => {
    const prisma = createMockPrisma({
      contactBoard: {
        ...createMockPrisma().contactBoard,
        findMany: vi
          .fn<BoardRulesPrismaLike["contactBoard"]["findMany"]>()
          .mockResolvedValue([
            board(),
            board({
              id: otherBoardId,
              channels: [{ channelId: otherChannelId }],
              stages: [
                {
                  id: "00000000-0000-4000-8000-000000000099",
                  workspaceId,
                  boardId: otherBoardId,
                  order: 9,
                  tagTriggers: [tagTrigger(tagId)]
                }
              ]
            })
          ])
      }
    });
    const service = createBoardRulesService(prisma, { now: () => ruleAppliedAt });

    const result = await service.applyBoardRulesForConversationTags({
      workspaceId,
      conversationId
    });

    expect(result).toMatchObject({ evaluated: 1, added: 1, moved: 0, ignored: 0, conflicts: 0 });
    expect(prisma.contactBoardMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          boardId,
          stageId: stageLaterId,
          lastMovedBy: "rule",
          lastRuleAppliedAt: ruleAppliedAt
        })
      })
    );
    expect(prisma.contactBoardMembership.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not move a contact backward or sideways to an equal or lower stage order", async () => {
    const prisma = createMockPrisma({
      contactBoardMembership: {
        ...createMockPrisma().contactBoardMembership,
        findFirst: vi
          .fn<BoardRulesPrismaLike["contactBoardMembership"]["findFirst"]>()
          .mockResolvedValue(membership({ stageId: stageLastId, stage: { order: 3 } }))
      }
    });
    const service = createBoardRulesService(prisma, { now: () => ruleAppliedAt });

    const result = await service.applyBoardRulesForConversationTags({
      workspaceId,
      conversationId
    });

    expect(result).toMatchObject({ evaluated: 1, added: 0, moved: 0, ignored: 1, conflicts: 0 });
    expect(prisma.contactBoardMembership.update).not.toHaveBeenCalled();
    expect(prisma.contactBoardMembership.upsert).not.toHaveBeenCalled();
  });

  it("promotes primary pipeline memberships and clears other primary memberships in one transaction", async () => {
    const prisma = createMockPrisma({
      contactBoard: {
        ...createMockPrisma().contactBoard,
        findMany: vi
          .fn<BoardRulesPrismaLike["contactBoard"]["findMany"]>()
          .mockResolvedValue([board({ isPrimaryPipeline: true })])
      },
      contactBoardMembership: {
        ...createMockPrisma().contactBoardMembership,
        findFirst: vi
          .fn<BoardRulesPrismaLike["contactBoardMembership"]["findFirst"]>()
          .mockResolvedValue(membership())
      }
    });
    const service = createBoardRulesService(prisma, { now: () => ruleAppliedAt });

    await service.applyBoardRulesForConversationTags({ workspaceId, conversationId });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.contactBoardMembership.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId,
        contactId,
        isPrimary: true,
        NOT: { boardId }
      },
      data: { isPrimary: false }
    });
    expect(prisma.contactBoardMembership.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isPrimary: true,
          lastMovedBy: "rule",
          lastRuleAppliedAt: ruleAppliedAt
        })
      })
    );
  });

  it.each([
    ["active" as const, { in: ["open", "pending"] }],
    ["closed" as const, "closed"],
    ["all" as const, undefined]
  ])("filters sync conversations by %s scope", async (scope, expectedStatus) => {
    const prisma = createMockPrisma();
    const service = createBoardRulesService(prisma, { now: () => ruleAppliedAt });

    await service.syncBoardRules({ workspaceId, boardId, scope });

    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedStatus
          ? expect.objectContaining({ status: expectedStatus })
          : expect.not.objectContaining({ status: expect.anything() })
      })
    );
  });

  it("aggregates sync results and publishes updated memberships", async () => {
    const publish = vi.fn();
    const prisma = createMockPrisma({
      conversation: {
        ...createMockPrisma().conversation,
        findMany: vi.fn<BoardRulesPrismaLike["conversation"]["findMany"]>().mockResolvedValue([
          conversation({ id: conversationId, contactId, tags: [{ tagId }] }),
          conversation({
            id: secondConversationId,
            contactId: secondContactId,
            tags: [{ tagId }]
          }),
          conversation({
            id: thirdConversationId,
            contactId: thirdContactId,
            tags: [{ tagId: otherTagId }]
          })
        ])
      },
      contactBoardMembership: {
        ...createMockPrisma().contactBoardMembership,
        findFirst: vi
          .fn<BoardRulesPrismaLike["contactBoardMembership"]["findFirst"]>()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(
            membership({
              id: "00000000-0000-4000-8000-000000000031",
              contactId: secondContactId,
              stageId: stageEarlyId,
              stage: { order: 0 }
            })
          )
          .mockResolvedValueOnce(
            membership({
              id: "00000000-0000-4000-8000-000000000032",
              contactId: thirdContactId,
              stageId: stageLastId,
              stage: { order: 3 }
            })
          ),
        upsert: vi
          .fn<BoardRulesPrismaLike["contactBoardMembership"]["upsert"]>()
          .mockResolvedValue(
            membership({
              contactId,
              stageId: stageLaterId,
              lastMovedBy: "rule",
              lastRuleAppliedAt: ruleAppliedAt
            })
          ),
        update: vi
          .fn<BoardRulesPrismaLike["contactBoardMembership"]["update"]>()
          .mockResolvedValue(
            membership({
              id: "00000000-0000-4000-8000-000000000031",
              contactId: secondContactId,
              stageId: stageLaterId,
              lastMovedBy: "rule",
              lastRuleAppliedAt: ruleAppliedAt
            })
          )
      }
    });
    const service = createBoardRulesService(prisma, { now: () => ruleAppliedAt });

    const result = await service.syncBoardRules({
      workspaceId,
      boardId,
      scope: "active",
      publish
    });

    expect(result).toEqual({ evaluated: 3, added: 1, moved: 1, ignored: 1, conflicts: 0 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(1, {
      type: "board_membership.updated",
      workspaceId,
      payload: expect.objectContaining({ contactId, stageId: stageLaterId })
    });
  });

  it("maps a missing board during sync to the existing board not found error", async () => {
    const prisma = createMockPrisma({
      contactBoard: {
        ...createMockPrisma().contactBoard,
        findFirst: vi.fn<BoardRulesPrismaLike["contactBoard"]["findFirst"]>().mockResolvedValue(
          null
        )
      }
    });
    const service = createBoardRulesService(prisma, { now: () => ruleAppliedAt });

    await expect(service.syncBoardRules({ workspaceId, boardId, scope: "active" })).rejects.toBeInstanceOf(
      BoardsServiceError
    );
  });

  it("exposes manual board rule sync through the boards route", async () => {
    const { app, publish } = await buildBoardsApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: `/boards/${boardId}/sync-rules`,
        payload: { scope: "active" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        evaluated: 1,
        added: 1,
        moved: 0,
        ignored: 0,
        conflicts: 0
      });
      expect(publish).toHaveBeenCalledWith({
        type: "board_membership.updated",
        workspaceId,
        payload: expect.objectContaining({
          contactId,
          boardId,
          stageId: stageLaterId,
          lastMovedBy: "rule"
        })
      });
    } finally {
      await app.close();
    }
  });
});
