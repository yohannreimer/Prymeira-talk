import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  buildPhoneLookupCandidates,
  normalizePhoneForStorage
} from "../contacts/phone-normalization.js";
import { toConversationDto, toMessageDto } from "../conversations/conversations.service.js";
import { resolveMetaRuntime } from "./meta-runtime.js";

const META_CLOUD_PROVIDER = "meta_cloud";
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const metaWebhookParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

const metaWebhookVerificationQuerySchema = z.object({
  "hub.mode": z.string().min(1),
  "hub.verify_token": z.string().min(1),
  "hub.challenge": z.string().min(1)
});

interface MetaInboundTextMessage {
  phoneNumberId: string;
  messageId: string;
  from: string;
  body: string;
  receivedAt: Date;
  profileName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function readRecord(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  const candidate = value[key];
  return isRecord(candidate) ? candidate : null;
}

function readArray(value: unknown, key: string) {
  if (!isRecord(value)) {
    return [];
  }

  const candidate = value[key];
  return Array.isArray(candidate) ? candidate : [];
}

function parseMetaTimestamp(value: string | null) {
  if (!value) {
    return new Date();
  }

  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();
}

function findProfileName(contacts: unknown[], from: string) {
  for (const contact of contacts) {
    if (!isRecord(contact) || contact.wa_id !== from) {
      continue;
    }

    const profile = readRecord(contact, "profile");
    const name = readString(profile, "name")?.trim();
    if (name) {
      return name;
    }
  }

  return null;
}

function extractInboundTextMessages(payload: unknown): MetaInboundTextMessage[] {
  const messages: MetaInboundTextMessage[] = [];

  for (const entry of readArray(payload, "entry")) {
    for (const change of readArray(entry, "changes")) {
      const value = readRecord(change, "value");
      const metadata = readRecord(value, "metadata");
      const phoneNumberId = readString(metadata, "phone_number_id");

      if (!phoneNumberId) {
        continue;
      }

      const contacts = readArray(value, "contacts");
      for (const message of readArray(value, "messages")) {
        const messageId = readString(message, "id");
        const from = readString(message, "from");
        const type = readString(message, "type");
        const text = readRecord(message, "text");
        const body = readString(text, "body");

        if (!messageId || !from || type !== "text" || !body) {
          continue;
        }

        messages.push({
          phoneNumberId,
          messageId,
          from,
          body,
          receivedAt: parseMetaTimestamp(readString(message, "timestamp")),
          profileName: findProfileName(contacts, from)
        });
      }
    }
  }

  return messages;
}

function isUniqueConstraintError(error: unknown) {
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

export const metaWebhooksRoutes: FastifyPluginAsync = async (app) => {
  app.get("/webhooks/meta/:workspaceId", async (request, reply) => {
    const params = metaWebhookParamsSchema.safeParse(request.params);
    const query = metaWebhookVerificationQuerySchema.safeParse(request.query);

    if (params.success && query.success) {
      const runtime = await resolveMetaRuntime(app.prisma, {
        workspaceId: params.data.workspaceId
      });

      if (
        query.data["hub.mode"] === "subscribe" &&
        runtime.active &&
        runtime.webhookVerifyToken &&
        query.data["hub.verify_token"] === runtime.webhookVerifyToken &&
        query.data["hub.challenge"]
      ) {
        return reply.type("text/plain").send(query.data["hub.challenge"]);
      }
    }

    return reply.code(403).send({ error: "Invalid Meta webhook verification token." });
  });

  app.post("/webhooks/meta/:workspaceId", async (request, reply) => {
    const params = metaWebhookParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid Meta webhook request." });
    }

    const workspaceId = params.data.workspaceId;
    const inboundMessages = extractInboundTextMessages(request.body);

    if (inboundMessages.length === 0) {
      return { ok: true, ignored: true };
    }

    try {
      const transactionResult = await app.prisma.$transaction(async (tx) => {
        const createdMessages = [];
        const updatedConversations = [];

        for (const inboundMessage of inboundMessages) {
          const channel = await tx.channel.findUnique({
            where: {
              workspaceId_provider_providerKey: {
                workspaceId,
                provider: META_CLOUD_PROVIDER,
                providerKey: inboundMessage.phoneNumberId
              }
            },
            select: { id: true }
          });

          if (!channel) {
            return { kind: "channel_not_found" as const };
          }

          const phone = normalizePhoneForStorage(inboundMessage.from);
          const phoneCandidates = buildPhoneLookupCandidates(phone);
          const contact =
            (await tx.contact.findFirst({
              where: {
                workspaceId,
                phone: { in: phoneCandidates }
              },
              orderBy: { updatedAt: "desc" }
            })) ??
            (await tx.contact.create({
              data: {
                workspaceId,
                phone,
                ...(inboundMessage.profileName ? { name: inboundMessage.profileName } : {})
              }
            }));

          if (inboundMessage.profileName) {
            await tx.contact.updateMany({
              where: {
                workspaceId,
                phone: { in: phoneCandidates },
                name: null
              },
              data: { name: inboundMessage.profileName }
            });
          }

          const customerServiceWindowExpiresAt = new Date(
            inboundMessage.receivedAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS
          );
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
              unreadCount: 0,
              customerServiceWindowExpiresAt
            },
            update: {
              customerServiceWindowExpiresAt
            }
          });

          const message = await tx.message.create({
            data: {
              workspaceId,
              conversationId: conversation.id,
              providerMessageId: inboundMessage.messageId,
              providerEventId: `meta:${inboundMessage.phoneNumberId}:${inboundMessage.messageId}`,
              direction: "inbound",
              type: "text",
              body: inboundMessage.body,
              mediaUrl: null,
              status: "delivered",
              createdAt: inboundMessage.receivedAt
            }
          });

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

          await tx.conversation.updateMany({
            where: {
              id: conversation.id,
              workspaceId,
              OR: [
                { lastMessageAt: null },
                { lastMessageAt: { lte: inboundMessage.receivedAt } }
              ]
            },
            data: {
              lastMessageAt: inboundMessage.receivedAt,
              lastMessagePreview: inboundMessage.body
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
            throw new Error("Conversation disappeared during Meta webhook ingestion.");
          }

          createdMessages.push(message);
          updatedConversations.push(updatedConversation);
        }

        return {
          kind: "created" as const,
          messages: createdMessages,
          conversations: updatedConversations
        };
      });

      if (transactionResult.kind === "channel_not_found") {
        return reply.code(404).send({ ok: false, error: "channel_not_found" });
      }

      for (const message of transactionResult.messages) {
        app.realtime.publish({
          type: "message.created",
          workspaceId,
          payload: toMessageDto(message)
        });
      }

      for (const conversation of transactionResult.conversations) {
        app.realtime.publish({
          type: "conversation.updated",
          workspaceId,
          payload: toConversationDto(conversation)
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
