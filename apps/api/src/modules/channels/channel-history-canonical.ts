import { json, sha, stable } from '../messaging/canonical-values.js';
import { recoveryTransaction, type RecoveryWriteFence } from './history-recovery-budget.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { normalizeWhatsappPhone } from './channel-connections.js';
import { autoResolveAuthority } from './conversation-authority.js';
import { usableContactName } from '../contacts/contact-name.js';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { deriveTrustedMessagingContext, StaleMessagingSourceError } from '../messaging/canonical-source.js';
import { selectConversationPreviewInTransaction } from '../messaging/conversation-preview.js';
import { createCanonicalStore, type CanonicalStoreOptions } from '../messaging/canonical-store.js';
import type { NormalizationResult, TrustedMessagingContext } from '../messaging/normalized-event.js';
import type { FrozenSource } from '../ingress/media-prepare-handler.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import type { HistoryRecord, RecentEvolutionChat } from '../evolution/evolution-history.js';

export type CanonicalHistoryChannel = { id: string; workspaceId: string; providerKey: string };
export type CanonicalHistoryResult = { conversationId: string | null; conversationIds: Set<string>; inserted: number; held: number; skipped: number };

const store = createCanonicalStore();
const BENIGN_HISTORY_IGNORES = new Set(['provider_system_notice', 'non_conversation_status', 'non_conversation_newsletter']);

/** No canonical identity can be certified for this provider row. Keep its source/key/reason
 * available to the caller while the fixed error message remains safe for operational logs.
 * Throwing leaves the recovery checkpoint unchanged, so a corrected row can be retried. */
export class HistoryNormalizationHoldError extends Error {
  readonly code = 'HISTORY_NORMALIZATION_HELD';
  constructor(readonly provider: 'evolution' | 'waha', readonly connectionId: string, readonly providerKey: string, readonly reason: string) {
    super('HISTORY_NORMALIZATION_HELD');
    this.name = 'HistoryNormalizationHoldError';
  }
}

/** Evolution connection that may write this channel's history, or null when the channel has no
 * eligible physical connection (the caller then keeps the legacy writer for this chat). */
export async function canonicalHistoryConnection(prisma: PrismaClient, channel: CanonicalHistoryChannel) {
  const connection = await prisma.channelConnection.findFirst({ where: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'evolution' } });
  return connection && connection.lifecycleGeneration % 2 === 0 ? connection : null;
}

/** One provider message read back from a provider API (history or gap recovery), normalized under the trusted
 * context only inside its own transaction. `receiptId` is the provider's own message id: never text or time. */
export type ProviderMessageItem = { receiptId: string; timestampMs: number; originalType?: string; fingerprint?: string;
  wahaTemplateSnapshot?: CanonicalStoreOptions['wahaTemplateSnapshot'];
  normalize: (context: TrustedMessagingContext) => NormalizationResult };
/** Initial-import UI callback. Media and bounded-recovery UI work use durable
 * effects committed with the message, so provider/network callbacks cannot block coverage. */
export type AfterPersist = {
  /** @deprecated Ignored: media.prepare is executed by the durable effect runner. */
  prepareMedia?: (input: { workspaceId: string; messageId: string; source: FrozenSource }) => Promise<unknown>;
  notify?: (workspaceId: string, created: Array<{ messageId: string; conversationId: string }>) => Promise<void>;
};

/**
 * Writes provider messages through the canonical store: exact identity, PN/LID aliases and deduplication against
 * everything already received (live, by the other connection, or by an earlier run).
 *
 * - `history`: old context. Never unread, agents, automations or AI control; new conversations are born
 *   human-controlled by the store itself.
 * - `recovered_live`: messages that should have arrived live but were missed (gap recovery). Inbound ones count as
 *   unread so people see them; no agent or automation acts on a message that may be minutes old.
 *
 * One transaction per message (the store requires READ COMMITTED and forbids wrapping a batch), so a failure keeps
 * what was already written and a retry finds it as a duplicate. Messages a legacy writer already owns are held for adoption by the canonical store,
 * rather than silently skipping any other chat which reused the native id.
 */
