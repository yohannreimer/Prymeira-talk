import {
  resolveWebhookPhone, resolveGroupJid, groupFallbackName, normalizeEvolutionEvent,
  isEditProtocolType, mapEvolutionMessageStatus, readPath, hasRecordPath, unwrapMessage,
  extractMessageContent, attachmentPresentation, extractMessageEdit, extractPushName, extractQrCode
} from "./evolution-normalizer.js";
export { resolveWebhookPhone, extractMessageContent, attachmentPresentation } from "./evolution-normalizer.js";
import { lockProspectingConversation } from "../prospecting/prospecting-lock.js";
import { findProspectingOutboundEcho } from "../prospecting/prospecting-delivery.js";
import { observeProspectingInbound } from "../prospecting/prospecting-lifecycle.js";
import type { FastifyPluginAsync } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ChannelDto } from "@prymeira-talk/shared";
import { z } from "zod";
import { toChannelDto } from "../channels/channels.service.js";
import type { Channel } from '@prisma/client';
import { createChannelConnectionsService } from '../channels/channel-connections.js';
import type { WahaRuntime } from '../waha/waha.client.js';
import {
  createAutomationRunner,
  type AutomationRunnerAgentRuntime,
  type AutomationRunnerEvolution,
  type AutomationRunnerPrisma
} from "../automations/automation-runner.js";
import { createBoardRulesService, type BoardRulesPrismaLike } from "../boards/board-rules.service.js";
import {
  buildPhoneLookupCandidates
} from "../contacts/phone-normalization.js";
import { usableContactName } from "../contacts/contact-name.js";
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
  waha?: WahaRuntime;
  /** Durable private copy of attachments, filled best-effort right after the message is saved. */
  durableMedia?: Pick<import('../conversations/message-media.js').MessageMediaService, 'prepare'>;
  /** Staged rollout: workspaces whose legacy-webhook attachments also get the durable copy. Absent = all. */
  durableMediaWorkspaces?: (workspaceId: string) => boolean;
  evolutionClient?: Pick<import('./evolution.client.js').EvolutionClient, 'fetchMedia'> | null;
  messageHistory?: Pick<EvolutionHistorySource, "findMessage">;
  historyBackfill?: (input: { workspaceId: string; channelId: string; conversationId: string; providerKey: string; remoteJid: string; identity: string; pushName: string | null }) => Promise<void>;
  assistantScheduler?: import('../assistant/assistant-scheduler.js').AssistantScheduler;
  handoffBriefService?: ReturnType<typeof import('../assistant/handoff-brief-service.js').createHandoffBriefService>;
  followupService?: ConversationFollowupsObserver;
  agentImprovements?: AgentImprovementObserver;
  inboxTriage?: InboxTriageObserver;
  webhookSecret: string;
  /** Workspaces whose Evolution webhook now belongs to the independent ingress (ids, or '*' for all). This route refuses
   * them with 409 instead of writing, so a webhook still pointed here fails loudly rather than being dropped or doubled. */
  delegatedWorkspaces?: ReadonlySet<string> | '*';
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

