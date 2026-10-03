import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '../evolution/evolution-history.js';
import type { WahaMessage } from '../waha/waha.client.js';
import { importChatCanonical } from './channel-history-canonical.js';
import { normalizeChatAddress } from '../messaging/whatsapp-identity.js';
import { rolloutDiagnostics } from './rollout-diagnostics.js';
import { compareProviderHistories, importConnectionHistory, recoverConnectionGap, wahaChatAddress, wahaHistorySweep, type ProviderHistoryDeps } from './provider-history.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const PHONE = '5547999990003', PN = `${PHONE}@s.whatsapp.net`, CUS = `${PHONE}@c.us`, LID = '323456789012345@lid';
const NOW = Date.now();

describe.skipIf(!databaseUrl)('provider history and gap recovery on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => {
    if (!db) return;
    const where = { workspaceId: { in: workspaces } };
    await db.canonicalChatAuthorityResolution.deleteMany({ where });
    await db.canonicalAction.deleteMany({ where }); await db.canonicalRecipientReceipt.deleteMany({ where });
    await db.canonicalAddressEvidence.deleteMany({ where }); await db.canonicalObservation.deleteMany({ where });
    await db.canonicalNativeAlias.deleteMany({ where }); await db.canonicalMessageIdentity.deleteMany({ where });
    await db.canonicalChatMember.deleteMany({ where }); await db.canonicalChat.deleteMany({ where });
    await db.canonicalAddressAlias.deleteMany({ where }); await db.canonicalAddress.updateMany({ where, data: { redirectId: null } });
    await db.canonicalAddress.deleteMany({ where }); await db.channel.deleteMany({ where }); await db.contact.deleteMany({ where });
    await db.$disconnect();
  });
  async function fixture(paired = true) {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `inst-${randomUUID()}`, historyImportStatus: 'completed' } });
    const connected = { status: 'connected' as const, verifiedPhoneNumber: '5547999998888', lastHealthyAt: new Date(), eligible: true };
    const evolution = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, ...connected } });
    const waha = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: `waha-${randomUUID()}`, ...connected,
      ...(paired ? {} : { verifiedPhoneNumber: '5511000000000' }) } });
    return { workspaceId, channel, evolution, waha, target: { id: channel.id, workspaceId, providerKey: channel.providerKey } };
  }
  const evo = (id: string, text: string, atMs: number, fromMe = false): HistoryRecord => ({ key: { id, remoteJid: PN, fromMe }, messageTimestamp: Math.floor(atMs / 1000), message: { conversation: text }, messageType: 'conversation', ...(fromMe ? {} : { pushName: 'Bia' }) });
  const wa = (id: string, text: string, atMs: number, chat = CUS, fromMe = false): WahaMessage => ({ id: `${fromMe}_${chat}_${id}`, from: fromMe ? undefined : chat, to: fromMe ? chat : undefined, fromMe, body: text, timestamp: Math.floor(atMs / 1000) });
  const deps = (input: { evolution?: HistoryRecord[]; waha?: Record<string, WahaMessage[]>; wahaChats?: Array<Record<string, unknown>> }): ProviderHistoryDeps => ({
    evolution: { recentChats: vi.fn(async () => ({ chats: [{ remoteJid: PN, phoneJid: PN, pushName: 'Bia', profilePicUrl: null }], unresolvedLids: 0 })),
      recentMessages: vi.fn(async () => input.evolution ?? []) },
    waha: { getChats: vi.fn(async ({ offset }: { offset: number }) => offset ? [] : (input.wahaChats ?? Object.keys(input.waha ?? {}).map(id => ({ id, name: 'Bia (WAHA)', timestamp: Math.floor(NOW / 1000) })))),
      getMessages: vi.fn(async ({ chatId }: { chatId: string }) => input.waha?.[chatId] ?? []) }
  } as unknown as ProviderHistoryDeps);

  it('WAHA history only adds what Evolution lacked, and never creates a conversation for an unproven LID chat', async () => {
    const f = await fixture();
    const day = 86_400_000;
    await importChatCanonical({ prisma: db, channel: f.target, connectionId: f.evolution.id, chat: { remoteJid: PN, phoneJid: PN, pushName: 'Bia', profilePicUrl: null },
      records: [evo('H1', 'oi', NOW - 3 * day), evo('H2', 'tudo bem?', NOW - 2 * day, true)], batchId: randomUUID() });
    const sources = deps({ waha: { [CUS]: [wa('H1', 'oi', NOW - 3 * day), wa('H2', 'tudo bem?', NOW - 2 * day, CUS, true), wa('H3', 'só a waha tinha', NOW - day)], [LID]: [wa('L1', 'por lid', NOW - day, LID)] } });
    const result = await importConnectionHistory(db, sources, f.waha);
    expect(result).toMatchObject({ inserted: 1 });
    expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    const messages = await db.message.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { createdAt: 'asc' } });
    expect(messages.map(m => m.body)).toEqual(['oi', 'tudo bem?', 'só a waha tinha']);
    expect(await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 0, aiControlStatus: 'human_controlled', lastMessagePreview: 'só a waha tinha' });
    expect(wahaChatAddress(LID)).toBeNull();
    expect(wahaChatAddress(CUS)).toBe(normalizeChatAddress(PN)); // the same storage form Evolution's address takes
  });

  it('the WAHA history sweep waits for Evolution, needs the same verified number, and runs once', async () => {
    const f = await fixture();
    const sources = deps({ waha: { [CUS]: [wa('S1', 'oi', NOW - 60_000)] } });
    await db.channel.update({ where: { id: f.channel.id }, data: { historyImportStatus: 'pending' } });
    expect(await wahaHistorySweep(db, sources, { workspaceIds: [f.workspaceId] })).toEqual({ imported: 0 });
    await db.channel.update({ where: { id: f.channel.id }, data: { historyImportStatus: 'completed' } });
    expect(await wahaHistorySweep(db, sources, { workspaceIds: [f.workspaceId] })).toEqual({ imported: 1 });
    expect(await wahaHistorySweep(db, sources, { workspaceIds: [f.workspaceId] })).toEqual({ imported: 0 });
    expect((await db.channelConnection.findUniqueOrThrow({ where: { id: f.waha.id } })).historyImportedAt).toBeInstanceOf(Date);
    const other = await fixture(false);
    expect(await wahaHistorySweep(db, sources, { workspaceIds: [other.workspaceId] })).toEqual({ imported: 0 });
    expect(await db.message.count({ where: { workspaceId: other.workspaceId } })).toBe(0);
  });

  it('gap recovery reconciles the window since the checkpoint with overlap, counts missed messages as unread and advances once', async () => {
    const f = await fixture();
    await db.channelConnection.update({ where: { id: f.evolution.id }, data: { recoveredThroughAt: new Date(NOW - 20 * 60_000) } });
    // Already received live (it is a duplicate), missed in the window, too new to touch, and older than the window.
    await importChatCanonical({ prisma: db, channel: f.target, connectionId: f.evolution.id, chat: { remoteJid: PN, phoneJid: PN, pushName: null, profilePicUrl: null },
      records: [evo('LIVE', 'chegou ao vivo', NOW - 25 * 60_000)], batchId: randomUUID() });
    const sources = deps({ evolution: [evo('LIVE', 'chegou ao vivo', NOW - 25 * 60_000), evo('MISSED', 'perdida', NOW - 15 * 60_000), evo('FRESH', 'agora', NOW - 5_000), evo('OLD', 'antiga', NOW - 60 * 60_000)] });
    const connection = await db.channelConnection.findUniqueOrThrow({ where: { id: f.evolution.id } });
    const first = await recoverConnectionGap(db, sources, connection, { now: NOW });
    expect(first).toMatchObject({ recovered: 1, advanced: true });
    expect((await db.message.findMany({ where: { workspaceId: f.workspaceId } })).map(m => m.body).sort()).toEqual(['chegou ao vivo', 'perdida']);
    expect((await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).unreadCount).toBe(1);
    expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    const advanced = await db.channelConnection.findUniqueOrThrow({ where: { id: f.evolution.id } });
    expect(advanced.recoveredThroughAt?.getTime()).toBe(NOW - 30_000);
    // The next run overlaps: the missed message is now a duplicate, the fresh one enters once it settles.
    expect(await recoverConnectionGap(db, sources, advanced, { now: NOW + 60_000 })).toMatchObject({ recovered: 1 });
    expect((await db.message.findMany({ where: { workspaceId: f.workspaceId } })).map(m => m.body).sort()).toEqual(['agora', 'chegou ao vivo', 'perdida']);
    // A stale checkpoint (another worker moved it) does not move it backwards.
    expect(await recoverConnectionGap(db, sources, connection, { now: NOW })).toMatchObject({ advanced: false });
  });

  it('compares both providers by exact message id without writing anything', async () => {
    const f = await fixture();
    const sources = deps({ evolution: [evo('A', 'a', NOW - 9_000), evo('B', 'b', NOW - 8_000)], waha: { [CUS]: [wa('A', 'a', NOW - 9_000), wa('C', 'c', NOW - 7_000)] } });
    const comparison = await compareProviderHistories(sources as Required<ProviderHistoryDeps>, { evolutionSession: f.evolution.sessionName, wahaSession: f.waha.sessionName });
    expect(comparison.totals).toEqual({ evolution: 2, waha: 2, onlyEvolution: 1, onlyWaha: 1, both: 1 });
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });

  it('prepares durable media and announces live what recovery or history writes', async () => {
    const f = await fixture();
    await db.channelConnection.update({ where: { id: f.evolution.id }, data: { recoveredThroughAt: new Date(NOW - 20 * 60_000) } });
    const image: HistoryRecord = { key: { id: 'IMG', remoteJid: PN, fromMe: false }, messageTimestamp: Math.floor((NOW - 10 * 60_000) / 1000), messageType: 'imageMessage',
      message: { imageMessage: { url: 'https://mmg.whatsapp.net/v/t62/img.enc', mimetype: 'image/jpeg', caption: 'foto' } }, pushName: 'Bia' };
    const prepareMedia = vi.fn(async () => undefined), notify = vi.fn(async () => undefined);
    const sources = { ...deps({ evolution: [image, evo('TXT', 'texto', NOW - 9 * 60_000)] }), after: { prepareMedia, notify } };
    const result = await recoverConnectionGap(db, sources, await db.channelConnection.findUniqueOrThrow({ where: { id: f.evolution.id } }), { now: NOW });
    expect(result.recovered).toBe(2);
    const stored = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'image' } });
    expect(prepareMedia).toHaveBeenCalledTimes(1);
    expect(prepareMedia).toHaveBeenCalledWith({ workspaceId: f.workspaceId, messageId: stored.id,
      source: expect.objectContaining({ provider: 'evolution', channelProvider: 'evolution', sessionName: f.evolution.sessionName, key: expect.objectContaining({ nativeId: 'IMG' }) }) });
    expect(notify).toHaveBeenCalledWith(f.workspaceId, expect.arrayContaining([expect.objectContaining({ messageId: stored.id })]));
    // A failing media download never undoes the message: it stays, with its media pending.
    const g = await fixture();
    await db.channelConnection.update({ where: { id: g.evolution.id }, data: { recoveredThroughAt: new Date(NOW - 20 * 60_000) } });
    const failing = { ...deps({ evolution: [{ ...image, key: { ...image.key, id: 'IMG2' } }] }), after: { prepareMedia: vi.fn(async () => { throw new Error('provider down'); }) } };
    expect((await recoverConnectionGap(db, failing, await db.channelConnection.findUniqueOrThrow({ where: { id: g.evolution.id } }), { now: NOW })).recovered).toBe(1);
    expect(await db.message.count({ where: { workspaceId: g.workspaceId, type: 'image' } })).toBe(1);
  });

  it('imports a WAHA LID chat into the phone conversation once WAHA proves the number, and skips it otherwise', async () => {
    const f = await fixture();
    await importChatCanonical({ prisma: db, channel: f.target, connectionId: f.evolution.id, chat: { remoteJid: PN, phoneJid: PN, pushName: 'Bia', profilePicUrl: null },
      records: [evo('P1', 'pelo telefone', NOW - 86_400_000)], batchId: randomUUID() });
    const base = deps({ waha: { [LID]: [wa('L1', 'pelo lid', NOW - 3_600_000, LID)] } });
    expect((await importConnectionHistory(db, { ...base, wahaLids: { lookup: async () => null } }, f.waha)).inserted).toBe(0);
    const proven = await importConnectionHistory(db, { ...base, wahaLids: { lookup: async (_s: string, lid: string) => lid === LID ? normalizeChatAddress(PN) : null } }, f.waha);
    expect(proven.inserted).toBe(1);
    expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    expect((await db.message.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { createdAt: 'asc' } })).map(m => m.body)).toEqual(['pelo telefone', 'pelo lid']);
  });

  it('summarises the workspace for the rollout without message text or full numbers', async () => {
    const f = await fixture();
    await importChatCanonical({ prisma: db, channel: f.target, connectionId: f.evolution.id, chat: { remoteJid: PN, phoneJid: PN, pushName: null, profilePicUrl: null },
      records: [evo('DIAG', 'conteudo privado', NOW - 60_000)], batchId: randomUUID() });
    const report = await rolloutDiagnostics(db, { workspaceId: f.workspaceId, hours: 1 });
    expect(report.channels[0]!.connections.map(c => c.provider).sort()).toEqual(['evolution', 'waha']);
    expect(report.channels[0]!.connections.find(c => c.provider === 'evolution')!.number).toBe('…8888');
    expect(report.messagesByOrigin).toEqual([{ mode: 'history', messages: 1 }]);
    expect(JSON.stringify(report)).not.toContain('conteudo privado');
    expect(JSON.stringify(report)).not.toContain('5547999998888');
  });
});
