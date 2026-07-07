import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  buildPhoneLookupCandidates,
  normalizePhoneForStorage
} from "../contacts/phone-normalization.js";
import { toConversationDto, toMessageDto } from "../conversations/conversations.service.js";
import { applyInboundDepartmentRouting, supportsDepartmentRouting } from "../team/team-routing.service.js";
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

const rawBodySymbol = Symbol("metaWebhookRawBody");

type MetaRawRequest = {
  [rawBodySymbol]?: Buffer;
};

interface MetaInboundTextMessage {
  phoneNumberId: string;
  messageId: string;
  from: string;
  body: string;
  receivedAt: Date;
  profileName: string | null;
}

type MetaMessageProcessResult =
  | {
      kind: "created";
      message: Parameters<typeof toMessageDto>[0];
      conversation: Parameters<typeof toConversationDto>[0];
    }
  | { kind: "duplicate" }
  | { kind: "channel_not_found" }
  | { kind: "ignored" };

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

function normalizeHeaderValue(header: string | string[] | undefined) {
  if (Array.isArray(header)) {
    return header.length === 1 ? header[0] : undefined;
  }

  return header;
}

function getRawRequestBody(request: { raw: unknown; body: unknown }) {
  const rawBody = (request.raw as MetaRawRequest)[rawBodySymbol];
  if (rawBody) {
    return rawBody;
  }

  return null;
}

function hasValidMetaSignature(
  header: string | string[] | undefined,
  rawBody: Buffer | null,
  appSecret: string
) {
  const signature = normalizeHeaderValue(header);
  if (!rawBody || !signature?.startsWith("sha256=")) {
    return false;
  }

  const signatureHex = signature.slice("sha256=".length);
  if (!/^[a-f0-9]+$/i.test(signatureHex)) {
    return false;
  }

  const actual = Buffer.from(signatureHex, "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const metaWebhooksRoutes: FastifyPluginAsync = async (app) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request.raw as MetaRawRequest)[rawBodySymbol] = rawBody;

    if (rawBody.length === 0) {
      done(null, {});
      return;
    }

    try {
      done(null, JSON.parse(rawBody.toString("utf8")) as unknown);
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.get("/webhooks/meta/:workspaceId", async (request, reply) => {
    const params = metaWebhookParamsSchema.safeParse(request.params);
    const query = metaWebhookVerificationQuerySchema.safeParse(request.query);

    if (!params.success || !query.success) {
      return reply
        .code(400)
        .send({ error: "Invalid Meta webhook verification request." });
    }

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

    return reply.code(403).send({ error: "Invalid Meta webhook verification token." });
  });

  app.post("/webhooks/meta/:workspaceId", async (request, reply) => {
    const params = metaWebhookParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid Meta webhook request." });
    }

    const workspaceId = params.data.workspaceId;
    const runtime = await resolveMetaRuntime(app.prisma, { workspaceId });

    if (!runtime.active || !runtime.client || !runtime.phoneNumberId) {
      return reply.code(409).send({ ok: false, error: "meta_cloud_not_configured" });
    }

    if (!runtime.appSecret) {
      return reply.code(409).send({ ok: false, error: "meta_signature_not_configured" });
    }

    if (!hasValidMetaSignature(
      request.headers["x-hub-signature-256"],
      getRawRequestBody(request),
      runtime.appSecret
    )) {
      return reply.code(401).send({ ok: false, error: "invalid_meta_signature" });
    }

    const inboundMessages = extractInboundTextMessages(request.body);

    if (inboundMessages.length === 0) {
      return { ok: true, ignored: true };
    }

    const results: MetaMessageProcessResult[] = [];

    for (const inboundMessage of inboundMessages) {
      if (inboundMessage.phoneNumberId !== runtime.phoneNumberId) {
        results.push({ kind: "ignored" });
        continue;
      }

      try {
        const result = await app.prisma.$transaction(async (tx): Promise<MetaMessageProcessResult> => {
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
            return { kind: "channel_not_found" };
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
            update: {}
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
                { customerServiceWindowExpiresAt: null },
                { customerServiceWindowExpiresAt: { lt: customerServiceWindowExpiresAt } }
              ]
            },
            data: {
              customerServiceWindowExpiresAt
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

          if (supportsDepartmentRouting(tx)) {
            await applyInboundDepartmentRouting(tx, {
              workspaceId,
              conversationId: conversation.id,
              channelId: channel.id
            });
          }

          const updatedConversation = await tx.conversation.findUnique({
            where: {
              workspaceId_id: {
                workspaceId,
                id: conversation.id
              }
            },
            include: {
              assignedUser: { select: { displayName: true } },
              channel: { select: { displayName: true, phoneNumber: true, provider: true } },
              contact: { select: { name: true, phone: true } },
              department: { select: { name: true } }
            }
          });

          if (!updatedConversation) {
            throw new Error("Conversation disappeared during Meta webhook ingestion.");
          }

          return { kind: "created", message, conversation: updatedConversation };
        });

        results.push(result);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          results.push({ kind: "duplicate" });
          continue;
        }

        throw error;
      }
    }

    for (const result of results) {
      if (result.kind !== "created") {
        continue;
      }

      app.realtime.publish({
        type: "message.created",
        workspaceId,
        payload: toMessageDto(result.message)
      });
      app.realtime.publish({
        type: "conversation.updated",
        workspaceId,
        payload: toConversationDto(result.conversation)
      });
    }

    const createdCount = results.filter((result) => result.kind === "created").length;
    const duplicateCount = results.filter((result) => result.kind === "duplicate").length;
    const ignoredCount = results.filter((result) => result.kind === "ignored").length;
    const channelNotFoundCount = results.filter(
      (result) => result.kind === "channel_not_found"
    ).length;

    if (channelNotFoundCount === results.length) {
      return reply.code(404).send({ ok: false, error: "channel_not_found" });
    }

    if (createdCount > 0) {
      return duplicateCount > 0 || ignoredCount > 0 || channelNotFoundCount > 0
        ? { ok: true, partial: true }
        : { ok: true };
    }

    if (duplicateCount > 0 && duplicateCount + ignoredCount === results.length) {
      return duplicateCount === results.length
        ? { ok: true, duplicate: true }
        : { ok: true, partial: true };
    }

    if (ignoredCount === results.length) {
      return { ok: true, ignored: true };
    }

    if (channelNotFoundCount > 0) {
      return { ok: true, partial: true };
    }

    return { ok: true };
  });
};
