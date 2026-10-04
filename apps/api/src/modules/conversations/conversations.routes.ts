import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createSupervisionService } from "../supervision/supervision.service.js";
import { SupervisionError } from "../supervision/supervision-access.js";
import type { Prisma } from "@prisma/client";
import { inboxViewSchema } from "@prymeira-talk/shared";
import { z } from "zod";
import { createBoardRulesService } from "../boards/board-rules.service.js";
import type { BoardRulesPrismaLike } from "../boards/board-rules.service.js";
import { toChannelDto } from "../channels/channels.service.js";
import { EvolutionClientError, isEvolutionConnectionClosedError } from "../evolution/evolution.client.js";
import { AgentMediaError } from "../agents/agent-media-resolver.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { MetaClientError } from "../meta/meta.client.js";
import { resolveMetaRuntime } from "../meta/meta-runtime.js";
import {
  ConversationActionError,
  ConversationNotFoundError,
  OutboundMessageValidationError,
  createConversationsService,
  toConversationDto,
  toMessageDto
} from "./conversations.service.js";
import { inboxHandoffWhere } from "./conversations.service.js";
import type { PrismaLike } from "./conversations.service.js";
import { createInboxMediaService } from './inbox-media.js';
import { transcribeInboundAudio } from '../agents/inbound-media.js';
import { resolveOpenAiCompatibleSettings } from '../agents/ai-provider-settings.js';
import type { ConversationFollowupsObserver } from "../followups/conversation-followups.service.js";
import type { AgentImprovementObserver } from "../agents/agent-improvements.service.js";
import type { InboxTriageObserver } from "./inbox-triage.service.js";
import { readCurrentClerkUserId, resolveCurrentUserProfileId } from "./current-user.js";
import { pauseAgentOnHumanOutbound } from "./pause-agent-on-human-outbound.js";
import { extractMessageContent, resolveWebhookPhone } from '../evolution/evolution.routes.js';
import { buildPhoneLookupCandidates } from '../contacts/phone-normalization.js';
import type { EvolutionHistorySource } from '../evolution/evolution-history.js';
import { isEncryptedControlEnvelope } from '../evolution/evolution-message-edit.js';

interface ConversationsRoutesOptions {
  publicTalkUrl?: string;
  assistantScheduler?: import('../assistant/assistant-scheduler.js').AssistantScheduler;
  handoffBriefService?: ReturnType<typeof import('../assistant/handoff-brief-service.js').createHandoffBriefService>;
  evolution?: EvolutionRuntime;
  /** Durable private media copies; omitted until the deployment provides a media store. */
  durableMedia?: Pick<import('./message-media.js').MessageMediaService, 'read'>;
  /** Shared transcription job; omitted until the deployment enables durable media. */
  transcriptions?: import('./message-transcription.js').MessageTranscriptionService;
  messageHistory?: Pick<EvolutionHistorySource, 'findMessage'>;
  followupService?: ConversationFollowupsObserver;
  agentImprovements?: AgentImprovementObserver;
  inboxTriage?: InboxTriageObserver;
}

export const createMessageParamsSchema = z.object({
  conversationId: z.string().uuid()
});

const listConversationsQuerySchema = z.object({
  status: z.enum(["active", "closed", "all"]).optional(),
  view: inboxViewSchema.default("all"),
  assignee: z.enum(["me"]).optional(),
  search: z.string().trim().max(100).optional(),
  channelId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional()
});

const createMessageBodySchema = z
  .object({
    body: z.string().trim().min(1).max(4000).optional(),
    attachment: z
      .object({
        fileName: z.string().trim().min(1).max(240),
        mimetype: z.string().trim().min(1).max(160),
        mediaUrl: z.string().min(1)
      })
      .optional(),
    contactCard: z.object({ sourceConversationId: z.string().uuid() }).optional(),
    replyToMessageId: z.string().uuid().optional()
  })
  .refine((body) => body.body || body.attachment || body.contactCard, {
    message: "Message body or attachment is required."
  }).refine((body) => !body.contactCard || (!body.body && !body.attachment), {
    message: "Contact cards must be sent separately."
  });

const conversationPrioritySchema = z.enum(["low", "normal", "high"]);

const conversationActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add_note"),
    body: z.string().trim().min(1).max(1200)
  }),
  z.object({
    action: z.literal("assign_current_user")
  }),
  z.object({
    action: z.literal("change_department"),
    departmentId: z.string().uuid().nullable()
  }),
  z.object({
    action: z.literal("change_priority"),
    priority: conversationPrioritySchema
  }),
  z.object({
    action: z.literal("change_primary_board_stage"),
    stageId: z.string().uuid()
  }),
  z.object({
    action: z.literal("add_tag"),
    name: z.string().trim().min(1).max(80)
  }),
  z.object({
    action: z.literal("remove_tag"),
    tagId: z.string().uuid()
  }),
  z.object({
    action: z.literal("request_ai_suggestion")
  }),
  z.object({
    action: z.literal("create_crm_note")
  }),
  z.object({
    action: z.literal("assume_ai_control")
  }),
  z.object({
    action: z.literal("release_ai_control")
  }),
  z.object({ action: z.literal("complete_handoff_action") }),
  z.object({ action: z.literal("reopen_handoff_action") }),
  z.object({ action: z.literal("reanalyze_handoff_reply") }),
  z.object({
    action: z.literal("close_conversation")
  })
]);

