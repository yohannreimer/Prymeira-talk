import { describe, expect, it } from "vitest";
import { conversationSchema, messageSchema } from "./domain";
import { realtimeEventSchema } from "./realtime";

describe("domain schemas", () => {
  const validConversation = {
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
  };

  const validMessage = {
    id: "msg_1",
    workspaceId: "workspace_1",
    conversationId: "conv_1",
    providerMessageId: null,
    direction: "outbound",
    type: "text",
    body: "Oi",
    mediaUrl: null,
    status: "pending",
    sentByUserId: null,
    createdAt: "2026-05-20T12:00:00.000Z"
  };

  it("accepts a tenant-owned open conversation", () => {
    const parsed = conversationSchema.parse(validConversation);

    expect(parsed.workspaceId).toBe("workspace_1");
  });

  it("rejects a conversation with a negative unread count", () => {
    expect(() =>
      conversationSchema.parse({
        ...validConversation,
        unreadCount: -1
      })
    ).toThrow();
  });

  it("rejects a conversation with an invalid last message datetime", () => {
    expect(() =>
      conversationSchema.parse({
        ...validConversation,
        lastMessageAt: "2026-05-20"
      })
    ).toThrow();
  });

  it("accepts a message DTO with required nullable fields set to null", () => {
    const parsed = messageSchema.parse(validMessage);

    expect(parsed.providerMessageId).toBeNull();
    expect(parsed.mediaUrl).toBeNull();
    expect(parsed.sentByUserId).toBeNull();
  });

  it("rejects a message DTO missing providerMessageId", () => {
    const { providerMessageId: _providerMessageId, ...messageWithoutProviderMessageId } = validMessage;

    expect(() => messageSchema.parse(messageWithoutProviderMessageId)).toThrow();
  });

  it("rejects a message DTO missing mediaUrl", () => {
    const { mediaUrl: _mediaUrl, ...messageWithoutMediaUrl } = validMessage;

    expect(() => messageSchema.parse(messageWithoutMediaUrl)).toThrow();
  });

  it("rejects a message DTO missing sentByUserId", () => {
    const { sentByUserId: _sentByUserId, ...messageWithoutSentByUserId } = validMessage;

    expect(() => messageSchema.parse(messageWithoutSentByUserId)).toThrow();
  });

  it("rejects a message with an invalid created datetime", () => {
    expect(() =>
      messageSchema.parse({
        ...validMessage,
        createdAt: "2026-05-20"
      })
    ).toThrow();
  });

  it("rejects an outbound message without a workspace id", () => {
    expect(() =>
      messageSchema.parse({
        id: "msg_1",
        conversationId: "conv_1",
        providerMessageId: null,
        direction: "outbound",
        type: "text",
        body: "Oi",
        mediaUrl: null,
        status: "pending",
        sentByUserId: null,
        createdAt: "2026-05-20T12:00:00.000Z"
      })
    ).toThrow();
  });

  it("rejects a message created event when envelope and payload workspaces differ", () => {
    expect(() =>
      realtimeEventSchema.parse({
        type: "message.created",
        workspaceId: "workspace_2",
        payload: validMessage
      })
    ).toThrow();
  });

  it("rejects a conversation updated event when envelope and payload workspaces differ", () => {
    expect(() =>
      realtimeEventSchema.parse({
        type: "conversation.updated",
        workspaceId: "workspace_2",
        payload: validConversation
      })
    ).toThrow();
  });

  it("accepts a valid message status changed event", () => {
    const parsed = realtimeEventSchema.parse({
      type: "message.status_changed",
      workspaceId: "workspace_1",
      payload: {
        messageId: "msg_1",
        status: "delivered"
      }
    });

    expect(parsed.workspaceId).toBe("workspace_1");
  });
});
