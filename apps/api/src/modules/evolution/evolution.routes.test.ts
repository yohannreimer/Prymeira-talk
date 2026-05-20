import Fastify from "fastify";
import { messageSchema } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { evolutionRoutes, isUniqueConstraintError } from "./evolution.routes.js";
import { evolutionWebhookEnvelopeSchema, evolutionWebhookSchema } from "./evolution.schemas.js";

const validWebhookBody = {
  event: "messages.upsert",
  instance: "client-one",
  data: {
    key: { id: "provider_msg_1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "Oi" },
    messageTimestamp: 1779300000
  }
};

function createMockPrisma(overrides: {
  $transaction?: ReturnType<typeof vi.fn>;
  channel?: { findUnique?: ReturnType<typeof vi.fn> };
  contact?: { upsert?: ReturnType<typeof vi.fn> };
  conversation?: {
    upsert?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
  };
  message?: {
    create?: ReturnType<typeof vi.fn>;
  };
} = {}) {
  const prisma = {
    channel: {
      findUnique:
        overrides.channel?.findUnique ??
        vi.fn().mockResolvedValue({
          id: "channel_1",
          workspaceId: "workspace_a",
          provider: "evolution",
          providerKey: "client-one"
        })
    },
    contact: {
      upsert:
        overrides.contact?.upsert ??
        vi.fn().mockResolvedValue({
          id: "contact_1",
          workspaceId: "workspace_a",
          phone: "5511999999999"
        })
    },
    conversation: {
      upsert:
        overrides.conversation?.upsert ??
        vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          lastMessageAt: null
        }),
      update:
        overrides.conversation?.update ??
        vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          lastMessageAt: null
        }),
      updateMany:
        overrides.conversation?.updateMany ??
        vi.fn().mockResolvedValue({
          count: 1
        })
    },
    message: {
      create:
        overrides.message?.create ??
        vi.fn().mockResolvedValue({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: "provider_msg_1",
          direction: "inbound",
          type: "text",
          body: "Oi",
          mediaUrl: null,
          status: "delivered",
          sentByUserId: null,
          createdAt: new Date("2026-05-20T12:00:00.000Z")
        })
    }
  };

  return {
    ...prisma,
    $transaction:
      overrides.$transaction ??
      vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma))
  };
}

async function buildEvolutionApp(prisma = createMockPrisma()) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  await app.register(evolutionRoutes, { webhookSecret: "top_secret" });

  return { app, prisma, publish };
}

describe("Evolution webhook schema", () => {
  it("parses a lightweight webhook envelope before message-specific data", () => {
    const parsed = evolutionWebhookEnvelopeSchema.parse({
      event: "connection.update",
      instance: "client-one",
      data: { state: "open" }
    });

    expect(parsed.event).toBe("connection.update");
  });

  it("normalizes an inbound text message event", () => {
    const parsed = evolutionWebhookSchema.parse(validWebhookBody);

    expect(parsed.data.key.id).toBe("provider_msg_1");
  });
});

