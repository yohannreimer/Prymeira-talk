import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { conversationSchema, messageSchema, realtimeEventSchema } from "@prymeira-talk/shared";
import {
  ConversationActionError,
  ConversationNotFoundError,
  createConversationsService
} from "./conversations.service.js";
import type { PrismaLike } from "./conversations.service.js";
import { conversationsRoutes, createMessageParamsSchema } from "./conversations.routes.js";

type MockPrisma = {
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
          priority: "normal"
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
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
      data: {
        lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
        lastMessagePreview: "Oi"
      }
    });
    expect(conversationSchema.parse(result.conversation)).toEqual(result.conversation);
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

  it("rejects contact notes without a current user identity", async () => {
    const prisma = createMockPrisma();
    const service = createConversationsService(prisma);

    const error = await service
      .runConversationAction({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        action: "add_note",
        body: "Cliente pediu retorno",
        currentClerkUserId: null
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConversationActionError);
    expect(error).toMatchObject({ code: "CURRENT_USER_REQUIRED" });
    expect(prisma.contactNote.create).not.toHaveBeenCalled();
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
