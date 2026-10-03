import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EvolutionClient } from '../evolution/evolution.client.js';
import { createOutboundDispatchJournal } from './outbound-dispatch-journal.js';
import { createOutboundRouter, OutboundUncertainError, type DeliveryProbe } from './outbound-router.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const PHONE = '5547999990000';

describe.skipIf(!databaseUrl)('outbound router on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => {
    if (!db) return;
    await db.outboundDispatch.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.channelConnection.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.channel.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.$disconnect();
  });

  async function fixture(opts: { redundancy?: boolean; active?: 'evolution' | 'waha'; evolution?: Record<string, unknown>; waha?: Record<string, unknown> } = {}) {
    const workspaceId = `router-${randomUUID()}`; workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `inst-${randomUUID()}` } });
    const connected = { status: 'connected' as const, health: 'healthy' as const, eligible: true, verifiedPhoneNumber: PHONE, lastHealthyAt: new Date() };
    const evolution = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, ...connected, ...opts.evolution } });
    const waha = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: `waha-${randomUUID()}`, ...connected, ...opts.waha } });
    await db.channel.update({ where: { id: channel.id }, data: { redundancyEnabled: opts.redundancy ?? true, activeConnectionId: (opts.active ?? 'evolution') === 'evolution' ? evolution.id : waha.id } });
    return { workspaceId, channel, evolution, waha };
  }
  const http = (statusCode: number, responseBody?: unknown) => Object.assign(new Error(`status ${statusCode}`), { statusCode, responseBody });
  const timeout = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });

  function clients(over: { evolution?: Partial<EvolutionClient>; waha?: Record<string, unknown> } = {}) {
    const base = {
      sendText: vi.fn(async () => ({ providerMessageId: 'EVO-TEXT-1', raw: {} })),
      sendMedia: vi.fn(async () => ({ providerMessageId: 'EVO-MEDIA-1', raw: {} })),
      sendAudio: vi.fn(async () => ({ providerMessageId: 'EVO-AUDIO-1', raw: {} })),
      sendContact: vi.fn(async () => ({ providerMessageId: 'EVO-CARD-1', raw: {} })),
      ...over.evolution
    } as unknown as EvolutionClient;
    const waha = {
      sendText: vi.fn(async () => ({ providerMessageId: 'true_5547888880000@c.us_3EB0TEXT', raw: { id: 'true_5547888880000@c.us_3EB0TEXT' } })),
      sendMedia: vi.fn(async () => ({ providerMessageId: 'x', raw: { id: 'true_5547888880000@c.us_3EB0MEDIA' } })),
      sendVoice: vi.fn(async () => ({ providerMessageId: 'x', raw: { id: 'true_5547888880000@c.us_3EB0VOICE' } })),
      sendContact: vi.fn(async () => ({ providerMessageId: 'x', raw: { id: 'true_5547888880000@c.us_3EB0CARD' } })),
      ...over.waha
    };
    return { base, waha };
  }
  const router = (c: ReturnType<typeof clients>, extra: Partial<Parameters<typeof createOutboundRouter>[0]> = {}) =>
    createOutboundRouter({ base: c.base, waha: c.waha as never, db, journal: createOutboundDispatchJournal(db), probeDelayMs: 0, ...extra });
  const send = (r: EvolutionClient, f: { channel: { providerKey: string } }, text = 'olá, tudo bem?') => r.sendText({ instanceName: f.channel.providerKey, number: '5547888880000', text });
  const rows = (workspaceId: string) => db.outboundDispatch.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });

  it('a workspace outside the staged rollout sends exactly as before: the legacy call, no journal', async () => {
    const f = await fixture();
    const c = clients();
    const result = await send(router(c, { routes: () => false }), f);
    expect(result).toMatchObject({ providerMessageId: 'EVO-TEXT-1' });
    expect(c.base.sendText).toHaveBeenCalledTimes(1);
    expect(c.waha.sendText).not.toHaveBeenCalled();
    expect(await rows(f.workspaceId)).toHaveLength(0);
  });
  it('sends through the active writer and journals which physical connection carried it', async () => {
    const f = await fixture(), c = clients();
    expect(await send(router(c), f)).toMatchObject({ providerMessageId: 'EVO-TEXT-1' });
    expect(c.base.sendText).toHaveBeenCalledTimes(1);
    expect(c.waha.sendText).not.toHaveBeenCalled();
    expect(await rows(f.workspaceId)).toEqual([expect.objectContaining({ state: 'accepted', kind: 'text', connectionId: f.evolution.id, providerMessageId: 'EVO-TEXT-1', preview: 'olá, tudo bem?', destination: '5547888880000' })]);
  });

  it('uses WAHA when it is the active writer, with the stanza id normalised so the Evolution echo matches it', async () => {
    const f = await fixture({ active: 'waha' }), c = clients();
    expect(await send(router(c), f)).toMatchObject({ providerMessageId: '3EB0TEXT' });
    expect(c.waha.sendText).toHaveBeenCalledWith(expect.objectContaining({ session: f.waha.sessionName, chatId: '5547888880000@c.us', text: 'olá, tudo bem?' }));
    expect(c.base.sendText).not.toHaveBeenCalled();
    expect((await rows(f.workspaceId))[0]).toMatchObject({ state: 'accepted', connectionId: f.waha.id, providerMessageId: '3EB0TEXT' });
  });

  it('a reply goes through WAHA quoting the message by its serialized id, and through Evolution with its key', async () => {
    const f = await fixture({ active: 'waha' }), c = clients();
    await router(c).sendText({ instanceName: f.channel.providerKey, number: '5547888880000', text: 'sim', quoted: { id: '3EB0Q', fromMe: false, participant: null, body: 'vai hoje?' } });
    expect(c.waha.sendText).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'false_5547888880000@c.us_3EB0Q' }));
    const e = await fixture(), d = clients();
    await router(d).sendText({ instanceName: e.channel.providerKey, number: '5547888880000', text: 'sim', quoted: { id: '3EB0Q', fromMe: true, participant: null, body: 'oi' } });
    expect(d.base.sendText).toHaveBeenCalledWith(expect.objectContaining({ quoted: { id: '3EB0Q', fromMe: true, participant: null, body: 'oi' } }));
  });
  it('deletes for everyone through WAHA when Evolution cannot', async () => {
    const f = await fixture(), c = clients({ evolution: { deleteMessageForEveryone: vi.fn(async () => { throw new Error('evolution down'); }) }, waha: { deleteMessage: vi.fn(async () => undefined) } });
    await router(c).deleteMessageForEveryone!({ instanceName: f.channel.providerKey, id: '3EB0DEL', remoteJid: '5547888880000@s.whatsapp.net', fromMe: true });
    expect((c.waha as unknown as { deleteMessage: ReturnType<typeof vi.fn> }).deleteMessage).toHaveBeenCalledWith({ session: f.waha.sessionName, chatId: '5547888880000@c.us', messageId: 'true_5547888880000@c.us_3EB0DEL' });
  });
  it('fails over to the other connection only when the first provably did not send', async () => {
    const f = await fixture(), onNotDelivered = vi.fn();
    const c = clients({ evolution: { sendText: vi.fn(async () => { throw http(404); }) } as never });
    expect(await send(router(c, { onNotDelivered }), f)).toMatchObject({ providerMessageId: '3EB0TEXT' });
    expect(c.base.sendText).toHaveBeenCalledTimes(1);
    expect(c.waha.sendText).toHaveBeenCalledTimes(1);
    expect(onNotDelivered).toHaveBeenCalledWith(expect.objectContaining({ id: f.evolution.id }), expect.anything());
    const [row] = await rows(f.workspaceId);
    expect(row).toMatchObject({ state: 'accepted', connectionId: f.waha.id });
    expect((row!.attempts as Array<{ provider: string; outcome: string }>).map(a => `${a.provider}:${a.outcome}`)).toEqual(['evolution:not_delivered', 'waha:accepted']);
  });

  it('NEVER resends after an uncertain failure: it is held for review and nothing else is sent', async () => {
    const f = await fixture(), c = clients({ evolution: { sendText: vi.fn(async () => { throw timeout(); }) } as never });
    const error = await send(router(c), f).catch(e => e);
    expect(error).toBeInstanceOf(OutboundUncertainError);
    expect(c.waha.sendText).not.toHaveBeenCalled();
    expect(c.base.sendText).toHaveBeenCalledTimes(1);
    const [row] = await rows(f.workspaceId);
    expect(row).toMatchObject({ state: 'uncertain', errorCode: 'TimeoutError' });
    expect((error as OutboundUncertainError).dispatchId).toBe(row!.id);
    const journal = createOutboundDispatchJournal(db);
    expect((await journal.listForReview({ workspaceId: f.workspaceId })).map(r => r.id)).toEqual([row!.id]);
    expect(await journal.resolve({ workspaceId: 'someone-else', id: row!.id, delivered: true, by: 'x' })).toBe(false);
    expect(await journal.resolve({ workspaceId: f.workspaceId, id: row!.id, delivered: false, by: 'Yohann' })).toBe(true);
    expect(await journal.resolve({ workspaceId: f.workspaceId, id: row!.id, delivered: true, by: 'Yohann' })).toBe(false);
    expect((await rows(f.workspaceId))[0]).toMatchObject({ state: 'resolved_not_delivered', resolvedBy: 'Yohann', resolvedAt: expect.any(Date) });
  });

  it('checks both connections after an uncertain failure and treats a message found in the chat as delivered', async () => {
    const f = await fixture(), c = clients({ evolution: { sendText: vi.fn(async () => { throw timeout(); }) } as never });
    const probe: DeliveryProbe = vi.fn(async ({ connection }) => connection.provider === 'waha' ? { found: true, providerMessageId: '3EB0FOUND' } : 'unknown');
    expect(await send(router(c, { probe }), f)).toEqual({ providerMessageId: '3EB0FOUND', raw: { recoveredByProbe: true } });
    expect(c.waha.sendText).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
    expect((await rows(f.workspaceId))[0]).toMatchObject({ state: 'accepted', providerMessageId: '3EB0FOUND', connectionId: f.waha.id });
  });

  it('stays uncertain when the probes find nothing or cannot answer', async () => {
    const f = await fixture(), c = clients({ evolution: { sendText: vi.fn(async () => { throw http(504); }) } as never });
    const probe: DeliveryProbe = vi.fn(async ({ connection }) => { if (connection.provider === 'waha') throw new Error('probe down'); return { found: false, providerMessageId: null }; });
    await expect(send(router(c, { probe }), f)).rejects.toBeInstanceOf(OutboundUncertainError);
    expect((await rows(f.workspaceId))[0]).toMatchObject({ state: 'uncertain', errorCode: 'HTTP_504' });
  });

  it('rethrows the original error when every connection provably failed, and journals it as failed', async () => {
    const f = await fixture(), original = http(401);
    const c = clients({ evolution: { sendText: vi.fn(async () => { throw original; }) } as never, waha: { sendText: vi.fn(async () => { throw http(422); }) } });
    await expect(send(router(c), f)).rejects.toMatchObject({ statusCode: 422 });
    expect((await rows(f.workspaceId))[0]).toMatchObject({ state: 'failed', errorCode: 'HTTP_422' });
  });

  it('keeps legacy behaviour without redundancy: no failover to WAHA, original error, uncertain never retried', async () => {
    const f = await fixture({ redundancy: false });
    const refused = clients({ evolution: { sendText: vi.fn(async () => { throw http(404); }) } as never });
    await expect(send(router(refused), f)).rejects.toMatchObject({ statusCode: 404 });
    expect(refused.waha.sendText).not.toHaveBeenCalled();
    const slow = clients({ evolution: { sendText: vi.fn(async () => { throw timeout(); }) } as never });
    await expect(send(router(slow), f)).rejects.toBeInstanceOf(OutboundUncertainError);
    expect(slow.waha.sendText).not.toHaveBeenCalled();
  });

  it('does not use a WAHA connection that is not proven to be the same number', async () => {
    const f = await fixture({ waha: { verifiedPhoneNumber: '5547000000000' } });
    const c = clients({ evolution: { sendText: vi.fn(async () => { throw http(404); }) } as never });
    await expect(send(router(c), f)).rejects.toMatchObject({ statusCode: 404 });
    expect(c.waha.sendText).not.toHaveBeenCalled();
  });

  it('sends every kind through WAHA when it writes: media, voice note as a voice, contact card', async () => {
    const f = await fixture({ active: 'waha' }), c = clients(), r = router(c);
    const png = Buffer.from('png-bytes').toString('base64');
    expect(await r.sendMedia({ instanceName: f.channel.providerKey, number: '5547888880000', mediatype: 'image', mimetype: 'image/png', media: `data:image/png;base64,${png}`, fileName: 'a.png', caption: 'foto' })).toMatchObject({ providerMessageId: '3EB0MEDIA' });
    expect(c.waha.sendMedia).toHaveBeenCalledWith({ session: f.waha.sessionName, chatId: '5547888880000@c.us', kind: 'image', data: png, mimetype: 'image/png', filename: 'a.png', caption: 'foto' });
    await r.sendMedia({ instanceName: f.channel.providerKey, number: '5547888880000', mediatype: 'document', mimetype: 'application/pdf', media: png, fileName: 'a.pdf' });
    expect(c.waha.sendMedia).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'file', data: png }));
    expect(await r.sendAudio!({ instanceName: f.channel.providerKey, number: '5547888880000', audio: `data:audio/ogg;base64,${png}` })).toMatchObject({ providerMessageId: '3EB0VOICE' });
    expect(c.waha.sendVoice).toHaveBeenCalledWith(expect.objectContaining({ session: f.waha.sessionName, data: png }));
    expect(await r.sendContact!({ instanceName: f.channel.providerKey, number: '123-456@g.us', contact: [{ fullName: 'Maria', wuid: '5547111110000', phoneNumber: '5547111110000' }] })).toMatchObject({ providerMessageId: '3EB0CARD' });
    expect(c.waha.sendContact).toHaveBeenCalledWith({ session: f.waha.sessionName, chatId: '123-456@g.us', contacts: [{ fullName: 'Maria', phoneNumber: '5547111110000', whatsappId: '5547111110000' }] });
    expect((await rows(f.workspaceId)).map(row => [row.kind, row.state])).toEqual([['media', 'accepted'], ['media', 'accepted'], ['audio', 'accepted'], ['contact', 'accepted']]);
  });

  it('fetches a remote media URL itself because WAHA only accepts bytes', async () => {
    const f = await fixture({ active: 'waha' }), c = clients();
    const fetchBinary = vi.fn(async () => Buffer.from('remote-bytes'));
    await router(c, { fetchBinary }).sendMedia({ instanceName: f.channel.providerKey, number: '5547888880000', mediatype: 'image', mimetype: 'image/jpeg', media: 'https://talk.example/uploads/x.jpg', fileName: 'x.jpg' });
    expect(fetchBinary).toHaveBeenCalledWith('https://talk.example/uploads/x.jpg', 'image/jpeg');
    expect(c.waha.sendMedia).toHaveBeenCalledWith(expect.objectContaining({ data: Buffer.from('remote-bytes').toString('base64') }));
  });

  it('passes straight through for an instance it does not know, and never lets the journal block a send', async () => {
    const c = clients(), journalRows = await db.outboundDispatch.count();
    await router(c).sendText({ instanceName: `unknown-${randomUUID()}`, number: '5547888880000', text: 'x' });
    expect(c.base.sendText).toHaveBeenCalledTimes(1);
    expect(await db.outboundDispatch.count()).toBe(journalRows);
    const f = await fixture();
    const broken = { ...createOutboundDispatchJournal(db), begin: vi.fn(async () => { throw new Error('journal down'); }) };
    const warn = vi.fn();
    expect(await send(router(clients(), { journal: broken as never, logger: { warn } }), f)).toMatchObject({ providerMessageId: 'EVO-TEXT-1' });
    expect(warn).toHaveBeenCalled();
  });

  it('turns a send that was interrupted mid-flight into an uncertain one instead of forgetting it', async () => {
    const f = await fixture(), journal = createOutboundDispatchJournal(db);
    const id = await journal.begin({ workspaceId: f.workspaceId, channelId: f.channel.id, kind: 'text', destination: '5547888880000', text: 'pendente' });
    expect(await journal.sweepStale(60_000)).toBe(0);
    await db.outboundDispatch.update({ where: { id }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await journal.sweepStale(60_000)).toBeGreaterThanOrEqual(1);
    expect(await db.outboundDispatch.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'uncertain', errorCode: 'PROCESS_INTERRUPTED' });
  });
});