export async function persistProviderMessages(input: {
  prisma: PrismaClient; channel: CanonicalHistoryChannel; connection: { id: string; provider: 'evolution' | 'waha'; lifecycleGeneration?: number; sessionName?: string };
  mode: 'history' | 'recovered_live'; items: ProviderMessageItem[]; batchId: string; after?: AfterPersist;
  recoveryBudget?: { signal: AbortSignal; remaining: () => number; fence: RecoveryWriteFence };
}): Promise<CanonicalHistoryResult> {
  const { prisma, channel, connection, mode, batchId } = input;
  const created: Array<{ messageId: string; conversationId: string; media: FrozenSource | null }> = [];
  const result: CanonicalHistoryResult = { conversationId: null, conversationIds: new Set(), inserted: 0, held: 0, skipped: 0 };
  const contested = new Set<string>();
  for (const item of [...input.items].sort((a, b) => a.timestampMs - b.timestampMs)) {
    input.recoveryBudget?.signal.throwIfAborted();
    const write = async (tx: Prisma.TransactionClient) => {
      await enterCanonicalWorkspaceTransaction(tx, channel.workspaceId);
      if (input.recoveryBudget) {
        await tx.$queryRaw`SELECT id FROM channels WHERE workspace_id=${channel.workspaceId} AND id=${channel.id}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM channel_connections WHERE workspace_id=${channel.workspaceId} AND channel_id=${channel.id}::uuid AND id=${connection.id}::uuid FOR SHARE`;
      }
      const context = await deriveTrustedMessagingContext(tx, { workspaceId: channel.workspaceId, channelId: channel.id,
        authenticatedSource: { provider: connection.provider, connectionId: connection.id }, mode, observedAt: new Date().toISOString() });
      if ((connection.lifecycleGeneration !== undefined && context.lifecycleGeneration !== connection.lifecycleGeneration)
        || (connection.sessionName !== undefined && context.sessionName !== connection.sessionName)) throw new StaleMessagingSourceError('Recovery source changed');
      if (input.recoveryBudget) {
        const current = await tx.channelConnection.findFirst({ where: { id: connection.id, workspaceId: channel.workspaceId,
          channelId: channel.id, historyRecoveryLeaseToken: input.recoveryBudget.fence.token,
          historyRecoveryLeaseUntil: { gt: new Date() }, recoveredThroughAt: input.recoveryBudget.fence.checkpoint,
          verifiedPhoneNumber: input.recoveryBudget.fence.verifiedPhoneNumber, status: 'connected', eligible: true } });
        if (!current) throw new StaleMessagingSourceError('Recovery lease changed');
      }
      const sourceChannel = await tx.channel.findUniqueOrThrow({ where: { id: channel.id } });
      if (input.recoveryBudget && sourceChannel.verifiedMessagingPhoneNumber !== input.recoveryBudget.fence.anchor) throw new StaleMessagingSourceError('Recovery channel anchor changed');
      const anchor = normalizeWhatsappPhone(sourceChannel.verifiedMessagingPhoneNumber);
      if (anchor) {
        const physical = await tx.channelConnection.findUniqueOrThrow({ where: { id: connection.id } });
        if (normalizeWhatsappPhone(physical.verifiedPhoneNumber) !== anchor) throw new StaleMessagingSourceError('Channel identity mismatch');
      }
      const normalized = item.normalize(context);
      if (normalized.kind !== 'accepted') {
        if (normalized.kind === 'ignored' && BENIGN_HISTORY_IGNORES.has(normalized.reason)) { result.skipped++; return; }
        throw new HistoryNormalizationHoldError(connection.provider, connection.id, item.receiptId, normalized.reason);
      }
      if (normalized.event.kind !== 'message') { result.skipped++; return; }
      const event = normalized.event;
      // Native ids alone can collide across chats, directions and channels. The canonical
      // store owns that complete identity; receipt keys preserve the same scoped tuple.
      const receiptKey = `${mode}:${connection.provider}:${channel.id}:${sha(stable(event.key))}`;
      const stored = await store.persistInTransaction(tx, event, { receiptKey,
        ...(connection.provider === 'waha' && item.wahaTemplateSnapshot ? { wahaTemplateSnapshot: item.wahaTemplateSnapshot } : {}),
        ...(mode === 'history' ? { presentation: { ingestedAt: new Date(item.timestampMs), history: { originalType: item.originalType ?? 'unknown', batchId } } } : {}) });
      if (stored.outcome === 'held') {
        result.held++;
        if (stored.chatId && stored.reconciliationReasons.includes('multiple_conversation_authorities')) contested.add(stored.chatId);
        return;
      }
      if (stored.conversationId) { result.conversationId = stored.conversationId; result.conversationIds.add(stored.conversationId); }
      if (!stored.messageId || !stored.conversationId) { result.skipped++; return; }
      const message = await tx.message.findUniqueOrThrow({ where: { id: stored.messageId } });
      if (message.hiddenByReset) { result.skipped++; return; }
      const media: FrozenSource | null = event.media?.hasMedia && ['audio', 'image', 'file'].includes(message.type)
        ? { provider: context.provider, channelProvider: context.channelProvider, sessionName: context.sessionName, key: event.key, mimeType: event.attachment.mimeType ?? null } : null;
      if (media) {
        // Imported media has no authenticated ingress receipt. Its own durable obligation
        // shares the message transaction, exact source and existing lease/backoff runner.
        const scope = { workspaceId: channel.workspaceId, channelId: channel.id }, logicalKey = `message:${message.id}`, kind = 'media.prepare';
        await tx.ingressEffect.upsert({ where: { workspaceId_channelId_logicalKey_kind: { ...scope, logicalKey, kind } }, update: {}, create: {
          ...scope, logicalKey, kind, messageId: message.id, conversationId: stored.conversationId,
          cause: json({ origin: 'canonical_history', observationId: stored.observationId, messageId: message.id }),
          frozen: json({ presentationOnly: true, mode, mediaSource: media, dependsOn: [] })
        } });
      }
      if (stored.outcome !== 'created') { result.skipped++; return; }
      if (input.recoveryBudget) {
        for (const kind of ['realtime.message', 'realtime.conversation']) {
          const scope = { workspaceId: channel.workspaceId, channelId: channel.id }, logicalKey = `message:${message.id}`;
          await tx.ingressEffect.upsert({ where: { workspaceId_channelId_logicalKey_kind: { ...scope, logicalKey, kind } }, update: {}, create: {
            ...scope, logicalKey, kind, messageId: message.id, conversationId: stored.conversationId,
            cause: json({ origin: 'canonical_history', observationId: stored.observationId, messageId: message.id }),
            frozen: json({ presentationOnly: true, mode, outcome: 'created', dependsOn: [] })
          } });
        }
      }
      result.inserted++;
      created.push({ messageId: message.id, conversationId: stored.conversationId, media });
      // Recovered in time order: a reply we sent from the phone clears what was waiting before it.
      if (mode === 'recovered_live' && message.direction === 'outbound')
        await tx.conversation.updateMany({ where: { workspaceId: channel.workspaceId, id: stored.conversationId, unreadCount: { gt: 0 } }, data: { unreadCount: 0 } });
      if (mode === 'recovered_live' && message.direction === 'inbound' && !event.content.reaction)
        await tx.conversation.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: stored.conversationId } }, data: { unreadCount: { increment: 1 }, hiddenUntilReply: false } });
      // Previews and activity only ever move forward; old messages can never displace a newer one.
      await selectConversationPreviewInTransaction(tx, context, { conversationId: stored.conversationId, messageId: message.id, preview: event.content.preview, selection: 'new_message' });
      await tx.conversation.updateMany({ where: { workspaceId: channel.workspaceId, id: stored.conversationId,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: message.createdAt } }] }, data: { lastMessageAt: message.createdAt } });
    };
    if (input.recoveryBudget) await recoveryTransaction(prisma, Math.min(500, input.recoveryBudget.remaining()), write);
    else await prisma.$transaction(write, { isolationLevel: 'ReadCommitted', timeout: 30_000 });
  }
  // Two conversations claim a chat: the phone-number default decides, and what was held enters as history.
  for (const chatId of input.recoveryBudget ? [] : contested) await autoResolveAuthority(prisma, { workspaceId: channel.workspaceId, channelId: channel.id, chatId }).catch(() => undefined);
  // media.prepare already committed with the canonical row. The durable effect runner
  // owns network work for imports and recovery; a hanging provider never blocks coverage.
  if (!input.recoveryBudget && created.length && input.after?.notify) {
    const notification = input.after.notify(channel.workspaceId, created.map(({ messageId, conversationId }) => ({ messageId, conversationId }))).catch(() => undefined);
    await notification;
  }
  return result;
}

