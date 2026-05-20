import { describe, expect, it } from "vitest";
import { conversationSchema, messageSchema } from "./domain";

describe("domain schemas", () => {
  it("accepts a tenant-owned open conversation", () => {
    const parsed = conversationSchema.parse({
      id: "conv_1",
      workspaceId: "workspace_1",
      channelId: "channel_1",
      contactId: "contact_1",
      status: "open",
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: "2026-05-20T12:00:00.000Z",
      lastMessagePreview: "Oi",
      unreadCount: 2,
      priority: "normal"
    });

    expect(parsed.workspaceId).toBe("workspace_1");
  });

  it("rejects an outbound message without a workspace id", () => {
    expect(() =>
      messageSchema.parse({
        id: "msg_1",
        conversationId: "conv_1",
        direction: "outbound",
        type: "text",
        body: "Oi",
        status: "pending",
        createdAt: "2026-05-20T12:00:00.000Z"
      })
    ).toThrow();
  });
});