function requireConversationResetOwner(
  role: "owner" | "manager" | "agent",
  reply: FastifyReply
) {
  if (role === "owner") return true;

  reply.code(403).send({
    code: "CONVERSATION_RESET_FORBIDDEN",
    error: "Only the workspace owner can reset a conversation."
  });
  return false;
}

/** What WhatsApp needs to quote a message of this conversation (or of one retired into it): its stanza id, who sent it
 * and its text. Null when the message has no WhatsApp id (e.g. a note, or a send that never left). */
async function replyReference(prisma: FastifyInstance['prisma'], workspaceId: string, conversationId: string, messageId: string) {
  const record = await prisma.message.findFirst({ where: { workspaceId, id: messageId,
    OR: [{ conversationId }, { conversation: { retiredIntoConversationId: conversationId } }] } });
  if (!record) return null;
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata as Record<string, unknown> : {};
  const whatsapp = (metadata.whatsapp && typeof metadata.whatsapp === 'object' ? metadata.whatsapp : {}) as Record<string, unknown>;
  const groupSender = (metadata.groupSender && typeof metadata.groupSender === 'object' ? metadata.groupSender : {}) as Record<string, unknown>;
  const identity = typeof whatsapp.id === 'string' || !prisma.canonicalMessageIdentity ? null : await prisma.canonicalMessageIdentity.findFirst({ where: { workspaceId, messageId: record.id, identityFormat: 'whatsapp_stanza' }, select: { rawId: true } });
  const legacy = record.providerMessageId && !record.providerMessageId.includes('_') && !record.providerMessageId.startsWith('wamid.') ? record.providerMessageId : null;
  const id = typeof whatsapp.id === 'string' ? whatsapp.id : identity?.rawId ?? legacy;
  if (!id) return null;
  const participant = typeof whatsapp.participant === 'string' ? whatsapp.participant : typeof groupSender.jid === 'string' ? groupSender.jid : null;
  return { id, fromMe: record.direction === 'outbound', participant: record.direction === 'outbound' ? null : participant, body: record.body?.slice(0, 500) ?? null };
}

