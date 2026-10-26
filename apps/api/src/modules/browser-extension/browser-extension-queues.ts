import type { Prisma } from '@prisma/client';
import type { ExtensionQueueQuery, ExtensionNavigation, ExtensionQueue, ExtensionQueueKind, ExtensionConversation, ExtensionNavigationTarget } from '@prymeira-talk/shared';
import { AssistantError } from '../assistant/assistant-access.js';
import { inboxHandoffWhere } from '../conversations/conversations.service.js';
import { requireExtensionAccount, type ExtensionDb, type ExtensionAuth } from './browser-extension-access.js';
const stale = (): never => { throw new AssistantError('EXTENSION_QUEUE_STALE', 'A fila mudou. Atualize antes de continuar.'); };
const conversationSelect = { id: true, channelId: true, contact: { select: { name: true, phone: true } } } as const;
const followupSelect = { id: true, kind: true, status: true, scheduledAt: true, updatedAt: true, conversation: { select: conversationSelect } } as const;
const humanSelect = { ...conversationSelect, activeAgentSession: { select: { handoffReason: true } } } as const;
const dto = (c: { id: string; channelId: string; contact: { name: string | null; phone: string } }): ExtensionConversation => ({ id: c.id, channelId: c.channelId, contactName: c.contact.name, phone: c.contact.phone });
function followupWhere(workspaceId: string, conversation: Prisma.ConversationWhereInput, kind: Exclude<ExtensionQueueKind, 'human'>): Prisma.ConversationFollowupWhereInput {
  return { workspaceId, activeKey: 'active', conversation: { is: conversation }, status: kind === 'scheduled' ? 'scheduled' : 'review',
    ...(kind === 'reminders' ? { kind: 'seller_reminder' } : kind === 'review' ? { NOT: { kind: 'seller_reminder' } } : { NOT: { reason: 'brain_quiet_wait' } }) };
}
async function scope(db: ExtensionDb, auth: ExtensionAuth, input: ExtensionQueueQuery | ExtensionNavigation) {
  const { actor, channel } = await requireExtensionAccount(db, auth, input.account);
  const conversation: Prisma.ConversationWhereInput = { workspaceId: actor.workspaceId, channelId: channel.id, status: { not: 'closed' },
    retiredIntoConversationId: null, contact: { is: { isGroup: false } }, ...(actor.role === 'agent' ? { assignedUserId: actor.userId } : {}) };
  const human: Prisma.ConversationWhereInput = { AND: [conversation, inboxHandoffWhere, { hiddenUntilReply: false }] };
  return { actor, conversation, human };
}
export async function listExtensionQueue(db: ExtensionDb, auth: ExtensionAuth, input: ExtensionQueueQuery): Promise<ExtensionQueue> {
  const s = await scope(db, auth, input);
  const kinds = ['review', 'reminders', 'scheduled', 'human'] as const;
  const values = await Promise.all(kinds.map(k => k === 'human' ? db.conversation.count({ where: s.human })
    : db.conversationFollowup.count({ where: followupWhere(s.actor.workspaceId, s.conversation, k) })));
  const counts = Object.fromEntries(kinds.map((k, i) => [k, values[i]!])) as ExtensionQueue['counts'];
  if (input.kind === 'human') {
    if (input.cursor && !await db.conversation.findFirst({ where: { AND: [s.human, { id: input.cursor }] }, select: { id: true } })) stale();
    const rows = await db.conversation.findMany({ where: s.human, select: humanSelect, orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: 31, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) });
    return { kind: input.kind, counts, nextCursor: rows.length > 30 ? rows[29]!.id : null, items: rows.slice(0,30).map(r => ({ id: r.id, conversation: dto(r), reason: r.activeAgentSession?.handoffReason ?? null, followup: null })) };
  }
  const where = followupWhere(s.actor.workspaceId, s.conversation, input.kind);
  if (input.cursor && !await db.conversationFollowup.findFirst({ where: { AND: [where, { id: input.cursor }] }, select: { id: true } })) stale();
  const rows = await db.conversationFollowup.findMany({ where, select: followupSelect, orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }], take: 31,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) });
  return { kind: input.kind, counts, nextCursor: rows.length > 30 ? rows[29]!.id : null, items: rows.slice(0,30).map(r => ({ id: r.id, conversation: dto(r.conversation), reason: null,
    followup: { id: r.id, kind: r.kind, status: r.status, scheduledAt: r.scheduledAt.toISOString(), updatedAt: r.updatedAt.toISOString() } })) };
}
export async function resolveExtensionQueueTarget(db: ExtensionDb, auth: ExtensionAuth, input: ExtensionNavigation): Promise<ExtensionNavigationTarget> {
  const s = await scope(db, auth, input);
  if (input.kind === 'human') {
    const row = await db.conversation.findFirst({ where: { AND: [s.human, { id: input.id }] }, select: humanSelect });
    if (!row) return stale();
    return { conversation: dto(row), prepare: null };
  }
  const row = await db.conversationFollowup.findFirst({ where: { AND: [followupWhere(s.actor.workspaceId, s.conversation, input.kind), { id: input.id }] }, select: followupSelect });
  if (!row || !input.expectedUpdatedAt || row.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) return stale();
  return { conversation: dto(row.conversation), prepare: input.kind === 'review' && row.kind !== 'seller_reminder' ? { id: row.id, expectedUpdatedAt: row.updatedAt.toISOString() } : null };
}
