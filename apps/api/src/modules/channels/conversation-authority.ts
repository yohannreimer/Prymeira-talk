import type { Prisma, PrismaClient } from '@prisma/client';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { createCanonicalStore, type CanonicalStoreResult } from '../messaging/canonical-store.js';
import { selectConversationPreviewInTransaction } from '../messaging/conversation-preview.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import type { NormalizedMessagingEvent } from '../messaging/normalized-event.js';

/**
 * A person with two conversations for one WhatsApp chat (a phone contact and a LID contact the provider later proved
 * to be the same number). Neither is moved or merged: both keep their UUIDs, settings and history, and the history
 * reads as one. An owner or manager picks which one operates; the others stop acting on their own.
 */
const store = createCanonicalStore();
const RETIRED_REASON = 'conversation_authority_resolved';
export const AUTO_RESOLVER = 'system:phone-default';

export type AuthorityReview = {
  chatId: string; channelId: string; address: string;
  conversations: Array<{ id: string; contactName: string | null; contactPhone: string; status: string; assignedTo: string | null; aiControlStatus: string;
    unreadCount: number; messageCount: number; lastMessageAt: string | null; lastMessagePreview: string | null }>;
};

export async function listAuthorityReviews(db: PrismaClient, input: { workspaceId: string; limit?: number }): Promise<AuthorityReview[]> {
  const chats = await db.canonicalChat.findMany({ where: { workspaceId: input.workspaceId, state: 'review', reviewReason: 'multiple_conversation_authorities' },
    orderBy: { id: 'asc' }, take: input.limit ?? 50, include: { address: { include: { aliases: true } },
      members: { include: { conversation: { include: { contact: true, assignedUser: true, _count: { select: { messages: true } } } } } } } });
  return chats.map(chat => ({ chatId: chat.id, channelId: chat.channelId,
    address: chat.address.aliases.map(a => a.address).sort((a, b) => Number(b.endsWith('@s.whatsapp.net')) - Number(a.endsWith('@s.whatsapp.net')))[0] ?? '',
    conversations: chat.members.map(m => m.conversation).map(c => ({ id: c.id, contactName: c.contact.name, contactPhone: c.contact.phone, status: c.status,
      assignedTo: c.assignedUser?.displayName ?? null, aiControlStatus: c.aiControlStatus, unreadCount: c.unreadCount, messageCount: c._count.messages,
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null, lastMessagePreview: c.lastMessagePreview })) }));
}

export type AuthorityResolution =
  | { ok: true; operationConversationId: string; retiredConversationIds: string[]; recovered: number }
  | { ok: false; reason: string };

/** Stops everything a retired conversation could still do on its own and hides it behind the operating one.
 * Rows and history are kept; the operating conversation shows the retired history. */
async function retire(tx: Prisma.TransactionClient, workspaceId: string, operatingId: string, conversationIds: string[]) {
  const now = new Date();
  // A new decision replaces any earlier one for the same claimants.
  await tx.conversation.updateMany({ where: { workspaceId, id: { in: [operatingId, ...conversationIds] } }, data: { retiredIntoConversationId: null } });
  await tx.conversation.updateMany({ where: { workspaceId, id: { in: conversationIds } }, data: { retiredIntoConversationId: operatingId } });
  await tx.conversation.updateMany({ where: { workspaceId, id: { in: conversationIds } },
    data: { aiControlStatus: 'human_controlled', aiControlUpdatedAt: now, activeAgentSessionId: null } });
  await tx.aiAgentSession.updateMany({ where: { workspaceId, conversationId: { in: conversationIds }, status: { in: ['active', 'handoff_requested'] } }, data: { status: 'closed' } });
  await tx.aiAgentPendingReply.updateMany({ where: { workspaceId, conversationId: { in: conversationIds }, status: { in: ['pending', 'claimed', 'processing'] } },
    data: { status: 'cancelled', claimToken: null, lastError: RETIRED_REASON } });
  await tx.conversationFollowup.updateMany({ where: { workspaceId, conversationId: { in: conversationIds }, status: { in: ['evaluating', 'scheduled', 'processing', 'review'] } },
    data: { status: 'cancelled', cancelledAt: now, reason: RETIRED_REASON, activeKey: null, lockedAt: null } });
  await tx.assistantConversationState.updateMany({ where: { workspaceId, conversationId: { in: conversationIds } },
    data: { status: 'stale', revision: { increment: 1 }, scheduledAt: null, lastMessageId: null, lastError: null } });
}