/** Provider-supplied display details only fill gaps; they never overwrite what a person set. */
export async function fillContactDetails(prisma: PrismaClient, workspaceId: string, conversationId: string, details: { name: string | null; avatarUrl: string | null }) {
  const conversation = await prisma.conversation.findFirst({ where: { workspaceId, id: conversationId }, include: { contact: true } });
  if (!conversation) return;
  // Placeholder, phone-number or WhatsApp-id "names" are never stored.
  const name = usableContactName(details.name);
  const patch = { ...(name && !usableContactName(conversation.contact.name) ? { name } : {}),
    ...(details.avatarUrl && !conversation.contact.avatarUrl ? { avatarUrl: details.avatarUrl } : {}) };
  if (Object.keys(patch).length) await prisma.contact.updateMany({ where: { workspaceId, id: conversation.contactId }, data: patch });
}

/** Evolution history for one chat (first connection or per-conversation backfill). */
export async function importChatCanonical(input: {
  prisma: PrismaClient; channel: CanonicalHistoryChannel; connectionId: string;
  chat: RecentEvolutionChat; records: HistoryRecord[]; batchId: string; after?: AfterPersist;
}): Promise<CanonicalHistoryResult> {
  const { prisma, channel, chat } = input;
  const result = await persistProviderMessages({ prisma, channel, connection: { id: input.connectionId, provider: 'evolution' }, mode: 'history', batchId: input.batchId, after: input.after,
    items: input.records.map(record => ({ receiptId: record.key.id, timestampMs: record.messageTimestamp * 1000, originalType: record.messageType,
      normalize: context => normalizeEvolutionWebhook(context, { event: 'messages.upsert', instance: channel.providerKey, data: record }) })) });
  if (result.conversationId) await fillContactDetails(prisma, channel.workspaceId, result.conversationId, { name: chat.pushName, avatarUrl: chat.profilePicUrl });
  return result;
}

export const isStaleHistorySource = (error: unknown) => error instanceof StaleMessagingSourceError;
