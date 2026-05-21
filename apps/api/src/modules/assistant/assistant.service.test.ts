import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { assistantRoutes } from "./assistant.routes.js";
import { createAssistantService } from "./assistant.service.js";
import type { PrismaLike } from "./assistant.service.js";

type MockPrisma = {
  aiActionLog: {
    create: any;
    findMany: any;
  };
  conversation: {
    findUnique: any;
  };
  contact: {
    findUnique: any;
  };
};

const actionId = "00000000-0000-4000-8000-000000000401";
const conversationId = "00000000-0000-4000-8000-000000000402";
const contactId = "00000000-0000-4000-8000-000000000403";

const baseAction = {
  id: actionId,
  workspaceId: "workspace_a",
  conversationId,
  contactId,
  userId: null,
  actionType: "summary",
  mode: "simulated" as const,
  input: { transcript: "Cliente quer saber preco." },
  result: { summary: "Cliente pediu informacoes de preco.", mode: "simulated" },
  status: "completed",
  createdAt: new Date("2026-05-21T14:00:00.000Z")
};

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
  return {
    aiActionLog: {
      create:
        overrides.aiActionLog?.create ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseAction,
          ...args.data
        })),
      findMany: overrides.aiActionLog?.findMany ?? vi.fn().mockResolvedValue([baseAction])
    },
    conversation: {
      findUnique:
        overrides.conversation?.findUnique ??
        vi.fn().mockResolvedValue({ id: conversationId, workspaceId: "workspace_a" })
    },
    contact: {
      findUnique:
        overrides.contact?.findUnique ??
        vi.fn().mockResolvedValue({ id: contactId, workspaceId: "workspace_a" })
    }
  } as MockPrisma & PrismaLike;
}

async function buildAssistantApp(input: { prisma?: MockPrisma & PrismaLike } = {}) {
  const app = Fastify({ logger: false });
  const prisma = input.prisma ?? createMockPrisma();

  app.decorate("prisma", prisma as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: "agent" };
  });
  await app.register(assistantRoutes);

  return { app, prisma };
}

describe("assistant service", () => {
  it.each([
    {
      actionType: "summary" as const,
      expectedResultKey: "summary"
    },
    {
      actionType: "suggested_reply" as const,
      expectedResultKey: "suggestedReply"
    }
  ])("creates a simulated $actionType action log", async ({ actionType, expectedResultKey }) => {
    const prisma = createMockPrisma();
    const service = createAssistantService(prisma);

    const action = await service.createAction({
      workspaceId: "workspace_a",
      actionType,
      conversationId,
      contactId,
      input: { transcript: "Cliente quer saber preco." }
    });

    expect(action).toEqual(
      expect.objectContaining({
        workspaceId: "workspace_a",
        actionType,
        mode: "simulated",
        status: "completed",
        result: expect.objectContaining({
          mode: "simulated",
          [expectedResultKey]: expect.any(String)
        })
      })
    );
    expect(prisma.aiActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          actionType,
          mode: "simulated",
          status: "completed"
        })
      })
    );
    expect(prisma.conversation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_id: {
            workspaceId: "workspace_a",
            id: conversationId
          }
        }
      })
    );
    expect(prisma.contact.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_id: {
            workspaceId: "workspace_a",
            id: contactId
          }
        }
      })
    );
  });

  it("rejects action logs for references outside the current workspace", async () => {
    const prisma = createMockPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue(null)
      }
    });
    const service = createAssistantService(prisma);

    await expect(
      service.createAction({
        workspaceId: "workspace_a",
        actionType: "summary",
        conversationId,
        contactId,
        input: { transcript: "Cliente quer saber preco." }
      })
    ).rejects.toMatchObject({ code: "ASSISTANT_CONVERSATION_NOT_FOUND" });
    expect(prisma.aiActionLog.create).not.toHaveBeenCalled();
  });
});

describe("assistant routes", () => {
  it("returns visible simulated mode from POST /assistant/actions", async () => {
    const { app } = await buildAssistantApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/assistant/actions",
        payload: {
          actionType: "suggested_reply",
          conversationId,
          contactId,
          input: { lastMessage: "Quanto custa?" }
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(
        expect.objectContaining({
          mode: "simulated",
          actionType: "suggested_reply",
          result: expect.objectContaining({
            mode: "simulated",
            suggestedReply: expect.any(String)
          })
        })
      );
    } finally {
      await app.close();
    }
  });

  it("returns 404 when assistant action references a contact outside workspace", async () => {
    const prisma = createMockPrisma({
      contact: {
        findUnique: vi.fn().mockResolvedValue(null)
      }
    });
    const { app } = await buildAssistantApp({ prisma });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/assistant/actions",
        payload: {
          actionType: "suggested_reply",
          conversationId,
          contactId,
          input: { lastMessage: "Quanto custa?" }
        }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: "ASSISTANT_CONTACT_NOT_FOUND",
        error: "Assistant contact not found."
      });
      expect(prisma.aiActionLog.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
