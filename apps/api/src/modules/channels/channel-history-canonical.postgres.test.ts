import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EvolutionHistorySource, HistoryRecord } from '../evolution/evolution-history.js';
import { createCanonicalStore } from '../messaging/canonical-store.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import { canonicalHistoryConnection } from './channel-history-canonical.js';
import { createChannelHistoryImporter } from './channel-history-import.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const PN = '5547999990001@s.whatsapp.net';
const LID = '123456789012345@lid';
const NOW = Math.floor(Date.now() / 1000);

describe.skipIf(!databaseUrl)('canonical channel history import on PostgreSQL', () => {
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
    await db.canonicalAction.deleteMany({ where }); await db.canonicalRecipientReceipt.deleteMany({ where });
    await db.canonicalAddressEvidence.deleteMany({ where }); await db.canonicalObservation.deleteMany({ where });
    await db.canonicalNativeAlias.deleteMany({ where }); await db.canonicalMessageIdentity.deleteMany({ where });
    await db.canonicalChatMember.deleteMany({ where }); await db.canonicalChat.deleteMany({ where });
    await db.canonicalAddressAlias.deleteMany({ where }); await db.canonicalAddress.updateMany({ where, data: { redirectId: null } });
    await db.canonicalAddress.deleteMany({ where }); await db.channel.deleteMany({ where }); await db.contact.deleteMany({ where });
    await db.$disconnect();
  });
  async function fixture(withConnection = true) {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `inst-${randomUUID()}` } });
    const connection = withConnection ? await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey } }) : null;
    return { workspaceId, channel, connection };
  }
  const record = (id: string, fromMe: boolean, text: string, offset: number, remoteJid = PN, extra: Partial<HistoryRecord['key']> = {}): HistoryRecord =>
    ({ key: { id, remoteJid, fromMe, ...extra }, messageTimestamp: NOW - 1000 + offset, message: { conversation: text }, ...(fromMe ? {} : { pushName: 'Cliente' }) });
  function importer(records: HistoryRecord[]) {
    const source = { recentMessages: vi.fn().mockResolvedValue(records) } as unknown as EvolutionHistorySource;
    return createChannelHistoryImporter({ prisma: db, source, canonical: true });
  }
  const chat = (remoteJid = PN, phoneJid = PN) => ({ remoteJid, phoneJid, pushName: null, profilePicUrl: 'https://example.com/a.jpg' });
  const target = (f: Awaited<ReturnType<typeof fixture>>) => ({ id: f.channel.id, workspaceId: f.workspaceId, providerKey: f.channel.providerKey, historyImportAttempts: 0 });

  it('imports through the canonical store: ordered, human-controlled, unread 0, idempotent', async () => {
    const f = await fixture();
    const records = [record('H2', true, 'Bom dia', 30), record('H1', false, 'Olá', 0)];
    const onConversation = vi.fn();
    const run = () => createChannelHistoryImporter({ prisma: db, canonical: true, onConversation,
      source: { recentMessages: vi.fn().mockResolvedValue(records) } as unknown as EvolutionHistorySource }).importChat(target(f), chat(), 30);
    expect(await run()).toBe(2);
    expect(await run()).toBe(0);
    const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId }, include: { contact: true, messages: { orderBy: { createdAt: 'asc' } } } });
    expect(conversation.messages.map(m => [m.direction, m.body])).toEqual([['inbound', 'Olá'], ['outbound', 'Bom dia']]);
    expect((await db.canonicalMessageIdentity.findMany({ where: { workspaceId: f.workspaceId } })).map(i => i.rawId).sort()).toEqual(['H1', 'H2']);
    expect(conversation).toMatchObject({ unreadCount: 0, aiControlStatus: 'human_controlled', lastMessagePreview: 'Bom dia' });
    expect(conversation.lastMessageAt?.getTime()).toBe(conversation.messages[1]!.createdAt.getTime());
    expect(conversation.contact).toMatchObject({ name: 'Cliente', avatarUrl: 'https://example.com/a.jpg' });
    expect((conversation.messages[0]!.metadata as any).historyImport).toMatchObject({ source: 'evolution', channelId: f.channel.id });
    expect(await db.canonicalMessageIdentity.count({ where: { workspaceId: f.workspaceId } })).toBe(2);
    expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    expect(onConversation).toHaveBeenCalledWith(f.workspaceId, conversation.id);
  });

  it('never duplicates a message already received live or owned by a legacy writer', async () => {
    const f = await fixture();
    const live = await db.$transaction(async tx => {
      const context = await deriveTrustedMessagingContext(tx, { workspaceId: f.workspaceId, channelId: f.channel.id, authenticatedSource: { provider: 'evolution', connectionId: f.connection!.id }, mode: 'live', observedAt: new Date().toISOString() });
      const n = normalizeEvolutionWebhook(context, { event: 'messages.upsert', instance: f.channel.providerKey, data: { ...record('LIVE', false, 'ao vivo', 900), messageType: 'conversation' } });
      if (n.kind !== 'accepted') throw new Error('not accepted');
      return store.persistInTransaction(tx, n.event, { receiptKey: 'live-1' });
    }, { isolationLevel: 'ReadCommitted' });
    const legacy = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: live.conversationId!, direction: 'inbound', type: 'text', body: 'legado', providerMessageId: 'LEGACY' } });
    expect(await importer([record('LIVE', false, 'ao vivo', 900), record('LEGACY', false, 'legado', 10), record('NEW', false, 'novo', 5)]).importChat(target(f), chat(), 30)).toBe(1);
    const messages = await db.message.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { createdAt: 'asc' } });
    expect(messages.map(m => m.body).sort()).toEqual(['ao vivo', 'legado', 'novo']);
    expect((await db.canonicalMessageIdentity.findMany({ where: { workspaceId: f.workspaceId } })).map(i => i.rawId).sort()).toEqual(['LIVE', 'NEW']);
    expect(messages.find(m => m.id === legacy.id)?.body).toBe('legado');
    expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
  });

  it('history older than the current activity never moves the preview or unread count', async () => {
    const f = await fixture();
    await importer([record('NEWER', false, 'recente', 500)]).importChat(target(f), chat(), 30);
    expect(await importer([record('OLDER', false, 'antiga', 10)]).importChat(target(f), chat(), 30)).toBe(1);
    const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    expect(conversation).toMatchObject({ lastMessagePreview: 'recente', unreadCount: 0 });
  });

  it('joins a LID chat and its phone chat into one conversation when the provider proves the pair', async () => {
    const f = await fixture();
    await importer([record('P1', false, 'pelo telefone', 0)]).importChat(target(f), chat(), 30);
    await importer([record('L1', false, 'pelo lid', 20, LID, { remoteJidAlt: PN })]).importChat(target(f), chat(LID, PN), 30);
    expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(2);
  });

  it('only a channel with an idle Evolution connection uses the canonical writer', async () => {
    const none = await fixture(false);
    expect(await canonicalHistoryConnection(db, { id: none.channel.id, workspaceId: none.workspaceId, providerKey: none.channel.providerKey })).toBeNull();
    const busy = await fixture();
    await db.channelConnection.update({ where: { id: busy.connection!.id }, data: { lifecycleGeneration: 1 } });
    expect(await canonicalHistoryConnection(db, { id: busy.channel.id, workspaceId: busy.workspaceId, providerKey: busy.channel.providerKey })).toBeNull();
  });
});
