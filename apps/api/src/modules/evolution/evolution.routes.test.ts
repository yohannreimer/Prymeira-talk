import Fastify from "fastify";
import { messageSchema } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { evolutionRoutes } from "./evolution.routes.js";
import { evolutionWebhookSchema } from "./evolution.schemas.js";

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
  channel?: { findUnique?: ReturnType<typeof vi.fn> };
  contact?: { upsert?: ReturnType<typeof vi.fn> };
  conversation?: { upsert?: ReturnType<typeof vi.fn> };
  message?: {
    findUnique?: ReturnType<typeof vi.fn>;
    upsert?: ReturnType<typeof vi.fn>;
  };
} = {}) {
  return {
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
          contactId: "contact_1"
        })
    },
    message: {
      findUnique: overrides.message?.findUnique ?? vi.fn().mockResolvedValue(null),
      upsert:
        overrides.message?.upsert ??
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
  it("normalizes an inbound text message event", () => {
    const parsed = evolutionWebhookSchema.parse(validWebhookBody);

    expect(parsed.data.key.id).toBe("provider_msg_1");
  });
});

describe("Evolution webhook routes", () => {
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
      expect(prisma.message.upsert).not.toHaveBeenCalled();
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

  it("returns ok duplicate without unread increments or publish for duplicate provider messages", async () => {
    const prisma = createMockPrisma({
      message: {
        findUnique: vi.fn().mockResolvedValue({ id: "msg_existing" })
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
      expect(prisma.message.findUnique).toHaveBeenCalledWith({
        where: {
          workspaceId_providerMessageId: {
            workspaceId: "workspace_a",
            providerMessageId: "provider_msg_1"
          }
        },
        select: { id: true }
      });
      expect(prisma.contact.upsert).not.toHaveBeenCalled();
      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      expect(prisma.message.upsert).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
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
          lastMessagePreview: "Oi",
          unreadCount: 1
        }),
        update: expect.objectContaining({
          lastMessagePreview: "Oi",
          unreadCount: { increment: 1 }
        })
      });
      expect(prisma.message.upsert).toHaveBeenCalledWith({
        where: {
          workspaceId_providerMessageId: {
            workspaceId: "workspace_a",
            providerMessageId: "provider_msg_1"
          }
        },
        create: expect.objectContaining({
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: "provider_msg_1",
          providerEventId: "messages.upsert:client-one:provider_msg_1",
          direction: "inbound",
          type: "text",
          body: "Oi",
          status: "delivered"
        }),
        update: {}
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