async function resolveInTransaction(tx: Prisma.TransactionClient, input: {
  workspaceId: string; channelId: string; chatId: string; conversationId: string; resolvedBy: string;
}): Promise<AuthorityResolution> {
  await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
  const chat = await tx.canonicalChat.findFirst({ where: { workspaceId: input.workspaceId, channelId: input.channelId, id: input.chatId },
    include: { members: true } });
  if (!chat) return { ok: false as const, reason: 'chat_not_found' };
  // A person may still be waiting on an unconfirmed prospecting send on a conversation that is about to retire.
  const unsettled = await tx.campaignProspectingReservation.count({ where: { workspaceId: input.workspaceId,
    conversationId: { in: chat.members.map(m => m.conversationId).filter(id => id !== input.conversationId) }, confirmedAt: null } });
  if (unsettled) return { ok: false as const, reason: 'prospecting_send_unconfirmed' };
  const resolved = await store.resolveAuthorityInTransaction(tx, { workspaceId: input.workspaceId, channelId: input.channelId, chatId: input.chatId,
    conversationId: input.conversationId, resolvedBy: input.resolvedBy });
  if (!resolved.ok) return resolved;
  await retire(tx, input.workspaceId, resolved.operationConversationId, resolved.retiredConversationIds);
  // Facts held only for lack of a decision now enter as conserved history.
  const replayed = await store.replayAuthorityHeldInTransaction(tx, { workspaceId: input.workspaceId, channelId: input.channelId, chatId: resolved.chatId });
  const recovered = await applyRecovered(tx, input.workspaceId, replayed);
  return { ok: true as const, operationConversationId: resolved.operationConversationId, retiredConversationIds: resolved.retiredConversationIds, recovered };
}

export function resolveConversationAuthority(db: PrismaClient, input: {
  workspaceId: string; channelId: string; chatId: string; conversationId: string; resolvedBy: string;
}): Promise<AuthorityResolution> {
  return db.$transaction(tx => resolveInTransaction(tx, input), { isolationLevel: 'ReadCommitted', timeout: 60_000 });
}

/** The default operating conversation: the one for the real phone number, never the one known only by a hidden ID
 * (LID). Several phone conversations (for example with and without the ninth digit): the most recently active, then
 * the one with more messages. Only LID conversations, or groups: nobody is chosen and a person decides. */
export function chooseDefaultConversation(candidates: Array<{ id: string; contactPhone: string; isGroup: boolean; lastMessageAt: Date | null; messageCount: number }>): string | null {
  const phones = candidates.filter(c => !c.isGroup && !c.contactPhone.endsWith('@lid') && !c.contactPhone.endsWith('@g.us'));
  if (!phones.length) return null;
  return [...phones].sort((a, b) => (b.lastMessageAt?.getTime() ?? -1) - (a.lastMessageAt?.getTime() ?? -1) || b.messageCount - a.messageCount || a.id.localeCompare(b.id))[0]!.id;
}

/** Resolves a chat that several conversations claim without asking anyone, by the phone-number default. A person's
 * earlier explicit choice is never overridden, and every safety refusal (unknown send outcome, unconfirmed
 * prospecting, disputed address mapping) leaves the chat for a person. */
