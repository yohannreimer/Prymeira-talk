import { describe, expect, it } from "vitest";
import {
  aiAgentRunSchema,
  aiAgentSchema,
  aiAgentSessionSchema,
  channelProviderSchema,
  channelSchema,
  contactBoardMembershipSchema,
  contactBoardSchema,
  contactBoardStageSchema,
  contactSchema,
  conversationSchema,
  integrationModeSchema,
  messageSchema,
  suiteModuleSchema,
  tagSchema
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
    priority: "normal",
    channelProvider: "meta_cloud",
    customerServiceWindowExpiresAt: "2026-05-21T12:00:00.000Z",
    metaServiceWindowOpen: true
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
    expect(parsed.channelProvider).toBe("meta_cloud");
    expect(parsed.customerServiceWindowExpiresAt).toBe("2026-05-21T12:00:00.000Z");
    expect(parsed.metaServiceWindowOpen).toBe(true);
  });

  it("accepts AI control fields on conversations", () => {
    const conversation = conversationSchema.parse({
      id: "conversation_1",
      workspaceId: "workspace_a",
      channelId: "channel_1",
      contactId: "contact_1",
      status: "open",
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: null,
      lastMessagePreview: null,
      unreadCount: 0,
      priority: "normal",
      aiControlStatus: "human_controlled",
      activeAgentName: "Secretaria IA",
      activeAgentSessionStatus: "paused_by_human",
      handoffReason: null
    });

    expect(conversation.aiControlStatus).toBe("human_controlled");
    expect(conversation.activeAgentName).toBe("Secretaria IA");
    expect(conversation.activeAgentSessionStatus).toBe("paused_by_human");
    expect(conversation.handoffReason).toBeNull();
  });

  it("accepts an AI agent DTO with behavior and action controls", () => {
    const agent = aiAgentSchema.parse({
      id: "agent_1",
      workspaceId: "workspace_a",
      name: "Secretaria IA",
      description: "Atende perguntas iniciais",
      status: "active",
      providerMode: "workspace_key",
      provider: "openai",
      model: "gpt-4.1-mini",
      systemPrompt: "Responda com clareza.",
      behaviorConfig: { tone: "friendly" },
      handoffConfig: { afterAttempts: 2 },
      limitsConfig: { maxMessages: 10 },
      allowedActions: ["send_message", "add_tag", "create_internal_note"],
      createdAt: "2026-06-23T19:00:00.000Z",
      updatedAt: "2026-06-23T19:00:00.000Z"
    });

    expect(agent.providerMode).toBe("workspace_key");
    expect(agent.allowedActions).toEqual(["send_message", "add_tag", "create_internal_note"]);
  });

  it("parses workspace tag catalog DTOs", () => {
    const tag = tagSchema.parse({
      id: "tag_1",
      workspaceId: "workspace_a",
      name: "Lead quente",
      color: "#2f6b57",
      useGuide: "Quando o cliente pedir preço, proposta ou demonstração.",
      isActive: true,
      agentCount: 1,
      conversationCount: 3,
      createdAt: "2026-07-05T12:00:00.000Z",
      updatedAt: "2026-07-05T12:00:00.000Z"
    });

    expect(tag.name).toBe("Lead quente");
    expect(tag.useGuide).toContain("preço");
  });

  it("parses agents with selected allowed tags", () => {
    const agent = aiAgentSchema.parse({
      id: "agent_1",
      workspaceId: "workspace_a",
      name: "Prymeira Vendedora",
      description: null,
      status: "active",
      providerMode: "prymeira_managed",
      provider: "simulated",
      model: "prymeira-simulated",
      systemPrompt: "Atenda bem.",
      behaviorConfig: {},
      handoffConfig: {},
      limitsConfig: {},
      allowedActions: ["send_message", "add_tag"],
      allowedTags: [
        {
          id: "tag_1",
          name: "Lead quente",
          color: "#2f6b57",
          useGuide: "Quando o cliente pedir preço, proposta ou demonstração."
        }
      ],
      createdAt: "2026-07-05T12:00:00.000Z",
      updatedAt: "2026-07-05T12:00:00.000Z"
    });

    expect(agent.allowedTags).toEqual([
      expect.objectContaining({ name: "Lead quente" })
    ]);
  });

  it("accepts an AI session DTO with handoff requested status", () => {
    const session = aiAgentSessionSchema.parse({
      id: "session_1",
      workspaceId: "workspace_a",
      agentId: "agent_1",
      conversationId: "conversation_1",
      status: "handoff_requested",
      messageCount: 4,
      lastRunAt: "2026-06-23T19:05:00.000Z",
      handoffReason: "Cliente pediu atendimento humano",
      createdAt: "2026-06-23T19:00:00.000Z",
      updatedAt: "2026-06-23T19:05:00.000Z"
    });

    expect(session.status).toBe("handoff_requested");
    expect(session.messageCount).toBe(4);
  });

  it("accepts an AI run DTO with automation trigger and completed output", () => {
    const run = aiAgentRunSchema.parse({
      id: "run_1",
      workspaceId: "workspace_a",
      agentId: "agent_1",
      sessionId: "session_1",
      conversationId: "conversation_1",
      trigger: "automation",
      input: { message: "Oi" },
      output: { reply: "Olá! Como posso ajudar?" },
      actions: [{ type: "send_message", body: "Olá! Como posso ajudar?" }],
      status: "completed",
      confidence: 0.92,
      errorMessage: null,
      createdAt: "2026-06-23T19:06:00.000Z"
    });

    expect(run.trigger).toBe("automation");
    expect(run.status).toBe("completed");
    expect(run.confidence).toBe(0.92);
    expect(run.actions).toHaveLength(1);
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
        displayName: "Número oficial",
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

  it("defaults old-shape contact boards to non-primary without channels", () => {
    const board = contactBoardSchema.parse({
      id: "board_1",
      workspaceId: "workspace_1",
      name: "Pre-vendas",
      description: null,
      createdAt: "2026-05-21T00:00:00.000Z"
    });

    expect(board.isPrimaryPipeline).toBe(false);
    expect(board.channels).toEqual([]);
  });

  it("defaults old-shape contact board stages to no tag triggers", () => {
    const stage = contactBoardStageSchema.parse({
      id: "stage_1",
      workspaceId: "workspace_1",
      boardId: "board_1",
      name: "Proposta enviada",
      color: "#DFF3EA",
      order: 2
    });

    expect(stage.tagTriggers).toEqual([]);
  });

  it("defaults old-shape board memberships to manual movement metadata", () => {
    const membership = contactBoardMembershipSchema.parse({
      id: "membership_1",
      workspaceId: "workspace_1",
      contactId: "contact_1",
      boardId: "board_1",
      stageId: "stage_1",
      isPrimary: true,
      updatedAt: "2026-05-21T00:00:00.000Z"
    });

    expect(membership.lastMovedBy).toBe("manual");
    expect(membership.lastRuleAppliedAt).toBe(null);
  });

  it("validates enriched contact board data with channels and primary pipeline flag", () => {
    expect(
      contactBoardSchema.parse({
        id: "board_1",
        workspaceId: "workspace_1",
        name: "Vendas",
        description: null,
        isPrimaryPipeline: true,
        channels: [
          {
            id: "channel_1",
            displayName: "WhatsApp Vendas",
            provider: "evolution",
            phoneNumber: "+5511999990000"
          }
        ],
        createdAt: "2026-07-07T12:00:00.000Z"
      })
    ).toMatchObject({
      name: "Vendas",
      isPrimaryPipeline: true,
      channels: [{ id: "channel_1" }]
    });
  });

  it("validates contact board stages with tag triggers", () => {
    expect(
      contactBoardStageSchema.parse({
        id: "stage_1",
        workspaceId: "workspace_1",
        boardId: "board_1",
        name: "Interesse forte",
        color: "#d63a22",
        order: 2,
        tagTriggers: [
          {
            id: "tag_1",
            name: "interesse_forte",
            color: "#d63a22",
            isActive: true
          }
        ]
      })
    ).toMatchObject({
      name: "Interesse forte",
      tagTriggers: [{ name: "interesse_forte" }]
    });
  });

  it("validates board memberships with movement metadata", () => {
    expect(
      contactBoardMembershipSchema.parse({
        id: "membership_1",
        workspaceId: "workspace_1",
        contactId: "contact_1",
        boardId: "board_1",
        stageId: "stage_1",
        isPrimary: true,
        lastMovedBy: "rule",
        lastRuleAppliedAt: "2026-07-07T12:30:00.000Z",
        updatedAt: "2026-07-07T12:31:00.000Z"
      })
    ).toMatchObject({
      lastMovedBy: "rule",
      lastRuleAppliedAt: "2026-07-07T12:30:00.000Z"
    });
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