function mapConnectionState(state: string | undefined): ChannelDto["status"] {
  if (state === "open" || state === "connected") return "connected";
  if (state === "connecting") return "connecting";
  if (state === "close" || state === "closed" || state === "disconnected") return "disconnected";
  return "failed";
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
  const describeChannel = (channel: Channel) => app.prisma.channelConnection
    ? createChannelConnectionsService(app.prisma, { waha: options.waha }).describe(channel)
    : Promise.resolve(toChannelDto(channel));
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
    if (options.delegatedWorkspaces === '*' || options.delegatedWorkspaces?.has(workspaceId)) {
      request.log.warn({ event: 'evolution_webhook_delegated_to_ingress', workspaceId }, 'Legacy Evolution webhook refused: this workspace is served by the ingress.');
      return reply.code(409).send({ ok: false, error: 'delegated_to_ingress' });
    }

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
            prospectingOrigin: { select: { campaign: { select: { id: true, name: true } } } },
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

      if (app.prisma.channelConnection) await app.prisma.channelConnection.upsert({
        where: { workspaceId_channelId_provider: { workspaceId, channelId: channel.id, provider: 'evolution' } },
        create: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, status: channel.status, eligible: channel.status === 'connected' },
        update: { status: channel.status, eligible: channel.status === 'connected', ...(channel.status === 'connected' ? { connectedAt: new Date() } : { health: 'unknown' as const }) }
      });

      app.realtime.publish({
        type: "channel.updated",
        workspaceId,
        payload: await describeChannel(channel)
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

      const connection = app.prisma.channelConnection ? await app.prisma.channelConnection.upsert({
        where: { workspaceId_channelId_provider: { workspaceId, channelId: channel.id, provider: 'evolution' } },
        create: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, status: 'connecting' },
        update: { status: 'connecting', eligible: false, health: 'unknown' }
      }) : null;

      app.realtime.publish({
        type: "channel.updated",
        workspaceId,
        payload: await describeChannel(channel)
      });
      app.realtime.publish({
        type: "channel.qr_updated",
        workspaceId,
        payload: {
          channelId: channel.id,
          qrCode,
          expiresAt: qrExpiresAt(),
          ...(connection ? { connectionId: connection.id, provider: 'evolution' as const, issuedAt: new Date().toISOString() } : {})
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

        await lockProspectingConversation(tx, workspaceId, conversation.id);
        const prospectingEcho = await findProspectingOutboundEcho(tx, { workspaceId, conversationId: conversation.id,
          direction: payload.data.key.fromMe ? 'outbound' : 'inbound', body: messageContent.body, mediaUrl: messageContent.mediaUrl });
        const message = prospectingEcho ? await tx.message.update({ where: { id: prospectingEcho.id }, data: {
          providerMessageId: payload.data.key.id, providerEventId: `${payload.event}:${payload.instance}:${payload.data.key.id}`, status: 'sent' } }) : await tx.message.create({
          data: {
            workspaceId,
            conversationId: conversation.id,
            providerMessageId: payload.data.key.id,
            providerEventId: `${payload.event}:${payload.instance}:${payload.data.key.id}`,
            direction: payload.data.key.fromMe ? "outbound" : "inbound",
            type: messageContent.type,
            body: messageContent.body,
            mediaUrl: messageContent.mediaUrl,
            ...(isGroup || messageContent.location || messageContent.contactCards?.length || ['audio', 'image', 'file'].includes(messageContent.type)
              ? { metadata: {
                  ...(isGroup && !payload.data.key.fromMe ? { groupSender: { jid: senderJid, name: pushName } } : {}),
                  ...(messageContent.contactCards?.length ? { contactCards: messageContent.contactCards } : {}),
                  ...(messageContent.location ? { location: messageContent.location } : {}),
                  ...(['audio', 'image', 'file'].includes(messageContent.type) ? { attachment: attachmentPresentation(payload.data.message) } : {})
                } } : {}),
            status: payload.data.key.fromMe ? "sent" : "delivered",
            createdAt: receivedAt
          }
        });

        const campaignDispatchMessage = payload.data.key.fromMe && !isGroup && typeof tx.campaignRecipient?.findFirst === 'function'
          ? await tx.campaignRecipient.findFirst({ where: { workspaceId, channelId: channel.id,
            OR: [{ providerMessageId: payload.data.key.id }, { status: 'in_flight', verifiedAt: { not: null },
              contactSnapshot: { path: ['message'], equals: messageContent.body ?? '' },
              OR: [{ contactId: selectedContact.id }, { phoneSnapshot: { in: candidates } }] }] }, select: { id: true } }) : null;
        const humanTookControl = payload.data.key.fromMe && !isGroup && !campaignDispatchMessage && !prospectingEcho
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
            prospectingOrigin: { select: { campaign: { select: { id: true, name: true } } } },
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
      const prospectingInbound = await observeProspectingInbound(app.prisma, { workspaceId, conversationId: message.conversationId, messageId: message.id, direction: message.direction, type: messageContent.type, body: message.body, createdAt: new Date(message.createdAt), ingestedAt: message.ingestedAt, isGroup, historical: payload.data.type === "append" || payload.data.type === "history" || payload.data.isHistory === true });
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

      if (options.durableMedia && (options.durableMediaWorkspaces?.(workspaceId) ?? true) && ['audio', 'image', 'file'].includes(messageContent.type)) {
        // Best effort and after realtime: every reader still falls back to the legacy path if this fails.
        const client = options.evolutionClient;
        const providerId = payload.data.key.id;
        await options.durableMedia.prepare({ workspaceId, messageId: message.id,
          fetchers: client?.fetchMedia ? [{ name: 'evolution', fetch: async () => ({ mediaUrl: await client.fetchMedia!({ instanceName: payload.instance, id: providerId }) }) }] : [] })
          .catch((error: unknown) => { request.log.warn({ err: error, messageId: message.id }, 'Durable media preparation failed.'); });
      }

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
        if ((!prospectingInbound.reserved || prospectingInbound.liveEligible) && message.type === "audio" && (prospectingInbound.reserved || !await options.assistantScheduler?.isAssisted(workspaceId, message.conversationId))) {
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

        if (!phone.endsWith('@lid') && (!prospectingInbound.reserved || prospectingInbound.liveEligible)) await options.agentReplyScheduler?.scheduleActiveSessionForMessage({
          workspaceId,
          conversationId: message.conversationId,
          messageId: message.id
        }).catch((error: unknown) => {
          request.log.error({ error }, "Failed to schedule agent reply.");
        });
      } else if (!isGroup && humanTookControl && message.direction === "outbound" && messageContent.type !== "system") {
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
