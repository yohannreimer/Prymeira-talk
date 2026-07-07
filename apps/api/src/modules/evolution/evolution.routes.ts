import type { FastifyPluginAsync } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ChannelDto, MessageDto } from "@prymeira-talk/shared";
import { z } from "zod";
import { toChannelDto } from "../channels/channels.service.js";
import {
  createAutomationRunner,
  type AutomationRunnerAgentRuntime,
  type AutomationRunnerEvolution,
  type AutomationRunnerPrisma
} from "../automations/automation-runner.js";
import { createBoardRulesService, type BoardRulesPrismaLike } from "../boards/board-rules.service.js";
import {
  buildPhoneLookupCandidates,
  normalizePhoneForStorage
} from "../contacts/phone-normalization.js";
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
  agentRuntime?: AutomationRunnerAgentRuntime;
  evolution?: AutomationRunnerEvolution;
  agentReplyScheduler?: {
    scheduleActiveSessionForMessage(input: {
      workspaceId: string;
      conversationId: string;
      messageId: string;
    }): Promise<{
      scheduled: boolean;
      scheduledAt?: Date | string;
    }>;
  };
}

const evolutionWebhookParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

function extractPhone(remoteJid: string) {
  return normalizePhoneForStorage(remoteJid.split("@")[0] ?? remoteJid);
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

function readFirstStringPath(data: unknown, paths: string[][]) {
  for (const path of paths) {
    const value = readStringPath(data, path);

    if (value) {
      return value;
    }
  }

  return null;
}

function hasRecordPath(data: unknown, path: string[]) {
  let current = data;

  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current !== null && typeof current === "object" && !Array.isArray(current);
}

function normalizeMediaUrl(value: string | null) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
      ? value
      : null;
  } catch {
    return null;
  }
}

function normalizeMediaMimeType(value: string | null) {
  const mimetype = value?.split(";")[0]?.trim().toLowerCase();

  return mimetype && mimetype.length > 0 ? mimetype : "application/octet-stream";
}

function normalizeBase64MediaUrl(value: string | null, mimetype: string | null) {
  if (!value) return null;

  if (value.startsWith("data:")) {
    return normalizeMediaUrl(value);
  }

  const compactValue = value.replace(/\s/g, "");

  return compactValue.length > 0
    ? `data:${normalizeMediaMimeType(mimetype)};base64,${compactValue}`
    : null;
}

function readMessageBase64(message: unknown, messageKey: string) {
  return (
    readStringPath(message, [messageKey, "base64"]) ??
    (hasRecordPath(message, [messageKey]) ? readStringPath(message, ["base64"]) : null)
  );
}

