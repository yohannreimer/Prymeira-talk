import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeWahaEvent } from '../waha/waha-normalizer.js';
import { persistProviderMessages } from './channel-history-canonical.js';
import { repairWahaNotices } from './waha-notice-repair.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const NOW = Date.now();

describe.skipIf(!databaseUrl)('repair of WAHA notices imported as unrecognized messages', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => { await db?.$disconnect(); });

  it('removes what only WAHA history wrote, hides chats left empty and restores the preview of the others', async () => {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `inst-${randomUUID()}`, historyImportStatus: 'completed' } });
    const waha = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: `waha-${randomUUID()}`, status: 'connected' } });
    const target = { id: channel.id, workspaceId, providerKey: channel.providerKey };
    // A type Talk cannot render still becomes "Mensagem não reconhecida", like the notices did before the filter.
    const item = (chat: string, id: string, atMs: number, type: string, body = '') => ({ receiptId: `false_${chat}_${id}`, timestampMs: atMs,
      normalize: (context: Parameters<typeof normalizeWahaEvent>[0]) => normalizeWahaEvent(context, { event: 'message.any', session: waha.sessionName,
        payload: { id: `false_${chat}_${id}`, from: chat, fromMe: false, body, timestamp: Math.floor(atMs / 1000), _data: { type, body } } }, { verifiedLidMappings: [] }) });
    const only = '5547999991111@c.us', mixed = '5547999992222@c.us';
    for (const items of [[item(only, 'N1', NOW, 'poll_creation')], [item(mixed, 'R1', NOW - 86_400_000, 'chat', 'mensagem real'), item(mixed, 'N2', NOW, 'poll_creation')]])
      await persistProviderMessages({ prisma: db, channel: target, connection: { id: waha.id, provider: 'waha' }, mode: 'history', items, batchId: randomUUID() });
    expect(await db.message.count({ where: { workspaceId, body: 'Mensagem não reconhecida' } })).toBe(2);

    expect(await repairWahaNotices(db, { workspaceId, apply: false })).toMatchObject({ candidates: 2, removed: 0 });
    expect(await repairWahaNotices(db, { workspaceId, apply: true })).toEqual({ candidates: 2, removed: 2, skipped: 0, hiddenConversations: 1, refreshedConversations: 1 });
    expect((await db.message.findMany({ where: { workspaceId } })).map(m => m.body)).toEqual(['mensagem real']);
    const conversations = await db.conversation.findMany({ where: { workspaceId }, include: { contact: true } });
    const hidden = conversations.find(c => c.contact.phone?.includes('1111'))!, kept = conversations.find(c => c.contact.phone?.includes('2222'))!;
    expect(hidden).toMatchObject({ hiddenUntilReply: true, lastMessagePreview: null, lastMessageAt: null });
    expect(kept).toMatchObject({ hiddenUntilReply: false, lastMessagePreview: 'mensagem real' });
    expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: kept.id } })).not.toBeNull();
    expect(await repairWahaNotices(db, { workspaceId, apply: true })).toMatchObject({ candidates: 0 });
  });
});
