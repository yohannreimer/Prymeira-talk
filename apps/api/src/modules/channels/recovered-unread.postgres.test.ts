import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeWahaEvent } from '../waha/waha-normalizer.js';
import { persistProviderMessages } from './channel-history-canonical.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const NOW = Date.now();

describe.skipIf(!databaseUrl)('unread after recovered messages', () => {
  let db: PrismaClient;
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => { await db?.$disconnect(); });

  it('a reply we sent from the phone clears what was waiting before it; reactions are never unread', async () => {
    const workspaceId = randomUUID();
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `inst-${randomUUID()}`, historyImportStatus: 'completed' } });
    const waha = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: `waha-${randomUUID()}`, status: 'connected' } });
    const chat = '5547999993333@c.us';
    const item = (id: string, atMs: number, fromMe: boolean, extra: Record<string, unknown> = {}, event = 'message.any') => ({ receiptId: `${fromMe}_${chat}_${id}`, timestampMs: atMs,
      normalize: (context: Parameters<typeof normalizeWahaEvent>[0]) => normalizeWahaEvent(context, { event, session: waha.sessionName,
        payload: { id: `${fromMe}_${chat}_${id}`, from: fromMe ? undefined : chat, to: fromMe ? chat : undefined, fromMe, body: id, timestamp: Math.floor(atMs / 1000), _data: { type: 'chat', body: id }, ...extra } }, { verifiedLidMappings: [] }) });
    const recover = (items: ReturnType<typeof item>[]) => persistProviderMessages({ prisma: db, channel: { id: channel.id, workspaceId, providerKey: channel.providerKey },
      connection: { id: waha.id, provider: 'waha' }, mode: 'recovered_live', items, batchId: randomUUID() });
    await recover([item('IN1', NOW - 300_000, false), item('IN2', NOW - 290_000, false)]);
    const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId } });
    expect(conversation.unreadCount).toBe(2);
    await recover([item('OUT1', NOW - 200_000, true)]);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).unreadCount).toBe(0);
    await recover([item('RX1', NOW - 100_000, false, { reaction: { text: '👍', messageId: `true_${chat}_OUT1` } }, 'message.reaction')]);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).unreadCount).toBe(0);
    const reaction = await db.message.findFirstOrThrow({ where: { workspaceId, body: 'Reagiu com 👍' } });
    expect(reaction.metadata).toMatchObject({ reaction: { targetId: 'OUT1', emoji: '👍' }, whatsapp: { id: 'RX1' } });
  });
});
