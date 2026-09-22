import { describe, expect, it, vi } from "vitest";
import { createRealtimeOutboundDelivery } from "./realtime-outbound-delivery.js";

describe("createRealtimeOutboundDelivery", () => {
  it("publishes confirmed outbound message and conversation exactly once", async () => {
    const result = {
      message: {
        id: "message_1", workspaceId: "workspace_a", conversationId: "conversation_1",
        providerMessageId: "provider_1", direction: "outbound" as const, type: "text" as const,
        body: "Oi", mediaUrl: null, status: "sent" as const, sentByUserId: null,
        createdAt: "2026-09-22T12:00:00.000Z"
      },
      conversation: {
        id: "conversation_1", workspaceId: "workspace_a", channelId: "channel_1", contactId: "contact_1",
        contactName: "Ana", contactPhone: "5511999999999", channelName: "WhatsApp", channelProvider: "evolution" as const,
        customerServiceWindowExpiresAt: null, metaServiceWindowOpen: null, departmentName: null, assignedUserName: null,
        status: "open" as const, assignedUserId: null, departmentId: null, lastMessageAt: "2026-09-22T12:00:00.000Z",
        lastMessagePreview: "Oi", unreadCount: 0, priority: "normal" as const, aiControlStatus: "agent_allowed" as const,
        activeAgentName: null, activeAgentSessionStatus: null, handoffReason: null
      }
    };
    const publish = vi.fn();
    const delivery = createRealtimeOutboundDelivery({
      delivery: { createPendingOutboundMessage: vi.fn().mockResolvedValue(result) },
      realtime: { publish }
    });

    await delivery.createPendingOutboundMessage({
      workspaceId: "workspace_a", conversationId: "conversation_1", body: "Oi", sentByUserId: null
    });

    expect(publish.mock.calls.map(([event]) => event.type)).toEqual(["message.created", "conversation.updated"]);
  });
});
