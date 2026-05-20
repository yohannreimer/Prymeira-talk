import { describe, expect, it, vi } from "vitest";
import { createConversationsService } from "./conversations.service.js";

describe("conversations service", () => {
  it("filters conversations by workspace id", async () => {
    const prisma = {
      conversation: {
        findMany: vi.fn().mockResolvedValue([])
      }
    };
    const service = createConversationsService(prisma as never);

    await service.listConversations({ workspaceId: "workspace_a" });

    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "workspace_a" })
      })
    );
  });

  it("creates outbound pending messages inside the caller workspace", async () => {
    const prisma = {
      message: {
        create: vi.fn().mockResolvedValue({
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
      }
    };
    const service = createConversationsService(prisma as never);

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
});
