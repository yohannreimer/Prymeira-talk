import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIngressHttp } from '../ingress/http.js';
import { IngressApplicationService } from '../ingress/application.js';
import { IngressJournal } from '../ingress/journal.js';
import { IngressPrivateStore } from '../ingress/private-store.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
import { normalizeReceipt } from '../ingress/normalization.js';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import { HistoryNormalizationHoldError, persistProviderMessages } from './channel-history-canonical.js';
import { recoverConnectionGap } from './provider-history.js';
import { canonicalEvolutionMediaKey } from '../messaging/canonical-media-source.js';
import { createMessageMediaService } from '../conversations/message-media.js';
import { createEffectRunner } from '../ingress/effect-runner.js';
import { createMediaPrepareHandler } from '../ingress/media-prepare-handler.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
const peer = '15550000001@s.whatsapp.net';
describe.skipIf(!url)('audit recovery durability on owned PostgreSQL', () => {
  let db: PrismaClient, blockerDb: PrismaClient, root: string, files: IngressPrivateStore;
  const workspaces: string[] = [];
  beforeAll(async () => {
    const target = new URL(url!);
    if (target.hostname !== '127.0.0.1' || target.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || target.pathname !== '/messaging_test') throw Error('Owned audit PostgreSQL required');
    db = new PrismaClient({ datasources: { db: { url } } }); blockerDb = new PrismaClient({ datasources: { db: { url } } });
    await mkdir(join(process.cwd(), '../../work'), { recursive: true });
    root = await mkdtemp(join(process.cwd(), '../../work/recovery-media-')); files = new IngressPrivateStore(root); await files.initialize();
  });
  afterAll(async () => {
    if (!db) return;
    const where = { workspaceId: { in: workspaces } };
    await db.ingressEffect.deleteMany({ where }); await db.ingressReceipt.deleteMany({ where });
    await db.canonicalChatAuthorityResolution.deleteMany({ where }); await db.canonicalAction.deleteMany({ where }); await db.canonicalRecipientReceipt.deleteMany({ where });
    await db.canonicalAddressEvidence.deleteMany({ where }); await db.canonicalObservation.deleteMany({ where }); await db.canonicalNativeAlias.deleteMany({ where }); await db.canonicalMessageIdentity.deleteMany({ where });
    await db.canonicalChatMember.deleteMany({ where }); await db.canonicalChat.deleteMany({ where }); await db.canonicalAddressAlias.deleteMany({ where });
    await db.canonicalAddress.updateMany({ where, data: { redirectId: null } }); await db.canonicalAddress.deleteMany({ where }); await db.channel.deleteMany({ where }); await db.contact.deleteMany({ where });
    await db.$disconnect(); await blockerDb.$disconnect(); await rm(root, { recursive: true, force: true });
  });
  async function fixture(workspaceId = randomUUID()) {
    if (!workspaces.includes(workspaceId)) workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, verifiedPhoneNumber: '15550000002' } });
    return { workspaceId, channel, connection };
  }
  const raw = (f: Awaited<ReturnType<typeof fixture>>, id: string, media = false, chat = peer, outbound = false) => ({ event: 'messages.upsert', instance: f.connection.sessionName, data: { key: { id, remoteJid: chat, fromMe: outbound }, messageTimestamp: 1_700_000_010, messageType: media ? 'imageMessage' : 'conversation', message: media ? { imageMessage: { mimetype: 'image/png' } } : { conversation: 'synthetic fixture' } } });
  const imports = (f: Awaited<ReturnType<typeof fixture>>, id: string, media = false, chat = peer, outbound = false) => ({ prisma: db, channel: f.channel, connection: { id: f.connection.id, provider: 'evolution' as const }, mode: 'history' as const, batchId: randomUUID(), items: [{ receiptId: id, timestampMs: 1_700_000_010_000, normalize: (context: TrustedMessagingContext) => normalizeEvolutionWebhook(context, raw(f, id, media, chat, outbound)) }] });
  it('finishes the same receipt after a 6.5 second workspace lock and replay preserves one effect', async () => {
    const f = await fixture(), journal = new IngressJournal(db, files, new Set([f.workspaceId]));
    const source = await db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId: f.workspaceId, channelId: f.channel.id, authenticatedSource: { provider: 'evolution', connectionId: f.connection.id }, mode: 'live', observedAt: new Date().toISOString() }));
    const input = raw(f, 'locked-finalize');
    const receipt = await journal.stage({ transportNamespace: `talk.isolated.${f.workspaceId}`, source, raw: Buffer.from(JSON.stringify(input)), payload: normalizeReceipt(source, input), authentication: 'synthetic', reauthenticate: async () => {} });
    let transactions = 0, blocker: Promise<unknown> | undefined;
    const proxy = new Proxy(db, { get(object, property) {
      if (property === '$transaction') return async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => {
        if (++transactions === 2) {
          let ready!: () => void; const acquired = new Promise<void>(resolve => { ready = resolve; });
          blocker = blockerDb.$transaction(async tx => { await enterCanonicalWorkspaceTransaction(tx, f.workspaceId); ready(); await tx.$queryRaw`SELECT pg_sleep(6.5)::text`; }, { timeout: 10_000 });
          await acquired;
        }
        return object.$transaction(fn, options);
      };
      const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value;
    } });
    try { await expect(new IngressApplicationService(new IngressJournal(proxy, files)).apply(receipt.id)).resolves.toMatchObject({ state: 'applied' }); } finally { await blocker; }
    const effects = await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } });
    await new IngressApplicationService(journal).apply(receipt.id);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    expect(await db.ingressEventProgress.count({ where: { receiptId: receipt.id } })).toBe(1);
    expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(effects);
  }, 25_000);
  it('accepts fresh WAHA-only traffic under the captured channel anchor and rejects a changed anchor', async () => {
    for (const changed of [false, true]) {
      const f = await fixture();
      await db.channel.update({ where: { id: f.channel.id }, data: { verifiedMessagingPhoneNumber: '15550000002' } });
      await db.channelConnection.delete({ where: { id: f.connection.id } });
      const wa = await db.channelConnection.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id, provider: 'waha', sessionName: randomUUID(), verifiedPhoneNumber: '15550000002', status: 'connected', eligible: true, lastHealthyAt: new Date() } });
      const journal = new IngressJournal(db, files);
      const source = await db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId: f.workspaceId, channelId: f.channel.id, authenticatedSource: { provider: 'waha', connectionId: wa.id }, mode: 'live', observedAt: new Date().toISOString() }));
      const input = { event: 'message.any', session: wa.sessionName, payload: { id: `false_${peer}_wa-only`, from: peer, fromMe: false, body: 'synthetic fixture', timestamp: 1700000010 } };
      const receipt = await journal.stage({ transportNamespace: `talk.isolated.${f.workspaceId}`, source, raw: Buffer.from(JSON.stringify(input)), payload: normalizeReceipt(source, input), authentication: 'synthetic', reauthenticate: async () => {} });
      if (changed) await db.channel.update({ where: { id: f.channel.id }, data: { verifiedMessagingPhoneNumber: '15550000003' } });
      expect(await new IngressApplicationService(journal).apply(receipt.id)).toMatchObject({ state: changed ? 'held' : 'applied' });
      expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(changed ? 0 : 1);
    }
  });
  it('holds content from a different Evolution phone on an anchored channel', async () => {
    const f = await fixture();
    await db.channel.update({ where: { id: f.channel.id }, data: { verifiedMessagingPhoneNumber: '15550000003' } });
    const journal = new IngressJournal(db, files);
    const source = await db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId: f.workspaceId, channelId: f.channel.id, authenticatedSource: { provider: 'evolution', connectionId: f.connection.id }, mode: 'live', observedAt: new Date().toISOString() }));
    const input = raw(f, 'foreign-primary');
    const receipt = await journal.stage({ transportNamespace: `talk.isolated.${f.workspaceId}`, source, raw: Buffer.from(JSON.stringify(input)), payload: normalizeReceipt(source, input), authentication: 'synthetic', reauthenticate: async () => {} });
    expect(await new IngressApplicationService(journal).apply(receipt.id)).toMatchObject({ state: 'held' });
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    await expect(persistProviderMessages(imports(f, 'foreign-history'))).rejects.toThrow('Channel identity mismatch');
  });
  it('keeps the recovery checkpoint on invalid WAHA declarations and retries the corrected provider row', async () => {
    const f = await fixture(), now = 1_800_000_000_000, checkpoint = new Date(now - 600_000);
    const wa = await db.channelConnection.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id, provider: 'waha', sessionName: randomUUID(),
      verifiedPhoneNumber: '15550000002', status: 'connected', eligible: true, lastHealthyAt: new Date(), recoveredThroughAt: checkpoint } });
    const providerKey = `false_${peer}_contradictory-history`;
    let from = '15550000003@s.whatsapp.net';
    const waha = {
      getChats: vi.fn(async ({ offset = 0 }) => offset ? [] : [{ id: peer, timestamp: now / 1000 }]),
      getMessages: vi.fn(async ({ offset = 0 }) => offset ? [] : [{ id: providerKey, from, fromMe: false, timestamp: (now - 60_000) / 1000, body: 'private synthetic body' }])
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await recoverConnectionGap(db, { waha }, wa, { now }).catch(error => error);
      expect(error).toBeInstanceOf(HistoryNormalizationHoldError);
      expect(error).toMatchObject({ code: 'HISTORY_NORMALIZATION_HELD', provider: 'waha', connectionId: wa.id,
        providerKey, reason: 'contradictory_chat_declarations', message: 'HISTORY_NORMALIZATION_HELD' });
      expect(JSON.stringify(error)).not.toContain('private synthetic body');
      expect((await db.channelConnection.findUniqueOrThrow({ where: { id: wa.id } })).recoveredThroughAt).toEqual(checkpoint);
      expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
      expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    }
    from = peer;
    expect(await recoverConnectionGap(db, { waha }, wa, { now })).toMatchObject({ recovered: 1, advanced: true });
    expect((await db.channelConnection.findUniqueOrThrow({ where: { id: wa.id } })).recoveredThroughAt).toEqual(new Date(now - 30_000));
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
  });
  it('skips benign history notices but holds unsupported and invalid normalization', async () => {
    const f = await fixture();
    for (const reason of ['provider_system_notice', 'non_conversation_status', 'non_conversation_newsletter']) {
      const input = { ...imports(f, reason), items: [{ receiptId: reason, timestampMs: 1_700_000_010_000,
        normalize: () => ({ kind: 'ignored' as const, reason }) }] };
      expect(await persistProviderMessages(input)).toMatchObject({ inserted: 0, held: 0, skipped: 1 });
    }
    for (const kind of ['invalid', 'ignored'] as const) {
      const reason = kind === 'invalid' ? 'invalid_message_key' : 'unsupported_encrypted_control';
      const input = { ...imports(f, reason), items: [{ receiptId: reason, timestampMs: 1_700_000_010_000,
        normalize: () => ({ kind, reason }) }] };
      await expect(persistProviderMessages(input)).rejects.toMatchObject({ code: 'HISTORY_NORMALIZATION_HELD', providerKey: reason, reason });
    }
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });
  it('rejects a physical session owned by two workspaces before staging or publication', async () => {
    const a = await fixture(), b = await fixture();
    await db.channelConnection.update({ where: { id: b.connection.id }, data: { sessionName: a.connection.sessionName } });
    const journal = new IngressJournal(db, files), publish = vi.fn();
    const app = createIngressHttp({ db, journal, publisher: () => ({ ready: true, namespace: `talk.isolated.${a.workspaceId}`, deadlineMs: 1000, publish } as never), evolutionSecret: 'synthetic-secret', wahaSecret: 'synthetic-secret', workspaceAllowlist: new Set([a.workspaceId, b.workspaceId]) });
    try {
      const response = await app.inject({ method: 'POST', url: `/webhooks/evolution/${a.workspaceId}`, headers: { 'x-prymeira-talk-secret': 'synthetic-secret' }, payload: raw(a, 'ambiguous-session') });
      expect(response.statusCode).toBe(409);
      expect(publish).not.toHaveBeenCalled();
      expect(await db.ingressReceipt.count({ where: { workspaceId: a.workspaceId } })).toBe(0);
      const source = await db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId: a.workspaceId, channelId: a.channel.id, authenticatedSource: { provider: 'evolution', connectionId: a.connection.id }, mode: 'live', observedAt: new Date().toISOString() }));
      const input = raw(a, 'ambiguous-direct-stage');
      await expect(journal.stage({ transportNamespace: `talk.isolated.${a.workspaceId}`, source, raw: Buffer.from(JSON.stringify(input)), payload: normalizeReceipt(source, input), authentication: 'synthetic', reauthenticate: async () => {} })).rejects.toThrow('Physical messaging source is ambiguous');
    } finally { await app.close(); }
  });
  it('persists history media work before callbacks and resumes after a process restart', async () => {
    const f = await fixture();
    const prepareMedia = vi.fn(async () => { throw Error('synthetic temporary outage'); });
    expect((await persistProviderMessages({ ...imports(f, 'media', true), after: { prepareMedia } })).inserted).toBe(1);
    const message = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    const obligation = await db.ingressEffect.findFirstOrThrow({ where: { workspaceId: f.workspaceId, messageId: message.id, kind: 'media.prepare' } });
    expect(obligation).toMatchObject({ state: 'pending' });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const media = createMessageMediaService({ db, store: files });
    const fetchMedia = vi.fn().mockRejectedValueOnce(Error('temporary provider failure')).mockResolvedValue(`data:image/png;base64,${bytes.toString('base64')}`);
    const handlers = { 'media.prepare': createMediaPrepareHandler({ media, waha: null, evolution: { fetchMedia } }) };
    const firstProcess = createEffectRunner({ db, workerId: 'before-restart', handlers, workspaceIds: [f.workspaceId], baseBackoffMs: 0 });
    expect(await firstProcess.runOnce()).toBe(true);
    expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: message.id } })).toMatchObject({ state: 'unavailable', attempts: 1 });
    const afterRestart = createEffectRunner({ db, workerId: 'after-restart', handlers, workspaceIds: [f.workspaceId] });
    expect(await afterRestart.runOnce()).toBe(true);
    expect(await db.ingressEffect.findUniqueOrThrow({ where: { id: obligation.id } })).toMatchObject({ state: 'done', attempts: 2 });
    const stored = await media.read({ workspaceId: f.workspaceId, conversationId: message.conversationId, messageId: message.id });
    expect(stored?.bytes).toEqual(bytes);
    expect(fetchMedia).toHaveBeenCalledTimes(2);
    expect(await canonicalEvolutionMediaKey(db, { workspaceId: f.workspaceId, messageId: message.id, instanceName: f.connection.sessionName })).toMatchObject({ nativeId: 'media', nativeChatAddress: peer, direction: 'inbound' });
    await expect(canonicalEvolutionMediaKey(db, { workspaceId: f.workspaceId, messageId: message.id, instanceName: 'foreign-session' })).rejects.toThrow('MEDIA_IDENTITY_UNAVAILABLE');
    expect((await persistProviderMessages(imports(f, 'media', true))).inserted).toBe(0);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
  });
  it('keeps reused native ids in distinct channels, chats and directions, deduplicating only equivalent observations', async () => {
    const a = await fixture(), b = await fixture(a.workspaceId);
    for (const input of [imports(a, 'collision'), imports(b, 'collision'), imports(a, 'collision', false, '15550000003@s.whatsapp.net'), imports(a, 'collision', false, peer, true)]) expect((await persistProviderMessages(input)).inserted).toBe(1);
    expect((await persistProviderMessages(imports(a, 'collision'))).inserted).toBe(0);
    expect(await db.message.count({ where: { workspaceId: a.workspaceId } })).toBe(4);
  });
});
