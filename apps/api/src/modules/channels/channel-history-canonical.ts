import type { PrismaClient } from '@prisma/client';
import { autoResolveAuthority } from './conversation-authority.js';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { deriveTrustedMessagingContext, StaleMessagingSourceError } from '../messaging/canonical-source.js';
import { selectConversationPreviewInTransaction } from '../messaging/conversation-preview.js';
import { createCanonicalStore } from '../messaging/canonical-store.js';
import type { NormalizationResult, TrustedMessagingContext } from '../messaging/normalized-event.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import type { HistoryRecord, RecentEvolutionChat } from '../evolution/evolution-history.js';

export type CanonicalHistoryChannel = { id: string; workspaceId: string; providerKey: string };
export type CanonicalHistoryResult = { conversationId: string | null; conversationIds: Set<string>; inserted: number; held: number; skipped: number };

const store = createCanonicalStore();

/** Evolution connection that may write this channel's history, or null when the channel has no
 * eligible physical connection (the caller then keeps the legacy writer for this chat). */
export async function canonicalHistoryConnection(prisma: PrismaClient, channel: CanonicalHistoryChannel) {
  const connection = await prisma.channelConnection.findFirst({ where: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'evolution' } });
  return connection && connection.lifecycleGeneration % 2 === 0 ? connection : null;
}

/** One provider message read back from a provider API (history or gap recovery), normalized under the trusted
 * context only inside its own transaction. `receiptId` is the provider's own message id: never text or time. */
export type ProviderMessageItem = { receiptId: string; timestampMs: number; originalType?: string;
  normalize: (context: TrustedMessagingContext) => NormalizationResult };

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
 * what was already written and a retry finds it as a duplicate. Messages a legacy writer already owns are skipped:
 * the store would hold them as "requires adoption" instead of duplicating them.
 */
export async function persistProviderMessages(input: {
  prisma: PrismaClient; channel: CanonicalHistoryChannel; connection: { id: string; provider: 'evolution' | 'waha' };
  mode: 'history' | 'recovered_live'; items: ProviderMessageItem[]; batchId: string;
}): Promise<CanonicalHistoryResult> {
  const { prisma, channel, connection, mode, batchId } = input;
  const result: CanonicalHistoryResult = { conversationId: null, conversationIds: new Set(), inserted: 0, held: 0, skipped: 0 };
  const contested = new Set<string>();
  const seen = new Set<string>();
  for (const item of [...input.items].sort((a, b) => a.timestampMs - b.timestampMs)) {
    if (seen.has(item.receiptId)) { result.skipped++; continue; }
    seen.add(item.receiptId);
    await prisma.$transaction(async tx => {
      await enterCanonicalWorkspaceTransaction(tx, channel.workspaceId);
      const context = await deriveTrustedMessagingContext(tx, { workspaceId: channel.workspaceId, channelId: channel.id,
        authenticatedSource: { provider: connection.provider, connectionId: connection.id }, mode, observedAt: new Date().toISOString() });
      const normalized = item.normalize(context);
      if (normalized.kind !== 'accepted' || normalized.event.kind !== 'message') { result.skipped++; return; }
      const event = normalized.event;
      const nativeIds = [...new Set([event.key.nativeId, event.key.rawId].filter((id): id is string => !!id))];
      if (nativeIds.length && await tx.message.findFirst({ where: { workspaceId: channel.workspaceId, providerMessageId: { in: nativeIds } }, select: { id: true } })) {
        result.skipped++; return;
      }
      // Evolution history keeps the receipt key earlier imports used, so a re-run finds them as duplicates.
      const receiptKey = mode === 'history' && connection.provider === 'evolution' ? `history:${channel.id}:${item.receiptId}` : `${mode}:${connection.provider}:${channel.id}:${item.receiptId}`;
      const stored = await store.persistInTransaction(tx, event, { receiptKey,
        ...(mode === 'history' ? { presentation: { ingestedAt: new Date(item.timestampMs), history: { originalType: item.originalType ?? 'unknown', batchId } } } : {}) });
      if (stored.outcome === 'held') {
        result.held++;
        if (stored.chatId && stored.reconciliationReasons.includes('multiple_conversation_authorities')) contested.add(stored.chatId);
        return;
      }
      if (stored.conversationId) { result.conversationId = stored.conversationId; result.conversationIds.add(stored.conversationId); }
      if (stored.outcome !== 'created' || !stored.messageId || !stored.conversationId) { result.skipped++; return; }
      result.inserted++;
      const message = await tx.message.findUniqueOrThrow({ where: { id: stored.messageId } });
      if (mode === 'recovered_live' && message.direction === 'inbound')
        await tx.conversation.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: stored.conversationId } }, data: { unreadCount: { increment: 1 }, hiddenUntilReply: false } });
      // Previews and activity only ever move forward; old messages can never displace a newer one.
      await selectConversationPreviewInTransaction(tx, context, { conversationId: stored.conversationId, messageId: message.id, preview: event.content.preview, selection: 'new_message' });
      await tx.conversation.updateMany({ where: { workspaceId: channel.workspaceId, id: stored.conversationId,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: message.createdAt } }] }, data: { lastMessageAt: message.createdAt } });
    }, { isolationLevel: 'ReadCommitted', timeout: 30_000 });
  }
  // Two conversations claim a chat: the phone-number default decides, and what was held enters as history.
  for (const chatId of contested) await autoResolveAuthority(prisma, { workspaceId: channel.workspaceId, channelId: channel.id, chatId }).catch(() => undefined);
  return result;
}

/** Provider-supplied display details only fill gaps; they never overwrite what a person set. */
export async function fillContactDetails(prisma: PrismaClient, workspaceId: string, conversationId: string, details: { name: string | null; avatarUrl: string | null }) {
  const conversation = await prisma.conversation.findFirst({ where: { workspaceId, id: conversationId }, include: { contact: true } });
  if (!conversation) return;
  const patch = { ...(details.name && !conversation.contact.name ? { name: details.name } : {}),
    ...(details.avatarUrl && !conversation.contact.avatarUrl ? { avatarUrl: details.avatarUrl } : {}) };
  if (Object.keys(patch).length) await prisma.contact.updateMany({ where: { workspaceId, id: conversation.contactId }, data: patch });
}

/** Evolution history for one chat (first connection or per-conversation backfill). */
export async function importChatCanonical(input: {
  prisma: PrismaClient; channel: CanonicalHistoryChannel; connectionId: string;
  chat: RecentEvolutionChat; records: HistoryRecord[]; batchId: string;
}): Promise<CanonicalHistoryResult> {
  const { prisma, channel, chat } = input;
  const result = await persistProviderMessages({ prisma, channel, connection: { id: input.connectionId, provider: 'evolution' }, mode: 'history', batchId: input.batchId,
    items: input.records.map(record => ({ receiptId: record.key.id, timestampMs: record.messageTimestamp * 1000, originalType: record.messageType,
      normalize: context => normalizeEvolutionWebhook(context, { event: 'messages.upsert', instance: channel.providerKey, data: record }) })) });
  if (result.conversationId) await fillContactDetails(prisma, channel.workspaceId, result.conversationId, { name: chat.pushName, avatarUrl: chat.profilePicUrl });
  return result;
}

export const isStaleHistorySource = (error: unknown) => error instanceof StaleMessagingSourceError;
