import { describe, expect, it, vi } from "vitest";
import { messageSchema } from "@prymeira-talk/shared";
import {
  ConversationNotFoundError,
  createConversationsService
} from "./conversations.service.js";
import type { PrismaLike } from "./conversations.service.js";
import { createMessageParamsSchema } from "./conversations.routes.js";

type MockPrisma = {
  conversation: {
    findMany: ReturnType<typeof vi.fn<PrismaLike["conversation"]["findMany"]>>;
    findUnique: ReturnType<typeof vi.fn<PrismaLike["conversation"]["findUnique"]>>;
  };
  message: {
    create: ReturnType<typeof vi.fn<PrismaLike["message"]["create"]>>;
  };
};

function createMockPrisma(overrides: {
  findMany?: MockPrisma["conversation"]["findMany"];
  findUnique?: MockPrisma["conversation"]["findUnique"];
  create?: MockPrisma["message"]["create"];
} = {}): MockPrisma {
  return {
    conversation: {
      findMany: overrides.findMany ?? vi.fn<PrismaLike["conversation"]["findMany"]>().mockResolvedValue([]),
      findUnique:
        overrides.findUnique ??
        vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({ id: "conv_1" })
    },
    message: {
      create:
        overrides.create ??
        vi.fn<PrismaLike["message"]["create"]>().mockResolvedValue({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          direction: "outbound",
          type: "text",
          body: "Oi",
          status: "pending",
          createdAt: new Date("2026-05-20T12:00:00.000Z")
        })
    }
  };
}

describe("conversations service", () => {
  it("filters conversations by workspace id", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    await service.listConversations({ workspaceId: "workspace_a" });

    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "workspace_a" })
      })
    );
  });

  it("creates outbound pending messages inside the caller workspace", async () => {
    const prisma = createMockPrisma({
      create: vi.fn<PrismaLike["message"]["create"]>().mockResolvedValue({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: null,
          direction: "outbound",
          type: "text",
          body: "Oi",
          mediaUrl: null,
          status: "pending",
          sentByUserId: "user_1",
          createdAt: new Date("2026-05-20T12:00:00.000Z")
        })
    });
    const service = createConversationsService(prisma);

    const message = await service.createPendingOutboundMessage({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      body: "Oi",
      sentByUserId: "user_1"
    });

    expect(message.workspaceId).toBe("workspace_a");
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          status: "pending"
        })
      })
    );
  });

  it("preflights outbound messages with the workspace conversation composite key", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    await service.createPendingOutboundMessage({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      body: "Oi",
      sentByUserId: "user_1"
    });

    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
      select: { id: true }
    });
  });

  it("rejects missing conversations without creating a message", async () => {
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue(null)
    });
    const service = createConversationsService(prisma);

    const error = await service
      .createPendingOutboundMessage({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        body: "Oi",
        sentByUserId: "user_1"
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConversationNotFoundError);
    expect(error).toMatchObject({
      code: "CONVERSATION_NOT_FOUND",
      statusCode: 404
    });
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("returns messages that parse as shared message DTOs", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    const message = await service.createPendingOutboundMessage({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      body: "Oi",
      sentByUserId: null
    });

    expect(messageSchema.parse(message)).toEqual(message);
    expect(message).toEqual(
      expect.objectContaining({
        providerMessageId: null,
        mediaUrl: null,
        sentByUserId: null
      })
    );
  });
});

describe("conversation route schemas", () => {
  it("requires conversation ids to be UUIDs", () => {
    expect(createMessageParamsSchema.safeParse({ conversationId: "not-a-uuid" }).success).toBe(false);
    expect(
      createMessageParamsSchema.safeParse({
        conversationId: "00000000-0000-4000-8000-000000000001"
      }).success
    ).toBe(true);
  });
});
