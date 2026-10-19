import { randomUUID } from 'node:crypto';
import { createOwnedMetaEvolutionClient } from '../meta/meta-evolution-client.js';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EvolutionClient } from '../evolution/evolution.client.js';
import { createChannelsService } from './channels.service.js';
import { createOutboundDispatchJournal } from './outbound-dispatch-journal.js';
import { createOutboundRouter, OutboundUncertainError, type DeliveryProbe } from './outbound-router.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const PHONE = '5547999990000';

describe.skipIf(!databaseUrl)('outbound router on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
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
    const f = await fixture(), c = clients({ evolution: { deleteMessageForEveryone: vi.fn(async () => { throw http(404); }) }, waha: { deleteMessage: vi.fn(async () => undefined) } });
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

  it('rejects unknown channels and stops before provider I/O when the journal is unavailable', async () => {
    const c = clients(), journalRows = await db.outboundDispatch.count();
    await expect(router(c).sendText({ instanceName: `unknown-${randomUUID()}`, number: '5547888880000', text: 'x' })).rejects.toThrow('CHANNEL_NOT_FOUND');
    expect(c.base.sendText).not.toHaveBeenCalled();
    expect(await db.outboundDispatch.count()).toBe(journalRows);
    const f = await fixture(), brokenClients = clients();
    const broken = { ...createOutboundDispatchJournal(db), begin: vi.fn(async () => { throw new Error('journal down'); }) };
    await expect(send(router(brokenClients, { journal: broken }), f)).rejects.toThrow('journal down');
    expect(brokenClients.base.sendText).not.toHaveBeenCalled(); expect(brokenClients.waha.sendText).not.toHaveBeenCalled();
  });

  it('rejects a duplicated logical provider key across real workspace rows, including explicitly scoped calls', async () => {
    const first = await fixture(), second = await fixture(), c = clients();
    await db.channel.update({ where: { id: second.channel.id }, data: { providerKey: first.channel.providerKey } });
    const r = router(c);
    await expect(r.sendText({ workspaceId: second.workspaceId, channelId: second.channel.id, instanceName: first.channel.providerKey, number: '5547888880000', text: 'synthetic' })).rejects.toThrow('CHANNEL_PROVIDER_KEY_AMBIGUOUS');
    expect(c.base.sendText).not.toHaveBeenCalled(); expect(c.waha.sendText).not.toHaveBeenCalled();
    expect(await rows(first.workspaceId)).toEqual([]); expect(await rows(second.workspaceId)).toEqual([]);
  });

  it('the database rejects a duplicated WAHA physical session across real workspace rows', async () => {
    const first = await fixture({ active: 'waha' }), second = await fixture(), c = clients();
    await expect(db.channelConnection.update({ where: { id: second.waha.id }, data: { sessionName: first.waha.sessionName } })).rejects.toMatchObject({ code: 'P2002' });
    expect(c.base.sendText).not.toHaveBeenCalled(); expect(c.waha.sendText).not.toHaveBeenCalled();
    expect(await rows(first.workspaceId)).toEqual([]);
  });

  it('does not dispatch when all actual physical rows are unavailable', async () => {
    const f = await fixture({ evolution: { status: 'disconnected', eligible: false }, waha: { status: 'disconnected', eligible: false } }), c = clients();
    await expect(send(router(c), f)).rejects.toThrow('NO_CONNECTION_AVAILABLE');
    expect(c.base.sendText).not.toHaveBeenCalled(); expect(c.waha.sendText).not.toHaveBeenCalled();
    expect(await rows(f.workspaceId)).toEqual([]);
  });

  it('rejects a QR request with colliding logical ownership before any provider control I/O', async () => {
    const first = await fixture(), second = await fixture();
    await db.channel.update({ where: { id: second.channel.id }, data: { providerKey: first.channel.providerKey } });
    const createInstance = vi.fn(), connectInstance = vi.fn(), setWebhook = vi.fn();
    const service = createChannelsService(db as never, { evolution: { mode: 'real', client: { createInstance, connectInstance, setWebhook } as never,
      webhookSecret: 'synthetic', publicWebhookUrl: () => 'https://example.invalid/hook', localWebhookUrl: () => 'http://example.invalid/hook' } });
    await expect(service.startQrSession({ workspaceId: second.workspaceId, channelId: second.channel.id })).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED', statusCode: 409 });
    expect(createInstance).not.toHaveBeenCalled(); expect(connectInstance).not.toHaveBeenCalled(); expect(setWebhook).not.toHaveBeenCalled();
  });

  it('persists the exact newly created instance claim before configuring its webhook', async () => {
    const f = await fixture();
    const createInstance = vi.fn(async ({ instanceName }: { instanceName: string }) => ({ instanceName, qrCode: 'synthetic-qr', raw: {} }));
    const setWebhook = vi.fn(async () => {
      expect((await db.channel.findUniqueOrThrow({ where: { id: f.channel.id } })).providerInstanceClaim).toBe(f.channel.providerKey);
      return { raw: {} };
    });
    const service = createChannelsService(db as never, { evolution: { mode: 'real', client: { createInstance, setWebhook } as never,
      webhookSecret: 'synthetic', publicWebhookUrl: () => 'https://example.invalid/hook', localWebhookUrl: () => 'http://example.invalid/hook' } });
    await expect(service.startQrSession({ workspaceId: f.workspaceId, channelId: f.channel.id })).resolves.toMatchObject({ qrCode: 'synthetic-qr' });
    expect(setWebhook).toHaveBeenCalledTimes(1);
  });

  it('persists template dispatches and refuses lost journal fences', async () => {
    const f = await fixture(), journal = createOutboundDispatchJournal(db);
    const id = await journal.begin({ workspaceId: f.workspaceId, channelId: f.channel.id, kind: 'template', destination: '15550001111' });
    await journal.recordAttempt(id, { connectionId: f.evolution.id, provider: 'evolution', outcome: 'accepted', code: null });
    await journal.accept(id, { connectionId: f.evolution.id, providerMessageId: 'template-proof' });
    expect(await db.outboundDispatch.findUniqueOrThrow({ where: { id } })).toMatchObject({ kind: 'template', state: 'accepted' });
    await expect(journal.accept(id, { connectionId: f.evolution.id, providerMessageId: 'replacement' })).rejects.toThrow('OUTBOUND_JOURNAL_FENCE_LOST');
    await expect(journal.recordAttempt(id, { connectionId: f.evolution.id, provider: 'evolution', outcome: 'accepted', code: null })).rejects.toThrow('OUTBOUND_JOURNAL_FENCE_LOST');
  });

  it('journals an attested Meta Evolution template with no physical connection and rejects a cross-workspace collision', async () => {
    const f = await fixture(), key = `meta-${randomUUID()}`;
    const meta = await db.channel.create({ data: { workspaceId: f.workspaceId, provider: 'meta_cloud', providerKey: key, status: 'connected' } });
    const expected = { webhookUrl: `https://example.invalid/webhooks/evolution/${f.workspaceId}`, webhookSecret: 'synthetic-owned-secret' };
    const sendTemplate = vi.fn(async () => ({ providerMessageId: 'meta-template', raw: {} }));
    const getWebhook = vi.fn(async () => ({ enabled: true, url: expected.webhookUrl, headers: { 'x-prymeira-talk-secret': expected.webhookSecret } }));
    const client = createOwnedMetaEvolutionClient({ ...clients().base, sendTemplate, getWebhook }, db, f.workspaceId, key, expected);
    await client.sendTemplate!({ instanceName: key, name: 'hello', language: 'pt_BR', number: '15550000002' });
    expect(getWebhook).toHaveBeenCalledTimes(1);
    expect(await db.channel.findUniqueOrThrow({ where: { id: meta.id } })).toMatchObject({ providerInstanceClaim: key });
    expect(await db.outboundDispatch.findFirstOrThrow({ where: { workspaceId: f.workspaceId, channelId: meta.id } })).toMatchObject({ kind: 'template', connectionId: null, state: 'accepted', providerMessageId: 'meta-template' });
    const otherWorkspace = `router-${randomUUID()}`; workspaces.push(otherWorkspace);
    await db.channel.create({ data: { workspaceId: otherWorkspace, provider: 'evolution', providerKey: key } });
    await expect(client.sendTemplate!({ instanceName: key, name: 'hello', language: 'pt_BR', number: '15550000002' })).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED' });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(await db.outboundDispatch.count({ where: { workspaceId: f.workspaceId, channelId: meta.id } })).toBe(1);
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
