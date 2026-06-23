import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { conversationSchema, messageSchema, realtimeEventSchema } from "@prymeira-talk/shared";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import { MetaClientError } from "../meta/meta.client.js";
import {
  ConversationActionError,
  ConversationNotFoundError,
  OutboundMessageValidationError,
  createConversationsService
} from "./conversations.service.js";
import type { PrismaLike } from "./conversations.service.js";
import { conversationsRoutes, createMessageParamsSchema } from "./conversations.routes.js";

type MockPrisma = {
  integrationConfig: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  conversation: {
    findMany: ReturnType<typeof vi.fn<PrismaLike["conversation"]["findMany"]>>;
    findUnique: ReturnType<typeof vi.fn<PrismaLike["conversation"]["findUnique"]>>;
    update: ReturnType<typeof vi.fn<PrismaLike["conversation"]["update"]>>;
  };
  message: {
    create: ReturnType<typeof vi.fn<PrismaLike["message"]["create"]>>;
    findMany: ReturnType<typeof vi.fn<PrismaLike["message"]["findMany"]>>;
  };
  contactNote: {
    create: ReturnType<typeof vi.fn<PrismaLike["contactNote"]["create"]>>;
    findMany: ReturnType<typeof vi.fn<PrismaLike["contactNote"]["findMany"]>>;
  };
  contactBoardMembership: {
    findFirst: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["findFirst"]>>;
    update: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["update"]>>;
    updateMany: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["updateMany"]>>;
    upsert: ReturnType<typeof vi.fn<PrismaLike["contactBoardMembership"]["upsert"]>>;
  };
  contactBoardStage: {
    findMany: ReturnType<typeof vi.fn<PrismaLike["contactBoardStage"]["findMany"]>>;
    findFirst: ReturnType<typeof vi.fn<PrismaLike["contactBoardStage"]["findFirst"]>>;
  };
  department: {
    findMany: ReturnType<typeof vi.fn<PrismaLike["department"]["findMany"]>>;
    findFirst: ReturnType<typeof vi.fn<PrismaLike["department"]["findFirst"]>>;
  };
  userProfile: {
    findFirst: ReturnType<typeof vi.fn<PrismaLike["userProfile"]["findFirst"]>>;
  };
  tag: {
    upsert: ReturnType<typeof vi.fn<PrismaLike["tag"]["upsert"]>>;
  };
  conversationTag: {
    upsert: ReturnType<typeof vi.fn<PrismaLike["conversationTag"]["upsert"]>>;
    deleteMany: ReturnType<typeof vi.fn<PrismaLike["conversationTag"]["deleteMany"]>>;
  };
  aiAgentSession: {
    update: ReturnType<typeof vi.fn<PrismaLike["aiAgentSession"]["update"]>>;
  };
  aiActionLog: {
    create: ReturnType<typeof vi.fn<PrismaLike["aiActionLog"]["create"]>>;
  };
  crmSyncAction: {
    create: ReturnType<typeof vi.fn<PrismaLike["crmSyncAction"]["create"]>>;
  };
  $transaction: ReturnType<typeof vi.fn<PrismaLike["$transaction"]>>;
};