export const conversationsRoutes: FastifyPluginAsync<ConversationsRoutesOptions> = async (
  app,
  options
) => {
  const mediaService = createInboxMediaService({ prisma: app.prisma, client: options.evolution?.client, durable: options.durableMedia ?? null });
  app.post('/conversations/:conversationId/messages/:messageId/delete-for-everyone', async (request, reply) => {
    const params = z.object({ conversationId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Mensagem inválida.' });
    const workspaceId = request.talk.workspaceId;
    const record = await app.prisma.message.findFirst({
      where: { id: params.data.messageId, conversationId: params.data.conversationId, workspaceId },
      include: { conversation: { include: { channel: true, contact: true } } }
    });
    if (!record) return reply.code(404).send({ error: 'Mensagem não encontrada.' });
    const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown> : {};
    if (typeof metadata.deletedAt === 'string') return toMessageDto(record);
    const client = options.evolution?.client;
    // Messages written by the canonical writer keep their WhatsApp id in metadata/identity, not in providerMessageId.
    const reference = record.direction === 'outbound' ? await replyReference(app.prisma, workspaceId, record.conversationId, record.id) : null;
    if (options.evolution?.mode !== 'real' || !client?.deleteMessageForEveryone ||
      record.conversation.channel.provider !== 'evolution' || record.conversation.contact.isGroup ||
      record.direction !== 'outbound' ||
      !reference || record.status === 'pending' || record.status === 'failed') {
      return reply.code(409).send({ error: 'Esta mensagem não pode ser apagada para todos.' });
    }
    const phone = record.conversation.contact.phone;
    const remoteJid = /^\d+@lid$/.test(phone) ? phone
      : /^\d{8,15}$/.test(phone) ? `${phone}@s.whatsapp.net` : null;
    if (!remoteJid) return reply.code(409).send({ error: 'Destino do WhatsApp inválido.' });
    try {
      await client.deleteMessageForEveryone({
        instanceName: record.conversation.channel.providerKey,
        id: reference.id, remoteJid, fromMe: true
      });
    } catch (error) {
      request.log.warn({ err: error, messageId: record.id }, 'Evolution failed to revoke message.');
      return reply.code(502).send({ error: 'O WhatsApp não confirmou a exclusão. A mensagem continua visível no Talk.' });
    }
    const updated = await app.prisma.message.update({
      where: { id: record.id }, data: {
        type: 'system', body: 'Você apagou esta mensagem', mediaUrl: null,
        metadata: { ...(metadata.whatsapp ? { whatsapp: metadata.whatsapp } : {}), deletedAt: new Date().toISOString() } as Prisma.InputJsonValue
      }
    });
    await app.prisma.conversation.updateMany({
      where: { id: record.conversationId, workspaceId, lastMessageAt: record.createdAt },
      data: { lastMessagePreview: 'Você apagou esta mensagem' }
    });
    const conversation = await app.prisma.conversation.findUnique({
      where: { workspaceId_id: { workspaceId, id: record.conversationId } },
      include: { assignedUser: { select: { displayName: true } },
        channel: { select: { displayName: true, phoneNumber: true, provider: true } },
        contact: { select: { name: true, phone: true, isGroup: true } },
        department: { select: { name: true } } }
    });
    const dto = toMessageDto(updated);
    app.realtime.publish({ type: 'message.updated', workspaceId, payload: dto });
    if (conversation) app.realtime.publish({ type: 'conversation.updated', workspaceId, payload: toConversationDto(conversation) });
    return dto;
  });
  app.post('/conversations/:conversationId/messages/:messageId/recognize-contact', async (request, reply) => {
    const params = z.object({ conversationId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Mensagem inválida.' });
    const workspaceId = request.talk.workspaceId;
    const message = await app.prisma.message.findFirst({ where: {
      id: params.data.messageId, conversationId: params.data.conversationId, workspaceId,
      type: 'system', body: 'Mensagem não reconhecida'
    } });
    if (!message?.providerMessageId) return reply.code(404).send({ error: 'Mensagem não encontrada.' });
    const conversation = await app.prisma.conversation.findFirst({ where: { id: params.data.conversationId, workspaceId },
      include: { channel: true, contact: true } });
    if (!conversation || conversation.channel.provider !== 'evolution' || !options.messageHistory) {
      return reply.code(404).send({ error: 'Histórico indisponível.' });
    }
    try {
      const original = await options.messageHistory.findMessage({ instanceName: conversation.channel.providerKey, id: message.providerMessageId });
      const phone = original && resolveWebhookPhone(original.key.remoteJid, original.key.remoteJidAlt);
      const matchesContact = conversation.contact.isGroup
        ? original?.key.remoteJid === conversation.contact.phone
        : phone && (phone === conversation.contact.phone ||
          (!phone.endsWith('@lid') && buildPhoneLookupCandidates(phone).includes(conversation.contact.phone)));
      if (!original || original.key.id !== message.providerMessageId || !matchesContact ||
        original.key.fromMe !== (message.direction === 'outbound')) {
        return reply.code(404).send({ error: 'Contato não encontrado no histórico.' });
      }
      if (isEncryptedControlEnvelope({ message: original.message })) {
        await app.prisma.message.delete({ where: { id: message.id } });
        const previous = await app.prisma.message.findFirst({
          where: { workspaceId, conversationId: conversation.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
        });
        await app.prisma.conversation.updateMany({
          where: { id: conversation.id, workspaceId, lastMessagePreview: 'Mensagem não reconhecida',
            lastMessageAt: message.createdAt },
          data: { lastMessagePreview: previous?.body ?? null,
            lastMessageAt: previous?.createdAt ?? null,
            lastMessagePreviewAt: previous?.createdAt ?? null }
        });
        app.realtime.publish({ type: 'message.deleted', workspaceId,
          payload: { messageId: message.id, conversationId: conversation.id } });
        return { removedMessageId: message.id };
      }
      const content = extractMessageContent(original.message, original.messageType);
      if (!content.contactCards?.length && !content.location) return reply.code(422).send({ error: 'Esta mensagem não é um contato ou uma localização.' });
      const updated = await app.prisma.message.update({ where: { id: message.id }, data: {
        type: 'text', body: content.body,
        metadata: { ...(message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
          ? message.metadata as Record<string, unknown> : {}),
          ...(content.contactCards?.length ? { contactCards: content.contactCards } : {}),
          ...(content.location ? { location: content.location } : {}) }
      } });
      await app.prisma.conversation.updateMany({ where: { id: conversation.id, workspaceId,
        lastMessagePreview: 'Mensagem não reconhecida', lastMessageAt: message.createdAt }, data: { lastMessagePreview: content.preview } });
      const dto = toMessageDto(updated);
      app.realtime.publish({ type: 'message.updated', workspaceId, payload: dto });
      return dto;
    } catch (error) {
      request.log.warn({ err: error, messageId: message.id }, 'Unknown message recovery failed.');
      return reply.code(503).send({ error: 'Não foi possível recuperar a mensagem agora.' });
    }
  });
  app.get('/conversations/:conversationId/messages/:messageId/preview', async (request, reply) => {
    const params = z.object({ conversationId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(request.params);
    const query = z.object({ page: z.coerce.number().int().min(1).max(2000).default(1) }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'Invalid PDF preview request.' });
    try {
      const media = await mediaService.preview(request.talk.workspaceId, params.data.conversationId, params.data.messageId, query.data.page);
      return reply.header('Cache-Control', 'private, no-store').send({ imageUrl: `data:image/png;base64,${media.bytes.toString('base64')}`, pages: media.pageCount });
    } catch (error) {
      return reply.code(error instanceof Error && error.message === 'NOT_FOUND' ? 404 : 422).send({ error: 'Não foi possível abrir a prévia deste PDF.' });
    }
  });
  app.get('/conversations/:conversationId/messages/:messageId/media', async (request, reply) => {
    const params = z.object({ conversationId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid media request.' });
    try {
      const media = await mediaService.media(request.talk.workspaceId, params.data.conversationId, params.data.messageId);
      return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
        .type(media.mimeType).send(media.bytes);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return reply.code(code === 'NOT_FOUND' ? 404 : code === 'MEDIA_BUSY' ? 429 : 422)
        .send({ error: 'Não foi possível carregar o anexo. Tente novamente.' });
    }
  });
  app.get('/conversations/:conversationId/messages/:messageId/poster', async (request, reply) => {
    const params = z.object({ conversationId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid poster request.' });
    try {
      const poster = await mediaService.poster(request.talk.workspaceId, params.data.conversationId, params.data.messageId);
      return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').type(poster.mimeType).send(poster.bytes);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      // No poster is not an error for the reader: the bubble keeps its plain play tile.
      return reply.code(code === 'NOT_FOUND' ? 404 : code === 'MEDIA_BUSY' ? 429 : 204).send();
    }
  });
  app.post('/conversations/:conversationId/messages/:messageId/transcription', async (request, reply) => {
    const params = z.object({ conversationId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Áudio inválido.' });
    const { conversationId, messageId } = params.data;
    const workspaceId = request.talk.workspaceId;
    const message = await app.prisma.message.findFirst({ where: { id: messageId, conversationId, workspaceId, type: 'audio' } });
    if (!message) return reply.code(404).send({ error: 'Áudio não encontrado.' });
    const existing = message.body?.trim();
    if (existing && !/^(Áudio recebido|Áudio enviado|Processando áudio\.\.\.|Não foi possível transcrever este áudio\.)$/i.test(existing)) {
      return reply.send({ text: existing });
    }
    try {
      const transcribe = async () => {
        const media = await mediaService.media(workspaceId, conversationId, messageId);
        const settings = await resolveOpenAiCompatibleSettings(app.prisma, { workspaceId });
        return transcribeInboundAudio({ bytes: media.bytes, mimeType: media.mimeType, settings });
      };
      if (options.transcriptions && (options.transcriptions.appliesTo?.(workspaceId) ?? true)) {
        // Same job the automatic path uses: a transcription already running or finished is shared, not repeated.
        const outcome = await options.transcriptions.run({ workspaceId, conversationId, messageId, retryFailed: true,
          work: async () => ({ text: (await transcribe()).text }) });
        if (outcome.status !== 'completed') throw new Error(outcome.status === 'failed' ? outcome.errorCode : 'TRANSCRIPTION_IN_PROGRESS');
        if (outcome.message) app.realtime.publish({ type: 'message.created', workspaceId, payload: toMessageDto(outcome.message) });
        return reply.send({ text: outcome.text });
      }
      const result = await transcribe();
      const updated = await app.prisma.message.update({ where: { id: messageId }, data: { body: result.text } });
      app.realtime.publish({ type: 'message.created', workspaceId, payload: toMessageDto(updated) });
      return reply.send({ text: result.text });
    } catch (error) {
      request.log.warn({ err: error, conversationId, messageId }, 'Audio transcription requested from inbox failed.');
      return reply.code(422).send({ error: 'Não foi possível transcrever este áudio. Tente novamente.' });
    }
  });
  app.get('/conversations/:conversationId/contact-photo', async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid photo request.' });
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    try {
      const photo = await mediaService.photo(request.talk.workspaceId, params.data.conversationId);
      return photo ? reply.type(photo.mimeType).send(photo.bytes) : reply.code(204).send();
    } catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND') return reply.code(404).send();
      request.log.warn({
        event: 'contact_photo_fetch_failed',
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId,
        reason: error instanceof AgentMediaError ? error.code
          : error instanceof EvolutionClientError ? `EVOLUTION_HTTP_${error.statusCode}`
          : error instanceof Error ? error.name : 'unknown'
      }, 'Failed to fetch contact photo');
      return reply.code(503).send({ error: 'Não foi possível carregar a foto do contato.' });
    }
  });
  app.get('/conversations/:conversationId/card-photo/:phone', async (request, reply) => {
    const params = z.object({ conversationId: z.string().uuid(), phone: z.string().regex(/^\d{8,15}$/) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid photo request.' });
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    try {
      const photo = await mediaService.photoForPhone(request.talk.workspaceId, params.data.conversationId, params.data.phone);
      return photo ? reply.type(photo.mimeType).send(photo.bytes) : reply.code(204).send();
    } catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND') return reply.code(404).send();
      return reply.code(204).send();
    }
  });
  app.get('/channels/:channelId/photo', async (request, reply) => {
    const params = z.object({ channelId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid photo request.' });
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    try {
      const photo = await mediaService.channelPhoto(request.talk.workspaceId, params.data.channelId);
      return photo ? reply.type(photo.mimeType).send(photo.bytes) : reply.code(204).send();
    } catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND') return reply.code(404).send();
      request.log.warn({ event: 'channel_photo_fetch_failed', workspaceId: request.talk.workspaceId, channelId: params.data.channelId,
        reason: error instanceof Error ? error.name : 'unknown' }, 'Failed to fetch channel photo');
      return reply.code(204).send();
    }
  });
  const service = createConversationsService(app.prisma as unknown as PrismaLike, {
    publicTalkUrl: options.publicTalkUrl,
    evolution: options.evolution
  });

  app.get("/conversations", async (request, reply) => {
    const query = listConversationsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid conversations request." });
    }

    const assignedUserId = query.data.assignee === "me"
      ? await resolveCurrentUserProfileId({
          prisma: app.prisma as unknown as PrismaLike,
          workspaceId: request.talk.workspaceId,
          clerkUserId: request.talk.clerkUserId,
          authorizationHeader: request.headers.authorization
      })
      : null;

    if (query.data.assignee === "me" && !assignedUserId) {
      return [];
    }

    return service.listConversations({
      workspaceId: request.talk.workspaceId,
      status: query.data.status,
      assignedUserId: query.data.assignee === "me" ? assignedUserId : null,
      channelId: query.data.channelId,
      search: query.data.search,
      cursor: query.data.cursor,
      view: query.data.view
    });
  });

  app.get("/conversations/attention-count", async (request, reply) => {
    const query = z.object({ channelId: z.string().uuid().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid attention count request." });
    const count = await app.prisma.conversation.count({
      where: {
        workspaceId: request.talk.workspaceId,
        ...(query.data.channelId ? { channelId: query.data.channelId } : {}),
        retiredIntoConversationId: null,
        ...inboxHandoffWhere
      }
    });
    return { count };
  });

  app.get("/conversations/:conversationId/messages", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);
    const query = z.object({ compactMedia: z.enum(['0', '1']).optional() }).safeParse(request.query);

    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Invalid conversation message request." });
    }

    const messages = await service.listMessages({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId,
      compactMedia: query.data.compactMedia === '1'
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      throw error;
    });

    if (!messages) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    return messages;
  });

  app.get("/conversations/:conversationId/context", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid conversation context request." });
    }

    const context = await service.getContactContext({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      throw error;
    });

    if (!context) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    return context;
  });

  app.post("/conversations/:conversationId/read", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid conversation read request." });
    }

    const conversation = await service.markConversationRead({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      throw error;
    });

    if (!conversation) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    app.realtime.publish({
      type: "conversation.updated",
      workspaceId: request.talk.workspaceId,
      payload: conversation
    });

    return conversation;
  });

  app.post("/conversations/:conversationId/reset", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid conversation reset request." });
    }

    if (!requireConversationResetOwner(request.talk.role, reply)) {
      return reply;
    }

    const actorUserId = await resolveCurrentUserProfileId({
      prisma: app.prisma as unknown as PrismaLike,
      workspaceId: request.talk.workspaceId,
      clerkUserId: request.talk.clerkUserId,
      authorizationHeader: request.headers.authorization
    });
    const result = await service.resetConversation({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId,
      actorUserId
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) return null;
      throw error;
    });

    if (!result) {
      return reply.code(404).send({
        code: "CONVERSATION_NOT_FOUND",
        error: "Conversation not found."
      });
    }

    app.realtime.publish({
      type: "conversation.updated",
      workspaceId: request.talk.workspaceId,
      payload: result.conversation
    });

    return result;
  });

  app.post("/conversations/:conversationId/actions", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);
    const body = conversationActionBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid conversation action request." });
    }

    if (body.data.action === "assume_ai_control" || body.data.action === "release_ai_control") {
      const actorUserId = await resolveCurrentUserProfileId({
        prisma: app.prisma as unknown as PrismaLike,
        workspaceId: request.talk.workspaceId,
        clerkUserId: request.talk.clerkUserId,
        authorizationHeader: request.headers.authorization
      });
      const conversation = await service.updateAiControl({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId,
        status: body.data.action === "assume_ai_control" ? "human_controlled" : "agent_allowed",
        actorUserId
      }).catch((error: unknown) => {
        if (error instanceof ConversationNotFoundError) {
          return null;
        }

        throw error;
      });

      if (!conversation) {
        return reply
          .code(404)
          .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
      }

      const context = await service.getContactContext({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId
      });

      await options.assistantScheduler?.control(request.talk.workspaceId, params.data.conversationId, body.data.action === 'assume_ai_control');
      const result = { conversation, context };

      app.realtime.publish({
        type: "conversation.updated",
        workspaceId: request.talk.workspaceId,
        payload: result.conversation
      });

      return result;
    }

    if (body.data.action === "complete_handoff_action" || body.data.action === "reopen_handoff_action" || body.data.action === "reanalyze_handoff_reply") {
      const action = body.data.action;
      const actorUserId = action === "complete_handoff_action" ? await resolveCurrentUserProfileId({
        prisma: app.prisma as unknown as PrismaLike,
        workspaceId: request.talk.workspaceId,
        clerkUserId: request.talk.clerkUserId,
        authorizationHeader: request.headers.authorization
      }) : null;
      const conversation = await service.updateHandoffAction({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId,
        completed: action === "reanalyze_handoff_reply" ? undefined : action === "complete_handoff_action",
        actorUserId
      }).catch((error: unknown) => {
        if (error instanceof ConversationNotFoundError) return null;
        if (error instanceof ConversationActionError) return error;
        throw error;
      });
      if (!conversation) return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
      if (conversation instanceof ConversationActionError) {
        return reply.code(conversation.statusCode).send({ code: conversation.code, error: conversation.message });
      }
      if (action === "complete_handoff_action") {
        await options.assistantScheduler?.handoffCompleted(request.talk.workspaceId, params.data.conversationId);
      } else if (action === "reopen_handoff_action") {
        await options.assistantScheduler?.control(request.talk.workspaceId, params.data.conversationId, true);
      }
      const context = await service.getContactContext({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId
      });
      let improvementAnalysis: { created: boolean; reason?: string } | null = null;
      if (action !== "reopen_handoff_action") {
        try {
          improvementAnalysis = await options.agentImprovements?.observeLatestHumanReplyAfterHandoff({
            workspaceId: request.talk.workspaceId,
            conversationId: params.data.conversationId
          }) ?? { created: false, reason: "analysis_unavailable" };
          request.log.info({
            event: "agent_improvement_observation",
            source: action,
            workspaceId: request.talk.workspaceId,
            conversationId: params.data.conversationId,
            outcome: improvementAnalysis.created ? "created" : "skipped",
            reason: improvementAnalysis.reason ?? null
          }, "Agent improvement observation completed.");
        } catch (error) {
          request.log.error({ error, event: "agent_improvement_observation_failed", source: action, workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId }, "Failed to analyze human handoff reply");
          improvementAnalysis = { created: false, reason: "analysis_failed" };
        }
      }
      app.realtime.publish({
        type: "conversation.updated",
        workspaceId: request.talk.workspaceId,
        payload: conversation
      });
      return { conversation, context, improvementAnalysis };
    }

    const result = await service.runConversationAction({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId,
      currentClerkUserId: readCurrentClerkUserId(request.headers.authorization),
      ...body.data
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      if (error instanceof ConversationActionError) {
        return error;
      }

      throw error;
    });

    if (!result) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    if (result instanceof ConversationActionError) {
      return reply.code(result.statusCode).send({ code: result.code, error: result.message });
    }

    if (result.appliedTag) {
      const ruleService = createBoardRulesService(app.prisma as unknown as BoardRulesPrismaLike);
      await ruleService.applyBoardRulesForConversationTags({
        workspaceId: request.talk.workspaceId,
        conversationId: result.appliedTag.conversationId,
        publish: (event) => app.realtime.publish(event)
      });
    }

    app.realtime.publish({
      type: "conversation.updated",
      workspaceId: request.talk.workspaceId,
      payload: result.conversation
    });

    if (result.boardMembership) {
      app.realtime.publish({
        type: "board_membership.updated",
        workspaceId: request.talk.workspaceId,
        payload: result.boardMembership
      });
    }

    return result;
  });

  /** One outbound path for the seller and for a supervisor answering in their place: same agent pause, delivery,
   * triage, follow-ups and realtime. Only where the workspace comes from, and the message's marks, differ. */
  const sent = (code: number, payload: unknown) => ({ code, payload });
  async function createMessage(request: FastifyRequest, scope: { workspaceId: string; conversationId: string; metadata?: Record<string, unknown>;
    /** A card already known (a forwarded one), instead of the contact of `body.contactCard.sourceConversationId`. */
    contactCard?: { fullName: string; phoneNumber: string } },
    body: { data: z.infer<typeof createMessageBodySchema> }): Promise<{ code: number; payload: unknown }> {

    let contactCard: { fullName: string; phoneNumber: string } | undefined = scope.contactCard;
    if (contactCard && (options.evolution?.mode !== "real" || !options.evolution.client?.sendContact)) {
      return sent(409, { code: "CONTACT_CARD_NOT_SUPPORTED", error: "O envio de contatos não está disponível neste canal." });
    }
    if (body.data.contactCard && !contactCard) {
      if (options.evolution?.mode !== "real" || !options.evolution.client?.sendContact) {
        return sent(409, { code: "CONTACT_CARD_NOT_SUPPORTED", error: "O envio de contatos não está disponível neste canal." });
      }
      const source = await app.prisma.conversation.findFirst({
        where: { id: body.data.contactCard.sourceConversationId, workspaceId: scope.workspaceId },
        select: { contact: { select: { name: true, phone: true } } }
      });
      if (!source?.contact.phone) return sent(404, { error: "Contato de origem não encontrado." });
      contactCard = {
        fullName: source.contact.name?.trim() || source.contact.phone,
        phoneNumber: source.contact.phone
      };
    }

    const meta = await resolveMetaRuntime(app.prisma, { workspaceId: scope.workspaceId });
    const writeService = createConversationsService(app.prisma as unknown as PrismaLike, {
      evolution: options.evolution,
      meta: {
        client: meta.client,
        phoneNumberId: meta.phoneNumberId
      },
      metaEvolution: {
        client: meta.evolutionClient?.sendText ? {
          sendText: meta.evolutionClient.sendText.bind(meta.evolutionClient)
        } : null
      }
    });

    // Take control before the provider send: an agent run may be in progress.
    const humanTookControl = await app.prisma.$transaction((tx) =>
      pauseAgentOnHumanOutbound(tx, {
        workspaceId: scope.workspaceId,
        conversationId: scope.conversationId
      })
    );
    if (humanTookControl) {
      request.log.info({ event: "human_outbound_paused_agent", workspaceId: scope.workspaceId, conversationId: scope.conversationId }, "Talk outbound message paused the agent.");
      await options.assistantScheduler?.control(scope.workspaceId, scope.conversationId, true).catch((error: unknown) => {
        request.log.error({ error, workspaceId: scope.workspaceId, conversationId: scope.conversationId }, "Failed to pause assistant suggestions after Talk outbound message.");
      });
    }

    const quoted = body.data.replyToMessageId && body.data.body && !body.data.attachment
      ? await replyReference(app.prisma, scope.workspaceId, scope.conversationId, body.data.replyToMessageId) : null;
    const result = await writeService.createPendingOutboundMessage({
      workspaceId: scope.workspaceId,
      conversationId: scope.conversationId,
      body: body.data.body,
      attachment: body.data.attachment,
      contactCard,
      sentByUserId: null,
      ...(scope.metadata ? { metadata: scope.metadata } : {}),
      ...(quoted ? { quoted } : {})
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      if (
        error instanceof OutboundMessageValidationError ||
        error instanceof EvolutionClientError ||
        error instanceof MetaClientError
      ) {
        return error;
      }

      throw error;
    });

    if (!result) {
      return sent(404, { code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    if (result instanceof OutboundMessageValidationError) {
      return sent(result.statusCode, { code: result.code, error: result.message });
    }

    if (result instanceof EvolutionClientError) {
      request.log.error({
        event: "evolution_outbound_rejected",
        workspaceId: scope.workspaceId,
        conversationId: scope.conversationId,
        messageType: body.data.contactCard ? "contact_card" : body.data.attachment ? "attachment" : "text",
        providerStatus: result.statusCode,
        providerResponse: result.responseBody
      }, "Evolution rejected an outbound message.");

      if (isEvolutionConnectionClosedError(result)) {
        const degraded = await app.prisma.channel.updateMany({
          where: {
            workspaceId: scope.workspaceId,
            provider: "evolution",
            status: "connected",
            conversations: { some: { id: scope.conversationId } }
          },
          data: { status: "failed" }
        }).catch((error: unknown) => {
          request.log.error({ err: error, conversationId: scope.conversationId }, "Failed to mark Evolution channel as unhealthy after closed connection.");
          return { count: 0 };
        });
        if (degraded.count > 0) {
          const channel = await app.prisma.channel.findFirst({
            where: {
              workspaceId: scope.workspaceId,
              provider: "evolution",
              conversations: { some: { id: scope.conversationId } }
            }
          }).catch((error: unknown) => {
            request.log.error({ err: error, conversationId: scope.conversationId }, "Failed to load degraded Evolution channel.");
            return null;
          });
          if (channel) app.realtime.publish({ type: "channel.updated", workspaceId: scope.workspaceId, payload: toChannelDto(channel) });
        }
        return sent(502, {
          code: "EVOLUTION_CONNECTION_CLOSED",
          error: "A conexão do WhatsApp fechou durante o envio. Confira a conversa do destinatário antes de tentar novamente e reconecte o canal em Canais se o problema continuar."
        });
      }

      return sent(502, {
        code: "EVOLUTION_SEND_FAILED",
        error: "A Evolution recusou o envio. Tente novamente após conferir a conexão do canal."
      });
    }

    if (result instanceof MetaClientError) {
      return sent(502, {
        code: "META_SEND_FAILED",
        error: "Meta did not accept the outbound message."
      });
    }

    if (!result.conversation.isGroup && result.message.status !== "pending") {
      await options.inboxTriage?.observeMessage({
        workspaceId: scope.workspaceId, conversationId: scope.conversationId,
        messageId: result.message.id, direction: "outbound", observedAt: new Date()
      }).catch((error: unknown) => {
        request.log.error({ err: error, conversationId: scope.conversationId }, "Inbox triage observation failed");
      });
    }

    if (!result.conversation.isGroup) await options.followupService?.observeConversationActivity({
      workspaceId: scope.workspaceId,
      conversationId: scope.conversationId,
      messageId: result.message.id,
      direction: "outbound",
      source: "human"
    }).catch((error: unknown) => {
      request.log.error({ error }, "Failed to observe human outbound follow-up.");
    });
    if (!result.conversation.isGroup && options.agentImprovements) {
      void options.agentImprovements.observeHumanReply({
        workspaceId: scope.workspaceId,
        conversationId: scope.conversationId,
        messageId: result.message.id
      }).then((analysis) => {
        request.log.info({
          event: "agent_improvement_observation",
          source: "talk_outbound",
          workspaceId: scope.workspaceId,
          conversationId: scope.conversationId,
          messageId: result.message.id,
          outcome: analysis.created ? "created" : "skipped",
          reason: analysis.reason ?? null
        }, "Agent improvement observation completed.");
      }).catch((error: unknown) => {
        request.log.error({ error, event: "agent_improvement_observation_failed", source: "talk_outbound", workspaceId: scope.workspaceId, conversationId: scope.conversationId, messageId: result.message.id }, "Failed to prepare agent improvement suggestion.");
      });
    }
    if (!result.conversation.isGroup && !humanTookControl) {
      await options.assistantScheduler?.message({ workspaceId: scope.workspaceId, conversationId: scope.conversationId, messageId: result.message.id, direction: 'outbound' });
    }
    if (!result.conversation.isGroup) options.handoffBriefService?.schedule({ workspaceId: scope.workspaceId, conversationId: scope.conversationId });
    app.realtime.publish({
      type: "message.created",
      workspaceId: scope.workspaceId,
      payload: result.message
    });
    app.realtime.publish({
      type: "conversation.updated",
      workspaceId: scope.workspaceId,
      payload: result.conversation
    });

    return sent(201, result.message);
  }

  // A 25 MB attachment travels as a data URL (4/3 of its size) inside JSON.
  app.post("/conversations/:conversationId/messages", { bodyLimit: 36 * 1024 * 1024 }, async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);
    const body = createMessageBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid conversation message request." });
    }
    const result = await createMessage(request, { workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId }, body);
    return reply.code(result.code).send(result.payload);
  });

  // A supervisor may answer a customer of a seller they supervise (text only). The message goes out through the
  // seller's channel like any other, marked so the seller sees in Talk that the supervisor answered.
  app.post("/supervision/workspaces/:workspaceId/conversations/:conversationId/messages", async (request, reply) => {
    const params = z.object({ workspaceId: z.string().uuid(), conversationId: z.string().uuid() }).safeParse(request.params);
    const body = createMessageBodySchema.safeParse(request.body);
    if (!params.success || !body.success || !body.data.body || body.data.attachment || body.data.contactCard) {
      return reply.code(400).send({ error: "Escreva a resposta do supervisor." });
    }
    if (request.supervision?.kind !== "viewer") return reply.code(403).send({ error: "Acesso de supervisão necessário." });
    const grants = request.supervision.grants;
    try { await createSupervisionService(app.prisma).authorizedConversation(grants, params.data.workspaceId, params.data.conversationId); }
    catch (error) {
      if (error instanceof SupervisionError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
    const grant = grants.find(item => item.workspace_id === params.data.workspaceId);
    const result = await createMessage(request, { workspaceId: params.data.workspaceId, conversationId: params.data.conversationId,
      metadata: { supervisorReply: { supervisorCustomerId: grant?.supervisor_customer_id ?? null, at: new Date().toISOString() } } }, body);
    return reply.code(result.code).send(result.payload);
  });

  // Forward, like WhatsApp: the chosen messages (texts, files, contact cards) go out again, in their order, to up to five
  // other conversations, each through its own channel. The customer receives normal messages; Talk marks them
  // "Encaminhada" for the team.
  app.post("/conversations/:conversationId/forward", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);
    const body = z.object({ messageIds: z.array(z.string().uuid()).min(1).max(20), targetConversationIds: z.array(z.string().uuid()).min(1).max(5) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Escolha até 20 mensagens e até 5 conversas." });
    const workspaceId = request.talk.workspaceId;
    const sources = await app.prisma.message.findMany({
      where: { workspaceId, conversationId: params.data.conversationId, id: { in: [...new Set(body.data.messageIds)] } },
      select: { id: true, type: true, body: true, metadata: true, createdAt: true }, orderBy: { createdAt: "asc" }
    });
    if (!sources.length) return reply.code(404).send({ error: "Mensagem não encontrada." });
    type Outgoing = { messageId: string; payload: z.infer<typeof createMessageBodySchema>; contactCard?: { fullName: string; phoneNumber: string } };
    const outgoing: Outgoing[] = [];
    for (const source of sources) {
      const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata as Record<string, unknown> : {};
      if (metadata.deletedAt || metadata.reaction) continue;
      const attachment = metadata.attachment && typeof metadata.attachment === "object" ? metadata.attachment as Record<string, unknown> : {};
      const cards = (Array.isArray(metadata.contactCards) ? metadata.contactCards : metadata.contactCard ? [metadata.contactCard] : [])
        .map(raw => raw && typeof raw === "object" ? raw as Record<string, unknown> : {})
        .map(card => ({ fullName: typeof card.fullName === "string" ? card.fullName.trim() : "", phoneNumber: typeof card.phoneNumber === "string" ? card.phoneNumber.replace(/\D/g, "") : "" }))
        .filter(card => card.phoneNumber.length >= 8);
      if (cards.length || metadata.contactCards || metadata.contactCard) {
        for (const card of cards) outgoing.push({ messageId: source.id, payload: {}, contactCard: { fullName: card.fullName || card.phoneNumber, phoneNumber: card.phoneNumber } });
      } else if (["image", "audio", "file"].includes(source.type)) {
        let media: { bytes: Buffer; mimeType: string };
        try { media = await mediaService.media(workspaceId, params.data.conversationId, source.id); }
        catch { return reply.code(409).send({ code: "FORWARD_MEDIA_UNAVAILABLE", error: "Não foi possível abrir um dos arquivos para encaminhar." }); }
        const caption = typeof attachment.caption === "string" && attachment.caption.trim() ? attachment.caption.trim().slice(0, 4000) : undefined;
        const extension = media.mimeType.split("/")[1]?.split(/[;+]/)[0] || "bin";
        const fileName = typeof attachment.fileName === "string" && attachment.fileName.trim() ? attachment.fileName.trim().slice(0, 240) : `arquivo.${extension}`;
        outgoing.push({ messageId: source.id, payload: { attachment: { fileName, mimetype: media.mimeType, mediaUrl: `data:${media.mimeType};base64,${media.bytes.toString("base64")}` }, ...(caption ? { body: caption } : {}) } });
      } else if ((source.type === "text" || source.type === "template") && source.body?.trim() && !metadata.location) {
        outgoing.push({ messageId: source.id, payload: { body: source.body.trim().slice(0, 4000) } });
      }
    }
    if (!outgoing.length) return reply.code(409).send({ code: "FORWARD_NOT_SUPPORTED", error: "Estas mensagens ainda não podem ser encaminhadas." });
    const targets = [...new Set(body.data.targetConversationIds)].filter(id => id !== params.data.conversationId);
    const results: Array<{ conversationId: string; ok: boolean; sent: number; error?: string }> = [];
    for (const conversationId of targets) {
      let sentCount = 0; let error: string | undefined;
      for (const item of outgoing) {
        const result = await createMessage(request, { workspaceId, conversationId, ...(item.contactCard ? { contactCard: item.contactCard } : {}),
          metadata: { forwarded: { fromConversationId: params.data.conversationId, fromMessageId: item.messageId, at: new Date().toISOString() } } }, { data: item.payload });
        if (result.code >= 400) {
          const message = result.payload && typeof result.payload === "object" ? (result.payload as { error?: unknown }).error : undefined;
          error = typeof message === "string" ? message : "Falha ao enviar."; break;
        }
        sentCount++;
      }
      results.push(error ? { conversationId, ok: false, sent: sentCount, error } : { conversationId, ok: true, sent: sentCount });
    }
    request.log.info({ event: "message_forwarded", workspaceId, messages: outgoing.length, targets: targets.length, failed: results.filter(item => !item.ok).length }, "Messages forwarded.");
    return reply.code(results.some(item => item.ok) ? 200 : 502).send({ results, total: outgoing.length });
  });
};
