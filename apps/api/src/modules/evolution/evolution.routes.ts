import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { evolutionWebhookSchema } from "./evolution.schemas.js";

export interface EvolutionRoutesOptions {
  webhookSecret: string;
}

const evolutionWebhookParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

function extractPhone(remoteJid: string) {
  return remoteJid.split("@")[0] ?? remoteJid;
}

export const evolutionRoutes: FastifyPluginAsync<EvolutionRoutesOptions> = async (
  app,
  options
) => {
  app.post("/webhooks/evolution/:workspaceId", async (request, reply) => {
    if (request.headers["x-prymeira-talk-secret"] !== options.webhookSecret) {
      return reply.code(401).send({ ok: false, error: "invalid_webhook_secret" });
    }

    const params = evolutionWebhookParamsSchema.safeParse(request.params);
    const body = evolutionWebhookSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_webhook_payload" });
    }

    const payload = body.data;
    if (payload.event !== "messages.upsert") {
      return { ok: true, ignored: true };
    }

    const channel = await app.prisma.channel.findUnique({
      where: {
        workspaceId_provider_providerKey: {
          workspaceId: params.data.workspaceId,
          provider: "evolution",
          providerKey: payload.instance
        }
      },
      select: { id: true }
    });

    if (!channel) {
      return reply.code(404).send({ ok: false, error: "channel_not_found" });
    }

    const existingMessage = await app.prisma.message.findUnique({
      where: {
        workspaceId_providerMessageId: {
          workspaceId: params.data.workspaceId,
          providerMessageId: payload.data.key.id
        }
      },
      select: { id: true }
    });

    if (existingMessage) {
      return { ok: true, duplicate: true };
    }

    const phone = extractPhone(payload.data.key.remoteJid);
    const messageBody = payload.data.message?.conversation ?? null;
    const receivedAt = new Date();

    const contact = await app.prisma.contact.upsert({
      where: {
        workspaceId_phone: {
          workspaceId: params.data.workspaceId,
          phone
        }
      },
      create: {
        workspaceId: params.data.workspaceId,
        phone
      },
      update: {}
    });

    const conversation = await app.prisma.conversation.upsert({
      where: {
        workspaceId_channelId_contactId: {
          workspaceId: params.data.workspaceId,
          channelId: channel.id,
          contactId: contact.id
        }
      },
      create: {
        workspaceId: params.data.workspaceId,
        channelId: channel.id,
        contactId: contact.id,
        status: "open",
        lastMessageAt: receivedAt,
        lastMessagePreview: messageBody,
        unreadCount: payload.data.key.fromMe ? 0 : 1
      },
      update: {
        lastMessageAt: receivedAt,
        lastMessagePreview: messageBody,
        unreadCount: payload.data.key.fromMe ? undefined : { increment: 1 }
      }
    });

    const message = await app.prisma.message.upsert({
      where: {
        workspaceId_providerMessageId: {
          workspaceId: params.data.workspaceId,
          providerMessageId: payload.data.key.id
        }
      },
      create: {
        workspaceId: params.data.workspaceId,
        conversationId: conversation.id,
        providerMessageId: payload.data.key.id,
        providerEventId: `${payload.event}:${payload.instance}:${payload.data.key.id}`,
        direction: payload.data.key.fromMe ? "outbound" : "inbound",
        type: "text",
        body: messageBody,
        status: payload.data.key.fromMe ? "sent" : "delivered"
      },
      update: {}
    });

    app.realtime.publish({
      type: "message.created",
      workspaceId: params.data.workspaceId,
      payload: {
        id: message.id,
        workspaceId: message.workspaceId,
        conversationId: message.conversationId,
        providerMessageId: message.providerMessageId ?? null,
        direction: message.direction,
        type: message.type,
        body: message.body,
        mediaUrl: message.mediaUrl ?? null,
        status: message.status,
        sentByUserId: message.sentByUserId ?? null,
        createdAt: message.createdAt.toISOString()
      }
    });

    return { ok: true };
  });
};
