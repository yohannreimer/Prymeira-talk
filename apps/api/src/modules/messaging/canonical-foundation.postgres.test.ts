import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanonicalStore } from './canonical-store.js';
import { canonicalTransaction, enterCanonicalTransaction, enterSourceFenceTransaction } from './canonical-boundary.js';
import { createCanonicalReads, lookupNativeInTransaction, resolveProviderReferenceInTransaction } from './canonical-resolution.js';
import type { TrustedMessagingContext, NormalizedMessagingEvent } from './normalized-event.js';
import { deriveTrustedMessagingContext } from './canonical-source.js';
import { parseWahaMessageKey } from './whatsapp-identity.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
const PN = '15550001111@s.whatsapp.net';
type Event = Extract<NormalizedMessagingEvent, { kind: 'message' }>;
function message(context: TrustedMessagingContext, id = 'A', chat = PN, sender?: string): Event {
  return { context, kind: 'message', providerEventId: null, providerEventType: 'message', addressMappings: [],
    key: { ...parseWahaMessageKey({ id, remote: chat, fromMe: false, participant: sender }), nativeId: id },
    content: { type: 'text', body: 'hello', mediaUrl: null, preview: 'hello' }, attachment: {}, media: null,
    currentRevision: null, pushName: null, source: null, order: { timestampMs: 1700000000000, sequence: null } };
}
describe.skipIf(!url)('canonical boundary and exact reads on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  const store = createCanonicalStore();
  async function fixture(): Promise<TrustedMessagingContext> {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: randomUUID() } });
    return { workspaceId, channelId: channel.id, provider: 'evolution', channelProvider: 'evolution', connectionId: connection.id,
      sessionName: connection.sessionName, lifecycleGeneration: 0, mode: 'live', observedAt: '2026-09-30T12:00:00Z' };
  }
  const persist = (e: Event) => store.persist(db, e, { receiptKey: randomUUID() });
  const lookup = (c: TrustedMessagingContext, key: Event['key']) => db.$transaction(tx => lookupNativeInTransaction(tx, c, key));
  beforeAll(() => {
    const u = new URL(url!);
    if (u.hostname !== '127.0.0.1' || u.port !== '55439' || u.pathname !== '/messaging_test') throw new Error('Only isolated local messaging_test');
    db = new PrismaClient({ datasources: { db: { url } } });
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
    await db.integrationConfig.deleteMany({ where }); await db.$disconnect();
  });
  it.each([1, 2])('rejects in-progress/stale physical generation %s before any domain write', async generation => {
    const c = await fixture();
    await db.channelConnection.update({ where: { id: c.connectionId! }, data: { lifecycleGeneration: generation } });
    await expect(persist(message(c))).rejects.toMatchObject({ code: 'stale_source' });
    expect(await db.canonicalObservation.count({ where: { workspaceId: c.workspaceId } })).toBe(0);
    expect(await db.contact.count({ where: { workspaceId: c.workspaceId } })).toBe(0);
  });
  it('waits for a concurrent lifecycle and rechecks under READ COMMITTED', async () => {
    const c = await fixture();
    let started!: () => void, release!: () => void;
    const held = new Promise<void>(r => { started = r; }), unblock = new Promise<void>(r => { release = r; });
    const lifecycle = db.$transaction(async tx => {
      await tx.channel.update({ where: { id: c.channelId }, data: { connectionLifecycleGeneration: { increment: 1 } } });
      await tx.channelConnection.update({ where: { id: c.connectionId! }, data: { lifecycleGeneration: 1 } });
      started(); await unblock;
    });
    await held;
    const writer = persist(message(c));
    // Observe a blocked lock in the actual server instead of assuming a timer proves concurrency.
    for (let i = 0; i < 100; i++) {
      const waiting = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%channels%'`;
      if (Number(waiting[0]!.n) > 0) break;
      if (i === 99) { release(); throw new Error('writer never blocked on lifecycle row'); }
      await new Promise(r => setTimeout(r, 10));
    }
    release(); await lifecycle;
    await expect(writer).rejects.toMatchObject({ code: 'stale_source' });
  });
  it('does not invalidate an independent physical session on another provider lifecycle', async () => {
    const c = await fixture();
    await db.channel.update({ where: { id: c.channelId }, data: { connectionLifecycleGeneration: 17 } });
    await db.channelConnection.create({ data: { workspaceId: c.workspaceId, channelId: c.channelId, provider: 'waha', sessionName: 'independent-qr', lifecycleGeneration: 1 } });
    expect((await persist(message(c))).outcome).toBe('created');
  });
  it('the shared source fence still holds lifecycle changes back, while two holders never wait for each other', async () => {
    const c = await fixture();
    let releaseA!: () => void;
    const holdA = new Promise<void>(resolve => { releaseA = resolve; });
    const events: string[] = [];
    const a = db.$transaction(async tx => { await enterSourceFenceTransaction(tx, c); events.push('A fenced'); await holdA; events.push('A done'); }, { isolationLevel: 'ReadCommitted', timeout: 20_000 });
    await new Promise(r => setTimeout(r, 200));
    // A second holder (another webhook, or a canonical writer of another workspace path) is not blocked.
    await db.$transaction(async tx => { await enterSourceFenceTransaction(tx, c); events.push('B fenced'); }, { isolationLevel: 'ReadCommitted' });
    // A lifecycle change (QR/logout bumps the generation) must wait for A.
    const lifecycle = db.channelConnection.update({ where: { id: c.connectionId! }, data: { lifecycleGeneration: 1 } }).then(() => events.push('lifecycle committed'));
    await new Promise(r => setTimeout(r, 300));
    expect(events).toEqual(['A fenced', 'B fenced']);
    releaseA();
    await a; await lifecycle;
    expect(events).toEqual(['A fenced', 'B fenced', 'A done', 'lifecycle committed']);
    // After the lifecycle commit, a new holder sees the source as stale.
    await expect(db.$transaction(tx => enterSourceFenceTransaction(tx, c), { isolationLevel: 'ReadCommitted' })).rejects.toThrow();
  });
  it('checks workspace lock before source/domain row locks and rejects snapshot isolation', async () => {
    const c = await fixture();
    const order: string[] = [];
    await db.$transaction(async tx => {
      const original = tx.$queryRaw.bind(tx), execute = tx.$executeRaw.bind(tx);
      const proxy = new Proxy(tx, { get(target, property) {
        if (property === '$queryRaw') return (...args: Parameters<typeof original>) => { order.push(String(args[0])); return original(...args); };
        if (property === '$executeRaw') return (...args: Parameters<typeof execute>) => { order.push(String(args[0])); return execute(...args); };
        return Reflect.get(target, property);
      } });
      await enterCanonicalTransaction(proxy, c);
    });
    expect(order.findIndex(s => s.includes('pg_advisory_xact_lock'))).toBeLessThan(order.findIndex(s => s.includes('FOR SHARE')));
    // Accepting a webhook fences the source with shared row locks only, never the workspace writer lock.
    const fenceOrder: string[] = [];
    await db.$transaction(async tx => {
      const original = tx.$queryRaw.bind(tx), execute = tx.$executeRaw.bind(tx);
      const proxy = new Proxy(tx, { get(target, property) {
        if (property === '$queryRaw') return (...args: Parameters<typeof original>) => { fenceOrder.push(String(args[0])); return original(...args); };
        if (property === '$executeRaw') return (...args: Parameters<typeof execute>) => { fenceOrder.push(String(args[0])); return execute(...args); };
        return Reflect.get(target, property);
      } });
      await enterSourceFenceTransaction(proxy, c);
    });
    expect(fenceOrder.some(s => s.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(fenceOrder.filter(s => s.includes('FOR SHARE')).length).toBe(2);
    await expect(db.$transaction(tx => enterCanonicalTransaction(tx, c), { isolationLevel: 'RepeatableRead' })).rejects.toThrow('READ COMMITTED');
    expect(await canonicalTransaction(db, c, async () => 'safe')).toBe('safe');
  });
  it('resolves exact tuples without writes and intersects every supplied partial field', async () => {
    const c = await fixture(), event = message(c), saved = await persist(event);
    const before = await db.canonicalAddress.count({ where: { workspaceId: c.workspaceId } });
    expect(await lookup(c, event.key)).toMatchObject({ kind: 'resolved', originMessageId: saved.messageId, originConversationId: saved.conversationId,
      authority: { conversationId: saved.conversationId, revision: expect.any(Number) }, key: event.key });
    expect(await lookup(c, { ...event.key, chatAddress: '15550002222@s.whatsapp.net' })).toMatchObject({ kind: 'missing' });
    expect(await lookup(c, { ...event.key, rawId: null, direction: null })).toMatchObject({ kind: 'resolved' });
    expect(await lookup(c, { ...event.key, rawId: null, direction: 'outbound' })).toMatchObject({ kind: 'missing' });
    expect(await db.canonicalAddress.count({ where: { workspaceId: c.workspaceId } })).toBe(before);
  });
  it('rejects an ambiguous partial alias and disambiguates by group sender/direction', async () => {
    const c = await fixture(), a = message(c, 'A', '120000-100@g.us', PN), b = message(c, 'A', '120000-100@g.us', '15550002222@s.whatsapp.net');
    await persist(a); const saved = await persist(b);
    expect(await lookup(c, { ...a.key, senderParticipant: null, nativeSenderParticipant: null })).toMatchObject({ kind: 'ambiguous' });
    expect(await lookup(c, b.key)).toMatchObject({ kind: 'resolved', originMessageId: saved.messageId });
  });
  it('authorizes the scoped original conversation before provider/authority lookup', async () => {
    const c = await fixture(), saved = await persist(message(c)), authorizeOrigin = vi.fn(async () => false);
    const input = { workspaceId: c.workspaceId, channelId: c.channelId, originConversationId: saved.conversationId!, messageId: saved.messageId!, requestedProvider: 'evolution' as const, authorizeOrigin };
    expect(await db.$transaction(tx => resolveProviderReferenceInTransaction(tx, input))).toMatchObject({ kind: 'forbidden_origin' });
    expect(authorizeOrigin).toHaveBeenCalledWith(expect.objectContaining({ conversationId: saved.conversationId, messageId: saved.messageId }));
    authorizeOrigin.mockResolvedValue(true);
    expect(await db.$transaction(tx => resolveProviderReferenceInTransaction(tx, input))).toMatchObject({ kind: 'resolved', originMessageId: saved.messageId });
    expect(await db.$transaction(tx => resolveProviderReferenceInTransaction(tx, { ...input, originConversationId: randomUUID() }))).toMatchObject({ kind: 'forbidden_origin' });
  });
  it('does not promote old observation provenance to the current generation', async () => {
    const c = await fixture(), event = message(c), saved = await persist(event);
    await db.channelConnection.update({ where: { id: c.connectionId! }, data: { lifecycleGeneration: 2 } });
    expect(await lookup({ ...c, lifecycleGeneration: 2 }, event.key)).toMatchObject({ kind: 'stale_source' });
    expect(await db.$transaction(tx => resolveProviderReferenceInTransaction(tx, { workspaceId: c.workspaceId, channelId: c.channelId, originConversationId: saved.conversationId!, messageId: saved.messageId!, requestedProvider: 'evolution', authorizeOrigin: async () => true }))).toMatchObject({ kind: 'stale_source' });
  });
  it('keeps official Meta in a separate namespace and adopts only its own exact legacy UUID', async () => {
    const physical = await fixture();
    const phoneNumberId = 'configured-phone-id';
    const channel = await db.channel.create({ data: { workspaceId: physical.workspaceId, provider: 'meta_cloud', providerKey: phoneNumberId } });
    await db.integrationConfig.create({ data: { workspaceId: physical.workspaceId, provider: 'meta_cloud', mode: 'real', status: 'connected', settings: { enabled: true, connectionMode: 'direct', phoneNumberId, wabaId: 'synthetic-waba', accessToken: 'synthetic-token' } } });
    const c: TrustedMessagingContext = { ...physical, channelId: channel.id, channelProvider: 'meta', provider: 'meta_official', connectionId: null, phoneNumberId, sessionName: phoneNumberId };
    const event = message(c, 'wamid.A'); event.key.identityFormat = 'provider_native'; event.key.rawId = null;
    const contact = await db.contact.create({ data: { workspaceId: c.workspaceId, phone: '15550001111' } });
    const conversation = await db.conversation.create({ data: { workspaceId: c.workspaceId, channelId: c.channelId, contactId: contact.id } });
    const legacy = await db.message.create({ data: { workspaceId: c.workspaceId, conversationId: conversation.id, direction: 'inbound', type: 'text', body: 'retained', providerMessageId: 'wamid.A', providerEventId: `meta:${phoneNumberId}:wamid.A`, metadata: { actor: 'kept', transcription: { text: 'kept' } }, createdAt: new Date(1600000000000) } });
    const result = await store.persist(db, event, { receiptKey: 'official', adoption: { messageId: legacy.id, key: event.key, source: 'provider_exact_lookup' } });
    expect(result).toMatchObject({ messageId: legacy.id, outcome: 'enriched', allowOperationalEffects: false });
    expect(await db.message.findUnique({ where: { id: legacy.id } })).toEqual(legacy);
    expect(await lookup(c, event.key)).toMatchObject({ kind: 'resolved', source: { provider: 'meta_official' } });
    expect(await lookup({ ...c, phoneNumberId: 'other' }, event.key)).toMatchObject({ kind: 'stale_source' });
    const injection = { ...event, addressMappings: [{ role: 'chat' as const, lid: '700001@lid', pn: PN, source: 'evolution.remoteJidAlt' as const }] };
    await expect(persist(injection)).rejects.toThrow('native namespace');
  });
  it('creates historical timestamps and human-controlled group conversations without effects', async () => {
    const c = { ...await fixture(), mode: 'history' as const }, event = message(c, 'H', '120000-100@g.us', PN);
    event.content = { type: 'image', body: 'Imagem recebida', preview: 'Imagem recebida', mediaUrl: null };
    const createdAt = new Date(1600000000000);
    const saved = await store.persist(db, event, { receiptKey: 'history', presentation: { createdAt, ingestedAt: createdAt,
      history: { batchId: 'synthetic', originalType: 'imageMessage' }, groupSender: { jid: PN, name: 'Fixture' },
      preparedMedia: { mediaUrl: 'https://owned.invalid/image', result: { status: 'processed', kind: 'image', extractedText: 'prepared' } } } });
    expect(saved.allowOperationalEffects).toBe(false);
    expect(await db.conversation.findUnique({ where: { id: saved.conversationId! } })).toMatchObject({ aiControlStatus: 'human_controlled', unreadCount: 0, customerServiceWindowExpiresAt: null });
    expect(await db.message.findUnique({ where: { id: saved.messageId! } })).toMatchObject({ createdAt, ingestedAt: createdAt, mediaUrl: 'https://owned.invalid/image', metadata: {
      historyImport: { source: 'evolution', batchId: 'synthetic', channelId: c.channelId }, groupSender: { jid: PN, name: 'Fixture' }, assistantMedia: { sourceHash: createHash('sha256').update(JSON.stringify([saved.messageId, 'image', 'https://owned.invalid/image'])).digest('hex'), result: { extractedText: 'prepared' } }
    } });
  });

  it('compares complete native tuples even in a forced hash collision bucket', async () => {
    const c = await fixture(), collision = createCanonicalStore({ hash: () => 'a' }), reads = createCanonicalReads({ hash: () => 'a' });
    const first = message(c), second = message(c, 'B');
    const saved = await collision.persist(db, first, { receiptKey: 'first' });
    await collision.persist(db, second, { receiptKey: 'second' });
    expect(await db.$transaction(tx => reads.lookupNativeInTransaction(tx, c, first.key))).toMatchObject({ kind: 'resolved', originMessageId: saved.messageId });
    for (const changed of [{ nativeChatAddress: '15550002222@s.whatsapp.net' }, { rawId: 'B' }, { direction: 'outbound' as const }, { nativeId: 'absent' }]) {
      expect(await db.$transaction(tx => reads.lookupNativeInTransaction(tx, c, { ...first.key, ...changed }))).toMatchObject({ kind: 'missing' });
    }
    const other = await fixture();
    expect(await db.$transaction(tx => reads.lookupNativeInTransaction(tx, other, first.key))).toMatchObject({ kind: 'missing' });
  });
  it('performs no model mutations on exact read and never consults aliases after permission denial', async () => {
    const c = await fixture(), event = message(c), saved = await persist(event);
    await db.$transaction(async tx => {
      const readonly = new Proxy(tx, { get(target, property) {
        const model = Reflect.get(target, property);
        if (typeof property === 'string' && !property.startsWith('$') && model && typeof model === 'object') return new Proxy(model, { get(delegate, method) {
          if (['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'].includes(String(method))) throw new Error('read attempted mutation');
          return Reflect.get(delegate, method);
        } });
        return model;
      } });
      expect(await lookupNativeInTransaction(readonly, c, event.key)).toMatchObject({ kind: 'resolved' });
      const denied = new Proxy(readonly, { get(target, property) {
        if (String(property).startsWith('canonical')) throw new Error('permission denial read canonical identity');
        return Reflect.get(target, property);
      } });
      expect(await resolveProviderReferenceInTransaction(denied, { workspaceId: c.workspaceId, channelId: c.channelId,
        originConversationId: saved.conversationId!, messageId: saved.messageId!, requestedProvider: 'evolution', authorizeOrigin: async () => false })).toMatchObject({ kind: 'forbidden_origin' });
    });
  });
  it('returns review for an authority dispute and incomplete for a legacy object alias', async () => {
    const c = await fixture(), event = message(c), saved = await persist(event);
    await db.canonicalChat.update({ where: { id: saved.chatId! }, data: { state: 'review', operationConversationId: null, reviewReason: 'fixture' } });
    expect(await lookup(c, event.key)).toMatchObject({ kind: 'review' });
    await db.canonicalNativeAlias.updateMany({ where: { workspaceId: c.workspaceId }, data: { fullTuple: { origin: 'legacy', messageId: saved.messageId, nativeId: 'A' } } });
    expect(await db.$transaction(tx => resolveProviderReferenceInTransaction(tx, { workspaceId: c.workspaceId, channelId: c.channelId,
      originConversationId: saved.conversationId!, messageId: saved.messageId!, requestedProvider: 'evolution', authorizeOrigin: async () => true }))).toMatchObject({ kind: 'incomplete' });
  });
  it('keeps stale pending lifecycle events held through recovery instead of applying them', async () => {
    const c = await fixture(), original = message(c);
    const pending = await store.persist(db, { ...original, kind: 'revoke', target: original.key, action: message(c, 'DELETE').key }, { receiptKey: 'pending' });
    await db.channelConnection.update({ where: { id: c.connectionId! }, data: { lifecycleGeneration: 2 } });
    const current = { ...c, lifecycleGeneration: 2 }, saved = await persist({ ...original, context: current });
    const recovery = await db.$transaction(tx => store.recoverPendingInTransaction(tx, current));
    expect(recovery.results).toEqual(expect.arrayContaining([expect.objectContaining({ observationId: pending.observationId, reconciliationReasons: ['stale_source'], changes: [] })]));
    expect(await db.message.findUnique({ where: { id: saved.messageId! } })).toMatchObject({ type: 'text', body: 'hello' });
    expect(await db.canonicalObservation.findUnique({ where: { id: pending.observationId } })).toMatchObject({ lifecycleGeneration: 0, state: 'held' });
  });
  it('derives physical source and generation from DB instead of transport metadata', async () => {
    const c = await fixture();
    const derived = await db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId: c.workspaceId, channelId: c.channelId,
      mode: 'history', observedAt: c.observedAt, authenticatedSource: { provider: 'evolution', connectionId: c.connectionId! } }));
    expect(derived).toMatchObject({ ...c, mode: 'history' });
    expect(Object.isFrozen(derived)).toBe(true);
  });
  it('keeps official and bridge wamid namespaces distinct on the same logical channel', async () => {
    const p = await fixture(), phoneNumberId = 'configured-second-phone';
    const channel = await db.channel.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', providerKey: phoneNumberId } });
    const config = await db.integrationConfig.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', mode: 'real', status: 'connected', settings: { enabled: true, phoneNumberId, wabaId: 'synthetic-waba', accessToken: 'synthetic-token' } } });
    const official: TrustedMessagingContext = { ...p, channelId: channel.id, provider: 'meta_official', channelProvider: 'meta', connectionId: null, phoneNumberId, sessionName: phoneNumberId };
    const first = message(official, 'wamid.shared'); first.key.identityFormat = 'provider_native'; first.key.rawId = null;
    const saved = await persist(first);
    await db.integrationConfig.update({ where: { id: config.id }, data: { settings: { enabled: true, connectionMode: 'evolution_official', evolutionInstanceName: 'bridge-fixture', evolutionBaseUrl: 'https://evolution.invalid', evolutionApiKey: 'synthetic-key' } } });
    const bridge: TrustedMessagingContext = { ...p, channelId: channel.id, provider: 'evolution', channelProvider: 'meta', connectionId: null, sessionName: 'bridge-fixture' };
    const second = await persist({ ...first, context: bridge });
    expect(second.messageId).not.toBe(saved.messageId);
    expect(second.conversationId).toBe(saved.conversationId);
    expect(await lookup(bridge, first.key)).toMatchObject({ kind: 'resolved', originMessageId: second.messageId });
  });
  it('ignores protected metadata in presentation and cannot promote recovered eligibility', async () => {
    const c = { ...await fixture(), mode: 'recovered_live' as const }, event = message(c);
    await expect(store.persist(db, event, { receiptKey: 'protected', presentation: { metadata: { allowOperationalEffects: true } } as never })).rejects.toThrow('Protected presentation field');
    expect(await db.message.count({ where: { workspaceId: c.workspaceId } })).toBe(0);
    const saved = await persist(event);
    expect(saved.allowOperationalEffects).toBe(false);
  });

  it('does not use a chosen operational authority to authorize a different message origin', async () => {
    const c = await fixture(), saved = await persist(message(c));
    const contact = await db.contact.create({ data: { workspaceId: c.workspaceId, phone: '15550008888' } });
    const other = await db.conversation.create({ data: { workspaceId: c.workspaceId, channelId: c.channelId, contactId: contact.id } });
    await db.canonicalChatMember.create({ data: { workspaceId: c.workspaceId, channelId: c.channelId, chatId: saved.chatId!, conversationId: other.id, source: 'fixture-review-choice' } });
    await db.canonicalChat.update({ where: { id: saved.chatId! }, data: { operationConversationId: other.id, revision: 3 } });
    const authorizeOrigin = vi.fn(async () => true);
    const request = { workspaceId: c.workspaceId, channelId: c.channelId, messageId: saved.messageId!, originConversationId: saved.conversationId!, requestedProvider: 'evolution' as const, authorizeOrigin };
    expect(await db.$transaction(tx => resolveProviderReferenceInTransaction(tx, request))).toMatchObject({ kind: 'resolved', originConversationId: saved.conversationId, authority: { conversationId: other.id, revision: 3 } });
    expect(authorizeOrigin).toHaveBeenCalledWith(expect.objectContaining({ conversationId: saved.conversationId }));
    authorizeOrigin.mockClear();
    expect(await db.$transaction(tx => resolveProviderReferenceInTransaction(tx, { ...request, originConversationId: other.id }))).toMatchObject({ kind: 'forbidden_origin' });
    expect(authorizeOrigin).not.toHaveBeenCalled();
  });
  it('refuses to relabel a legacy Meta UUID owned by another configured phone ID', async () => {
    const p = await fixture(), phoneNumberId = 'configured-adoption-phone';
    const channel = await db.channel.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', providerKey: phoneNumberId } });
    await db.integrationConfig.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', mode: 'real', status: 'connected', settings: { enabled: true, phoneNumberId, wabaId: 'synthetic-waba', accessToken: 'synthetic-token' } } });
    const c: TrustedMessagingContext = { ...p, channelId: channel.id, provider: 'meta_official', channelProvider: 'meta', connectionId: null, phoneNumberId, sessionName: phoneNumberId };
    const contact = await db.contact.create({ data: { workspaceId: c.workspaceId, phone: '15550001111' } });
    const conversation = await db.conversation.create({ data: { workspaceId: c.workspaceId, channelId: c.channelId, contactId: contact.id } });
    const legacy = await db.message.create({ data: { workspaceId: c.workspaceId, conversationId: conversation.id, direction: 'inbound', type: 'text', providerMessageId: 'wamid.foreign', providerEventId: 'meta:other-phone:wamid.foreign' } });
    const event = message(c, 'wamid.foreign'); event.key.identityFormat = 'provider_native'; event.key.rawId = null;
    expect(await store.persist(db, event, { receiptKey: 'foreign', adoption: { messageId: legacy.id, key: event.key, source: 'provider_exact_lookup' } })).toMatchObject({ outcome: 'held', reconciliationReasons: ['official_meta_adoption_requires_exact_native'] });
    expect(await db.message.findUnique({ where: { id: legacy.id } })).toEqual(legacy);
  });

  it('holds a divergent origin direction instead of trusting cached canonical fields', async () => {
    const c = await fixture(), event = message(c), saved = await persist(event);
    await db.message.update({ where: { id: saved.messageId! }, data: { direction: 'outbound' } });
    expect(await lookup(c, event.key)).toMatchObject({ kind: 'review' });
  });

  it.each(['alias_review', 'identity_review', 'alias_binding'] as const)('waits for workspace lock before all origin reads and authorization: %s', async mutation => {
    const c = await fixture(), saved = await persist(message(c));
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { locked = r; }), unblock = new Promise<void>(r => { release = r; });
    const domainReads: string[] = [];
    const writer = db.$transaction(async tx => {
      await enterCanonicalTransaction(tx, c); locked(); await unblock;
      if (mutation === 'alias_review') await tx.canonicalNativeAlias.updateMany({ where: { workspaceId: c.workspaceId }, data: { state: 'review' } });
      if (mutation === 'identity_review') await tx.canonicalMessageIdentity.update({ where: { id: saved.identityId! }, data: { state: 'review' } });
      if (mutation === 'alias_binding') await tx.canonicalNativeAlias.updateMany({ where: { workspaceId: c.workspaceId }, data: { identityId: null, state: 'unresolved' } });
    });
    await ready;
    const resolver = db.$transaction(async tx => {
      const watched = new Proxy(tx, { get(target, property) {
        if (['message', 'conversation', 'canonicalMessageIdentity', 'canonicalNativeAlias'].includes(String(property))) domainReads.push(String(property));
        return Reflect.get(target, property);
      } });
      return resolveProviderReferenceInTransaction(watched, { workspaceId: c.workspaceId, channelId: c.channelId,
        originConversationId: saved.conversationId!, messageId: saved.messageId!, requestedProvider: 'evolution', authorizeOrigin: async () => { domainReads.push('authorizeOrigin'); return true; } });
    });
    let blocked = false;
    try {
      for (let i = 0; i < 100; i++) {
        const waiting = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
        if (Number(waiting[0]!.n)) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
      expect(domainReads).toEqual([]);
    } finally { release(); await writer; }
    expect(await resolver).toMatchObject({ kind: mutation === 'alias_binding' ? 'missing' : 'review' });
  });
  it.each(['wabaId', 'accessToken'])('rejects inactive official Meta when %s is missing', async missing => {
    const p = await fixture(), phoneNumberId = 'configured-active-phone';
    const channel = await db.channel.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', providerKey: phoneNumberId } });
    const settings: Record<string, unknown> = { enabled: true, connectionMode: 'direct', phoneNumberId, wabaId: 'synthetic-waba', accessToken: 'synthetic-token' };
    delete settings[missing];
    await db.integrationConfig.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', mode: 'real', status: 'connected', settings: settings as never } });
    await expect(db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId: p.workspaceId, channelId: channel.id, mode: 'live', observedAt: p.observedAt,
      authenticatedSource: { provider: 'meta_official', connectionId: null, phoneNumberId } }))).rejects.toMatchObject({ code: 'stale_source' });
  });
  it.each(['evolutionBaseUrl', 'evolutionApiKey'])('rejects inactive Evolution bridge when %s is missing', async missing => {
    const p = await fixture();
    const channel = await db.channel.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', providerKey: 'bridge-phone' } });
    const settings: Record<string, unknown> = { enabled: true, connectionMode: 'evolution_official', evolutionInstanceName: 'fixture-bridge', evolutionBaseUrl: 'https://evolution.invalid', evolutionApiKey: 'synthetic-key' };
    delete settings[missing];
    await db.integrationConfig.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', mode: 'real', status: 'connected', settings: settings as never } });
    await expect(db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId: p.workspaceId, channelId: channel.id, mode: 'live', observedAt: p.observedAt,
      authenticatedSource: { provider: 'evolution', connectionId: null, sessionName: 'fixture-bridge' } }))).rejects.toMatchObject({ code: 'stale_source' });
  });

  it.each(['meta_official', 'evolution'] as const)('rechecks active %s configuration after waiting for a concurrent removal', async provider => {
    const p = await fixture(), phoneNumberId = 'configured-removal-phone', sessionName = provider === 'meta_official' ? phoneNumberId : 'removal-bridge';
    const channel = await db.channel.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', providerKey: phoneNumberId } });
    const settings: Record<string, unknown> = provider === 'meta_official'
      ? { enabled: true, connectionMode: 'direct', phoneNumberId, wabaId: 'synthetic-waba', accessToken: 'synthetic-token' }
      : { enabled: true, connectionMode: 'evolution_official', evolutionInstanceName: sessionName, evolutionBaseUrl: 'https://evolution.invalid', evolutionApiKey: 'synthetic-key' };
    const config = await db.integrationConfig.create({ data: { workspaceId: p.workspaceId, provider: 'meta_cloud', mode: 'real', status: 'connected', settings: settings as never } });
    const context = await db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId: p.workspaceId, channelId: channel.id, mode: 'live', observedAt: p.observedAt,
      authenticatedSource: provider === 'meta_official' ? { provider, connectionId: null, phoneNumberId } : { provider, connectionId: null, sessionName } }));
    await expect(db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId: p.workspaceId, channelId: channel.id, mode: 'live', observedAt: p.observedAt,
      authenticatedSource: provider === 'meta_official' ? { provider, connectionId: null, phoneNumberId: 'wrong-configured-phone' } : { provider, connectionId: null, sessionName: 'wrong-configured-bridge' } }))).rejects.toMatchObject({ code: 'stale_source' });
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { locked = r; }), unblock = new Promise<void>(r => { release = r; });
    const configWriter = db.$transaction(async tx => {
      delete settings[provider === 'meta_official' ? 'accessToken' : 'evolutionApiKey'];
      await tx.integrationConfig.update({ where: { id: config.id }, data: { settings: settings as never } });
      locked(); await unblock;
    });
    await ready;
    const event = message(context, 'wamid.removal'); event.key.identityFormat = 'provider_native'; event.key.rawId = null;
    const writer = persist(event);
    let blocked = false;
    try {
      for (let i = 0; i < 100; i++) {
        const waiting = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%integration_configs%'`;
        if (Number(waiting[0]!.n)) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); await configWriter; }
    await expect(writer).rejects.toMatchObject({ code: 'stale_source' });
    expect(await db.canonicalObservation.count({ where: { workspaceId: p.workspaceId } })).toBe(0);
  });

});
