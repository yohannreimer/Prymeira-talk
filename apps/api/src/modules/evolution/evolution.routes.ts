import type { FastifyPluginAsync } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ChannelDto, MessageDto } from "@prymeira-talk/shared";
import { z } from "zod";
import { toChannelDto } from "../channels/channels.service.js";
import { toConversationDto, toMessageDto } from "../conversations/conversations.service.js";
import {
  evolutionConnectionUpdateSchema,
  evolutionMessageStatusUpdateSchema,
  evolutionQrUpdateSchema,
  evolutionWebhookEnvelopeSchema,
  evolutionWebhookSchema
} from "./evolution.schemas.js";

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

function normalizeEvolutionEvent(event: string) {
  return event.toLowerCase().replace(/_/g, ".");
}

function mapConnectionState(state: string | undefined): ChannelDto["status"] {
  if (state === "open" || state === "connected") return "connected";
  if (state === "connecting") return "connecting";
  if (state === "close" || state === "closed" || state === "disconnected") return "disconnected";
  return "failed";
}

function mapEvolutionMessageStatus(status: string | number | undefined): MessageDto["status"] | null {
  const normalized = String(status ?? "").toLowerCase();
  if (["read", "played"].includes(normalized) || normalized === "4") return "read";
  if (["delivered", "delivery_ack"].includes(normalized) || normalized === "3") return "delivered";
  if (["sent", "server_ack", "sended"].includes(normalized) || normalized === "2") return "sent";
  if (["pending", "queued"].includes(normalized) || normalized === "1") return "pending";
  if (["failed", "error"].includes(normalized)) return "failed";
  return null;
}

function readStringPath(data: unknown, path: string[]) {
  let current = data;

  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return null;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" && current.length > 0 ? current : null;
}

function extractPushName(data: unknown) {
  const candidates = [
    readStringPath(data, ["pushName"]),
    readStringPath(data, ["data", "pushName"]),
    readStringPath(data, ["key", "pushName"]),
    readStringPath(data, ["data", "key", "pushName"])
  ];

  return candidates.find((value) => value && value.trim().length > 0)?.trim() ?? null;
}

function extractQrCode(data: unknown) {
  return (
    readStringPath(data, ["qrcode", "code"]) ??
    readStringPath(data, ["qrcode", "base64"]) ??
    readStringPath(data, ["qrCode"]) ??
    readStringPath(data, ["code"]) ??
    readStringPath(data, ["base64"])
  );
}

function qrExpiresAt() {
  return new Date(Date.now() + 5 * 60_000).toISOString();
}

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
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

    const normalizedEvent = normalizeEvolutionEvent(envelope.data.event);
    const workspaceId = params.data.workspaceId;

    if (normalizedEvent === "connection.update") {
      const body = evolutionConnectionUpdateSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: "invalid_webhook_payload" });
      }

      const state = body.data.data?.state ?? body.data.data?.status;
      const channel = await app.prisma.channel.update({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId,
            provider: "evolution",
            providerKey: body.data.instance
          }
        },
        data: { status: mapConnectionState(state) }
      }).catch((error: unknown) => {
        if (isPrismaKnownRequestErrorCode(error, "P2025")) {
          return null;
        }

        throw error;
      });

      if (!channel) {
        return reply.code(404).send({ ok: false, error: "channel_not_found" });
      }

      app.realtime.publish({
        type: "channel.updated",
        workspaceId,
        payload: toChannelDto(channel)
      });

      return { ok: true };
    }

    if (normalizedEvent === "qrcode.updated") {
      const body = evolutionQrUpdateSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: "invalid_webhook_payload" });
      }

      const qrCode = extractQrCode(body.data.data);
      if (!qrCode) {
        return { ok: true, ignored: true };
      }

      const channel = await app.prisma.channel.update({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId,
            provider: "evolution",
            providerKey: body.data.instance
          }
        },
        data: { status: "connecting" }
      }).catch((error: unknown) => {
        if (isPrismaKnownRequestErrorCode(error, "P2025")) {
          return null;
        }

        throw error;
      });

      if (!channel) {
        return reply.code(404).send({ ok: false, error: "channel_not_found" });
      }

      app.realtime.publish({
        type: "channel.updated",
        workspaceId,
        payload: toChannelDto(channel)
      });
      app.realtime.publish({
        type: "channel.qr_updated",
        workspaceId,
        payload: {
          channelId: channel.id,
          qrCode,
          expiresAt: qrExpiresAt()
        }
      });

      return { ok: true };
    }

    if (normalizedEvent === "messages.update" || normalizedEvent === "send.message") {
      const body = evolutionMessageStatusUpdateSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: "invalid_webhook_payload" });
      }

      const providerMessageId = body.data.data?.key?.id ?? body.data.data?.messageId ?? body.data.data?.id;
      const status = mapEvolutionMessageStatus(body.data.data?.status);

      if (!providerMessageId || !status) {
        return { ok: true, ignored: true };
      }

      const message = await app.prisma.message.update({
        where: {
          workspaceId_providerMessageId: {
            workspaceId,
            providerMessageId
          }
        },
        data: { status }
      }).catch((error: unknown) => {
        if (isPrismaKnownRequestErrorCode(error, "P2025")) {
          return null;
        }

        throw error;
      });

      if (!message) {
        return { ok: true, ignored: true };
      }

      app.realtime.publish({
        type: "message.status_changed",
        workspaceId,
        payload: {
          messageId: message.id,
          status: message.status
        }
      });

      return { ok: true };
    }

    if (normalizedEvent !== "messages.upsert") {
      return { ok: true, ignored: true };
    }

    const body = evolutionWebhookSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_webhook_payload" });
    }

    const payload = body.data;
    const phone = extractPhone(payload.data.key.remoteJid);
    const pushName = extractPushName(request.body);
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

        const existingContact = await tx.contact.findUnique({
          where: {
            workspaceId_phone: {
              workspaceId,
              phone
            }
          },
          select: { id: true, name: true }
        });

        const contact = await tx.contact.upsert({
          where: {
            workspaceId_phone: {
              workspaceId,
              phone
            }
          },
          create: {
            workspaceId,
            phone,
            ...(pushName ? { name: pushName } : {})
          },
          update: !existingContact?.name && pushName ? { name: pushName } : {}
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