function createMockPrisma(overrides: {
  findMany?: MockPrisma["conversation"]["findMany"];
  findUnique?: MockPrisma["conversation"]["findUnique"];
  update?: MockPrisma["conversation"]["update"];
  create?: MockPrisma["message"]["create"];
  findMessages?: MockPrisma["message"]["findMany"];
  findNotes?: MockPrisma["contactNote"]["findMany"];
} = {}): MockPrisma {
  let result: MockPrisma;
  result = {
    integrationConfig: {
      findUnique: vi.fn().mockResolvedValue(null)
    },
    conversation: {
      findMany: overrides.findMany ?? vi.fn<PrismaLike["conversation"]["findMany"]>().mockResolvedValue([]),
      findUnique:
        overrides.findUnique ??
        vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
          lastMessagePreview: "Oi",
          unreadCount: 0,
          priority: "normal",
          tags: []
        }),
      update:
        overrides.update ??
        vi.fn<PrismaLike["conversation"]["update"]>().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
          lastMessagePreview: "Oi",
          unreadCount: 0,
          priority: "normal",
          channel: { displayName: "WhatsApp", phoneNumber: "+55 47 99999-0000" },
          contact: { name: "Ana Silva", phone: "5547999990000" },
          department: null,
          assignedUser: null,
          tags: []
        })
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
        }),
      findMany:
        overrides.findMessages ??
        vi.fn<PrismaLike["message"]["findMany"]>().mockResolvedValue([
          {
            id: "msg_1",
            workspaceId: "workspace_a",
            conversationId: "conv_1",
            providerMessageId: null,
            direction: "inbound",
            type: "text",
            body: "Oi",
            mediaUrl: null,
            status: "delivered",
            sentByUserId: null,
            createdAt: new Date("2026-05-20T12:00:00.000Z")
          }
        ])
    },
    contactNote: {
      create: vi.fn<PrismaLike["contactNote"]["create"]>().mockResolvedValue({
        id: "note_1",
        workspaceId: "workspace_a",
        contactId: "contact_1",
        conversationId: "conv_1",
        body: "Cliente pediu retorno",
        createdById: "user_1",
        createdAt: new Date("2026-05-20T12:10:00.000Z"),
        createdBy: { displayName: "Ana" }
      }),
      findMany:
        overrides.findNotes ??
        vi.fn<PrismaLike["contactNote"]["findMany"]>().mockResolvedValue([
          {
            id: "note_1",
            workspaceId: "workspace_a",
            contactId: "contact_1",
            conversationId: "conv_1",
            body: "Cliente pediu retorno",
            createdById: "user_1",
            createdAt: new Date("2026-05-20T12:10:00.000Z"),
            createdBy: { displayName: "Ana" }
          }
        ])
    },
    contactBoardMembership: {
      findFirst: vi.fn<PrismaLike["contactBoardMembership"]["findFirst"]>().mockResolvedValue({
        id: "membership_1",
        workspaceId: "workspace_a",
        contactId: "contact_1",
        boardId: "board_1",
        stageId: "stage_1",
        isPrimary: true,
        updatedAt: new Date("2026-05-20T12:00:00.000Z"),
        board: { name: "Pipeline" },
        stage: { name: "Novo", color: "#24564a" }
      }),
      update: vi.fn<PrismaLike["contactBoardMembership"]["update"]>().mockResolvedValue({
        id: "membership_1",
        workspaceId: "workspace_a",
        contactId: "contact_1",
        boardId: "board_1",
        stageId: "stage_2",
        isPrimary: true,
        updatedAt: new Date("2026-05-20T12:15:00.000Z"),
        board: { name: "Pipeline" },
        stage: { name: "Qualificado", color: "#d29b44" }
      }),
      updateMany: vi.fn<PrismaLike["contactBoardMembership"]["updateMany"]>().mockResolvedValue({ count: 1 }),
      upsert: vi.fn<PrismaLike["contactBoardMembership"]["upsert"]>().mockResolvedValue({
        id: "membership_1",
        workspaceId: "workspace_a",
        contactId: "contact_1",
        boardId: "board_1",
        stageId: "stage_2",
        isPrimary: true,
        updatedAt: new Date("2026-05-20T12:15:00.000Z"),
        board: { name: "Pipeline" },
        stage: { name: "Qualificado", color: "#d29b44" }
      })
    },
    contactBoardStage: {
      findMany: vi.fn<PrismaLike["contactBoardStage"]["findMany"]>().mockResolvedValue([
        {
          id: "stage_1",
          workspaceId: "workspace_a",
          boardId: "board_1",
          name: "Novo",
          color: "#24564a",
          order: 0,
          board: { name: "Pipeline" }
        },
        {
          id: "stage_2",
          workspaceId: "workspace_a",
          boardId: "board_1",
          name: "Qualificado",
          color: "#d29b44",
          order: 1,
          board: { name: "Pipeline" }
        }
      ]),
      findFirst: vi.fn<PrismaLike["contactBoardStage"]["findFirst"]>().mockResolvedValue({
        id: "stage_2",
        workspaceId: "workspace_a",
        boardId: "board_1",
        name: "Qualificado",
        color: "#d29b44",
        order: 1,
        board: { name: "Pipeline" }
      })
    },
    department: {
      findMany: vi.fn<PrismaLike["department"]["findMany"]>().mockResolvedValue([
        { id: "department_1", workspaceId: "workspace_a", name: "Vendas" }
      ]),
      findFirst: vi.fn<PrismaLike["department"]["findFirst"]>().mockResolvedValue({
        id: "department_1",
        workspaceId: "workspace_a",
        name: "Vendas"
      })
    },
    userProfile: {
      findFirst: vi.fn<PrismaLike["userProfile"]["findFirst"]>().mockResolvedValue({
        id: "user_1",
        workspaceId: "workspace_a",
        displayName: "Ana"
      })
    },
    tag: {
      upsert: vi.fn<PrismaLike["tag"]["upsert"]>().mockResolvedValue({
        id: "tag_1",
        name: "VIP",
        color: "#24564a"
      })
    },
    conversationTag: {
      upsert: vi.fn<PrismaLike["conversationTag"]["upsert"]>().mockResolvedValue({}),
      deleteMany: vi.fn<PrismaLike["conversationTag"]["deleteMany"]>().mockResolvedValue({ count: 1 })
    },
    aiAgentSession: {
      update: vi.fn<PrismaLike["aiAgentSession"]["update"]>().mockResolvedValue({})
    },
    aiActionLog: {
      create: vi.fn<PrismaLike["aiActionLog"]["create"]>().mockResolvedValue({
        id: "ai_1",
        status: "completed"
      })
    },
    crmSyncAction: {
      create: vi.fn<PrismaLike["crmSyncAction"]["create"]>().mockResolvedValue({
        id: "crm_1",
        status: "queued"
      })
    },
    $transaction: vi.fn<PrismaLike["$transaction"]>(async (callback) =>
      callback(result)
    )
  };

  return result;
}