export async function autoResolveAuthority(db: PrismaClient, input: { workspaceId: string; channelId: string; chatId: string }): Promise<AuthorityResolution | { ok: false; reason: 'not_in_review' | 'manual_choice_on_record' | 'no_phone_conversation' }> {
  return db.$transaction(async tx => {
    await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
    const chat = await tx.canonicalChat.findFirst({ where: { workspaceId: input.workspaceId, channelId: input.channelId, id: input.chatId },
      include: { members: { include: { conversation: { include: { contact: true, _count: { select: { messages: true } } } } } }, authorityResolution: true } });
    if (!chat || chat.state !== 'review' || chat.reviewReason !== 'multiple_conversation_authorities') return { ok: false as const, reason: 'not_in_review' as const };
    if (chat.authorityResolution && chat.authorityResolution.resolvedBy !== AUTO_RESOLVER) return { ok: false as const, reason: 'manual_choice_on_record' as const };
    const chosen = chooseDefaultConversation(chat.members.map(m => ({ id: m.conversation.id, contactPhone: m.conversation.contact.phone, isGroup: m.conversation.contact.isGroup,
      lastMessageAt: m.conversation.lastMessageAt, messageCount: m.conversation._count.messages })));
    if (!chosen) return { ok: false as const, reason: 'no_phone_conversation' as const };
    return resolveInTransaction(tx, { workspaceId: input.workspaceId, channelId: input.channelId, chatId: input.chatId, conversationId: chosen, resolvedBy: AUTO_RESOLVER });
  }, { isolationLevel: 'ReadCommitted', timeout: 60_000 });
}

/** Sweep for chats still waiting (old duplicates found by history import or by the first live event). */
export async function autoResolvePending(db: PrismaClient, input: { workspaceIds?: readonly string[]; limit?: number } = {}) {
  const chats = await db.canonicalChat.findMany({ where: { state: 'review', reviewReason: 'multiple_conversation_authorities',
    ...(input.workspaceIds ? { workspaceId: { in: [...input.workspaceIds] } } : {}) }, orderBy: { id: 'asc' }, take: input.limit ?? 25, select: { id: true, workspaceId: true, channelId: true } });
  let resolved = 0;
  for (const chat of chats) {
    const result = await autoResolveAuthority(db, { workspaceId: chat.workspaceId, channelId: chat.channelId, chatId: chat.id });
    if (result.ok) resolved++;
  }
  return { examined: chats.length, resolved };
}

async function applyRecovered(tx: Prisma.TransactionClient, workspaceId: string, results: CanonicalStoreResult[]) {
  let recovered = 0;
  for (const result of results) {
    if (result.outcome === 'held' || !result.messageId || !result.conversationId) continue;
    recovered++;
    // Ingress progress rows are immutable facts (the held decision stays on record); the canonical observation,
    // now applied, is what shows the message was recovered.
    if (result.outcome !== 'created') continue;
    // Recovered history only moves previews and activity forward, like imported history.
    const message = await tx.message.findUniqueOrThrow({ where: { id: result.messageId } });
    const observation = await tx.canonicalObservation.findUniqueOrThrow({ where: { id: result.observationId } });
    // A customer message that arrived live is not history: people must notice it, even though no agent answers it.
    if (message.direction === 'inbound' && observation.mode !== 'history')
      await tx.conversation.update({ where: { workspaceId_id: { workspaceId, id: result.conversationId } }, data: { unreadCount: { increment: 1 }, hiddenUntilReply: false } });
    const event = observation.payload as unknown as Extract<NormalizedMessagingEvent, { kind: 'message' }>;
    const connection = observation.connectionId ? { provider: observation.provider as 'evolution' | 'waha', connectionId: observation.connectionId } : null;
    if (connection) {
      const context = await deriveTrustedMessagingContext(tx, { workspaceId, channelId: observation.channelId, authenticatedSource: connection, mode: 'history', observedAt: new Date().toISOString() })
        .catch(() => null);
      if (context) await selectConversationPreviewInTransaction(tx, context, { conversationId: result.conversationId, messageId: message.id, preview: event.content.preview, selection: 'new_message' });
    }
    await tx.conversation.updateMany({ where: { workspaceId, id: result.conversationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: message.createdAt } }] }, data: { lastMessageAt: message.createdAt } });
  }
  return recovered;
}
