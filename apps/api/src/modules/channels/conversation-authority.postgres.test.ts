import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanonicalStore } from '../messaging/canonical-store.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import { createConversationsService, type PrismaLike as ConversationsPrismaLike } from '../conversations/conversations.service.js';
import { autoResolveAuthority, autoResolvePending, chooseDefaultConversation, listAuthorityReviews, resolveConversationAuthority } from './conversation-authority.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const PN = '5547999990002@s.whatsapp.net';
const LID = '223456789012345@lid';
const NOW = Math.floor(Date.now() / 1000);

describe.skipIf(!databaseUrl)('conversation authority resolution on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  const store = createCanonicalStore();
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => {
    if (!db) return;
    const where = { workspaceId: { in: workspaces } };
    await db.outboundIntent.deleteMany({ where });
    await db.canonicalChatAuthorityResolution.deleteMany({ where });
    await db.canonicalAction.deleteMany({ where }); await db.canonicalRecipientReceipt.deleteMany({ where });
    await db.canonicalAddressEvidence.deleteMany({ where }); await db.canonicalObservation.deleteMany({ where });
    await db.canonicalNativeAlias.deleteMany({ where }); await db.canonicalMessageIdentity.deleteMany({ where });
    await db.canonicalChatMember.deleteMany({ where }); await db.canonicalChat.deleteMany({ where });
    await db.canonicalAddressAlias.deleteMany({ where }); await db.canonicalAddress.updateMany({ where, data: { redirectId: null } });
    await db.canonicalAddress.deleteMany({ where }); await db.channel.deleteMany({ where }); await db.contact.deleteMany({ where });
    await db.$disconnect();
  });

  /** Two existing conversations (phone contact and LID contact) for one WhatsApp person. */
  async function fixture() {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `inst-${randomUUID()}` } });
    const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey } });
    const phoneContact = await db.contact.create({ data: { workspaceId, phone: '5547999990002', name: 'Ana (telefone)' } });
    const lidContact = await db.contact.create({ data: { workspaceId, phone: LID, name: 'Ana (lid)' } });
    const phoneConversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: phoneContact.id } });
    const lidConversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: lidContact.id } });
    return { workspaceId, channel, connection, phoneConversation, lidConversation };
  }
  async function deliver(f: Awaited<ReturnType<typeof fixture>>, id: string, text: string, offset: number, remoteJid = PN, extra: Record<string, unknown> = {}, mode: 'live' | 'history' = 'live') {
    return db.$transaction(async tx => {
      const context = await deriveTrustedMessagingContext(tx, { workspaceId: f.workspaceId, channelId: f.channel.id, authenticatedSource: { provider: 'evolution', connectionId: f.connection.id }, mode, observedAt: new Date().toISOString() });
      const n = normalizeEvolutionWebhook(context, { event: 'messages.upsert', instance: f.channel.providerKey, data: { key: { id, remoteJid, fromMe: false, ...extra }, messageTimestamp: NOW - 100 + offset, message: { conversation: text }, messageType: 'conversation', pushName: 'Ana' } });
      if (n.kind !== 'accepted') throw new Error('not accepted');
      return store.persistInTransaction(tx, n.event, { receiptKey: `r-${id}` });
    }, { isolationLevel: 'ReadCommitted' });
  }
  const prove = (f: Awaited<ReturnType<typeof fixture>>) => deliver(f, 'PROOF', 'prova', 0, LID, { remoteJidAlt: PN });

  it('holds a proven duplicate chat, lists it, and an operator choice reopens it and recovers held messages as history', async () => {
    const f = await fixture();
    const proof = await prove(f);
    expect(proof).toMatchObject({ outcome: 'held', reconciliationReasons: ['multiple_conversation_authorities'] });
    const held = await deliver(f, 'HELD-1', 'enquanto aguardava', 5);
    expect(held.outcome).toBe('held');

    const reviews = await listAuthorityReviews(db, { workspaceId: f.workspaceId });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.conversations.map(c => c.id).sort()).toEqual([f.phoneConversation.id, f.lidConversation.id].sort());

    // Give the retiring conversation jobs that must stop.
    await db.conversation.update({ where: { id: f.lidConversation.id }, data: { aiControlStatus: 'agent_allowed' } });
    const resolved = await resolveConversationAuthority(db, { workspaceId: f.workspaceId, channelId: f.channel.id, chatId: reviews[0]!.chatId, conversationId: f.phoneConversation.id, resolvedBy: 'owner-1' });
    expect(resolved).toMatchObject({ ok: true, operationConversationId: f.phoneConversation.id, retiredConversationIds: [f.lidConversation.id] });
    expect(resolved.ok && resolved.recovered).toBeGreaterThanOrEqual(1);

    expect(await listAuthorityReviews(db, { workspaceId: f.workspaceId })).toHaveLength(0);
    const retired = await db.conversation.findUniqueOrThrow({ where: { id: f.lidConversation.id } });
    expect(retired.aiControlStatus).toBe('human_controlled');
    expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(2); // nothing merged or removed
    // The held message landed in the operating conversation, without unread or operational effects.
    const operating = await db.conversation.findUniqueOrThrow({ where: { id: f.phoneConversation.id }, include: { messages: true } });
    expect(operating.messages.map(m => m.body)).toContain('enquanto aguardava');
    // Customer messages that arrived live and were held are not silent (people see them), but nothing acts on them.
    expect(operating.unreadCount).toBe(2);
    expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(0);

    // New messages from either spelling now operate the chosen conversation.
    const live = await deliver(f, 'LIVE-1', 'depois da decisao', 50, LID, { remoteJidAlt: PN });
    expect(live).toMatchObject({ outcome: 'created', conversationId: f.phoneConversation.id });
  });

  it('refuses a conversation that is not a claimant, a chat that is not in review, and an unknown send outcome', async () => {
    const f = await fixture();
    await prove(f);
    const chat = (await listAuthorityReviews(db, { workspaceId: f.workspaceId }))[0]!;
    const stranger = await db.conversation.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id, contactId: (await db.contact.create({ data: { workspaceId: f.workspaceId, phone: '5547000000000' } })).id } });
    expect(await resolveConversationAuthority(db, { workspaceId: f.workspaceId, channelId: f.channel.id, chatId: chat.chatId, conversationId: stranger.id, resolvedBy: 'o' })).toEqual({ ok: false, reason: 'conversation_not_a_member' });
    expect(await resolveConversationAuthority(db, { workspaceId: f.workspaceId, channelId: f.channel.id, chatId: randomUUID(), conversationId: f.phoneConversation.id, resolvedBy: 'o' })).toEqual({ ok: false, reason: 'chat_not_found' });
    const message = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: f.lidConversation.id, direction: 'outbound', type: 'text', body: 'x' } });
    await db.outboundIntent.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id, conversationId: f.lidConversation.id, messageId: message.id, chatId: chat.chatId,
      originKind: 'human', originId: 'u', actionOrdinal: 0, requestKey: 'k', request: {}, domainFences: {}, authorityRevision: 0, state: 'uncertain' } });
    expect(await resolveConversationAuthority(db, { workspaceId: f.workspaceId, channelId: f.channel.id, chatId: chat.chatId, conversationId: f.phoneConversation.id, resolvedBy: 'o' })).toEqual({ ok: false, reason: 'send_outcome_unknown' });
    expect(await listAuthorityReviews(db, { workspaceId: f.workspaceId })).toHaveLength(1);
  });

  it('a decision does not survive a new competing conversation', async () => {
    const f = await fixture();
    await prove(f);
    const chat = (await listAuthorityReviews(db, { workspaceId: f.workspaceId }))[0]!;
    expect((await resolveConversationAuthority(db, { workspaceId: f.workspaceId, channelId: f.channel.id, chatId: chat.chatId, conversationId: f.lidConversation.id, resolvedBy: 'o' })).ok).toBe(true);
    // A third contact for the same phone (another spelling) appears later.
    const third = await db.contact.create({ data: { workspaceId: f.workspaceId, phone: '554799990002' } });
    await db.conversation.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id, contactId: third.id } });
    const after = await deliver(f, 'AFTER-3RD', 'nova', 60);
    expect(after).toMatchObject({ outcome: 'held', reconciliationReasons: ['multiple_conversation_authorities'] });
  });

  describe('phone-number default: nobody has to choose, and only one conversation shows', () => {
    const service = () => createConversationsService(db as unknown as ConversationsPrismaLike);
    it('picks the phone conversation over the LID one, hides the other and shows both histories in the one that stays', async () => {
      const f = await fixture();
      await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: f.lidConversation.id, direction: 'inbound', type: 'text', status: 'delivered', metadata: {}, body: 'historia no lid', createdAt: new Date(Date.now() - 86_400_000) } });
      await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: f.phoneConversation.id, direction: 'inbound', type: 'text', status: 'delivered', metadata: {}, body: 'historia no telefone', createdAt: new Date(Date.now() - 43_200_000) } });
      await prove(f);
      const held = await deliver(f, 'HELD-A', 'chegou durante a duvida', 5);
      expect(held.outcome).toBe('held');
      const chat = (await listAuthorityReviews(db, { workspaceId: f.workspaceId }))[0]!;
      const result = await autoResolveAuthority(db, { workspaceId: f.workspaceId, channelId: f.channel.id, chatId: chat.chatId });
      expect(result).toMatchObject({ ok: true, operationConversationId: f.phoneConversation.id, retiredConversationIds: [f.lidConversation.id] });
      expect(await db.canonicalChatAuthorityResolution.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).toMatchObject({ resolvedBy: 'system:phone-default' });
      expect(await listAuthorityReviews(db, { workspaceId: f.workspaceId })).toHaveLength(0);

      // Only one conversation reaches the inbox, and the person's whole history is in it.
      const listed = await service().listConversations({ workspaceId: f.workspaceId, status: 'all' });
      expect(listed.map(c => c.id)).toEqual([f.phoneConversation.id]);
      const messages = await service().listMessages({ workspaceId: f.workspaceId, conversationId: f.phoneConversation.id });
      expect(messages.map(m => m.body)).toEqual(expect.arrayContaining(['historia no lid', 'historia no telefone', 'chegou durante a duvida']));
      expect((await db.conversation.findUniqueOrThrow({ where: { id: f.phoneConversation.id } })).unreadCount).toBe(2); // the proving message and the held one are live: not silent
      // Opening the hidden one directly shows nothing extra; it owns only its own rows.
      expect((await service().listMessages({ workspaceId: f.workspaceId, conversationId: f.lidConversation.id })).map(m => m.body)).toEqual(['historia no lid']);
    });

    it('leaves a person\'s earlier explicit choice alone, and every safety refusal for a person', async () => {
      const f = await fixture();
      await prove(f);
      const chat = (await listAuthorityReviews(db, { workspaceId: f.workspaceId }))[0]!;
      // An unknown send outcome keeps the chat waiting; the sweep does not force it.
      const message = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: f.lidConversation.id, direction: 'outbound', type: 'text', body: 'x' } });
      await db.outboundIntent.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id, conversationId: f.lidConversation.id, messageId: message.id, chatId: chat.chatId,
        originKind: 'human', originId: 'u', actionOrdinal: 0, requestKey: 'k2', request: {}, domainFences: {}, authorityRevision: 0, state: 'uncertain' } });
      expect(await autoResolveAuthority(db, { workspaceId: f.workspaceId, channelId: f.channel.id, chatId: chat.chatId })).toEqual({ ok: false, reason: 'send_outcome_unknown' });
      expect(await autoResolvePending(db, { workspaceIds: [f.workspaceId] })).toEqual({ examined: 1, resolved: 0 });
      expect((await db.conversation.findUniqueOrThrow({ where: { id: f.lidConversation.id } })).retiredIntoConversationId).toBeNull();
      // Once the send is settled, the sweep decides.
      await db.outboundIntent.updateMany({ where: { workspaceId: f.workspaceId }, data: { state: 'definitively_rejected' } });
      expect(await autoResolvePending(db, { workspaceIds: [f.workspaceId] })).toEqual({ examined: 1, resolved: 1 });
      // A person chose the LID one earlier: a later conflict is never decided for them.
      const g = await fixture();
      await prove(g);
      const gChat = (await listAuthorityReviews(db, { workspaceId: g.workspaceId }))[0]!;
      expect((await resolveConversationAuthority(db, { workspaceId: g.workspaceId, channelId: g.channel.id, chatId: gChat.chatId, conversationId: g.lidConversation.id, resolvedBy: 'owner-1' })).ok).toBe(true);
      const third = await db.contact.create({ data: { workspaceId: g.workspaceId, phone: '554799990002' } });
      await db.conversation.create({ data: { workspaceId: g.workspaceId, channelId: g.channel.id, contactId: third.id } });
      await deliver(g, 'AFTER-3RD-B', 'nova', 70);
      expect(await autoResolveAuthority(db, { workspaceId: g.workspaceId, channelId: g.channel.id, chatId: gChat.chatId })).toEqual({ ok: false, reason: 'manual_choice_on_record' });
    });

    it('chooses by rule: real phone only, then most recent activity, then more messages', () => {
      const at = (day: number) => new Date(2026, 9, day);
      const lid = { id: 'lid', contactPhone: '1@lid', isGroup: false, lastMessageAt: at(30), messageCount: 99 };
      expect(chooseDefaultConversation([lid])).toBeNull();
      expect(chooseDefaultConversation([lid, { id: 'phone', contactPhone: '5547999990002', isGroup: false, lastMessageAt: at(1), messageCount: 1 }])).toBe('phone');
      expect(chooseDefaultConversation([{ id: 'old', contactPhone: '554799990002', isGroup: false, lastMessageAt: at(1), messageCount: 50 }, { id: 'recent', contactPhone: '5547999990002', isGroup: false, lastMessageAt: at(5), messageCount: 2 }])).toBe('recent');
      expect(chooseDefaultConversation([{ id: 'a', contactPhone: '5547999990002', isGroup: false, lastMessageAt: at(5), messageCount: 2 }, { id: 'b', contactPhone: '554799990002', isGroup: false, lastMessageAt: at(5), messageCount: 9 }])).toBe('b');
    });
  });
});