function extractMessageContent(message: unknown): {
  type: MessageDto["type"];
  body: string | null;
  mediaUrl: string | null;
  preview: string | null;
} {
  const text = readFirstStringPath(message, [
    ["conversation"],
    ["extendedTextMessage", "text"]
  ]);

  if (text) {
    return {
      type: "text",
      body: text,
      mediaUrl: null,
      preview: text
    };
  }

  const imageMimetype = readStringPath(message, ["imageMessage", "mimetype"]);
  const imageDataUrl = normalizeBase64MediaUrl(readMessageBase64(message, "imageMessage"), imageMimetype);
  const imageUrl =
    imageDataUrl ??
    normalizeMediaUrl(
      readFirstStringPath(message, [
        ["imageMessage", "url"],
        ["imageMessage", "mediaUrl"]
      ])
    );
  if (imageMimetype || imageUrl) {
    const caption = readStringPath(message, ["imageMessage", "caption"]);
    const body = caption ?? "Imagem recebida";

    return {
      type: "image",
      body,
      mediaUrl: imageUrl,
      preview: body
    };
  }

  const stickerMimetype = readStringPath(message, ["stickerMessage", "mimetype"]);
  const stickerDataUrl = normalizeBase64MediaUrl(readMessageBase64(message, "stickerMessage"), stickerMimetype);
  const stickerUrl =
    stickerDataUrl ??
    normalizeMediaUrl(
      readFirstStringPath(message, [
        ["stickerMessage", "url"],
        ["stickerMessage", "mediaUrl"]
      ])
    );
  if (stickerMimetype || stickerUrl) {
    return {
      type: "image",
      body: "Figurinha recebida",
      mediaUrl: stickerUrl,
      preview: "Figurinha recebida"
    };
  }

  const audioMimetype = readStringPath(message, ["audioMessage", "mimetype"]);
  const audioDataUrl = normalizeBase64MediaUrl(readMessageBase64(message, "audioMessage"), audioMimetype);
  const audioUrl =
    audioDataUrl ??
    normalizeMediaUrl(
      readFirstStringPath(message, [
        ["audioMessage", "url"],
        ["audioMessage", "mediaUrl"]
      ])
    );
  if (audioMimetype || audioUrl) {
    return {
      type: "audio",
      body: "Áudio recebido",
      mediaUrl: audioUrl,
      preview: "Áudio recebido"
    };
  }

  const documentMimetype =
    readStringPath(message, ["documentMessage", "mimetype"]) ??
    readStringPath(message, ["videoMessage", "mimetype"]);
  const documentDataUrl =
    normalizeBase64MediaUrl(readMessageBase64(message, "documentMessage"), documentMimetype) ??
    normalizeBase64MediaUrl(readMessageBase64(message, "videoMessage"), documentMimetype);
  const documentUrl =
    documentDataUrl ??
    normalizeMediaUrl(
      readFirstStringPath(message, [
        ["documentMessage", "url"],
        ["documentMessage", "mediaUrl"],
        ["videoMessage", "url"],
        ["videoMessage", "mediaUrl"]
      ])
    );
  if (documentMimetype || documentUrl) {
    const body =
      readStringPath(message, ["documentMessage", "fileName"]) ??
      readStringPath(message, ["documentMessage", "caption"]) ??
      readStringPath(message, ["videoMessage", "caption"]) ??
      "Arquivo recebido";

    return {
      type: "file",
      body,
      mediaUrl: documentUrl,
      preview: body
    };
  }

  return {
    type: "text",
    body: null,
    mediaUrl: null,
    preview: "Mensagem recebida"
  };
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
  const automationRunner = createAutomationRunner({
    prisma: app.prisma as unknown as AutomationRunnerPrisma,
    agentRuntime: options.agentRuntime,
    agentReplyScheduler: options.agentReplyScheduler,
    evolution: options.evolution,
    realtime: app.realtime,
    boardRules: createBoardRulesService(app.prisma as unknown as BoardRulesPrismaLike)
  });

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

      const providerMessageId =
        body.data.data?.key?.id ?? body.data.data?.keyId ?? body.data.data?.id ?? body.data.data?.messageId;
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
    const pushName = payload.data.key.fromMe ? null : extractPushName(request.body);
    const messageContent = extractMessageContent(payload.data.message);
    const receivedAt =
      typeof payload.data.messageTimestamp === "number"
        ? new Date(payload.data.messageTimestamp * 1000)
        : new Date();

    try {
      const transactionResult = await app.prisma.$transaction(async (tx) => {
        const channel =
          await tx.channel.findUnique({
            where: {
              workspaceId_provider_providerKey: {
                workspaceId,
                provider: "evolution",
                providerKey: payload.instance
              }
            },
            select: { id: true, provider: true }
          }) ??
          await tx.channel.findUnique({
            where: {
              workspaceId_provider_providerKey: {
                workspaceId,
                provider: "meta_cloud",
                providerKey: payload.instance
              }
            },
            select: { id: true, provider: true }
          });

        if (!channel) {
          return { kind: "channel_not_found" as const };
        }

        const contact = await tx.contact.findFirst({
          where: {
            workspaceId,
            phone: { in: buildPhoneLookupCandidates(phone) }
          },
          orderBy: { updatedAt: "desc" }
        }) ?? await tx.contact.create({
          data: {
            workspaceId,
            phone,
            ...(pushName ? { name: pushName } : {})
          }
        });

        if (pushName) {
          await tx.contact.updateMany({
            where: {
              workspaceId,
              phone: { in: buildPhoneLookupCandidates(phone) },
              name: null
            },
            data: { name: pushName }
          });
        }

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
            ...(channel.provider === "meta_cloud" && !payload.data.key.fromMe
              ? { customerServiceWindowExpiresAt: new Date(receivedAt.getTime() + 24 * 60 * 60 * 1000) }
              : {}),
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
            type: messageContent.type,
            body: messageContent.body,
            mediaUrl: messageContent.mediaUrl,
            status: payload.data.key.fromMe ? "sent" : "delivered",
            createdAt: receivedAt
          }
        });

        if (!payload.data.key.fromMe) {
          if (channel.provider === "meta_cloud") {
            const customerServiceWindowExpiresAt = new Date(receivedAt.getTime() + 24 * 60 * 60 * 1000);
            await tx.conversation.updateMany({
              where: {
                id: conversation.id,
                workspaceId,
                OR: [
                  { customerServiceWindowExpiresAt: null },
                  { customerServiceWindowExpiresAt: { lt: customerServiceWindowExpiresAt } }
                ]
              },
              data: { customerServiceWindowExpiresAt }
            });
          }

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
            lastMessagePreview: messageContent.preview
          }
        });

        const updatedConversation = await tx.conversation.findUnique({
          where: {
            workspaceId_id: {
              workspaceId,
              id: conversation.id
            }
          },
          include: {
            assignedUser: { select: { displayName: true } },
            channel: { select: { displayName: true, phoneNumber: true } },
            contact: { select: { name: true, phone: true } },
            department: { select: { name: true } }
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

      if (message.direction === "inbound") {
        await automationRunner.runForInboundMessage({
          workspaceId,
          messageId: message.id,
          eventKey: `message.received:${message.providerMessageId ?? message.id}`
        }).catch((error: unknown) => {
          request.log.error({ error }, "Failed to run message automations.");
        });

        await options.agentReplyScheduler?.scheduleActiveSessionForMessage({
          workspaceId,
          conversationId: message.conversationId,
          messageId: message.id
        }).catch((error: unknown) => {
          request.log.error({ error }, "Failed to schedule agent reply.");
        });
      }

      return { ok: true };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { ok: true, duplicate: true };
      }

      throw error;
    }
  });
};
