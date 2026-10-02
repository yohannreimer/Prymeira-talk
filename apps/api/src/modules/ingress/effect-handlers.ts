import type { PrismaClient } from '@prisma/client';
import type { RealtimeEvent } from '@prymeira-talk/shared';
import { conversationDtoInclude, toConversationDto, toMessageDto } from '../conversations/conversations.service.js';
import { observeProspectingInbound } from '../prospecting/prospecting-lifecycle.js';
import { groupFallbackName } from '../evolution/evolution-normalizer.js';
import type { EffectHandler, EffectOutcome } from './effect-runner.js';
import type { ReceiptPayload } from './normalization.js';

/** Handlers for the obligations the canonical application records in the same transaction as the Message.
 * Each one performs exactly what the legacy webhook did after its commit, from the frozen inputs (what was
 * true when the message arrived) plus current rows. Every handler is idempotent: a lease can expire while a
 * handler is still running, so it may run twice. Domain state (unread count, previews, agent pause, routing)
 * was already written atomically with the Message; these are the observable consequences. */

type Realtime = { publish(event: RealtimeEvent): void };
type Maybe<T> = T | undefined | null;

export type EffectServices = {
  db: PrismaClient;
  realtime: Realtime;
  assistantScheduler?: Maybe<{
    message(input: { workspaceId: string; conversationId: string; messageId: string; direction: string }): Promise<unknown>;
    control(workspaceId: string, conversationId: string, paused: boolean): Promise<unknown>;
    isAssisted(workspaceId: string, conversationId: string): Promise<boolean>;
  }>;
  handoffBriefService?: Maybe<{ schedule(input: { workspaceId: string; conversationId: string }): void }>;
  inboxTriage?: Maybe<{ observeMessage(input: { workspaceId: string; conversationId: string; messageId: string; direction: 'inbound' | 'outbound'; observedAt: Date }): Promise<unknown> }>;
  followupService?: Maybe<{ observeConversationActivity(input: { workspaceId: string; conversationId: string; messageId: string; direction: 'inbound' | 'outbound'; source: 'customer' | 'human' | 'agent' }): Promise<unknown> }>;
  agentImprovements?: Maybe<{ observeHumanReply(input: { workspaceId: string; conversationId: string; messageId: string }): Promise<unknown> }>;
  agentRuntime?: Maybe<{ prepareAudioMessage(input: { workspaceId: string; messageId: string }): Promise<{ status: string; errorCode?: string }> }>;
  agentReplyScheduler?: Maybe<{ scheduleActiveSessionForMessage(input: { workspaceId: string; conversationId: string; messageId: string }): Promise<unknown> }>;
  automationRunner?: Maybe<{ runForInboundMessage(input: { workspaceId: string; messageId: string; eventKey: string }): Promise<unknown> }>;
  historyBackfill?: Maybe<(input: { workspaceId: string; channelId: string; conversationId: string; providerKey: string; remoteJid: string; identity: string; pushName: string | null }) => Promise<void>>;
  groupSubject?: Maybe<(input: { provider: 'evolution' | 'waha'; sessionName: string; groupJid: string }) => Promise<string | null>>;
  describeChannel?: Maybe<(channel: unknown) => Promise<unknown>>;
  /** Only the process that owns the private receipt store can hand out a QR code. */
  journal?: Maybe<{ readPayload(receiptId: string): Promise<{ payload: ReceiptPayload }> }>;
  qrExpiresAt?: () => string;
  logger?: Maybe<{ warn(fields: Record<string, unknown>, message: string): void }>;
};

const done = (result?: Record<string, unknown>): EffectOutcome => ({ status: 'done', ...(result ? { result: result as never } : {}) });
const skipped = (reason: string): EffectOutcome => done({ skipped: reason });
const str = (value: unknown) => typeof value === 'string' ? value : null;
const date = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value) : null;

