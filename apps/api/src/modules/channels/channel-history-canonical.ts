import type { PrismaClient } from '@prisma/client';
import { autoResolveAuthority } from './conversation-authority.js';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { deriveTrustedMessagingContext, StaleMessagingSourceError } from '../messaging/canonical-source.js';
import { selectConversationPreviewInTransaction } from '../messaging/conversation-preview.js';
import { createCanonicalStore } from '../messaging/canonical-store.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import type { HistoryRecord, RecentEvolutionChat } from '../evolution/evolution-history.js';

export type CanonicalHistoryChannel = { id: string; workspaceId: string; providerKey: string };
export type CanonicalHistoryResult = { conversationId: string | null; inserted: number; held: number; skipped: number };

const store = createCanonicalStore();

/** Evolution connection that may write this channel's history, or null when the channel has no
 * eligible physical connection (the caller then keeps the legacy writer for this chat). */
export async function canonicalHistoryConnection(prisma: PrismaClient, channel: CanonicalHistoryChannel) {
  const connection = await prisma.channelConnection.findFirst({ where: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'evolution' } });
  return connection && connection.lifecycleGeneration % 2 === 0 ? connection : null;
}

/**
 * Writes one chat's history through the canonical store: exact message identity, PN/LID aliases and
 * deduplication against live events. History mode never allows operational effects, so it cannot
 * trigger automations, agents, unread counts or AI control; new conversations are born
 * human-controlled by the store itself.
 *
 * One transaction per record (the store requires READ COMMITTED and forbids wrapping a batch), so a
 * failure keeps everything already imported and a retry skips it as a duplicate.
 */
export async function importChatCanonical(input: {
  prisma: PrismaClient; channel: CanonicalHistoryChannel; connectionId: string;
  chat: RecentEvolutionChat; records: HistoryRecord[]; batchId: string;
}): Promise<CanonicalHistoryResult> {
  const { prisma, channel, connectionId, chat, records, batchId } = input;
  const result: CanonicalHistoryResult = { conversationId: null, inserted: 0, held: 0, skipped: 0 };
  // Messages the legacy writers (or an earlier import) already own are never re-imported: the
  // canonical store would hold them as "requires adoption" rather than duplicate them.
  const known = new Set((await prisma.message.findMany({ where: { workspaceId: channel.workspaceId, providerMessageId: { in: [...new Set(records.map(r => r.key.id))] } },
    select: { providerMessageId: true } })).map(m => m.providerMessageId));
  const contested = new Set<string>();
  for (const record of [...records].sort((a, b) => a.messageTimestamp - b.messageTimestamp)) {
    if (known.has(record.key.id)) { result.skipped++; continue; }
    known.add(record.key.id);
    await prisma.$transaction(async tx => {
      await enterCanonicalWorkspaceTransaction(tx, channel.workspaceId);
      const context = await deriveTrustedMessagingContext(tx, { workspaceId: channel.workspaceId, channelId: channel.id,
        authenticatedSource: { provider: 'evolution', connectionId }, mode: 'history', observedAt: new Date().toISOString() });
      const normalized = normalizeEvolutionWebhook(context, { event: 'messages.upsert', instance: channel.providerKey, data: record });
      if (normalized.kind !== 'accepted' || normalized.event.kind !== 'message') { result.skipped++; return; }
      const event = normalized.event;
      const stored = await store.persistInTransaction(tx, event, { receiptKey: `history:${channel.id}:${record.key.id}`,
        presentation: { ingestedAt: new Date(record.messageTimestamp * 1000), history: { originalType: record.messageType ?? 'unknown', batchId } } });
      if (stored.outcome === 'held') {
        result.held++;
        if (stored.chatId && stored.reconciliationReasons.includes('multiple_conversation_authorities')) contested.add(stored.chatId);
        return;
      }
      if (stored.conversationId) result.conversationId = stored.conversationId;
      if (stored.outcome !== 'created' || !stored.messageId || !stored.conversationId) { result.skipped++; return; }
      result.inserted++;
      // Previews and activity only ever move forward; history can never displace a newer message.
      const message = await tx.message.findUniqueOrThrow({ where: { id: stored.messageId } });
      await selectConversationPreviewInTransaction(tx, context, { conversationId: stored.conversationId, messageId: message.id, preview: event.content.preview, selection: 'new_message' });
      await tx.conversation.updateMany({ where: { workspaceId: channel.workspaceId, id: stored.conversationId,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: message.createdAt } }] }, data: { lastMessageAt: message.createdAt } });
    }, { isolationLevel: 'ReadCommitted', timeout: 30_000 });
  }
  // Two conversations claim this chat: the phone-number default decides, and what was held enters as history.
  for (const chatId of contested) await autoResolveAuthority(prisma, { workspaceId: channel.workspaceId, channelId: channel.id, chatId }).catch(() => undefined);
  if (result.conversationId) {
    // Provider-supplied display details only fill gaps; they never overwrite what a person set.
    const conversation = await prisma.conversation.findFirst({ where: { workspaceId: channel.workspaceId, id: result.conversationId }, include: { contact: true } });
    if (conversation) {
      const patch = { ...(chat.pushName && !conversation.contact.name ? { name: chat.pushName } : {}),
        ...(chat.profilePicUrl && !conversation.contact.avatarUrl ? { avatarUrl: chat.profilePicUrl } : {}) };
      if (Object.keys(patch).length) await prisma.contact.updateMany({ where: { workspaceId: channel.workspaceId, id: conversation.contactId }, data: patch });
    }
  }
  return result;
}

export const isStaleHistorySource = (error: unknown) => error instanceof StaleMessagingSourceError;
