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
import { pauseAgentOnHumanOutbound } from "../conversations/pause-agent-on-human-outbound.js";
import { applyInboundDepartmentRouting, supportsDepartmentRouting } from "../team/team-routing.service.js";
import {
  evolutionConnectionUpdateSchema,
  evolutionMessageStatusUpdateSchema,
  evolutionQrUpdateSchema,
  evolutionWebhookEnvelopeSchema,
  evolutionWebhookSchema
} from "./evolution.schemas.js";
import type { ConversationFollowupsObserver } from "../followups/conversation-followups.service.js";
import type { AgentImprovementObserver } from "../agents/agent-improvements.service.js";
import type { InboxTriageObserver } from "../conversations/inbox-triage.service.js";
import type { EvolutionHistorySource } from "./evolution-history.js";
import { decryptEncryptedMessageEdit, extractEncryptedMessageEdit, isEncryptedControlEnvelope } from "./evolution-message-edit.js";

export interface EvolutionRoutesOptions {
  messageHistory?: Pick<EvolutionHistorySource, "findMessage">;
  historyBackfill?: (input: { workspaceId: string; channelId: string; conversationId: string; providerKey: string; remoteJid: string; identity: string; pushName: string | null }) => Promise<void>;
  assistantScheduler?: import('../assistant/assistant-scheduler.js').AssistantScheduler;
  handoffBriefService?: ReturnType<typeof import('../assistant/handoff-brief-service.js').createHandoffBriefService>;
  followupService?: ConversationFollowupsObserver;
  agentImprovements?: AgentImprovementObserver;
  inboxTriage?: InboxTriageObserver;
  webhookSecret: string;
  agentRuntime?: AutomationRunnerAgentRuntime & {
    prepareAudioMessage(input: {
      workspaceId: string;
      messageId: string;
    }): Promise<{
      status: "completed" | "failed" | "skipped";
      text?: string;
      errorCode?: string;
    }>;
  };
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

export function resolveWebhookPhone(remoteJid: string, remoteJidAlt?: string): string | null {
  const address = remoteJid.endsWith('@lid') ? remoteJidAlt ?? remoteJid : remoteJid;
  if (/^\d+@lid$/.test(address)) return address;
  if (!address || (address.includes('@') && !address.endsWith('@s.whatsapp.net'))) return null;
  const phone = normalizePhoneForStorage(address.split('@')[0]);
  return phone.length >= 8 && phone.length <= 15 ? phone : null;
}

function resolveGroupJid(remoteJid: string): string | null {
  return /^\d+(?:-\d+)?@g\.us$/.test(remoteJid) && remoteJid.length <= 80 ? remoteJid : null;
}

function groupFallbackName(groupJid: string): string {
  return `Grupo ${groupJid.split('@')[0]!.slice(-8)}`;
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

function isEditProtocolType(type: unknown) {
  return type === 14 || type === "14" || type === "MESSAGE_EDIT";
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
  const current = readPath(data, path);
  return typeof current === "string" && current.length > 0 ? current : null;
}

function readPath(data: unknown, path: string[]): unknown {
  let current = data;

  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return null;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
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

function unwrapMessage(message: unknown) {
  let current = message;
  for (let depth = 0; depth < 6; depth++) {
    const wrapper = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage"]
      .find((key) => hasRecordPath(current, [key, "message"]));
    if (!wrapper) break;
    current = (current as Record<string, Record<string, unknown>>)[wrapper].message;
  }
  return current;
}

export function attachmentPresentation(message: unknown) {
  message = unwrapMessage(message);
  const fileName = readStringPath(message, ['documentMessage', 'fileName']);
  const caption = readFirstStringPath(message, [['documentMessage', 'caption'], ['imageMessage', 'caption'], ['videoMessage', 'caption']]);
  const mimeType = readFirstStringPath(message, [['videoMessage', 'mimetype'], ['documentMessage', 'mimetype'], ['imageMessage', 'mimetype'], ['audioMessage', 'mimetype']]);
  const raw = message && typeof message === 'object' ? (message as Record<string, unknown>).audioMessage : null;
  const seconds = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).seconds : null;
  return {
    ...(fileName ? { fileName } : {}), ...(caption ? { caption } : {}), ...(mimeType ? { mimeType } : {}),
    ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? { durationSeconds: seconds } : {})
  };
}

function parseContactCard(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  const vcard = typeof card.vcard === 'string' ? card.vcard.slice(0, 32_000).replace(/\r?\n[ \t]/g, '') : '';
  const fullName = (typeof card.displayName === 'string' ? card.displayName : '')
    .trim() || /^FN:(.+)$/im.exec(vcard)?.[1]?.trim() || 'Contato';
  const tel = vcard.split(/\r?\n/).find(line => /^TEL(?:;|:)/i.test(line));
  const waid = tel && /(?:^|;)waid=(\d+)/i.exec(tel)?.[1];
  const phoneNumber = (waid || tel?.slice(tel.indexOf(':') + 1).replace(/\D/g, '') || '').slice(0, 20) || null;
  return { fullName: fullName.slice(0, 200), phoneNumber };
}

export function extractMessageContent(message: unknown, messageType?: unknown): {
  type: MessageDto["type"];
  body: string | null;
  mediaUrl: string | null;
  preview: string | null;
  contactCards?: Array<{ fullName: string; phoneNumber: string | null }>;
} {
  message = unwrapMessage(message);
  const singleContact = readPath(message, ['contactMessage']);
  const contactArray = readPath(message, ['contactsArrayMessage', 'contacts']);
  const contactCards = (Array.isArray(contactArray) ? contactArray.slice(0, 50) : singleContact ? [singleContact] : [])
    .map(parseContactCard).filter((card): card is NonNullable<typeof card> => card !== null);
  if (contactCards.length) {
    const label = contactCards.length === 1
      ? `Contato compartilhado: ${contactCards[0]!.fullName}${contactCards[0]!.phoneNumber ? ` (${contactCards[0]!.phoneNumber})` : ''}`
      : `${contactCards.length} contatos compartilhados`;
    return { type: 'text', body: label, mediaUrl: null, preview: label, contactCards };
  }
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

  if (hasRecordPath(message, ["templateMessage"]) || messageType === "templateMessage") {
    const title = readStringPath(message, ["templateMessage", "hydratedTemplate", "hydratedTitleText"])?.trim();
    const content = readStringPath(message, ["templateMessage", "hydratedTemplate", "hydratedContentText"])?.trim();
    const body = [title, content].filter(Boolean).join("\n");
    return body
      ? { type: "template", body, mediaUrl: null, preview: body }
      : { type: "system", body: "Template recebido sem texto", mediaUrl: null, preview: "Template recebido sem texto" };
  }

  if (hasRecordPath(message, ["reactionMessage"]) || messageType === "reactionMessage") {
    const emoji = readStringPath(message, ["reactionMessage", "text"]);
    const body = emoji ? `Reagiu com ${emoji}` : "Removeu uma reação";
    return { type: "system", body, mediaUrl: null, preview: body };
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
  const stickerDataUrl = normalizeBase64MediaUrl(readMessageBase64(message, "stickerMessage"), stickerMimetype ?? "image/webp");
  const stickerUrl =
    stickerDataUrl ??
    normalizeMediaUrl(
      readFirstStringPath(message, [
        ["stickerMessage", "url"],
        ["stickerMessage", "mediaUrl"]
      ])
    );
  if (hasRecordPath(message, ["stickerMessage"]) || messageType === "stickerMessage") {
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
      (hasRecordPath(message, ["videoMessage"]) || documentMimetype?.toLowerCase().startsWith('video/') ? "Vídeo recebido" : "Arquivo recebido");

    return {
      type: "file",
      body,
      mediaUrl: documentUrl,
      preview: body
    };
  }

  return {
    type: "system",
    body: "Mensagem não reconhecida",
    mediaUrl: null,
    preview: "Mensagem não reconhecida"
  };
}

function extractMessageEdit(data: unknown, event: string): {
  targetId: string;
  body: string;
} | null {
  const message = unwrapMessage(readPath(data, ["message"]));
  const protocol = readPath(message, ["protocolMessage"]);
  const protocolType = readPath(protocol, ["type"]);
  const isProtocolEdit = isEditProtocolType(protocolType);
  const updateMessage = readPath(data, ["update", "message"]);
  const editedContent = isProtocolEdit
    ? readPath(protocol, ["editedMessage"])
    : readPath(updateMessage, ["editedMessage", "message"])
      ?? readPath(message, ["editedMessage", "message"]);
  const candidate = editedContent ?? (event === "messages.edited" ? updateMessage ?? message : null);
  const content = candidate ? extractMessageContent(candidate) : null;
  if (content?.type !== "text" || !content.body) return null;

  const targetId = isProtocolEdit
    ? readStringPath(protocol, ["key", "id"])
    : readFirstStringPath(data, [["key", "id"], ["keyId"], ["id"]]);
  return targetId ? { targetId, body: content.body } : null;
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

    const editData = envelope.data.data;
    const encryptedEdit = extractEncryptedMessageEdit(editData);
    if (!encryptedEdit && isEncryptedControlEnvelope(editData)) return { ok: true, ignored: true };
    const editEnvelope = normalizedEvent === "messages.edited" ||
      encryptedEdit !== null ||
      (normalizedEvent === "messages.upsert" &&
        (hasRecordPath(unwrapMessage(readPath(editData, ["message"])), ["editedMessage"]) ||
          isEditProtocolType(readPath(unwrapMessage(readPath(editData, ["message"])), ["protocolMessage", "type"])))) ||
      (normalizedEvent === "messages.update" &&
        (hasRecordPath(readPath(editData, ["update", "message"]), ["editedMessage"]) ||
          hasRecordPath(readPath(editData, ["message"]), ["editedMessage"])));
    if (editEnvelope) {
      const clearEdit = extractMessageEdit(editData, normalizedEvent);
      const targetId = clearEdit?.targetId ?? encryptedEdit?.targetId;
      if (!targetId) return { ok: true, ignored: true };

      const original = await app.prisma.message.findUnique({
        where: { workspaceId_providerMessageId: { workspaceId, providerMessageId: targetId } },
        include: { conversation: { include: { channel: true } } }
      });
      if (!original || original.conversation.channel.providerKey !== envelope.data.instance) {
        return { ok: true, ignored: true };
      }
      let edit = clearEdit;
      if (!edit && encryptedEdit && options.messageHistory) {
        const providerOriginal = await options.messageHistory.findMessage({
          instanceName: envelope.data.instance, id: targetId
        });
        const body = providerOriginal && decryptEncryptedMessageEdit(encryptedEdit, providerOriginal);
        if (body) edit = { targetId, body };
      }
      if (!edit) return { ok: true, ignored: true };
      if (original.body === edit.body &&
        typeof original.metadata === "object" && original.metadata !== null &&
        "editedAt" in original.metadata) {
        return { ok: true };
      }

      const metadata = original.metadata && typeof original.metadata === "object" && !Array.isArray(original.metadata)
        ? original.metadata as Record<string, unknown> : {};
      const updated = await app.prisma.message.update({
        where: { workspaceId_providerMessageId: { workspaceId, providerMessageId: edit.targetId } },
        data: { type: "text", body: edit.body, metadata: { ...metadata, editedAt: new Date().toISOString() } }
      });
      const latest = await app.prisma.message.findFirst({
        where: { workspaceId, conversationId: original.conversationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true }
      });
      if (latest?.id === original.id) {
        await app.prisma.conversation.updateMany({
          where: { workspaceId, id: original.conversationId },
          data: { lastMessagePreview: edit.body }
        });
        const conversation = await app.prisma.conversation.findUnique({
          where: { workspaceId_id: { workspaceId, id: original.conversationId } },
          include: {
            assignedUser: { select: { displayName: true } },
            channel: { select: { displayName: true, phoneNumber: true } },
            contact: { select: { name: true, phone: true, isGroup: true } },
            department: { select: { name: true } }
          }
        });
        if (conversation) app.realtime.publish({ type: "conversation.updated", workspaceId, payload: toConversationDto(conversation) });
      }
      app.realtime.publish({ type: "message.updated", workspaceId, payload: toMessageDto(updated) });
      return { ok: true };
    }

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
    const groupJid = resolveGroupJid(payload.data.key.remoteJid);
    const isGroup = Boolean(groupJid);
    const phone = groupJid ?? resolveWebhookPhone(payload.data.key.remoteJid, payload.data.key.remoteJidAlt);
    if (!phone) {
      request.log.warn({ event: 'evolution_unresolved_identity', workspaceId,
        providerMessageId: payload.data.key.id, remoteJidType: payload.data.key.remoteJid.split('@')[1] ?? 'unknown' },
      'Evolution message has no phone identity yet.');
      return { ok: true, ignored: true, reason: 'unresolved_identity' };
    }
    const pushName = payload.data.key.fromMe ? null : extractPushName(request.body);
    const existingGroup = groupJid ? await app.prisma.contact.findFirst({
      where: { workspaceId, phone: groupJid, isGroup: true }, select: { name: true }
    }) : null;
    const savedGroupName = existingGroup?.name?.trim();
    const groupName = groupJid ? (savedGroupName && savedGroupName !== groupFallbackName(groupJid)
      ? savedGroupName
      : await options.evolution?.client?.getGroupInfo?.({ instanceName: payload.instance, groupJid })
        .then(result => result.subject).catch((error: unknown) => {
          request.log.warn({ err: error, groupJid }, 'Evolution group name lookup failed.');
          return null;
        }) ?? savedGroupName ?? groupFallbackName(groupJid)) : null;
    const participant = payload.data.key.participant ?? payload.data.participant;
    const senderJid = isGroup && !payload.data.key.fromMe && typeof participant === 'string'
      ? participant.slice(0, 100) : null;
    const messageContent = extractMessageContent(payload.data.message, payload.data.messageType);
    if (messageContent.body === "Template recebido sem texto" || messageContent.body === "Mensagem não reconhecida") {
      const message = unwrapMessage(payload.data.message);
      request.log.warn({
        event: "evolution_message_without_readable_content",
        workspaceId,
        providerMessageId: payload.data.key.id,
        providerMessageType: payload.data.messageType,
        messageKeys: message && typeof message === "object" && !Array.isArray(message) ? Object.keys(message) : []
      }, "Evolution message has no readable content.");
    }
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
        if (isGroup && channel.provider !== 'evolution') {
          return { kind: "unsupported_group_provider" as const };
        }

        const candidates = isGroup || phone.endsWith('@lid') ? [phone] : buildPhoneLookupCandidates(phone);
        const existingLidContact = payload.data.key.remoteJid.endsWith('@lid')
          ? await tx.contact.findFirst({ where: { workspaceId, phone: payload.data.key.remoteJid } })
          : null;
        const contact = isGroup ? null : await tx.contact.findFirst({
          where: {
            workspaceId,
            phone: { in: candidates }
          },
          orderBy: { updatedAt: "desc" }
        });
        const lid = !isGroup && /^\d+@lid$/.test(payload.data.key.remoteJid) ? payload.data.key.remoteJid : null;
        const phoneContact = contact && !contact.phone.endsWith('@lid') ? contact : null;
        const linkedContact = lid && !phoneContact && (phone.endsWith('@lid') || !existingLidContact) ? await tx.contact.findFirst({
          where: { workspaceId, customFields: { path: ['evolutionLid'], equals: lid } }
        }) : null;
        const lidContact = linkedContact ?? existingLidContact;
        const mappedContact = lid && !phone.endsWith('@lid') && lidContact?.phone.endsWith('@lid') && !phoneContact
          ? await tx.contact.update({
              where: { workspaceId_id: { workspaceId, id: lidContact.id } },
              data: { phone, customFields: {
                ...(lidContact.customFields && typeof lidContact.customFields === 'object' && !Array.isArray(lidContact.customFields)
                  ? lidContact.customFields as Record<string, unknown> : {}), evolutionLid: lid
              } }
            })
          : null;
        if (lid && phoneContact) {
          const fields = phoneContact.customFields && typeof phoneContact.customFields === 'object' && !Array.isArray(phoneContact.customFields)
            ? phoneContact.customFields as Record<string, unknown> : {};
          if (fields.evolutionLid !== lid) await tx.contact.update({
            where: { workspaceId_id: { workspaceId, id: phoneContact.id } },
            data: { customFields: { ...fields, evolutionLid: lid } }
          });
        }
        const selectedContact = isGroup ? await tx.contact.upsert({
          where: { workspaceId_phone: { workspaceId, phone } },
          create: { workspaceId, phone, isGroup: true, name: groupName },
          update: { name: groupName }
        }) : phoneContact ?? mappedContact ?? lidContact ?? contact ?? await tx.contact.create({
          data: {
            workspaceId,
            phone,
            ...(pushName ? { name: pushName } : {})
          }
        });

        if (!isGroup && pushName) {
          await tx.contact.updateMany({
            where: {
              workspaceId,
              ...(existingLidContact || phone.endsWith('@lid') ? { id: selectedContact.id } : { phone: { in: candidates } }),
              name: null
            },
            data: { name: pushName }
          });
        }

        const hiddenCampaignMessage = !isGroup && payload.data.key.fromMe && channel.provider === 'evolution' &&
          typeof tx.campaignRecipient?.findFirst === 'function'
          ? await tx.campaignRecipient.findFirst({
              where: { workspaceId, channelId: channel.id,
                campaign: { is: { hideFromInboxUntilReply: true } },
                OR: [{ providerMessageId: payload.data.key.id },
                  { status: 'in_flight',
                    contactSnapshot: { path: ['message'], equals: messageContent.body ?? '' },
                    OR: [{ contactId: selectedContact.id },
                    { phoneSnapshot: { in: candidates } }] },
                  { status: 'sent', providerMessageId: null,
                    sentAt: { gte: new Date(receivedAt.getTime() - 10 * 60 * 1000) },
                    contactSnapshot: { path: ['message'], equals: messageContent.body ?? '' },
                    OR: [{ contactId: selectedContact.id }, { phoneSnapshot: { in: candidates } }] }] },
              select: { id: true }
            })
          : null;

        const conversation = await tx.conversation.upsert({
          where: {
            workspaceId_channelId_contactId: {
              workspaceId,
              channelId: channel.id,
              contactId: selectedContact.id
            }
          },
          create: {
            workspaceId,
            channelId: channel.id,
            contactId: selectedContact.id,
            status: "open",
            hiddenUntilReply: Boolean(hiddenCampaignMessage),
            ...(isGroup || phone.endsWith('@lid') ? { aiControlStatus: 'human_controlled' as const } : {}),
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
            ...(isGroup || messageContent.contactCards?.length || ['audio', 'image', 'file'].includes(messageContent.type)
              ? { metadata: {
                  ...(isGroup && !payload.data.key.fromMe ? { groupSender: { jid: senderJid, name: pushName } } : {}),
                  ...(messageContent.contactCards?.length ? { contactCards: messageContent.contactCards } : {}),
                  ...(['audio', 'image', 'file'].includes(messageContent.type) ? { attachment: attachmentPresentation(payload.data.message) } : {})
                } } : {}),
            status: payload.data.key.fromMe ? "sent" : "delivered",
            createdAt: receivedAt
          }
        });

        const humanTookControl = payload.data.key.fromMe && !isGroup
          ? await pauseAgentOnHumanOutbound(tx, {
              workspaceId,
              conversationId: conversation.id
            })
          : false;

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
              unreadCount: { increment: 1 },
              hiddenUntilReply: false
            }
          });
        }

        if (hiddenCampaignMessage) {
          await tx.conversation.updateMany({
            where: { id: conversation.id, workspaceId,
              OR: [{ lastMessagePreviewAt: null }, { lastMessagePreviewAt: { lte: receivedAt } }] },
            data: { lastMessagePreview: messageContent.preview, lastMessagePreviewAt: receivedAt }
          });
        } else {
          await tx.conversation.updateMany({
            where: {
              id: conversation.id,
              workspaceId,
              OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: receivedAt } }]
            },
            data: {
              lastMessageAt: receivedAt,
              lastMessagePreview: messageContent.preview,
              lastMessagePreviewAt: receivedAt
            }
          });
        }

        if (!isGroup && !payload.data.key.fromMe && supportsDepartmentRouting(tx)) {
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
            channel: { select: { displayName: true, phoneNumber: true } },
            contact: { select: { name: true, phone: true, isGroup: true } },
            department: { select: { name: true } }
          }
        });

        if (!updatedConversation) {
          throw new Error("Conversation disappeared during Evolution webhook ingestion.");
        }

        if (!isGroup && messageContent.type !== "system") {
          await options.assistantScheduler?.persistInbound(tx, { workspaceId, conversationId: message.conversationId, messageId: message.id, direction: message.direction });
        }
        return { kind: "created" as const, message, conversation: updatedConversation, humanTookControl };
      });

      if (transactionResult.kind === "channel_not_found") {
        return reply.code(404).send({ ok: false, error: "channel_not_found" });
      }
      if (transactionResult.kind === 'unsupported_group_provider') {
        return { ok: true, ignored: true, reason: 'unsupported_group_provider' };
      }

      const { message, conversation, humanTookControl } = transactionResult;
      if (!isGroup && humanTookControl) {
        request.log.info({ event: "human_outbound_paused_agent", workspaceId, conversationId: message.conversationId, messageId: message.id }, "Human outbound message paused the agent.");
        await options.assistantScheduler?.control(workspaceId, message.conversationId, true).catch((error: unknown) => {
          request.log.error({ error, workspaceId, conversationId: message.conversationId }, "Failed to pause assistant suggestions after human outbound message.");
        });
      }
      if (!isGroup && !humanTookControl && messageContent.type !== "system") {
        await options.assistantScheduler?.message({ workspaceId, conversationId: message.conversationId, messageId: message.id, direction: message.direction });
      }
      if (!isGroup) options.handoffBriefService?.schedule({ workspaceId, conversationId: message.conversationId });
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

      // Historical sync may need several provider requests. Never hold the live
      // webhook or the realtime notification while those older messages load.
      if (!isGroup && message.direction === 'inbound' && messageContent.type !== 'system') {
        void options.historyBackfill?.({ workspaceId, channelId: conversation.channelId,
          conversationId: conversation.id, providerKey: payload.instance,
          remoteJid: payload.data.key.remoteJid, identity: phone, pushName }).catch((error: unknown) => {
          request.log.error({ err: error, conversationId: conversation.id }, 'Recent Evolution context backfill failed.');
        });
      }

      if (!isGroup && messageContent.type !== "system") {
        await options.inboxTriage?.observeMessage({
          workspaceId, conversationId: message.conversationId, messageId: message.id,
          direction: message.direction, observedAt: new Date()
        }).catch((error: unknown) => {
          request.log.error({ err: error, conversationId: message.conversationId }, "Inbox triage observation failed");
        });
      }

      if (!isGroup && message.direction === "inbound" && messageContent.type !== "system") {
        await options.followupService?.observeConversationActivity({
          workspaceId,
          conversationId: message.conversationId,
          messageId: message.id,
          direction: "inbound",
          source: "customer"
        }).catch((error: unknown) => {
          request.log.error({ error }, "Failed to observe inbound customer follow-up.");
        });
        if (message.type === "audio" && !await options.assistantScheduler?.isAssisted(workspaceId, message.conversationId)) {
          await options.agentRuntime?.prepareAudioMessage({
            workspaceId,
            messageId: message.id
          }).catch((error: unknown) => {
            request.log.error({ error }, "Failed to prepare inbound audio.");
          });
        }

        if (!phone.endsWith('@lid')) await automationRunner.runForInboundMessage({
          workspaceId,
          messageId: message.id,
          eventKey: `message.received:${message.providerMessageId ?? message.id}`
        }).catch((error: unknown) => {
          request.log.error({ error }, "Failed to run message automations.");
        });

        if (!phone.endsWith('@lid')) await options.agentReplyScheduler?.scheduleActiveSessionForMessage({
          workspaceId,
          conversationId: message.conversationId,
          messageId: message.id
        }).catch((error: unknown) => {
          request.log.error({ error }, "Failed to schedule agent reply.");
        });
      } else if (!isGroup && message.direction === "outbound" && messageContent.type !== "system") {
        await options.followupService?.observeConversationActivity({
          workspaceId,
          conversationId: message.conversationId,
          messageId: message.id,
          direction: "outbound",
          source: "human"
        }).catch((error: unknown) => {
          request.log.error({ error }, "Failed to observe external human outbound follow-up.");
        });
        if (options.agentImprovements) void options.agentImprovements.observeHumanReply({
          workspaceId,
          conversationId: message.conversationId,
          messageId: message.id
        }).then((analysis) => {
          request.log.info({
            event: "agent_improvement_observation",
            source: "evolution_outbound",
            workspaceId,
            conversationId: message.conversationId,
            messageId: message.id,
            outcome: analysis.created ? "created" : "skipped",
            reason: analysis.reason ?? null
          }, "Agent improvement observation completed.");
        }).catch((error: unknown) => {
          request.log.error({ error, event: "agent_improvement_observation_failed", source: "evolution_outbound", workspaceId, conversationId: message.conversationId, messageId: message.id }, "Failed to prepare agent improvement suggestion.");
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
