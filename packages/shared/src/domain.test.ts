import { describe, expect, it } from "vitest";
import {
  channelProviderSchema,
  channelSchema,
  contactBoardMembershipSchema,
  contactBoardSchema,
  contactBoardStageSchema,
  contactSchema,
  conversationSchema,
  integrationModeSchema,
  messageSchema,
  suiteModuleSchema
} from "./domain.js";
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

  const validContact = {
    id: "contact_1",
    workspaceId: "workspace_1",
    name: "Joao Martins",
    phone: "+5551999999999",
    email: null,
    company: null,
    atomicCrmContactId: null,
    atomicCrmLeadId: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z"
  };

  const validBoardMembership = {
    id: "membership_1",
    workspaceId: "workspace_1",
    contactId: "contact_1",
    boardId: "board_1",
    stageId: "stage_1",
    isPrimary: true,
    updatedAt: "2026-05-21T00:00:00.000Z"
  };

  const validChannel = {
    id: "channel_1",
    workspaceId: "workspace_1",
    provider: "evolution",
    providerKey: "demo-evolution",
    phoneNumber: "+5551999999999",
    displayName: "WhatsApp Demo",
    status: "connecting",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z"
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

  it("accepts a message DTO with a base64 data media URL", () => {
    const parsed = messageSchema.parse({
      ...validMessage,
      type: "image",
      mediaUrl: "data:image/jpeg;base64,aW1hZ2Vt"
    });

    expect(parsed.mediaUrl).toBe("data:image/jpeg;base64,aW1hZ2Vt");
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

  it("accepts suite module realtime events", () => {
    expect(
      realtimeEventSchema.parse({
        type: "contact.updated",
        workspaceId: "workspace_1",
        payload: validContact
      }).type
    ).toBe("contact.updated");

    expect(
      realtimeEventSchema.parse({
        type: "board_membership.updated",
        workspaceId: "workspace_1",
        payload: validBoardMembership
      }).type
    ).toBe("board_membership.updated");

    expect(
      realtimeEventSchema.parse({
        type: "channel.updated",
        workspaceId: "workspace_1",
        payload: validChannel
      }).type
    ).toBe("channel.updated");

    expect(
      realtimeEventSchema.parse({
        type: "channel.qr_updated",
        workspaceId: "workspace_1",
        payload: {
          channelId: "channel_1",
          qrCode: "2@qr-code",
          expiresAt: "2026-05-20T12:05:00.000Z"
        }
      }).type
    ).toBe("channel.qr_updated");

    expect(
      realtimeEventSchema.parse({
        type: "automation_run.created",
        workspaceId: "workspace_1",
        payload: {
          id: "run_1",
          workspaceId: "workspace_1",
          ruleId: "rule_1",
          eventKey: "manual_test",
          status: "completed",
          input: {},
          result: {},
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z"
        }
      }).type
    ).toBe("automation_run.created");

    expect(
      realtimeEventSchema.parse({
        type: "campaign.updated",
        workspaceId: "workspace_1",
        payload: {
          id: "campaign_1",
          workspaceId: "workspace_1",
          name: "Maio",
          status: "completed",
          audience: { type: "board", boardId: "board_1" },
          messageBody: "Oi {{name}}",
          scheduledAt: null,
          mode: "simulated",
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z"
        }
      }).type
    ).toBe("campaign.updated");
  });

  it("rejects suite module events when envelope and payload workspaces differ", () => {
    expect(() =>
      realtimeEventSchema.parse({
        type: "contact.updated",
        workspaceId: "workspace_2",
        payload: validContact
      })
    ).toThrow("Payload workspaceId must match event workspaceId");

    expect(() =>
      realtimeEventSchema.parse({
        type: "board_membership.updated",
        workspaceId: "workspace_2",
        payload: validBoardMembership
      })
    ).toThrow("Payload workspaceId must match event workspaceId");
  });

  it("validates suite module keys", () => {
    expect(suiteModuleSchema.parse("atendimento")).toBe("atendimento");
    expect(() => suiteModuleSchema.parse("pipeline")).toThrow();
  });

  it("accepts Meta Cloud as a WhatsApp channel provider", () => {
    expect(channelProviderSchema.parse("meta_cloud")).toBe("meta_cloud");
    expect(
      channelSchema.parse({
        id: "channel_1",
        workspaceId: "local_workspace",
        provider: "meta_cloud",
        providerKey: "1234567890",
        phoneNumber: "5511999999999",
        displayName: "Numero oficial",
        status: "connected",
        createdAt: "2026-06-02T12:00:00.000Z",
        updatedAt: "2026-06-02T12:00:00.000Z"
      }).provider
    ).toBe("meta_cloud");
  });

  it("validates contact board membership with primary flag", () => {
    expect(
      contactBoardMembershipSchema.parse({
        id: "membership_1",
        workspaceId: "workspace_1",
        contactId: "contact_1",
        boardId: "board_1",
        stageId: "stage_1",
        isPrimary: true,
        updatedAt: "2026-05-21T00:00:00.000Z"
      }).isPrimary
    ).toBe(true);
  });

  it("validates contact board and stages", () => {
    expect(
      contactBoardSchema.parse({
        id: "board_1",
        workspaceId: "workspace_1",
        name: "Pre-vendas",
        description: null,
        createdAt: "2026-05-21T00:00:00.000Z"
      }).name
    ).toBe("Pre-vendas");

    expect(
      contactBoardStageSchema.parse({
        id: "stage_1",
        workspaceId: "workspace_1",
        boardId: "board_1",
        name: "Proposta enviada",
        color: "#DFF3EA",
        order: 2
      }).order
    ).toBe(2);
  });

  it("validates contacts and integration mode", () => {
    expect(
      contactSchema.parse({
        id: "contact_1",
        workspaceId: "workspace_1",
        name: "Joao Martins",
        phone: "+5551999999999",
        email: null,
        company: null,
        atomicCrmContactId: null,
        atomicCrmLeadId: null,
        createdAt: "2026-05-21T00:00:00.000Z",
        updatedAt: "2026-05-21T00:00:00.000Z"
      }).phone
    ).toBe("+5551999999999");

    expect(integrationModeSchema.parse("simulated")).toBe("simulated");
  });
});