describe("conversations service", () => {
  it("filters conversations by workspace id", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    await service.listConversations({ workspaceId: "workspace_a" });

    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace_a",
          status: { in: ["open", "pending"] }
        })
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

    const result = await service.createPendingOutboundMessage({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      body: "Oi",
      sentByUserId: "user_1"
    });

    expect(result.message.workspaceId).toBe("workspace_a");
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          status: "pending"
        })
      })
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
        data: {
          lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
          lastMessagePreview: "Oi"
        },
        include: expect.objectContaining({
          contact: { select: { name: true, phone: true } },
          channel: { select: { displayName: true, phoneNumber: true, provider: true } }
        })
      })
    );
    expect(conversationSchema.parse(result.conversation)).toEqual(result.conversation);
    expect(result.conversation.contactName).toBe("Ana Silva");
    expect(result.conversation.channelName).toBe("WhatsApp");
  });

  it("marks conversations as read with complete contact and channel data", async () => {
    const prisma = createMockPrisma({
      update: vi.fn<PrismaLike["conversation"]["update"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        status: "open",
        assignedUserId: null,
        departmentId: null,
        lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
        lastMessagePreview: "Oi",
        unreadCount: 0,
        priority: "normal",
        channel: { displayName: "WhatsApp", phoneNumber: null },
        contact: { name: "Yohann", phone: "554791396920" },
        department: null,
        assignedUser: null,
        tags: []
      })
    });
    const service = createConversationsService(prisma);

    const conversation = await service.markConversationRead({
      workspaceId: "workspace_a",
      conversationId: "conv_1"
    });

    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
        data: { unreadCount: 0 },
        include: expect.any(Object)
      })
    );
    expect(conversation.unreadCount).toBe(0);
    expect(conversation.contactName).toBe("Yohann");
    expect(conversation.channelName).toBe("WhatsApp");
  });

  it("marks conversations as human controlled", async () => {
    const humanControlledConversation = {
      id: "conv_1",
      workspaceId: "workspace_a",
      channelId: "channel_1",
      contactId: "contact_1",
      status: "open" as const,
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
      lastMessagePreview: "Oi",
      unreadCount: 0,
      priority: "normal" as const,
      aiControlStatus: "human_controlled" as const,
      activeAgentSessionId: null,
      activeAgentSession: null,
      channel: { displayName: "WhatsApp", phoneNumber: null, provider: "evolution" },
      contact: { name: "Yohann", phone: "554791396920" },
      department: null,
      assignedUser: null,
      tags: []
    };
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        contactId: "contact_1",
        activeAgentSessionId: null
      }),
      update: vi.fn<PrismaLike["conversation"]["update"]>().mockResolvedValue(humanControlledConversation)
    });
    const service = createConversationsService(prisma);

    const conversation = await service.updateAiControl({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      status: "human_controlled",
      actorUserId: "00000000-0000-4000-8000-000000000010"
    });

    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
      select: {
        id: true,
        workspaceId: true,
        contactId: true,
        activeAgentSessionId: true
      }
    });
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
        data: expect.objectContaining({
          aiControlStatus: "human_controlled",
          aiControlUpdatedAt: expect.any(Date),
          aiControlUpdatedById: "00000000-0000-4000-8000-000000000010"
        }),
        include: expect.objectContaining({
          activeAgentSession: expect.objectContaining({
            select: expect.objectContaining({
              status: true,
              handoffReason: true
            })
          })
        })
      })
    );
    expect(prisma.aiAgentSession.update).not.toHaveBeenCalled();
    expect(conversation.aiControlStatus).toBe("human_controlled");
  });

  it("pauses the active agent session when assuming human control", async () => {
    const pausedConversation = {
      id: "conv_1",
      workspaceId: "workspace_a",
      channelId: "channel_1",
      contactId: "contact_1",
      status: "open" as const,
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
      lastMessagePreview: "Oi",
      unreadCount: 0,
      priority: "normal" as const,
      aiControlStatus: "human_controlled" as const,
      activeAgentSessionId: "00000000-0000-4000-8000-000000000020",
      activeAgentSession: {
        status: "paused_by_human" as const,
        handoffReason: null,
        agent: { name: "Prymeira Concierge" }
      },
      channel: { displayName: "WhatsApp", phoneNumber: null, provider: "evolution" },
      contact: { name: "Yohann", phone: "554791396920" },
      department: null,
      assignedUser: null,
      tags: []
    };
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        contactId: "contact_1",
        activeAgentSessionId: "00000000-0000-4000-8000-000000000020"
      }),
      update: vi.fn<PrismaLike["conversation"]["update"]>().mockResolvedValue(pausedConversation)
    });
    const service = createConversationsService(prisma);

    const conversation = await service.updateAiControl({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      status: "human_controlled",
      actorUserId: "00000000-0000-4000-8000-000000000010"
    });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.aiAgentSession.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: "00000000-0000-4000-8000-000000000020"
        }
      },
      data: {
        status: "paused_by_human"
      }
    });
    expect(conversation.activeAgentName).toBe("Prymeira Concierge");
    expect(conversation.activeAgentSessionStatus).toBe("paused_by_human");
  });

  it("releases conversations back to agent allowed without running an agent session", async () => {
    const releasedConversation = {
      id: "conv_1",
      workspaceId: "workspace_a",
      channelId: "channel_1",
      contactId: "contact_1",
      status: "open" as const,
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
      lastMessagePreview: "Oi",
      unreadCount: 0,
      priority: "normal" as const,
      aiControlStatus: "agent_allowed" as const,
      activeAgentSessionId: "00000000-0000-4000-8000-000000000020",
      activeAgentSession: {
        status: "paused_by_human" as const,
        handoffReason: null,
        agent: { name: "Prymeira Concierge" }
      },
      channel: { displayName: "WhatsApp", phoneNumber: null, provider: "evolution" },
      contact: { name: "Yohann", phone: "554791396920" },
      department: null,
      assignedUser: null,
      tags: []
    };
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        contactId: "contact_1",
        activeAgentSessionId: "00000000-0000-4000-8000-000000000020"
      }),
      update: vi.fn<PrismaLike["conversation"]["update"]>().mockResolvedValue(releasedConversation)
    });
    const service = createConversationsService(prisma);

    const conversation = await service.updateAiControl({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      status: "agent_allowed",
      actorUserId: "00000000-0000-4000-8000-000000000010"
    });

    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aiControlStatus: "agent_allowed",
          aiControlUpdatedById: "00000000-0000-4000-8000-000000000010"
        })
      })
    );
    expect(prisma.aiAgentSession.update).not.toHaveBeenCalled();
    expect(prisma.aiActionLog.create).not.toHaveBeenCalled();
    expect(conversation.aiControlStatus).toBe("agent_allowed");
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
      select: {
        customerServiceWindowExpiresAt: true,
        id: true,
        channel: { select: { provider: true, providerKey: true } },
        contact: { select: { phone: true } }
      }
    });
  });

  it("sends Meta Cloud text when the customer service window is open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));

    const sendText = vi.fn().mockResolvedValue({
      providerMessageId: "wamid.meta_1",
      raw: { messages: [{ id: "wamid.meta_1" }] }
    });
    const prisma = createMockPrisma({
      findUnique: vi
        .fn<PrismaLike["conversation"]["findUnique"]>()
        .mockResolvedValueOnce({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          customerServiceWindowExpiresAt: new Date("2026-05-20T13:00:00.000Z"),
          channel: { provider: "meta_cloud", providerKey: "meta-channel" },
          contact: { phone: "5547999990000" }
        })
        .mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
          lastMessagePreview: "Oi Meta",
          unreadCount: 0,
          priority: "normal",
          tags: []
        }),
      create: vi.fn<PrismaLike["message"]["create"]>().mockResolvedValue({
        id: "msg_1",
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        providerMessageId: "wamid.meta_1",
        direction: "outbound",
        type: "text",
        body: "Oi Meta",
        mediaUrl: null,
        status: "sent",
        sentByUserId: "user_1",
        createdAt: new Date("2026-05-20T12:00:00.000Z")
      })
    });
    const service = createConversationsService(prisma, {
      meta: {
        phoneNumberId: "phone_number_1",
        client: { sendText }
      }
    });

    try {
      const result = await service.createPendingOutboundMessage({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        body: "Oi Meta",
        sentByUserId: "user_1"
      });

      expect(sendText).toHaveBeenCalledWith({
        phoneNumberId: "phone_number_1",
        to: "5547999990000",
        text: "Oi Meta"
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerMessageId: "wamid.meta_1",
            status: "sent"
          })
        })
      );
      expect(result.message.status).toBe("sent");
      expect(result.message.providerMessageId).toBe("wamid.meta_1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends Meta Cloud via Evolution text when the customer service window is open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));

    const sendText = vi.fn().mockResolvedValue({
      providerMessageId: "evo_text_1",
      raw: { key: { id: "evo_text_1" } }
    });
    const prisma = createMockPrisma({
      findUnique: vi
        .fn<PrismaLike["conversation"]["findUnique"]>()
        .mockResolvedValueOnce({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          customerServiceWindowExpiresAt: new Date("2026-05-20T13:00:00.000Z"),
          channel: { provider: "meta_cloud", providerKey: "official-instance" },
          contact: { phone: "5547999990000" }
        })
        .mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
          lastMessagePreview: "Oi Evolution",
          unreadCount: 0,
          priority: "normal",
          tags: []
        }),
      create: vi.fn<PrismaLike["message"]["create"]>().mockResolvedValue({
        id: "msg_1",
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        providerMessageId: "evo_text_1",
        direction: "outbound",
        type: "text",
        body: "Oi Evolution",
        mediaUrl: null,
        status: "sent",
        sentByUserId: "user_1",
        createdAt: new Date("2026-05-20T12:00:00.000Z")
      })
    });
    const service = createConversationsService(prisma, {
      metaEvolution: {
        client: { sendText }
      }
    });

    try {
      const result = await service.createPendingOutboundMessage({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        body: "Oi Evolution",
        sentByUserId: "user_1"
      });

      expect(sendText).toHaveBeenCalledWith({
        instanceName: "official-instance",
        number: "5547999990000",
        text: "Oi Evolution"
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerMessageId: "evo_text_1",
            status: "sent"
          })
        })
      );
      expect(result.message.status).toBe("sent");
      expect(result.message.providerMessageId).toBe("evo_text_1");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["missing", null],
    ["closed", new Date("2026-05-20T11:59:59.000Z")]
  ])("rejects Meta Cloud text when the customer service window is %s", async (_caseName, expiresAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));

    const sendText = vi.fn();
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        customerServiceWindowExpiresAt: expiresAt,
        channel: { provider: "meta_cloud", providerKey: "meta-channel" },
        contact: { phone: "5547999990000" }
      })
    });
    const service = createConversationsService(prisma, {
      meta: {
        phoneNumberId: "phone_number_1",
        client: { sendText }
      }
    });

    try {
      const error = await service
        .createPendingOutboundMessage({
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          body: "Oi Meta",
          sentByUserId: "user_1"
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OutboundMessageValidationError);
      expect(error).toMatchObject({
        code: "META_SERVICE_WINDOW_CLOSED",
        statusCode: 400
      });
      expect(sendText).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects Meta Cloud text when Meta runtime is not configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));

    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        customerServiceWindowExpiresAt: new Date("2026-05-20T13:00:00.000Z"),
        channel: { provider: "meta_cloud", providerKey: "meta-channel" },
        contact: { phone: "5547999990000" }
      })
    });
    const service = createConversationsService(prisma, {
      meta: {
        phoneNumberId: null,
        client: null
      }
    });

    try {
      const error = await service
        .createPendingOutboundMessage({
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          body: "Oi Meta",
          sentByUserId: "user_1"
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OutboundMessageValidationError);
      expect(error).toMatchObject({
        code: "META_NOT_CONFIGURED",
        statusCode: 400
      });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends outbound text through Evolution in real mode", async () => {
    const sendText = vi.fn().mockResolvedValue({
      providerMessageId: "provider_msg_1",
      raw: { key: { id: "provider_msg_1" } }
    });
    const prisma = createMockPrisma({
      findUnique: vi
        .fn<PrismaLike["conversation"]["findUnique"]>()
        .mockResolvedValueOnce({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          channel: { provider: "evolution", providerKey: "talk-workspace_a-abc" },
          contact: { phone: "5547999990000" }
        })
        .mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
          lastMessagePreview: "Oi real",
          unreadCount: 0,
          priority: "normal",
          tags: []
        }),
      create: vi.fn<PrismaLike["message"]["create"]>().mockResolvedValue({
        id: "msg_1",
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        providerMessageId: "provider_msg_1",
        direction: "outbound",
        type: "text",
        body: "Oi real",
        mediaUrl: null,
        status: "sent",
        sentByUserId: "user_1",
        createdAt: new Date("2026-05-20T12:00:00.000Z")
      })
    });
    const service = createConversationsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "secret",
        publicWebhookUrl: vi.fn(),
        localWebhookUrl: vi.fn(),
        client: {
          createInstance: vi.fn(),
          connectInstance: vi.fn(),
          setWebhook: vi.fn(),
          sendText,
          sendMedia: vi.fn()
        }
      }
    });

    const result = await service.createPendingOutboundMessage({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      body: "Oi real",
      sentByUserId: "user_1"
    });

    expect(sendText).toHaveBeenCalledWith({
      instanceName: "talk-workspace_a-abc",
      number: "5547999990000",
      text: "Oi real"
    });
    expect(result.message.status).toBe("sent");
    expect(result.message.providerMessageId).toBe("provider_msg_1");
  });

  it("sends outbound media through Evolution in real mode", async () => {
    const sendMedia = vi.fn().mockResolvedValue({
      providerMessageId: "provider_media_1",
      raw: { key: { id: "provider_media_1" } }
    });
    const prisma = createMockPrisma({
      findUnique: vi
        .fn<PrismaLike["conversation"]["findUnique"]>()
        .mockResolvedValueOnce({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          channel: { provider: "evolution", providerKey: "talk-workspace_a-abc" },
          contact: { phone: "5547999990000" }
        })
        .mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
          lastMessagePreview: "Comprovante",
          unreadCount: 0,
          priority: "normal",
          tags: []
        }),
      create: vi.fn<PrismaLike["message"]["create"]>().mockResolvedValue({
        id: "msg_1",
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        providerMessageId: "provider_media_1",
        direction: "outbound",
        type: "image",
        body: "Comprovante",
        mediaUrl: "data:image/png;base64,aW1n",
        status: "sent",
        sentByUserId: "user_1",
        createdAt: new Date("2026-05-20T12:00:00.000Z")
      })
    });
    const service = createConversationsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "secret",
        publicWebhookUrl: vi.fn(),
        localWebhookUrl: vi.fn(),
        client: {
          createInstance: vi.fn(),
          connectInstance: vi.fn(),
          setWebhook: vi.fn(),
          sendText: vi.fn(),
          sendMedia
        }
      }
    });

    const result = await service.createPendingOutboundMessage({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      body: "Comprovante",
      attachment: {
        fileName: "foto.png",
        mimetype: "image/png",
        mediaUrl: "data:image/png;base64,aW1n"
      },
      sentByUserId: "user_1"
    });

    expect(sendMedia).toHaveBeenCalledWith({
      instanceName: "talk-workspace_a-abc",
      number: "5547999990000",
      mediatype: "image",
      mimetype: "image/png",
      media: "data:image/png;base64,aW1n",
      fileName: "foto.png",
      caption: "Comprovante"
    });
    expect(result.message.status).toBe("sent");
    expect(result.message.providerMessageId).toBe("provider_media_1");
  });

  it("rejects real Evolution outbound messages when the contact phone is blank", async () => {
    const sendText = vi.fn();
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        channel: { provider: "evolution", providerKey: "talk-workspace_a-abc" },
        contact: { phone: "   " }
      })
    });
    const service = createConversationsService(prisma, {
      evolution: {
        mode: "real",
        webhookSecret: "secret",
        publicWebhookUrl: vi.fn(),
        localWebhookUrl: vi.fn(),
        client: {
          createInstance: vi.fn(),
          connectInstance: vi.fn(),
          setWebhook: vi.fn(),
          sendText,
          sendMedia: vi.fn()
        }
      }
    });

    const error = await service
      .createPendingOutboundMessage({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        body: "Oi real",
        sentByUserId: "user_1"
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: "OUTBOUND_CONTACT_PHONE_REQUIRED",
      statusCode: 400
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
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
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("returns messages that parse as shared message DTOs", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    const result = await service.createPendingOutboundMessage({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      body: "Oi",
      sentByUserId: null
    });

    expect(messageSchema.parse(result.message)).toEqual(result.message);
    expect(result.message).toEqual(
      expect.objectContaining({
        providerMessageId: null,
        mediaUrl: null,
        sentByUserId: null
      })
    );
  });

  it("lists messages inside the caller workspace conversation", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    const messages = await service.listMessages({
      workspaceId: "workspace_a",
      conversationId: "conv_1"
    });

    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
      select: { id: true }
    });
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        conversationId: "conv_1"
      },
      orderBy: { createdAt: "asc" },
      take: 100
    });
    expect(messageSchema.array().parse(messages)).toEqual(messages);
  });

  it("rejects message listing for missing conversations", async () => {
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue(null)
    });
    const service = createConversationsService(prisma);

    const error = await service
      .listMessages({
        workspaceId: "workspace_a",
        conversationId: "conv_1"
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConversationNotFoundError);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("returns contact context with primary board stage, tags and notes", async () => {
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
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
        tags: [{ tag: { id: "tag_1", name: "VIP", color: "#24564a" } }]
      })
    });
    const service = createConversationsService(prisma);

    const context = await service.getContactContext({
      workspaceId: "workspace_a",
      conversationId: "conv_1"
    });

    expect(context.primaryBoardStage).toEqual(
      expect.objectContaining({
        membershipId: "membership_1",
        stageName: "Novo",
        boardName: "Pipeline"
      })
    );
    expect(context.tags).toEqual([{ id: "tag_1", name: "VIP", color: "#24564a" }]);
    expect(context.notes).toEqual([
      expect.objectContaining({
        id: "note_1",
        body: "Cliente pediu retorno",
        createdByName: "Ana"
      })
    ]);
  });

  it("adds contact notes and returns refreshed context", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    const result = await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "add_note",
      body: "Cliente pediu retorno",
      currentClerkUserId: "clerk_user_1"
    });

    expect(prisma.contactNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          contactId: "contact_1",
          conversationId: "conv_1",
          body: "Cliente pediu retorno",
          createdById: "user_1"
        })
      })
    );
    expect(result.context.notes[0]?.body).toBe("Cliente pediu retorno");
  });

  it("creates contact notes without a current user identity as a system note", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    const result = await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "add_note",
      body: "Cliente pediu retorno",
      currentClerkUserId: null
    });

    expect(prisma.userProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.contactNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          body: "Cliente pediu retorno",
          createdById: null
        })
      })
    );
    expect(result.context.notes[0]?.body).toBe("Cliente pediu retorno");
  });

  it("creates contact notes as the current user even when another agent owns the conversation", async () => {
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        status: "open",
        assignedUserId: "other_user",
        departmentId: null,
        lastMessageAt: null,
        lastMessagePreview: null,
        unreadCount: 0,
        priority: "normal",
        tags: []
      })
    });
    const service = createConversationsService(prisma);

    await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "add_note",
      body: "Nota do atendente atual",
      currentClerkUserId: "clerk_user_1"
    });

    expect(prisma.contactNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          createdById: "user_1"
        })
      })
    );
  });

  it("updates assignment, department, priority and board stage through quick actions", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "assign_current_user",
      currentClerkUserId: "clerk_user_1"
    });
    await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "change_department",
      departmentId: "department_1"
    });
    await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "change_priority",
      priority: "high"
    });
    await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "change_primary_board_stage",
      stageId: "stage_2"
    });

    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assignedUserId: "user_1" })
      })
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ departmentId: "department_1" })
      })
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: "high" })
      })
    );
    expect(prisma.contactBoardMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ stageId: "stage_2", isPrimary: true })
      })
    );
  });

  it("closes a conversation through quick actions", async () => {
    const openConversation = {
      id: "conv_1",
      workspaceId: "workspace_a",
      channelId: "channel_1",
      contactId: "contact_1",
      status: "open" as const,
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
      lastMessagePreview: "Oi",
      unreadCount: 3,
      priority: "normal" as const,
      tags: []
    };
    const closedConversation = {
      ...openConversation,
      status: "closed" as const,
      unreadCount: 0,
      channel: { displayName: "WhatsApp", phoneNumber: "+55 47 99999-0000" },
      contact: { name: "Ana Silva", phone: "5547999990000" },
      department: null,
      assignedUser: null
    };
    const prisma = createMockPrisma({
      findUnique: vi
        .fn<PrismaLike["conversation"]["findUnique"]>()
        .mockResolvedValueOnce(openConversation)
        .mockResolvedValueOnce(closedConversation),
      update: vi.fn<PrismaLike["conversation"]["update"]>().mockResolvedValue(closedConversation)
    });
    const service = createConversationsService(prisma);

    const result = await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "close_conversation"
    });

    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
        data: {
          status: "closed",
          unreadCount: 0
        }
      })
    );
    expect(result.conversation.status).toBe("closed");
    expect(result.conversation.unreadCount).toBe(0);
  });

  it("rejects assigning without a current user identity", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    const error = await service
      .runConversationAction({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        action: "assign_current_user",
        currentClerkUserId: null
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConversationActionError);
    expect(error).toMatchObject({ code: "CURRENT_USER_REQUIRED" });
    expect(prisma.userProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("rejects assigning when the current Clerk user has no workspace profile", async () => {
    const prisma = createMockPrisma();
    prisma.userProfile.findFirst.mockResolvedValueOnce(null);
    const service = createConversationsService(prisma);

    const error = await service
      .runConversationAction({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        action: "assign_current_user",
        currentClerkUserId: "missing_clerk_user"
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConversationActionError);
    expect(error).toMatchObject({ code: "CURRENT_USER_NOT_FOUND" });
    expect(prisma.userProfile.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a", clerkUserId: "missing_clerk_user" }
    });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("rejects department changes when the department is missing in the workspace", async () => {
    const prisma = createMockPrisma();
    prisma.department.findFirst.mockResolvedValueOnce(null);
    const service = createConversationsService(prisma);

    const error = await service
      .runConversationAction({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        action: "change_department",
        departmentId: "missing_department"
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConversationActionError);
    expect(error).toMatchObject({ code: "DEPARTMENT_NOT_FOUND" });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("changes primary board stage in a transaction and creates missing memberships", async () => {
    const prisma = createMockPrisma();
    prisma.contactBoardMembership.findFirst.mockResolvedValueOnce(null);
    const service = createConversationsService(prisma);

    await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "change_primary_board_stage",
      stageId: "stage_2"
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.contactBoardMembership.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        contactId: "contact_1",
        isPrimary: true
      },
      data: { isPrimary: false }
    });
    expect(prisma.contactBoardMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_contactId_boardId: {
            workspaceId: "workspace_a",
            contactId: "contact_1",
            boardId: "board_1"
          }
        },
        create: expect.objectContaining({
          workspaceId: "workspace_a",
          contactId: "contact_1",
          boardId: "board_1",
          stageId: "stage_2",
          isPrimary: true
        }),
        update: expect.objectContaining({
          stageId: "stage_2",
          isPrimary: true
        })
      })
    );
  });

  it("adds and removes conversation tags", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "add_tag",
      name: " VIP "
    });
    await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "remove_tag",
      tagId: "tag_1"
    });

    expect(prisma.tag.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_name: {
          workspaceId: "workspace_a",
          name: "VIP"
        }
      },
      create: {
        workspaceId: "workspace_a",
        name: "VIP",
        color: "#24564a"
      },
      update: {}
    });
    expect(prisma.conversationTag.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_conversationId_tagId: {
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          tagId: "tag_1"
        }
      },
      create: {
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        tagId: "tag_1"
      },
      update: {}
    });
    expect(prisma.conversationTag.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        tagId: "tag_1"
      }
    });
  });

  it("logs simulated AI suggestions and CRM notes", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    const aiResult = await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "request_ai_suggestion"
    });
    const crmResult = await service.runConversationAction({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      action: "create_crm_note"
    });

    expect(prisma.aiActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          contactId: "contact_1",
          actionType: "reply_suggestion",
          mode: "simulated"
        })
      })
    );
    expect(aiResult.aiSuggestion).toContain("Sugestao");
    expect(prisma.crmSyncAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          contactId: "contact_1",
          actionType: "create_note",
          mode: "simulated"
        })
      })
    );
    expect(crmResult.crmAction?.status).toBe("queued");
  });
});

