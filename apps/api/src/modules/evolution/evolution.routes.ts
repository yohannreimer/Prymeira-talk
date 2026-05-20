import type { FastifyPluginAsync } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { toConversationDto, toMessageDto } from "../conversations/conversations.service.js";
import { evolutionWebhookEnvelopeSchema, evolutionWebhookSchema } from "./evolution.schemas.js";

export interface EvolutionRoutesOptions {
  webhookSecret: string;
}

const evolutionWebhookParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

function extractPhone(remoteJid: string) {
  return remoteJid.split("@")[0] ?? remoteJid;
}

function normalizeHeaderValue(header: string | string[] | undefined) {
  if (Array.isArray(header)) {
    return header.length === 1 ? header[0] : undefined;
  }

  return header;
}

function hasValidWebhookSecret(header: string | string[] | undefined, expectedSecret: string) {
  const actualSecret = normalizeHeaderValue(header);

  if (!actualSecret || !expectedSecret) {
    return false;
  }

  const actual = createHash("sha256").update(actualSecret).digest();
  const expected = createHash("sha256").update(expectedSecret).digest();

  return timingSafeEqual(actual, expected);
}

export function isUniqueConstraintError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") {
    return false;
  }

  const target = candidate.meta?.target;
  const targetFields = Array.isArray(target)
    ? target.map(String)
    : typeof target === "string"
      ? [target]
      : [];

  return targetFields.some(
    (field) =>
      field.includes("providerMessageId") ||
      field.includes("provider_message_id") ||
      field.includes("providerEventId") ||
      field.includes("provider_event_id")
  );
}

export const evolutionRoutes: FastifyPluginAsync<EvolutionRoutesOptions> = async (
  app,
  options
) => {
  app.post("/webhooks/evolution/:workspaceId", async (request, reply) => {
    if (!hasValidWebhookSecret(request.headers["x-prymeira-talk-secret"], options.webhookSecret)) {
      return reply.code(401).send({ ok: false, error: "invalid_webhook_secret" });
    }

    const params = evolutionWebhookParamsSchema.safeParse(request.params);
    const envelope = evolutionWebhookEnvelopeSchema.safeParse(request.body);

    if (!params.success || !envelope.success) {
      return reply.code(400).send({ ok: false, error: "invalid_webhook_payload" });
    }

    if (envelope.data.event !== "messages.upsert") {
      return { ok: true, ignored: true };
    }

    const body = evolutionWebhookSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_webhook_payload" });
    }

    const payload = body.data;
    const workspaceId = params.data.workspaceId;
    const phone = extractPhone(payload.data.key.remoteJid);
    const messageBody = payload.data.message?.conversation ?? null;
    const receivedAt =
      typeof payload.data.messageTimestamp === "number"
        ? new Date(payload.data.messageTimestamp * 1000)
        : new Date();

    try {
      const transactionResult = await app.prisma.$transaction(async (tx) => {
        const channel = await tx.channel.findUnique({
          where: {
            workspaceId_provider_providerKey: {
              workspaceId,
              provider: "evolution",
              providerKey: payload.instance
            }
          },
          select: { id: true }
        });

        if (!channel) {
          return { kind: "channel_not_found" as const };
        }

        const contact = await tx.contact.upsert({
          where: {
            workspaceId_phone: {
              workspaceId,
              phone
            }
          },
          create: {
            workspaceId,
            phone
          },
          update: {}
        });

        const conversation = await tx.conversation.upsert({
          where: {
            workspaceId_channelId_contactId: {
              workspaceId,
              channelId: channel.id,
              contactId: contact.id
            }
          },
          create: {
            workspaceId,
            channelId: channel.id,
            contactId: contact.id,
            status: "open",
            unreadCount: 0
          },
          update: {}
        });

        const message = await tx.message.create({
          data: {
            workspaceId,
            conversationId: conversation.id,
            providerMessageId: payload.data.key.id,
            providerEventId: `${payload.event}:${payload.instance}:${payload.data.key.id}`,
            direction: payload.data.key.fromMe ? "outbound" : "inbound",
            type: "text",
            body: messageBody,
            status: payload.data.key.fromMe ? "sent" : "delivered",
            createdAt: receivedAt
          }
        });

        if (!payload.data.key.fromMe) {
          await tx.conversation.update({
            where: {
              workspaceId_id: {
                workspaceId,
                id: conversation.id
              }
            },
            data: {
              unreadCount: { increment: 1 }
            }
          });
        }

        await tx.conversation.updateMany({
          where: {
            id: conversation.id,
            workspaceId,
            OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: receivedAt } }]
          },
          data: {
            lastMessageAt: receivedAt,
            lastMessagePreview: messageBody
          }
        });

        const updatedConversation = await tx.conversation.findUnique({
          where: {
            workspaceId_id: {
              workspaceId,
              id: conversation.id
            }
          }
        });

        if (!updatedConversation) {
          throw new Error("Conversation disappeared during Evolution webhook ingestion.");
        }

        return { kind: "created" as const, message, conversation: updatedConversation };
      });

      if (transactionResult.kind === "channel_not_found") {
        return reply.code(404).send({ ok: false, error: "channel_not_found" });
      }

      const { message, conversation } = transactionResult;
      app.realtime.publish({
        type: "message.created",
        workspaceId,
        payload: toMessageDto(message)
      });
      app.realtime.publish({
        type: "conversation.updated",
        workspaceId,
        payload: toConversationDto(conversation)
      });

      return { ok: true };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { ok: true, duplicate: true };
      }

      throw error;
    }
  });
};