describe("Evolution webhook routes", () => {
  it("detects Prisma provider message id unique constraint errors", () => {
    expect(
      isUniqueConstraintError({
        code: "P2002",
        meta: { target: ["workspace_id", "provider_message_id"] }
      })
    ).toBe(true);

    expect(
      isUniqueConstraintError({
        code: "P2002",
        meta: { target: ["workspace_id", "provider_event_id"] }
      })
    ).toBe(true);

    expect(isUniqueConstraintError({ code: "P2002", meta: { target: ["email"] } })).toBe(false);
  });

  it("returns 401 for invalid secrets without touching Prisma", async () => {
    const { app, prisma } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "wrong_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ ok: false, error: "invalid_webhook_secret" });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.contact.upsert).not.toHaveBeenCalled();
      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 401 for duplicate secret headers without touching Prisma", async () => {
    const { app, prisma } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": ["top_secret", "wrong_secret"] },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ ok: false, error: "invalid_webhook_secret" });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("ignores non-message events without touching Prisma", async () => {
    const { app, prisma } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: { ...validWebhookBody, event: "connection.update" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, ignored: true });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("ignores non-message events before parsing message-shaped data", async () => {
    const { app, prisma } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "connection.update",
          instance: "client-one",
          data: { state: "open" }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, ignored: true });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the Evolution channel is missing", async () => {
    const prisma = createMockPrisma({
      channel: { findUnique: vi.fn().mockResolvedValue(null) }
    });
    const { app } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ ok: false, error: "channel_not_found" });
      expect(prisma.channel.findUnique).toHaveBeenCalledWith({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId: "workspace_a",
            provider: "evolution",
            providerKey: "client-one"
          }
        },
        select: { id: true }
      });
    } finally {
      await app.close();
    }
  });

  it("returns ok duplicate without unread increments or publish when message create loses the race", async () => {
    const duplicateError = {
      code: "P2002",
      meta: { target: ["workspace_id", "provider_message_id"] }
    };
    const prisma = createMockPrisma({
      message: {
        create: vi.fn().mockRejectedValue(duplicateError)
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, duplicate: true });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          providerMessageId: "provider_msg_1"
        })
      });
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns ok duplicate without unread increments or publish for duplicate provider events", async () => {
    const duplicateError = {
      code: "P2002",
      meta: { target: ["workspace_id", "provider_event_id"] }
    };
    const prisma = createMockPrisma({
      message: {
        create: vi.fn().mockRejectedValue(duplicateError)
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, duplicate: true });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          providerEventId: "messages.upsert:client-one:provider_msg_1"
        })
      });
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("increments unread without regressing preview when an older inbound message arrives", async () => {
    const currentLastMessageAt = new Date("2026-05-21T12:00:00.000Z");
    const incomingMessageAt = new Date(validWebhookBody.data.messageTimestamp * 1000);
    const prisma = createMockPrisma({
      conversation: {
        upsert: vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          lastMessageAt: currentLastMessageAt
        })
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          createdAt: incomingMessageAt
        })
      });
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: {
          workspaceId_id: {
            workspaceId: "workspace_a",
            id: "conv_1"
          }
        },
        data: {
          unreadCount: { increment: 1 }
        }
      });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "conv_1",
          workspaceId: "workspace_a",
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: incomingMessageAt } }]
        },
        data: {
          lastMessageAt: incomingMessageAt,
          lastMessagePreview: "Oi"
        }
      });
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("ingests a new inbound text event and publishes a workspace-consistent message", async () => {
    const { app, prisma, publish } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.contact.upsert).toHaveBeenCalledWith({
        where: { workspaceId_phone: { workspaceId: "workspace_a", phone: "5511999999999" } },
        create: { workspaceId: "workspace_a", phone: "5511999999999" },
        update: {}
      });
      const timestampDate = new Date(validWebhookBody.data.messageTimestamp * 1000);
      expect(prisma.conversation.upsert).toHaveBeenCalledWith({
        where: {
          workspaceId_channelId_contactId: {
            workspaceId: "workspace_a",
            channelId: "channel_1",
            contactId: "contact_1"
          }
        },
        create: expect.objectContaining({
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          unreadCount: 0
        }),
        update: {}
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: "provider_msg_1",
          providerEventId: "messages.upsert:client-one:provider_msg_1",
          direction: "inbound",
          type: "text",
          body: "Oi",
          status: "delivered",
          createdAt: timestampDate
        })
      });
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: {
          workspaceId_id: {
            workspaceId: "workspace_a",
            id: "conv_1"
          }
        },
        data: {
          unreadCount: { increment: 1 }
        }
      });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "conv_1",
          workspaceId: "workspace_a",
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: timestampDate } }]
        },
        data: {
          lastMessageAt: timestampDate,
          lastMessagePreview: "Oi"
        }
      });

      expect(publish).toHaveBeenCalledWith({
        type: "message.created",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: "provider_msg_1",
          mediaUrl: null,
          sentByUserId: null
        })
      });

      const event = publish.mock.calls[0][0];
      expect(messageSchema.parse(event.payload)).toEqual(event.payload);
    } finally {
      await app.close();
    }
  });
});