describe("conversation routes", () => {
  it("returns outbound messages and publishes message plus conversation updates once", async () => {
    const prisma = createMockPrisma();
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/messages",
        payload: { body: "Oi" }
      });

      expect(response.statusCode).toBe(201);
      expect(messageSchema.parse(response.json())).toEqual(response.json());
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenNthCalledWith(1, {
        type: "message.created",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          body: "Oi"
        })
      });
      expect(publish).toHaveBeenNthCalledWith(2, {
        type: "conversation.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: "conv_1",
          workspaceId: "workspace_a",
          lastMessagePreview: "Oi"
        })
      });
      for (const [event] of publish.mock.calls) {
        expect(realtimeEventSchema.parse(event)).toEqual(event);
      }
    } finally {
      await app.close();
    }
  });

  it("marks a conversation as read and publishes the updated conversation", async () => {
    const prisma = createMockPrisma();
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/read"
      });

      expect(response.statusCode).toBe(200);
      expect(conversationSchema.parse(response.json())).toEqual(response.json());
      expect(publish).toHaveBeenCalledWith({
        type: "conversation.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          unreadCount: 0,
          contactName: "Ana Silva",
          channelName: "WhatsApp"
        })
      });
    } finally {
      await app.close();
    }
  });

  it("maps outbound validation errors to a 400 response", async () => {
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        channel: { provider: "evolution", providerKey: "talk-workspace_a-abc" },
        contact: { phone: "" }
      })
    });
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes, {
      evolution: {
        mode: "real",
        webhookSecret: "secret",
        publicWebhookUrl: vi.fn(),
        localWebhookUrl: vi.fn(),
        client: {
          createInstance: vi.fn(),
          connectInstance: vi.fn(),
          setWebhook: vi.fn(),
          sendText: vi.fn(),
          sendMedia: vi.fn()
        }
      }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/messages",
        payload: { body: "Oi" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: "OUTBOUND_CONTACT_PHONE_REQUIRED",
        error: "Contact phone is required to send an Evolution message."
      });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps Meta service window errors to a 400 response", async () => {
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        customerServiceWindowExpiresAt: null,
        channel: { provider: "meta_cloud", providerKey: "meta-channel" },
        contact: { phone: "5547999990000" }
      })
    });
    prisma.integrationConfig.findUnique.mockResolvedValue({
      mode: "real",
      status: "connected",
      settings: {
        enabled: true,
        wabaId: "waba_1",
        phoneNumberId: "phone_number_1",
        accessToken: "meta_access_token"
      }
    });
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/messages",
        payload: { body: "Oi" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: "META_SERVICE_WINDOW_CLOSED",
        error: "The Meta customer service window is closed. An approved Meta template is required."
      });
      expect(prisma.integrationConfig.findUnique).toHaveBeenCalledWith({
        where: {
          workspaceId_provider: {
            workspaceId: "workspace_a",
            provider: "meta_cloud"
          }
        }
      });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps Meta provider send failures to a 502 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new MetaClientError(400, { error: { message: "outside policy" } }))
    );

    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        customerServiceWindowExpiresAt: new Date("2999-05-20T13:00:00.000Z"),
        channel: { provider: "meta_cloud", providerKey: "meta-channel" },
        contact: { phone: "5547999990000" }
      })
    });
    prisma.integrationConfig.findUnique.mockResolvedValue({
      mode: "real",
      status: "connected",
      settings: {
        enabled: true,
        wabaId: "waba_1",
        phoneNumberId: "phone_number_1",
        accessToken: "meta_access_token"
      }
    });
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/messages",
        payload: { body: "Oi" }
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        code: "META_SEND_FAILED",
        error: "Meta did not accept the outbound message."
      });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it("maps Evolution provider send failures to a 502 response", async () => {
    const sendText = vi.fn().mockRejectedValue(new EvolutionClientError(503, { error: "down" }));
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        channel: { provider: "evolution", providerKey: "talk-workspace_a-abc" },
        contact: { phone: "5547999990000" }
      })
    });
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes, {
      evolution: {
        mode: "real",
        webhookSecret: "secret",
        publicWebhookUrl: vi.fn(),
        localWebhookUrl: vi.fn(),
        client: { createInstance: vi.fn(), connectInstance: vi.fn(), setWebhook: vi.fn(), sendText, sendMedia: vi.fn() }
      }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/messages",
        payload: { body: "Oi" }
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        code: "EVOLUTION_SEND_FAILED",
        error: "Evolution did not accept the outbound message."
      });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns messages for a workspace conversation", async () => {
    const prisma = createMockPrisma();
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/conversations/00000000-0000-4000-8000-000000000001/messages"
      });

      expect(response.statusCode).toBe(200);
      expect(messageSchema.array().parse(response.json())).toEqual(response.json());
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns contact context for a conversation", async () => {
    const prisma = createMockPrisma();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish: vi.fn(), addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/conversations/00000000-0000-4000-8000-000000000001/context"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          primaryBoardStage: expect.objectContaining({ stageName: "Novo" }),
          tags: [],
          notes: expect.any(Array)
        })
      );
    } finally {
      await app.close();
    }
  });

  it("runs quick actions and publishes conversation updates", async () => {
    const prisma = createMockPrisma();
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/actions",
        payload: { action: "change_priority", priority: "high" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          conversation: expect.objectContaining({ id: "conv_1" }),
          context: expect.objectContaining({ notes: expect.any(Array) })
        })
      );
      expect(publish).toHaveBeenCalledWith({
        type: "conversation.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({ id: "conv_1" })
      });
    } finally {
      await app.close();
    }
  });

  it("assumes AI control through the actions route and publishes conversation updates", async () => {
    const humanControlledConversation = {
      id: "conv_1",
      workspaceId: "workspace_a",
      channelId: "channel_1",
      contactId: "contact_1",
      status: "open" as const,
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
      lastMessagePreview: "Oi",
      unreadCount: 0,
      priority: "normal" as const,
      aiControlStatus: "human_controlled" as const,
      activeAgentSessionId: null,
      activeAgentSession: null,
      channel: { displayName: "WhatsApp", phoneNumber: "+55 47 99999-0000", provider: "evolution" },
      contact: { name: "Ana Silva", phone: "5547999990000" },
      department: null,
      assignedUser: null,
      tags: []
    };
    const prisma = createMockPrisma({
      findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        status: "open",
        assignedUserId: null,
        departmentId: null,
        lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
        lastMessagePreview: "Oi",
        unreadCount: 0,
        priority: "normal",
        activeAgentSessionId: null,
        tags: []
      }),
      update: vi.fn<PrismaLike["conversation"]["update"]>().mockResolvedValue(humanControlledConversation)
    });
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/actions",
        payload: { action: "assume_ai_control" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          conversation: expect.objectContaining({
            id: "conv_1",
            aiControlStatus: "human_controlled"
          }),
          context: expect.objectContaining({ notes: expect.any(Array) })
        })
      );
      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            aiControlStatus: "human_controlled"
          })
        })
      );
      expect(publish).toHaveBeenCalledWith({
        type: "conversation.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: "conv_1",
          aiControlStatus: "human_controlled"
        })
      });
    } finally {
      await app.close();
    }
  });

  it("publishes board membership updates when changing a board stage from atendimento", async () => {
    const prisma = createMockPrisma();
    const publish = vi.fn();
    const app = Fastify({ logger: false });
    const requestedStageId = "00000000-0000-4000-8000-000000000002";

    prisma.contactBoardStage.findFirst.mockResolvedValueOnce({
      id: requestedStageId,
      workspaceId: "workspace_a",
      boardId: "board_1",
      name: "Qualificado",
      color: "#d29b44",
      order: 1,
      board: { name: "Pipeline" }
    });
    prisma.contactBoardMembership.upsert.mockResolvedValueOnce({
      id: "membership_1",
      workspaceId: "workspace_a",
      contactId: "contact_1",
      boardId: "board_1",
      stageId: requestedStageId,
      isPrimary: true,
      updatedAt: new Date("2026-05-20T12:15:00.000Z"),
      board: { name: "Pipeline" },
      stage: { name: "Qualificado", color: "#d29b44" }
    });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/actions",
        payload: {
          action: "change_primary_board_stage",
          stageId: requestedStageId
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          boardMembership: expect.objectContaining({
            id: "membership_1",
            workspaceId: "workspace_a",
            contactId: "contact_1",
            boardId: "board_1",
            stageId: requestedStageId,
            isPrimary: true
          })
        })
      );
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenNthCalledWith(1, {
        type: "conversation.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({ id: "conv_1" })
      });
      expect(publish).toHaveBeenNthCalledWith(2, {
        type: "board_membership.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: "membership_1",
          workspaceId: "workspace_a",
          contactId: "contact_1",
          stageId: requestedStageId
        })
      });
      for (const [event] of publish.mock.calls) {
        expect(realtimeEventSchema.parse(event)).toEqual(event);
      }
    } finally {
      await app.close();
    }
  });

  it("returns a controlled error when assigning without a current Clerk subject", async () => {
    const prisma = createMockPrisma();
    const publish = vi.fn();
    const app = Fastify({ logger: false });

    app.decorate("prisma", prisma as never);
    app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "agent" };
    });
    await app.register(conversationsRoutes);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/conversations/00000000-0000-4000-8000-000000000001/actions",
        payload: { action: "assign_current_user" }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: "CURRENT_USER_REQUIRED",
        error: "Current user identity is required for assignment."
      });
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
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