export function createEffectHandlers(services: EffectServices): Record<string, EffectHandler> {
  const { db } = services;
  const needs = (effect: { workspaceId: string; conversationId: string | null; messageId: string | null }) =>
    effect.conversationId && effect.messageId ? { workspaceId: effect.workspaceId, conversationId: effect.conversationId, messageId: effect.messageId } : null;
  const direction = (value: unknown): 'inbound' | 'outbound' => value === 'outbound' ? 'outbound' : 'inbound';

  /** What the prospecting observer decided for this message; agent and audio handling depend on it. */
  async function prospectingOf(effect: { workspaceId: string; messageId: string | null }) {
    const row = await db.ingressEffect.findFirst({ where: { workspaceId: effect.workspaceId, messageId: effect.messageId, kind: 'prospecting.inbound' }, select: { state: true, result: true } });
    if (!row) return { known: true as const, reserved: false, liveEligible: false };
    if (row.state === 'failed') return { known: false as const, reserved: false, liveEligible: false };
    const result = (row.result ?? {}) as Record<string, unknown>;
    return { known: true as const, reserved: result.reserved === true, liveEligible: result.liveEligible === true };
  }

  async function publishConversation(workspaceId: string, conversationId: string) {
    const conversation = await db.conversation.findUnique({ where: { workspaceId_id: { workspaceId, id: conversationId } }, include: conversationDtoInclude });
    if (!conversation) return false;
    services.realtime.publish({ type: 'conversation.updated', workspaceId, payload: toConversationDto(conversation as never) });
    return true;
  }

  const handlers: Record<string, EffectHandler> = {
    'realtime.message': async effect => {
      const scope = needs(effect);
      if (!scope) return skipped('no_message');
      const message = await db.message.findFirst({ where: { id: scope.messageId, workspaceId: scope.workspaceId } });
      if (!message) return skipped('message_missing');
      services.realtime.publish({ type: effect.frozen.outcome === 'created' ? 'message.created' : 'message.updated', workspaceId: scope.workspaceId, payload: toMessageDto(message as never) });
      return done();
    },

    'realtime.conversation': async effect => {
      if (!effect.conversationId) return skipped('no_conversation');
      return await publishConversation(effect.workspaceId, effect.conversationId) ? done() : skipped('conversation_missing');
    },

    'content.reconcile': async effect => {
      const scope = needs(effect);
      if (!scope) return skipped('no_message');
      const message = await db.message.findFirst({ where: { id: scope.messageId, workspaceId: scope.workspaceId } });
      if (!message) return skipped('message_missing');
      const kind = str(effect.frozen.kind);
      services.realtime.publish({ type: 'message.updated', workspaceId: scope.workspaceId, payload: toMessageDto(message as never) });
      if (kind === 'edit' || kind === 'encrypted_edit' || kind === 'revoke') {
        const latest = await db.message.findFirst({ where: { workspaceId: scope.workspaceId, conversationId: scope.conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
        if (latest?.id === message.id) await publishConversation(scope.workspaceId, scope.conversationId);
      }
      return done();
    },

    'assistant.control': async effect => {
      const scope = needs(effect);
      if (!scope || !services.assistantScheduler) return skipped('assistant_unavailable');
      await services.assistantScheduler.control(scope.workspaceId, scope.conversationId, true);
      return done();
    },

    'assistant.message': async effect => {
      const scope = needs(effect);
      if (!scope || !services.assistantScheduler) return skipped('assistant_unavailable');
      await services.assistantScheduler.message({ ...scope, direction: str(effect.frozen.direction) ?? 'inbound' });
      return done();
    },

    'handoff.brief': async effect => {
      const scope = needs(effect);
      if (!scope || !services.handoffBriefService) return skipped('handoff_unavailable');
      services.handoffBriefService.schedule({ workspaceId: scope.workspaceId, conversationId: scope.conversationId });
      return done();
    },

    'triage.message': async effect => {
      const scope = needs(effect);
      if (!scope || !services.inboxTriage) return skipped('triage_unavailable');
      await services.inboxTriage.observeMessage({ ...scope, direction: direction(effect.frozen.direction), observedAt: new Date() });
      return done();
    },

    'followup.activity': async effect => {
      const scope = needs(effect);
      if (!scope || !services.followupService) return skipped('followups_unavailable');
      const source = effect.frozen.source === 'human' ? 'human' : 'customer';
      await services.followupService.observeConversationActivity({ ...scope, direction: source === 'human' ? 'outbound' : 'inbound', source });
      return done();
    },

    'human_reply.improvement': async effect => {
      const scope = needs(effect);
      if (!scope || !services.agentImprovements) return skipped('improvements_unavailable');
      const analysis = await services.agentImprovements.observeHumanReply(scope) as { created?: boolean; reason?: string | null } | undefined;
      return done({ outcome: analysis?.created ? 'created' : 'skipped', reason: analysis?.reason ?? null });
    },

    'prospecting.inbound': async effect => {
      const scope = needs(effect);
      if (!scope) return skipped('no_message');
      const message = await db.message.findFirst({ where: { id: scope.messageId, workspaceId: scope.workspaceId }, select: { direction: true, type: true, body: true, createdAt: true, ingestedAt: true } });
      if (!message) return skipped('message_missing');
      const result = await observeProspectingInbound(db, { ...scope, direction: message.direction, type: message.type, body: message.body,
        createdAt: date(effect.frozen.messageCreatedAt) ?? message.createdAt, ingestedAt: date(effect.frozen.ingestedAt) ?? message.ingestedAt,
        isGroup: effect.frozen.isGroup === true, historical: effect.frozen.mode === 'history' });
      return done(result);
    },

    'history.backfill': async effect => {
      const scope = needs(effect);
      if (!scope || !services.historyBackfill) return skipped('backfill_unavailable');
      const conversation = await db.conversation.findUnique({ where: { workspaceId_id: { workspaceId: scope.workspaceId, id: scope.conversationId } }, include: { contact: true, channel: true } });
      const remoteJid = str(effect.frozen.chatAddress);
      if (!conversation || !remoteJid || conversation.channel.provider !== 'evolution') return skipped('not_applicable');
      await services.historyBackfill({ workspaceId: scope.workspaceId, channelId: conversation.channelId, conversationId: conversation.id,
        providerKey: conversation.channel.providerKey, remoteJid, identity: conversation.contact.phone, pushName: str(effect.frozen.pushName) });
      return done();
    },

    'automation.occurrence': async effect => {
      const scope = needs(effect);
      if (!scope || !services.automationRunner) return skipped('automations_unavailable');
      await services.automationRunner.runForInboundMessage({ workspaceId: scope.workspaceId, messageId: scope.messageId,
        eventKey: str(effect.frozen.eventKey) ?? `message.received:${scope.messageId}` });
      return done();
    },

    'agent.debounce': async effect => {
      const scope = needs(effect);
      if (!scope) return skipped('no_message');
      const prospecting = await prospectingOf(effect);
      // A failed prospecting observation leaves it unknown whether the agent may answer: stop visibly.
      if (!prospecting.known) return { status: 'failed', errorCode: 'PROSPECTING_STATE_UNKNOWN' };
      if (prospecting.reserved && !prospecting.liveEligible) return skipped('prospecting_reserved');
      const message = await db.message.findFirst({ where: { id: scope.messageId, workspaceId: scope.workspaceId }, select: { type: true } });
      if (!message) return skipped('message_missing');
      if (message.type === 'audio' && services.agentRuntime && (prospecting.reserved || !await services.assistantScheduler?.isAssisted(scope.workspaceId, scope.conversationId))) {
        // media.prepare already finished (dependency), so the transcription reads the durable original.
        await services.agentRuntime.prepareAudioMessage({ workspaceId: scope.workspaceId, messageId: scope.messageId });
      }
      if (services.agentReplyScheduler) await services.agentReplyScheduler.scheduleActiveSessionForMessage(scope);
      return done();
    },

    'contact.group_metadata': async effect => {
      const contactId = str(effect.frozen.contactId), groupJid = str(effect.frozen.chatAddress);
      if (!contactId || !groupJid || !services.groupSubject) return skipped('group_lookup_unavailable');
      const conversation = effect.conversationId ? await db.conversation.findUnique({ where: { workspaceId_id: { workspaceId: effect.workspaceId, id: effect.conversationId } }, include: { channel: true } }) : null;
      if (!conversation) return skipped('conversation_missing');
      const connection = await db.channelConnection.findFirst({ where: { workspaceId: effect.workspaceId, channelId: conversation.channelId, provider: effect.frozen.provider === 'waha' ? 'waha' : 'evolution' } });
      const provider = connection?.provider === 'waha' ? 'waha' as const : 'evolution' as const;
      const subject = (await services.groupSubject({ provider, sessionName: connection?.sessionName ?? conversation.channel.providerKey, groupJid }))?.trim();
      if (!subject) return skipped('no_subject');
      // Compare-and-set: never overwrite a name somebody set in the meantime.
      const updated = await db.contact.updateMany({ where: { workspaceId: effect.workspaceId, id: contactId,
        OR: [{ name: null }, { name: '' }, { name: groupFallbackName(groupJid) }, { name: str(effect.frozen.originalName) ?? undefined }] }, data: { name: subject.slice(0, 120) } });
      if (updated.count && effect.conversationId) await publishConversation(effect.workspaceId, effect.conversationId);
      return done({ updated: updated.count });
    }
  };

  // QR codes live only in the private receipt; the process that owns that store publishes them.
  if (services.journal && services.describeChannel) {
    const journal = services.journal, describeChannel = services.describeChannel;
    handlers['realtime.connection'] = async effect => {
      const connectionId = str(effect.frozen.connectionId);
      const connection = connectionId ? await db.channelConnection.findFirst({ where: { id: connectionId, workspaceId: effect.workspaceId } }) : null;
      const channel = connection ? await db.channel.findFirst({ where: { id: connection.channelId, workspaceId: effect.workspaceId } }) : null;
      if (!connection || !channel) return skipped('connection_missing');
      services.realtime.publish({ type: 'channel.updated', workspaceId: effect.workspaceId, payload: await describeChannel(channel) } as never);
      const qr = effect.frozen.qr as { privateReceiptId?: unknown; eventIndex?: unknown } | null;
      if (effect.frozen.control === 'qr' && qr && typeof qr.privateReceiptId === 'string' && Number.isInteger(qr.eventIndex)) {
        const { payload } = await journal.readPayload(qr.privateReceiptId);
        const item = payload.events[qr.eventIndex as number];
        if (item?.kind === 'accepted' && item.event.kind === 'control' && item.event.control === 'qr') {
          services.realtime.publish({ type: 'channel.qr_updated', workspaceId: effect.workspaceId, payload: { channelId: channel.id, qrCode: item.event.qrCode,
            expiresAt: services.qrExpiresAt?.() ?? new Date(Date.now() + 60_000).toISOString(), connectionId: connection.id, provider: connection.provider, issuedAt: new Date().toISOString() } } as never);
        }
      }
      return done();
    };
  }
  return handlers;
}
