import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '../evolution/evolution-history.js';
import { importChatCanonical } from './channel-history-canonical.js';
import { resolveLidConversationsSweep } from './lid-resolution.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const NOW = Date.now();

describe.skipIf(!databaseUrl)('LID conversations resolved through WAHA', () => {
  let db: PrismaClient;
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => { await db?.$disconnect(); });

  async function fixture() {
    const workspaceId = randomUUID();
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `inst-${randomUUID()}`, historyImportStatus: 'completed' } });
    const connected = { status: 'connected' as const, verifiedPhoneNumber: '5547999998888', lastHealthyAt: new Date(), eligible: true };
    const evolution = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, ...connected } });
    await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: `waha-${randomUUID()}`, ...connected } });
    const target = { id: channel.id, workspaceId, providerKey: channel.providerKey };
    const imported = (jid: string, id: string, text: string, atMs: number) => importChatCanonical({ prisma: db, channel: target, connectionId: evolution.id,
      chat: { remoteJid: jid, phoneJid: jid, pushName: null, profilePicUrl: null }, batchId: randomUUID(),
      records: [{ key: { id, remoteJid: jid, fromMe: false }, messageTimestamp: Math.floor(atMs / 1000), message: { conversation: text }, messageType: 'conversation' } as HistoryRecord] });
    return { workspaceId, imported };
  }
  const lid = () => `${Math.floor(1e14 + Math.random() * 8e14)}@lid`;

  it('gives a LID-only conversation its phone number', async () => {
    const f = await fixture(), L = lid();
    await f.imported(L, 'A1', 'opa, confirmado hoje?', NOW - 60_000);
    const lookup = vi.fn(async () => '5547988887777@s.whatsapp.net');
    expect(await resolveLidConversationsSweep(db, { lids: { lookup } }, { workspaceIds: [f.workspaceId] })).toEqual({ resolved: 1, merged: 0 });
    const conversations = await db.conversation.findMany({ where: { workspaceId: f.workspaceId }, include: { contact: true } });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.contact.phone).not.toContain('@lid');
    expect(conversations[0]!.contact.customFields).toMatchObject({ evolutionLid: L });
    // Resolved: never asked again.
    expect(await resolveLidConversationsSweep(db, { lids: { lookup } }, { workspaceIds: [f.workspaceId] })).toEqual({ resolved: 0, merged: 0 });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('merges a LID conversation into the existing phone conversation, keeping the phone one', async () => {
    const f = await fixture(), L = lid();
    await f.imported('5547977776666@s.whatsapp.net', 'P1', 'mensagem pelo número', NOW - 120_000);
    await f.imported(L, 'L1', 'mensagem pelo lid', NOW - 60_000);
    expect(await db.conversation.count({ where: { workspaceId: f.workspaceId, retiredIntoConversationId: null } })).toBe(2);
    expect(await resolveLidConversationsSweep(db, { lids: { lookup: async () => '5547977776666@s.whatsapp.net' } }, { workspaceIds: [f.workspaceId] })).toEqual({ resolved: 1, merged: 1 });
    const visible = await db.conversation.findMany({ where: { workspaceId: f.workspaceId, retiredIntoConversationId: null }, include: { contact: true } });
    expect(visible).toHaveLength(1);
    expect(visible[0]!.contact.phone).not.toContain('@lid');
  });

  it('leaves a LID WAHA does not know as it is and asks again later, more rarely each time', async () => {
    const f = await fixture(), L = lid();
    await f.imported(L, 'U1', 'oi', NOW - 60_000);
    const lookup = vi.fn(async () => null);
    let clock = NOW;
    const run = () => resolveLidConversationsSweep(db, { lids: { lookup } }, { workspaceIds: [f.workspaceId], now: () => clock });
    expect(await run()).toEqual({ resolved: 0, merged: 0 });
    expect(await run()).toEqual({ resolved: 0, merged: 0 });
    expect(lookup).toHaveBeenCalledTimes(1);
    clock += 6 * 60_000; await run();
    expect(lookup).toHaveBeenCalledTimes(2); // 5 min after the first try
    clock += 6 * 60_000; await run();
    expect(lookup).toHaveBeenCalledTimes(2); // the next one waits 15 min
    clock += 7 * 60 * 60_000; await run();
    expect(lookup).toHaveBeenCalledTimes(3);
    expect((await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId }, include: { contact: true } })).contact.phone).toBe(L);
  });
});
