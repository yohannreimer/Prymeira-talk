import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MessageEditPatch, NormalizedMessagingEvent, TrustedMessagingContext } from './normalized-event.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import { normalizeWahaEvent } from '../waha/waha-normalizer.js';
import { parseWahaMessageKey } from './whatsapp-identity.js';
import { createCanonicalStore, type CanonicalStoreOptions } from './canonical-store.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;
const PN = '15550001111@s.whatsapp.net', LID = '700001@lid', GROUP = '120000-100@g.us';
type MessageEvent = Extract<NormalizedMessagingEvent, { kind: 'message' }>;
function msg(context: TrustedMessagingContext, rawId = 'A', chat = PN, sender?: string): MessageEvent {
  const result = context.provider === 'evolution'
    ? normalizeEvolutionWebhook(context, { event: 'messages.upsert', data: { key: { id: rawId, remoteJid: chat, fromMe: false, participant: sender }, message: { conversation: 'hello' }, messageTimestamp: 1700000000 } })
    : normalizeWahaEvent(context, { event: 'message', payload: { id: `false_${chat}_${rawId}${sender ? `_${sender}` : ''}`, fromMe: false, timestamp: 1700000000, _data: { id: { id: rawId, remote: chat, fromMe: false, participant: sender }, type: 'chat', body: 'hello' } } });
  if (result.kind !== 'accepted' || result.event.kind !== 'message') throw new Error('Invalid normalized fixture');
  return result.event;
}

describe.skipIf(!url)('canonical persistent reducers on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  const store = createCanonicalStore();
  async function context(workspaceId: string = randomUUID(), channelId?: string, provider: 'evolution' | 'waha' = 'evolution'): Promise<TrustedMessagingContext> {
    if (!workspaces.includes(workspaceId)) workspaces.push(workspaceId);
    const channel = channelId ? await db.channel.findUniqueOrThrow({ where: { id: channelId } }) : await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const connection = await db.channelConnection.upsert({ where: { workspaceId_channelId_provider: { workspaceId, channelId: channel.id, provider } }, create: { workspaceId, channelId: channel.id, provider, sessionName: randomUUID() }, update: {} });
    return { workspaceId, channelId: channel.id, provider, channelProvider: 'evolution', connectionId: connection.id, sessionName: connection.sessionName, lifecycleGeneration: 0, mode: 'live', observedAt: '2026-09-30T12:00:00.000Z' };
  }
  const persist = (event: NormalizedMessagingEvent, receiptKey: string = randomUUID(), options: Omit<Partial<CanonicalStoreOptions>, 'receiptKey'> = {}) => store.persist(db, event, { receiptKey, ...options });
  beforeAll(() => {
    const u = new URL(url!);
    if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['localhost','127.0.0.1'].includes(u.hostname) || u.pathname !== '/messaging_test') throw new Error('Only local messaging_test');
    db = new PrismaClient({ datasources: { db: { url } } });
  });
  afterAll(async () => {
    if (!db) return;
    // All cleanup is restricted to fixture workspace UUIDs.
    const where = { workspaceId: { in: workspaces } };
    await db.canonicalAction.deleteMany({ where });
    await db.canonicalRecipientReceipt.deleteMany({ where });
    await db.canonicalAddressEvidence.deleteMany({ where });
    await db.canonicalObservation.deleteMany({ where });
    await db.canonicalNativeAlias.deleteMany({ where });
    await db.canonicalMessageIdentity.deleteMany({ where });
    await db.canonicalChatMember.deleteMany({ where });
    await db.canonicalChat.deleteMany({ where });
    await db.canonicalAddressAlias.deleteMany({ where });
    await db.canonicalAddress.updateMany({ where, data: { redirectId: null } });
    await db.canonicalAddress.deleteMany({ where });
    await db.channel.deleteMany({ where });
    await db.contact.deleteMany({ where });
    await db.$disconnect();
  });
  it('keeps revoke before original durable through restart and suppresses deleted content effects', async () => {
    const c = await context(), original = msg(c);
    const revoke: NormalizedMessagingEvent = { ...original, kind: 'revoke', target: original.key, action: msg(c, 'DELETE').key };
    const pending = await persist(revoke, 'revoke');
    expect(pending.outcome).toBe('held');
    expect(await db.message.count({ where: { workspaceId: c.workspaceId } })).toBe(0);
    const result = await createCanonicalStore().persist(db, original, { receiptKey: 'original' });
    expect(result.allowOperationalEffects).toBe(false);
    expect(await db.message.findUnique({ where: { id: result.messageId! } })).toMatchObject({ type: 'system', mediaUrl: null, metadata: expect.objectContaining({ deletedAt: expect.any(String) }) });
    const retry = await createCanonicalStore().persist(db, revoke, { receiptKey: 'revoke' });
    expect(retry.observationId).toBe(pending.observationId);
    expect(retry.changes).toEqual([]);
    expect(await db.canonicalObservation.count({ where: { workspaceId: c.workspaceId } })).toBe(2);
  });
  it('reduces receipts monotonically while retaining played and provider observations', async () => {
    const c = await context(), original = msg(c); original.key.direction = 'outbound';
    const created = await persist(original);
    for (const [status, providerStatus] of [['read', 'played'], ['delivered', 'delivered'], ['failed', 'failed'], ['pending', 'pending']] as const) {
      await persist({ ...original, kind: 'receipt', target: original.key, status, providerStatus, recipient: PN });
    }
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ status: 'read' });
    const receipts = await db.canonicalRecipientReceipt.findMany({ where: { identityId: created.identityId! } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: 'read', played: true });
    expect(await db.canonicalObservation.count({ where: { workspaceId: c.workspaceId, kind: 'receipt' } })).toBe(4);
  });
  it('keeps group receipt recipients separate without advertising all members read', async () => {
    const c = await context(), original = msg(c, 'A', GROUP, PN); original.key.direction = 'outbound';
    const created = await persist(original);
    const recipient = '15550002222@s.whatsapp.net';
    expect((await persist({ ...original, kind: 'receipt', target: original.key, status: 'read', providerStatus: 'read', recipient })).outcome).toBe('enriched');
    await persist({ ...original, kind: 'receipt', target: original.key, status: 'delivered', providerStatus: 'delivered', recipient: PN });
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ status: 'sent' });
    expect(await db.canonicalRecipientReceipt.count({ where: { identityId: created.identityId! } })).toBe(2);
    const unknown = await persist({ ...original, kind: 'receipt', target: { ...original.key, senderParticipant: null }, status: 'read', providerStatus: 'read', recipient });
    expect(unknown.outcome).toBe('held');
  });

  it('uses a fully scoped WAHA native alias for an otherwise incomplete receipt, never a wildcard', async () => {
    const c = await context(), w = await context(c.workspaceId, c.channelId, 'waha');
    const original = msg(w); original.key.direction = 'outbound'; original.key.nativeId = `true_${PN}_raw_with_underscores`;
    const created = await persist(original);
    const target = { ...original.key, rawId: null, chatAddress: null, direction: null, senderParticipant: null, nativeChatAddress: null, nativeSenderParticipant: null };
    const receipt: NormalizedMessagingEvent = { ...original, kind: 'receipt', target, status: 'read', providerStatus: 'read', recipient: PN };
    const resolved = await persist(receipt);
    expect(resolved).toMatchObject({ outcome: 'enriched', messageId: created.messageId, allowOperationalEffects: false });
    const wrongSession = await persist({ ...receipt, context: { ...w, sessionName: 'different-session' } });
    expect(wrongSession).toMatchObject({ outcome: 'held', messageId: null });
    const wrongDirection = await persist({ ...receipt, target: { ...target, direction: 'inbound' } });
    expect(wrongDirection).toMatchObject({ outcome: 'held', messageId: null });
    const wrongNative = await persist({ ...receipt, target: { ...target, nativeId: 'raw_with_underscores' } });
    expect(wrongNative).toMatchObject({ outcome: 'held', messageId: null });
  });

  it('applies one demonstrated text edit but holds competing edits without certified order', async () => {
    const c = await context(), original = msg(c), created = await persist(original);
    const first: NormalizedMessagingEvent = { ...original, kind: 'edit', target: original.key, action: msg(c, 'EDIT_1').key, patch: { field: 'body', body: 'corrected' } };
    expect((await persist(first)).outcome).toBe('enriched');
    const second: NormalizedMessagingEvent = { ...first, action: msg(c, 'EDIT_2').key, patch: { field: 'body', body: 'competing' }, order: { timestampMs: 9999999999999, sequence: '999' } };
    expect((await persist(second)).reconciliationReasons).toContain('edit_order_unproven');
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ type: 'text', body: 'corrected' });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'pending_reconciliation' });
    await persist({ ...original, context: { ...c, mode: 'history' } });
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'corrected' });
  });
  it('does not clear an unresolved original snapshot when one edit is applied', async () => {
    const c = await context(), original = msg(c), created = await persist(original);
    const conflict = msg(c); conflict.content.body = 'disputed original';
    expect((await persist(conflict)).outcome).toBe('held');
    await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'E1').key, patch: { field: 'body', body: 'edited' } });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'pending_reconciliation' });
    expect(await db.canonicalObservation.count({ where: { identityId: created.identityId!, kind: 'message', state: 'held' } })).toBe(1);
  });
  it.each(['audio', 'image', 'file'] as const)('removes a %s caption while preserving media and prepared fields', async (type) => {
    const c = await context(), original = msg(c); original.content = { type, body: type === 'audio' ? 'prepared transcript' : 'caption', mediaUrl: 'https://owned.test/media', preview: 'caption' }; original.attachment = { caption: 'caption', fileName: 'original.pdf', mimeType: 'application/pdf' };
    const created = await persist(original);
    const stored = await db.message.findUniqueOrThrow({ where: { id: created.messageId! } });
    await db.message.update({ where: { id: stored.id }, data: { metadata: { ...(stored.metadata as object), transcription: { status: 'completed' }, assistantMedia: { status: 'completed' } } } });
    expect((await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'EDIT').key, patch: { field: 'caption', caption: '' } })).outcome).toBe('enriched');
    const result = await db.message.findUniqueOrThrow({ where: { id: stored.id } });
    expect(result).toMatchObject({ type, mediaUrl: 'https://owned.test/media', metadata: expect.objectContaining({ attachment: expect.objectContaining({ caption: '', fileName: 'original.pdf', mimeType: 'application/pdf' }), transcription: { status: 'completed' }, assistantMedia: { status: 'completed' } }) });
    expect(result.body).not.toBe('caption');
    if (type === 'audio') expect(result.body).toBe('prepared transcript');
  });

  it('reconciles competing edits only against an exact certified revision and a complete pending frontier', async () => {
    expect(store.reconcileRevisionInTransaction).toBeTypeOf('function');
    const c = await context(), original = msg(c), created = await persist(original);
    await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'E1').key, patch: { field: 'body', body: 'first' } });
    const held = await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'E2').key, patch: { field: 'body', body: 'second' } });
    const identity = await db.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: created.identityId! } });
    const request = { actionId: held.actionId!, expectedRevisionVersion: identity.revisionVersion, pendingActionIds: [held.actionId!],
      target: original.key, revision: msg(c, 'E2').key, patch: { field: 'body' as const, body: 'second' },
      proof: { source: 'provider_current_revision' as const, requestId: 'fetch-1' } };
    await expect(db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { ...request, revision: msg(c, 'WRONG').key }))).rejects.toThrow('revision');
    const result = await db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, request));
    expect(result).toMatchObject({ outcome: 'enriched', allowOperationalEffects: false, changes: ['revision_reconciled'] });
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'second' });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'ready', revisionVersion: 2 });
    expect(await db.canonicalAction.findUnique({ where: { id: held.actionId! } })).toMatchObject({ evidence: expect.objectContaining({ certifiedBy: expect.objectContaining({ provider: c.provider, connectionId: c.connectionId, sessionName: c.sessionName }) }) });
    expect((await db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, request))).changes).toEqual([]);
    const late = await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'E3').key, patch: { field: 'body', body: 'third' } });
    await expect(db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { ...request, actionId: late.actionId!, revision: msg(c, 'E3').key, pendingActionIds: [late.actionId!] }))).rejects.toThrow(/stale/i);
  });
  it('retains ciphertext privately until exact decryption and revision evidence are supplied', async () => {
    expect(store.reconcileRevisionInTransaction).toBeTypeOf('function');
    const c = await context(), original = msg(c), created = await persist(original);
    const encrypted = { ivBase64: 'aXY=', payloadBase64: 'c2VjcmV0', senderJids: [PN] };
    const held = await persist({ ...original, kind: 'encrypted_edit', target: original.key, action: msg(c, 'E1').key, encrypted });
    expect(held.reconciliationReasons).toContain('decrypt_reconciliation_required');
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'hello' });
    const request = { actionId: held.actionId!, expectedRevisionVersion: 0, pendingActionIds: [held.actionId!],
      target: original.key, revision: msg(c, 'E1').key, patch: { field: 'body' as const, body: 'decrypted result' },
      proof: { source: 'authenticated_decryption' as const, requestId: 'decrypt-1', currentRevisionRequestId: 'current-fetch', authorAddress: PN, ivBase64: encrypted.ivBase64, payloadBase64: encrypted.payloadBase64 } };
    await expect(db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { ...request, proof: { ...request.proof, authorAddress: '15550003333@s.whatsapp.net' } }))).rejects.toThrow('decryption');
    await expect(db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { ...request, proof: { ...request.proof, currentRevisionRequestId: '' } }))).rejects.toThrow('decryption');
    expect((await db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, request))).outcome).toBe('enriched');
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'decrypted result' });
    expect(await db.canonicalObservation.findUnique({ where: { id: held.observationId } })).toMatchObject({ payload: expect.objectContaining({ encrypted }) });
    const conflicting = await persist({ ...original, kind: 'encrypted_edit', target: original.key, action: msg(c, 'E1').key, encrypted: { ...encrypted, payloadBase64: 'ZGlmZmVyZW50' } });
    expect(conflicting.reconciliationReasons).toContain('action_revision_conflict');
  });

  it('enriches only missing media presentation fields from the same revision and keeps private sources', async () => {
    const c = await context(), w = await context(c.workspaceId, c.channelId, 'waha');
    const original = msg(c); original.content = { type: 'image', body: 'Imagem recebida', preview: 'Imagem recebida', mediaUrl: null }; original.media = { kind: 'image', hasMedia: true, url: null, state: 'pending' };
    const created = await persist(original);
    const mirror = { ...original, context: w, key: msg(w).key, attachment: { caption: 'new caption', mimeType: 'image/jpeg', fileName: 'a.jpg', width: 640, height: 480, durationSeconds: 5 }, content: { ...original.content, body: 'new caption', mediaUrl: 'https://provider.test/a.jpg' }, media: { ...original.media!, url: 'https://provider.test/a.jpg', state: 'available' as const } };
    const enriched = await persist(mirror);
    expect(enriched.outcome).toBe('enriched');
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ type: 'image', body: 'new caption', metadata: expect.objectContaining({ attachment: mirror.attachment, canonicalPreparation: { status: 'pending' } }) });
    const conflict = await persist({ ...mirror, attachment: { ...mirror.attachment, caption: 'conflicting' }, content: { ...mirror.content, body: 'conflicting' } });
    expect(conflict.reconciliationReasons).toContain('content_reconciliation_required');
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'new caption' });
    expect(await db.canonicalObservation.count({ where: { identityId: created.identityId!, provider: 'waha' } })).toBe(2);
  });
  it('never promotes client-only URLs or provider errors during enrichment', async () => {
    const c = await context(), original = msg(c); original.content.type = 'audio'; original.content.body = 'Áudio recebido';
    const created = await persist(original);
    const unsafe = { ...original, content: { ...original.content, mediaUrl: 'blob:client-only' }, media: { kind: 'audio' as const, hasMedia: true, url: 'blob:client-only', state: 'failed' as const, errorCode: 'provider_media_unavailable' as const } };
    await persist(unsafe);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ mediaUrl: null, body: 'Áudio recebido' });
  });

  it('holds every competing edit already pending before the original without choosing UUID or arrival order', async () => {
    const c = await context(), original = msg(c);
    for (const id of ['EARLIER', 'LATER']) await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, id).key, patch: { field: 'body', body: id } });
    const created = await persist(original);
    expect(created.allowOperationalEffects).toBe(false);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'hello' });
    expect(await db.canonicalAction.count({ where: { identityId: created.identityId!, state: 'pending' } })).toBe(2);
  });
  it('offers bounded restart-safe recovery and keeps quarantined receipt conflicts held', async () => {
    expect(store.recoverPendingInTransaction).toBeTypeOf('function');
    const c = await context(), original = msg(c);
    const first = await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'E1').key, patch: { field: 'body', body: 'one' } }, 'conflict');
    await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'E1').key, patch: { field: 'body', body: 'two' } }, 'conflict');
    const created = await persist(original);
    await db.$transaction(tx => createCanonicalStore().recoverPendingInTransaction(tx, c, { limit: 1 }));
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'hello' });
    expect(await db.canonicalObservation.findUnique({ where: { id: first.observationId } })).toMatchObject({ reason: 'receipt_key_conflict', state: 'held' });
    await expect(db.$transaction(tx => store.recoverPendingInTransaction(tx, c, { limit: 101 }))).rejects.toThrow('limit');
  });

  it('resolves held content snapshots through an exact certified observation without granting effects', async () => {
    expect(store.reconcileSnapshotInTransaction).toBeTypeOf('function');
    const c = await context(), original = msg(c), created = await persist(original);
    const snapshot = { ...original, content: { ...original.content, body: 'certified content' } };
    const held = await persist(snapshot);
    expect(held.outcome).toBe('held');
    const request = { observationId: held.observationId, target: original.key, expectedRevisionVersion: 0,
      pendingObservationIds: [held.observationId], proof: { source: 'provider_current_revision' as const, requestId: 'fetch-current' } };
    await expect(db.$transaction(tx => store.reconcileSnapshotInTransaction(tx, c, { ...request, target: msg(c, 'OTHER').key }))).rejects.toThrow('scope');
    const result = await db.$transaction(tx => store.reconcileSnapshotInTransaction(tx, c, request));
    expect(result).toMatchObject({ outcome: 'enriched', allowOperationalEffects: false });
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'certified content' });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'ready' });
    expect((await db.$transaction(tx => store.reconcileSnapshotInTransaction(tx, c, request))).changes).toEqual([]);
    expect((await db.message.findUniqueOrThrow({ where: { id: created.messageId! } })).metadata).not.toHaveProperty('editedAt');
    expect((await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'FIRST_EDIT').key, patch: { field: 'body', body: 'first real edit' } })).changes).toContain('message_edited');
  });

  it('coalesces mirrored edit actions before the original and concurrent delivery without double application', async () => {
    const c = await context(), w = await context(c.workspaceId, c.channelId, 'waha');
    const action = (ctx: TrustedMessagingContext): NormalizedMessagingEvent => ({ ...msg(ctx), kind: 'edit', target: msg(ctx).key, action: msg(ctx, 'E').key, patch: { field: 'body', body: 'updated' } });
    await Promise.all([persist(action(c)), persist(action(w))]);
    const created = await persist(msg(c));
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'updated' });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ revisionVersion: 1 });
    const results = await Promise.all([persist(action(c)), persist(action(w))]);
    expect(results.every(result => result.changes.length === 0 && !result.allowOperationalEffects)).toBe(true);
  });
  it('replays receipts before the original after explicit PN/LID proof and preserves Evolution played', async () => {
    const c = await context(), original = msg(c); original.key.direction = 'outbound';
    const event: NormalizedMessagingEvent = { ...original, kind: 'receipt', target: { ...msg(c, 'A', LID).key, direction: 'outbound' }, status: 'read', providerStatus: 5, recipient: PN };
    const held = await persist(event, 'receipt');
    original.addressMappings = [{ role: 'chat', lid: LID, pn: PN, source: 'evolution.remoteJidAlt' }];
    const created = await persist(original);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ status: 'read' });
    expect(await db.canonicalRecipientReceipt.findFirst({ where: { identityId: created.identityId! } })).toMatchObject({ played: true });
    expect((await createCanonicalStore().persist(db, event, { receiptKey: 'receipt' })).observationId).toBe(held.observationId);
  });
  it('does not let Evolution READ numeric 4 pretend the media was played', async () => {
    const c = await context(), original = msg(c), created = await persist(original);
    await persist({ ...original, kind: 'receipt', target: original.key, status: 'read', providerStatus: 4, recipient: PN });
    expect(await db.canonicalRecipientReceipt.findFirst({ where: { identityId: created.identityId! } })).toMatchObject({ status: 'read', played: false });
  });
  it('keeps action targets exact under hash collisions across chats, directions, senders, channels and tenants', async () => {
    const c = await context(), otherChannel = await context(c.workspaceId), tenant = await context();
    const collision = createCanonicalStore({ hash: () => '0' });
    const originals = [msg(c), msg(c, 'A', '15550002222@s.whatsapp.net'), msg(c, 'A', GROUP, PN), msg(c, 'A', GROUP, '15550002222@s.whatsapp.net'), msg(otherChannel), msg(tenant)];
    originals.push({ ...msg(c), key: { ...msg(c).key, direction: 'outbound' } });
    const created = []; for (const original of originals) created.push(await collision.persist(db, original, { receiptKey: randomUUID() }));
    const target = originals[2]!;
    const result = await collision.persist(db, { ...target, kind: 'revoke', target: target.key, action: msg(c, 'DELETE', GROUP, PN).key }, { receiptKey: 'revoke' });
    expect(result.messageId).toBe(created[2]!.messageId);
    const deleted = await db.message.findMany({ where: { id: { in: created.map(row => row.messageId!) }, type: 'system' } });
    expect(deleted.map(row => row.id)).toEqual([created[2]!.messageId]);
  });
  it('rolls back original creation, tombstone reduction and pending attempts with the caller', async () => {
    const c = await context(), original = msg(c);
    const pending = await persist({ ...original, kind: 'revoke', target: original.key, action: msg(c, 'D').key });
    const before = await db.canonicalAction.findUniqueOrThrow({ where: { id: pending.actionId! } });
    await expect(db.$transaction(async tx => { await store.persistInTransaction(tx, original, { receiptKey: 'rollback' }); throw new Error('caller failed'); })).rejects.toThrow('caller failed');
    expect(await db.message.count({ where: { workspaceId: c.workspaceId } })).toBe(0);
    expect(await db.canonicalAction.findUnique({ where: { id: pending.actionId! } })).toMatchObject({ attempts: before.attempts, state: 'pending', identityId: null });
    expect((await persist(original, 'rollback')).allowOperationalEffects).toBe(false);
  });
  it('never resurrects a revoked message from a receipt, edit, history or stale media snapshot', async () => {
    const c = await context(), original = msg(c); original.content.type = 'image'; original.content.mediaUrl = 'https://owned.test/a.jpg'; original.attachment.caption = 'original';
    const created = await persist(original);
    await persist({ ...original, kind: 'revoke', target: original.key, action: msg(c, 'D').key });
    await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'E').key, patch: { field: 'caption', caption: 'new' } });
    await persist({ ...original, kind: 'receipt', target: original.key, status: 'read', providerStatus: 'read', recipient: PN });
    expect((await persist({ ...original, context: { ...c, mode: 'history' }, currentRevision: msg(c, 'E').key })).allowOperationalEffects).toBe(false);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ type: 'system', mediaUrl: null, metadata: { deletedAt: c.observedAt } });
  });
  it.each(['history', 'recovered_live'] as const)('keeps %s originals inert through pending edit reduction', async mode => {
    const c = { ...await context(), mode }, original = msg(c);
    await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'E').key, patch: { field: 'body', body: 'updated' } });
    const created = await persist(original);
    expect(created.allowOperationalEffects).toBe(false);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'updated' });
    expect(await db.conversation.findUnique({ where: { id: created.conversationId! } })).toMatchObject({ unreadCount: 0 });
  });
  it('blocks content understanding when encrypted edits precede the original', async () => {
    const c = await context(), original = msg(c);
    await persist({ ...original, kind: 'encrypted_edit', target: original.key, action: msg(c, 'E').key, encrypted: { ivBase64: 'aXY=', payloadBase64: 'c2VjcmV0', senderJids: [PN] } });
    const created = await persist(original);
    expect(created.allowOperationalEffects).toBe(false);
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'pending_reconciliation' });
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'hello' });
  });
  it('enforces composite FKs on actions and receipts and rejects stronger recovery snapshots', async () => {
    const c = await context(), other = await context(), a = await persist(msg(c)), b = await persist(msg(other));
    await expect(db.canonicalAction.create({ data: { workspaceId: c.workspaceId, channelId: c.channelId, observationId: a.observationId, identityId: b.identityId, kind: 'revoke', target: {}, targetHash: 'a' } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.canonicalRecipientReceipt.create({ data: { workspaceId: c.workspaceId, channelId: c.channelId, identityId: b.identityId!, recipient: PN, status: 'read' } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.$transaction(tx => store.recoverPendingInTransaction(tx, c), { isolationLevel: 'RepeatableRead' })).rejects.toThrow('READ COMMITTED');
  });

  it('resolves actions through the root chat after PN/LID union of one history and holds two authorities', async () => {
    const c = await context(), original = msg(c, 'A', LID), created = await persist(original);
    const mirror = msg(c); mirror.addressMappings = [{ role: 'chat', lid: LID, pn: PN, source: 'evolution.remoteJidAlt' }];
    await persist(mirror);
    const revoked = await persist({ ...mirror, kind: 'revoke', target: mirror.key, action: msg(c, 'D').key });
    expect(revoked.messageId).toBe(created.messageId);
    expect(revoked.changes).toContain('message_revoked');
    const other = await context(); await persist(msg(other, 'A', LID)); await persist(msg(other, 'A', PN));
    const disputed = { ...msg(other), addressMappings: mirror.addressMappings };
    const held = await persist({ ...disputed, kind: 'revoke', target: disputed.key, action: msg(other, 'D').key });
    expect(held.reconciliationReasons).toContain('multiple_conversation_authorities');
    expect(await db.message.count({ where: { workspaceId: other.workspaceId, type: 'system' } })).toBe(0);
  });
  it('enriches missing location and contact phone fields while preserving existing values', async () => {
    const c = await context(), original = msg(c); original.content.location = { latitude: null, longitude: null, name: 'Fixture place', address: null, isLive: false };
    const created = await persist(original);
    const mirror = { ...original, content: { ...original.content, location: { ...original.content.location!, latitude: 10, longitude: 20, address: 'Fixture address' } } };
    await persist(mirror);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ metadata: expect.objectContaining({ location: mirror.content.location }) });
    const card = msg(c, 'CARD'); card.content.contactCards = [{ fullName: 'Fixture card', phoneNumber: null }];
    const cardCreated = await persist(card);
    await persist({ ...card, content: { ...card.content, contactCards: [{ fullName: 'Fixture card', phoneNumber: '15550003333' }] } });
    expect(await db.message.findUnique({ where: { id: cardCreated.messageId! } })).toMatchObject({ metadata: expect.objectContaining({ contactCards: [{ fullName: 'Fixture card', phoneNumber: '15550003333' }] }) });
  });
  it('enriches missing metadata of the edited current revision without replacing prepared media', async () => {
    const c = await context(), w = await context(c.workspaceId, c.channelId, 'waha'), original = msg(c); original.content.type = 'image'; original.content.mediaUrl = 'https://owned.test/original'; original.attachment.caption = 'old';
    const created = await persist(original), revision = msg(c, 'EDIT').key;
    await persist({ ...original, kind: 'edit', target: original.key, action: revision, patch: { field: 'caption', caption: 'edited' } });
    const mirror = { ...original, context: w, key: msg(w).key, currentRevision: msg(w, 'EDIT').key, content: { ...original.content, body: 'edited', mediaUrl: 'https://provider.test/new' }, attachment: { caption: 'edited', width: 640, height: 480 } };
    expect((await persist(mirror)).outcome).toBe('enriched');
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'edited', mediaUrl: 'https://owned.test/original', metadata: expect.objectContaining({ attachment: mirror.attachment }) });
    expect((await persist({ ...original, context: { ...c, mode: 'history' } })).allowOperationalEffects).toBe(false);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'edited' });
  });

  it('lets a certified current snapshot resolve an edit whose webhook omitted the action identity', async () => {
    const c = await context(), original = msg(c), created = await persist(original);
    const unknownAction = { ...original.key, nativeId: null, rawId: null, direction: null };
    const edit = await persist({ ...original, kind: 'edit', target: original.key, action: unknownAction, patch: { field: 'body', body: 'reported edit' } });
    const revision = msg(c, 'VERIFIED_REVISION').key;
    const snapshot = await persist({ ...original, currentRevision: revision, content: { ...original.content, body: 'verified current body' } });
    const evidence = { observationId: snapshot.observationId, target: original.key, expectedRevisionVersion: 0, pendingObservationIds: [snapshot.observationId], pendingActionIds: [edit.actionId!], proof: { source: 'provider_current_revision' as const, requestId: 'exact-lookup' } };
    const result = await db.$transaction(tx => store.reconcileSnapshotInTransaction(tx, c, evidence));
    expect(result.allowOperationalEffects).toBe(false);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'verified current body' });
    expect(await db.canonicalAction.findUnique({ where: { id: edit.actionId! } })).toMatchObject({ state: 'superseded' });
  });

  it('does not reduce another chat as an unreported side effect of original delivery', async () => {
    const c = await context(), original = msg(c), created = await persist(original);
    await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'review' } });
    const held = await persist({ ...original, kind: 'revoke', target: original.key, action: msg(c, 'D').key });
    await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'active' } });
    await persist(msg(c, 'A', '15550002222@s.whatsapp.net'));
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'hello', type: 'text' });
    const recovery = await db.$transaction(tx => store.recoverPendingInTransaction(tx, c));
    expect(recovery.results).toEqual(expect.arrayContaining([expect.objectContaining({ observationId: held.observationId, changes: ['message_revoked'] })]));
  });
  it('does not declare content ready while an unacknowledged snapshot conflict remains', async () => {
    const c = await context(), original = msg(c), created = await persist(original);
    const held = await persist({ ...original, kind: 'encrypted_edit', target: original.key, action: msg(c, 'E').key, encrypted: { ivBase64: 'aXY=', payloadBase64: 'c2VjcmV0', senderJids: [PN] } });
    const snapshot = await persist({ ...original, content: { ...original.content, body: 'other snapshot' } });
    const request = { actionId: held.actionId!, expectedRevisionVersion: 0, pendingActionIds: [held.actionId!], target: original.key, revision: msg(c, 'E').key, patch: { field: 'body' as const, body: 'verified' }, proof: { source: 'authenticated_decryption' as const, requestId: 'decrypt', currentRevisionRequestId: 'current-fetch', authorAddress: PN, ivBase64: 'aXY=', payloadBase64: 'c2VjcmV0' } };
    await expect(db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, request))).rejects.toThrow('snapshot frontier');
    expect((await db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { ...request, pendingObservationIds: [snapshot.observationId] }))).outcome).toBe('enriched');
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'ready' });
  });

  it('quarantines an already applied edit when its ingress receipt is reused with contradictory content', async () => {
    const c = await context(), original = msg(c), created = await persist(original);
    const edit: NormalizedMessagingEvent = { ...original, kind: 'edit', target: original.key, action: msg(c, 'E').key, patch: { field: 'body', body: 'one' } };
    await persist(edit, 'same-edit');
    await persist({ ...edit, patch: { field: 'body', body: 'contradiction' } }, 'same-edit');
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'pending_reconciliation' });
    expect((await persist(edit, 'same-edit')).reconciliationReasons).toContain('receipt_key_conflict');
  });

  it('does not reuse the same action identity to edit two different target messages', async () => {
    const c = await context(), first = msg(c, 'A'), second = msg(c, 'B');
    await persist(first); const created = await persist(second);
    await persist({ ...first, kind: 'edit', target: first.key, action: msg(c, 'EDIT').key, patch: { field: 'body', body: 'first edited' } });
    const conflict = await persist({ ...second, kind: 'edit', target: second.key, action: msg(c, 'EDIT').key, patch: { field: 'body', body: 'wrong target' } });
    expect(conflict.reconciliationReasons).toContain('action_target_conflict');
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'hello' });
  });

  it('retries a receipt with no normalized target only after an exact WAHA alias arrives', async () => {
    const c = await context(undefined, undefined, 'waha'), original = msg(c);
    const target = { ...original.key, rawId: null, chatAddress: null, direction: null, senderParticipant: null, nativeChatAddress: null, nativeSenderParticipant: null };
    const receipt: NormalizedMessagingEvent = { ...original, kind: 'receipt', target, status: 'read', providerStatus: 3, recipient: PN };
    const held = await persist(receipt, 'pending-alias');
    const created = await persist(original);
    const result = await createCanonicalStore().persist(db, receipt, { receiptKey: 'pending-alias' });
    expect(result).toMatchObject({ outcome: 'duplicate', observationId: held.observationId, messageId: created.messageId, changes: [], allowOperationalEffects: false });
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ status: 'read' });
  });
  it('pages pending recovery with persistent attempts and a fresh store each page', async () => {
    const c = await context();
    for (const raw of ['A', 'B', 'C']) { const base = msg(c, raw); await persist({ ...base, kind: 'receipt', target: base.key, status: 'read', providerStatus: 3, recipient: PN }); }
    const seen: string[] = []; let afterId: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await db.$transaction(tx => createCanonicalStore().recoverPendingInTransaction(tx, c, { limit: 1, afterId }));
      expect(result.results).toHaveLength(1); expect(result.hasMore).toBe(page < 2);
      seen.push(result.results[0]!.actionId!); afterId = result.nextCursor!;
    }
    expect(new Set(seen).size).toBe(3);
    expect(await db.canonicalAction.findMany({ where: { workspaceId: c.workspaceId }, select: { attempts: true, state: true } })).toEqual(Array(3).fill({ attempts: 2, state: 'pending' }));
  });
  it('matches the additive SQL lookup backfill to the shared SHA tuple encoding', async () => {
    const c = await context(undefined, undefined, 'waha'); await persist(msg(c, 'raw_with_underscores'));
    const rows = await db.$queryRaw<Array<{ lookup_hash: string; sql_hash: string }>>`SELECT lookup_hash, encode(sha256(convert_to(concat('[', full_tuple->1, ',', full_tuple->2, ',', full_tuple->3, ',', full_tuple->4, ']'), 'UTF8')), 'hex') AS sql_hash FROM canonical_native_aliases WHERE workspace_id = ${c.workspaceId}`;
    expect(rows).toHaveLength(1); expect(rows[0]!.lookup_hash).toBe(rows[0]!.sql_hash);
  });

  it('preserves per-recipient monotonicity when explicit PN/LID proof unites receipt identities', async () => {
    const c = await context(), original = msg(c, 'A', GROUP, '15550003333@s.whatsapp.net'), created = await persist(original);
    for (const [recipient, status] of [[LID, 'read'], [PN, 'delivered']] as const) await persist({ ...original, kind: 'receipt', target: original.key, status, providerStatus: status, recipient });
    const proof = msg(c, 'PROOF'); proof.addressMappings = [{ role: 'chat', lid: LID, pn: PN, source: 'evolution.remoteJidAlt' }]; await persist(proof);
    await persist({ ...original, kind: 'receipt', target: original.key, status: 'delivered', providerStatus: 'delivered', recipient: PN });
    const receipts = await db.canonicalRecipientReceipt.findMany({ where: { identityId: created.identityId! } });
    expect(receipts).toHaveLength(1); expect(receipts[0]!.status).toBe('read');
    expect(await db.canonicalObservation.count({ where: { identityId: created.identityId!, kind: 'receipt' } })).toBe(3);
  });

  it('keeps receipt pagination separate from content readiness when recovery exceeds 100', async () => {
    const c = await context(), original = msg(c);
    for (let n = 0; n < 101; n++) await persist({ ...original, kind: 'receipt', target: original.key, status: 'read', providerStatus: 3, recipient: PN });
    const result = await persist(original);
    expect(result).toMatchObject({ outcome: 'created', allowOperationalEffects: true });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: result.identityId! } })).toMatchObject({ contentState: 'ready' });
    await db.$transaction(tx => store.recoverPendingInTransaction(tx, c));
    expect(await db.canonicalAction.count({ where: { workspaceId: c.workspaceId, state: 'pending' } })).toBe(0);
  });

  it('drains more than 100 content actions using fresh certified pages and becomes ready only on the last page', async () => {
    expect(store.reconciliationFrontierInTransaction).toBeTypeOf('function');
    const c = await context(), original = msg(c), created = await persist(original);
    for (let n = 0; n < 105; n++) await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, `E${n}`).key, patch: { field: 'body', body: `edit ${n}` } });
    const snapshot = await persist({ ...original, currentRevision: msg(c, 'E104').key, content: { ...original.content, body: 'verified current' } });
    const frontier = await db.$transaction(tx => store.reconciliationFrontierInTransaction(tx, c, original.key));
    expect(frontier.pendingActionIds).toHaveLength(100); expect(frontier.hasMore).toBe(true);
    const request = { observationId: snapshot.observationId, target: original.key, expectedRevisionVersion: frontier.revisionVersion,
      pendingObservationIds: frontier.pendingObservationIds, pendingActionIds: frontier.pendingActionIds, partial: true,
      proof: { source: 'provider_current_revision' as const, requestId: 'fresh-fetch-page-1' } };
    const first = await db.$transaction(tx => store.reconcileSnapshotInTransaction(tx, c, request));
    expect(first).toMatchObject({ outcome: 'held', allowOperationalEffects: false });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'pending_reconciliation' });
    const next = await db.$transaction(tx => createCanonicalStore().reconciliationFrontierInTransaction(tx, c, original.key));
    expect(next.pendingActionIds).toHaveLength(4); expect(next.hasMore).toBe(false);
    const nextRequest = { ...request, expectedRevisionVersion: next.revisionVersion, pendingActionIds: next.pendingActionIds, pendingObservationIds: next.pendingObservationIds };
    await expect(db.$transaction(tx => store.reconcileSnapshotInTransaction(tx, c, nextRequest))).rejects.toThrow('fresh');
    const final = await db.$transaction(tx => store.reconcileSnapshotInTransaction(tx, c, { ...nextRequest, proof: { ...request.proof, requestId: 'fresh-fetch-page-2' } }));
    expect(final.outcome).toBe('enriched');
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'ready' });
    expect(await db.canonicalAction.count({ where: { identityId: created.identityId!, state: 'pending' } })).toBe(0);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'verified current' });
  });

  // This volume fixture persists 101 ingress events plus several bounded cursor
  // transactions; its 15s test deadline does not enlarge the 100-action/transaction budget.
  it('clears the recovery budget gate when the final mirrored content action is replayed', async () => {
    const c = await context(), original = msg(c);
    for (let n = 0; n < 101; n++) await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'E').key, patch: { field: 'body', body: 'updated' } });
    const created = await persist(original);
    expect(created.reconciliationReasons).toContain('pending_recovery_budget_exhausted');
    expect(created.allowOperationalEffects).toBe(false);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'hello' });
    const changes: string[] = []; let afterId: string | undefined, revisit = false;
    for (let page = 0; page < 4; page++) {
      const recovery = await db.$transaction(tx => createCanonicalStore().recoverPendingInTransaction(tx, c, { limit: 100, afterId }));
      changes.push(...recovery.results.flatMap(result => result.changes));
      expect(recovery.results.every(result => !result.allowOperationalEffects)).toBe(true);
      revisit ||= recovery.revisitFromStart;
      if (recovery.hasMore) afterId = recovery.nextCursor!;
      else if (revisit) { afterId = undefined; revisit = false; }
      else break;
    }
    expect(changes).toContain('pending_recovery_completed');
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'ready', revisionVersion: 1 });
    expect(await db.canonicalAction.count({ where: { identityId: created.identityId!, state: 'pending' } })).toBe(0);
  }, 15000);

  it.each([false, true])('does not gate unrelated originals through raw ID/hash buckets (collision=%s)', async (collision) => {
    const c = await context(), isolated = createCanonicalStore(collision ? { hash: () => 'a' } : {});
    const original = msg(c), foreign = msg(c, 'A', '15550009999@s.whatsapp.net');
    const variants = [foreign.key, { ...original.key, direction: 'outbound' as const }, msg(c, 'OTHER').key,
      msg(c, 'A', GROUP, PN).key];
    for (const target of variants) await isolated.persist(db, { ...original, kind: 'revoke', target, action: msg(c, 'DELETE').key }, { receiptKey: randomUUID() });
    const result = await isolated.persist(db, original, { receiptKey: randomUUID() });
    expect(result).toMatchObject({ outcome: 'created', allowOperationalEffects: true, reconciliationReasons: [] });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: result.identityId! } })).toMatchObject({ contentState: 'ready' });
    expect(await db.message.findUnique({ where: { id: result.messageId! } })).toMatchObject({ body: 'hello' });
  });
  it.each([['active_restoration', 1], ['active_restoration', 2], ['late_pn_lid', 1], ['late_pn_lid', 2]] as const)('discovers competing unbound edits across recovery pages after %s with limit %s', async (scenario, limit) => {
    const c = await context(), original = msg(c), created = await persist(original);
    if (scenario === 'active_restoration') await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'review' } });
    for (const raw of ['E1', 'E2']) {
      const target = scenario === 'late_pn_lid' ? msg(c, 'A', LID).key : original.key;
      await persist({ ...original, kind: 'edit', target, action: msg(c, raw, target.chatAddress!).key, patch: { field: 'body', body: raw } });
    }
    expect(await db.canonicalAction.count({ where: { workspaceId: c.workspaceId, identityId: null } })).toBe(2);
    if (scenario === 'active_restoration') await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'active' } });
    else {
      const proof = msg(c, 'PROOF'); proof.addressMappings = [{ role: 'chat', lid: LID, pn: PN, source: 'evolution.remoteJidAlt' }]; await persist(proof);
    }
    let afterId: string | undefined;
    for (let page = 0; page < Math.ceil(2 / limit); page++) {
      const recovered = await db.$transaction(tx => createCanonicalStore().recoverPendingInTransaction(tx, c, { limit, afterId }));
      expect(recovered.results.every(r => !r.changes.includes('message_edited'))).toBe(true);
      expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'hello' });
      afterId = recovered.nextCursor!;
    }
    expect(await db.canonicalAction.count({ where: { identityId: created.identityId!, state: 'pending' } })).toBe(2);
  });
  it.each(['width', 'mimeType', 'fileName', 'durationSeconds', 'location', 'contactCards'] as const)('does not certify unresolved snapshot field %s or partially apply its caption', async (field) => {
    const c = await context(), original = msg(c);
    original.content = { ...original.content, type: 'image', body: 'old caption', mediaUrl: 'https://owned.test/media', location: { latitude: 1, longitude: 2, name: null, address: null, isLive: false }, contactCards: [{ fullName: 'Name', phoneNumber: '123' }] };
    original.attachment = { width: 100, mimeType: 'image/png', fileName: 'original.png', durationSeconds: 1, caption: 'old caption' };
    const created = await persist(original), before = await db.message.findUniqueOrThrow({ where: { id: created.messageId! } });
    await db.message.update({ where: { id: before.id }, data: { metadata: { ...(before.metadata as object), transcription: { status: 'completed', text: 'prepared' }, assistantMedia: { status: 'completed', playbackUrl: 'https://owned.test/play' } } } });
    const snapshot = structuredClone(original); snapshot.attachment.caption = 'new caption'; snapshot.content.body = 'new caption';
    if (field === 'location') snapshot.content.location = { latitude: 9, longitude: 2, name: null, address: null, isLive: false };
    else if (field === 'contactCards') snapshot.content.contactCards = [{ fullName: 'Name', phoneNumber: '999' }];
    else Object.assign(snapshot.attachment, { [field]: field === 'width' ? 200 : field === 'durationSeconds' ? 5 : field === 'mimeType' ? 'image/jpeg' : 'changed.jpg' });
    const held = await persist(snapshot);
    const result = await db.$transaction(tx => store.reconcileSnapshotInTransaction(tx, c, { observationId: held.observationId, target: original.key, expectedRevisionVersion: 0, pendingObservationIds: [held.observationId], proof: { source: 'provider_current_revision', requestId: 'field-proof' } }));
    expect(result).toMatchObject({ outcome: 'held', reconciliationReasons: ['snapshot_field_conflict'], changes: [], allowOperationalEffects: false });
    expect(await db.canonicalObservation.count({ where: { identityId: created.identityId!, kind: 'reconciliation' } })).toBe(0);
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'pending_reconciliation', revisionVersion: 0 });
    expect(await db.canonicalObservation.findUnique({ where: { id: held.observationId } })).toMatchObject({ state: 'held' });
    expect(await db.message.findUnique({ where: { id: before.id } })).toMatchObject({ body: 'old caption', mediaUrl: 'https://owned.test/media', metadata: expect.objectContaining({ attachment: original.attachment, transcription: { status: 'completed', text: 'prepared' }, assistantMedia: { status: 'completed', playbackUrl: 'https://owned.test/play' } }) });
  });

  it('does not gate a group sender or scoped native alias through a colliding target bucket', async () => {
    const c = await context(undefined, undefined, 'waha'), colliding = createCanonicalStore({ hash: () => 'a' });
    const original = msg(c, 'SAME', GROUP, PN), wrongSender = msg(c, 'SAME', GROUP, '15550009999@s.whatsapp.net');
    await colliding.persist(db, { ...wrongSender, kind: 'revoke', target: wrongSender.key, action: msg(c, 'D', GROUP, '15550009999@s.whatsapp.net').key }, { receiptKey: 'wrong-sender' });
    const partial = { ...original.key, rawId: null, chatAddress: null, direction: null, senderParticipant: null, nativeChatAddress: null, nativeSenderParticipant: null };
    await colliding.persist(db, { ...original, context: { ...c, sessionName: 'another-session' }, kind: 'revoke', target: partial, action: original.key }, { receiptKey: 'wrong-session' });
    await colliding.persist(db, { ...original, kind: 'revoke', target: { ...partial, nativeId: 'different-native' }, action: original.key }, { receiptKey: 'wrong-native' });
    const result = await colliding.persist(db, original, { receiptKey: 'original' });
    expect(result).toMatchObject({ outcome: 'created', allowOperationalEffects: true, reconciliationReasons: [] });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: result.identityId! } })).toMatchObject({ contentState: 'ready' });
  });

  it.each([false, true])('bounds action materialization while seeing a conflicting mirror beyond row 100 (conflict=%s)', async (conflict) => {
    const c = await context(), isolated = createCanonicalStore({ hash: () => 'a' }), original = msg(c);
    const created = await isolated.persist(db, original, { receiptKey: 'original' });
    await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'review' } });
    const prefix = randomUUID().slice(0, 24);
    for (let n = 0; n < 103; n++) {
      const result = await isolated.persist(db, { ...original, kind: 'edit', target: original.key, action: msg(c, 'SAME_EDIT').key,
        patch: { field: 'body', body: conflict && n === 102 ? 'conflicting last mirror' : 'identical edit' } }, { receiptKey: `mirror-${n}` });
      await db.canonicalAction.update({ where: { id: result.actionId! }, data: { id: `${prefix}${String(n).padStart(12, '0')}` } });
    }
    await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'active' } });
    const first = await db.$transaction(tx => isolated.recoverPendingInTransaction(tx, c, { limit: 100 }));
    expect(first.hasMore).toBe(true);
    expect(first.results.every(result => !result.changes.includes('message_edited'))).toBe(true);
    const materialized: number[] = [];
    const measured = db.$extends({ query: { canonicalAction: { async findMany({ args, query }) {
      const rows = await query(args); materialized.push(rows.length); return rows;
    } } } });
    const last = await measured.$transaction(tx => isolated.recoverPendingInTransaction(tx as unknown as Prisma.TransactionClient, c, { limit: 3, afterId: first.nextCursor! }));
    // The three-row page must not materialize the 102 historical peers per action.
    expect(materialized.length).toBeGreaterThan(0);
    expect(Math.max(...materialized)).toBeLessThanOrEqual(4);
    expect(materialized.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(12);
    if (conflict) {
      expect(last.results.every(result => result.reconciliationReasons.includes('action_revision_conflict'))).toBe(true);
      expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'hello' });
      expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ revisionVersion: 0, contentState: 'pending_reconciliation' });
    } else {
      expect(last.results.flatMap(result => result.changes).filter(change => change === 'message_edited')).toHaveLength(1);
      expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'identical edit' });
    }
  }, 15000);

  it('compares full action tuples when aggregate buckets collide', async () => {
    const c = await context(), collision = createCanonicalStore({ hash: () => 'a' });
    const first = msg(c, 'FIRST'), second = msg(c, 'SECOND');
    await collision.persist(db, first, { receiptKey: 'first' });
    const created = await collision.persist(db, second, { receiptKey: 'second' });
    await collision.persist(db, { ...first, kind: 'edit', target: first.key, action: msg(c, 'EDIT_FIRST').key, patch: { field: 'body', body: 'other patch' } }, { receiptKey: 'other-action' });
    const result = await collision.persist(db, { ...second, kind: 'edit', target: second.key, action: msg(c, 'EDIT_SECOND').key, patch: { field: 'body', body: 'right patch' } }, { receiptKey: 'right-action' });
    expect(result.changes).toEqual(['message_edited']);
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'right patch' });
  });
  it('does not treat an applied plaintext edit as authenticated decryption of its encrypted mirror', async () => {
    const c = await context(), original = msg(c), created = await persist(original), revision = msg(c, 'EDIT').key;
    await persist({ ...original, kind: 'edit', target: original.key, action: revision, patch: { field: 'body', body: 'plain edit' } });
    const encrypted = { ivBase64: 'aXY=', payloadBase64: 'c2VjcmV0', senderJids: [PN] };
    const event: NormalizedMessagingEvent = { ...original, kind: 'encrypted_edit', target: original.key, action: revision, encrypted };
    const held = await persist(event);
    expect(held.reconciliationReasons).toContain('decrypt_reconciliation_required');
    await db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { actionId: held.actionId!, target: original.key, revision, expectedRevisionVersion: 1, pendingActionIds: [held.actionId!], patch: { field: 'body', body: 'plain edit' }, proof: { source: 'authenticated_decryption', requestId: 'decrypt-same', currentRevisionRequestId: 'current-same', authorAddress: PN, ivBase64: encrypted.ivBase64, payloadBase64: encrypted.payloadBase64 } }));
    const replay = await persist(event);
    expect(replay).toMatchObject({ outcome: 'duplicate', changes: [] });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ revisionVersion: 2 });
    const cipherConflict = await persist({ ...event, encrypted: { ...encrypted, payloadBase64: 'b3RoZXI=' } });
    expect(cipherConflict.reconciliationReasons).toContain('action_revision_conflict');
  });

  it.each([['text', 'same'], ['text', 'different'], ['image', 'same'], ['image', 'different'], ['image', 'field']] as const)('compares certified decrypted %s patch with plaintext mirror (%s)', async (type, variant) => {
    const c = await context(), original = msg(c), revision = msg(c, 'EDIT').key;
    if (type === 'image') { original.content = { type, body: 'original caption', preview: 'original caption', mediaUrl: 'https://owned.test/image' }; original.attachment = { caption: 'original caption', fileName: 'image.png' }; }
    const created = await persist(original), encrypted = { ivBase64: 'aXY=', payloadBase64: 'c2VjcmV0', senderJids: [PN] };
    const cipher = await persist({ ...original, kind: 'encrypted_edit', target: original.key, action: revision, encrypted });
    const patch: MessageEditPatch = type === 'text' ? { field: 'body', body: 'verified decrypted body' } : { field: 'caption', caption: '' };
    await db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { actionId: cipher.actionId!, target: original.key, revision, expectedRevisionVersion: 0, pendingActionIds: [cipher.actionId!], patch, proof: { source: 'authenticated_decryption', requestId: 'decrypt-first', currentRevisionRequestId: 'current-first', authorAddress: PN, ivBase64: encrypted.ivBase64, payloadBase64: encrypted.payloadBase64 } }));
    const before = await db.message.findUniqueOrThrow({ where: { id: created.messageId! } });
    const incoming: MessageEditPatch = variant === 'same' ? patch : variant === 'field' ? { field: 'body', body: '' } : type === 'text' ? { field: 'body', body: 'contradictory plaintext body' } : { field: 'caption', caption: 'contradictory caption' };
    const result = await persist({ ...original, kind: 'edit', target: original.key, action: revision, patch: incoming });
    expect(result).toMatchObject({ outcome: variant === 'same' ? 'duplicate' : 'held', changes: [], allowOperationalEffects: false });
    expect(await db.canonicalAction.findUnique({ where: { id: result.actionId! } })).toMatchObject({ state: variant === 'same' ? 'applied' : 'pending' });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ revisionVersion: 1, contentState: variant === 'same' ? 'ready' : 'pending_reconciliation' });
    const after = await db.message.findUniqueOrThrow({ where: { id: created.messageId! } });
    expect({ body: after.body, metadata: after.metadata, mediaUrl: after.mediaUrl, type: after.type }).toEqual({ body: before.body, metadata: before.metadata, mediaUrl: before.mediaUrl, type: before.type });
  });
  it('does not use superseding a ciphertext as proof for unseen plaintext of that older action', async () => {
    const c = await context(), original = msg(c), created = await persist(original), encrypted = { ivBase64: 'aXY=', payloadBase64: 'c2VjcmV0', senderJids: [PN] };
    const oldEvent: NormalizedMessagingEvent = { ...original, kind: 'encrypted_edit', target: original.key, action: msg(c, 'OLD').key, encrypted };
    const old = await persist(oldEvent, 'known-old'), currentRevision = msg(c, 'CURRENT').key;
    const current = await persist({ ...oldEvent, action: currentRevision });
    await db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { actionId: current.actionId!, target: original.key, revision: currentRevision, expectedRevisionVersion: 0, pendingActionIds: [old.actionId!, current.actionId!], patch: { field: 'body', body: 'certified current' }, proof: { source: 'authenticated_decryption', requestId: 'decrypt-current', currentRevisionRequestId: 'current-fetch', authorAddress: PN, ivBase64: encrypted.ivBase64, payloadBase64: encrypted.payloadBase64 } }));
    expect((await persist(oldEvent, 'known-old')).outcome).toBe('duplicate');
    expect((await persist(oldEvent, 'known-old-new-ingress')).outcome).toBe('duplicate');
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'ready' });
    const unseen = await persist({ ...original, kind: 'edit', target: original.key, action: oldEvent.action, patch: { field: 'body', body: 'unverified old bytes' } });
    expect(unseen.outcome).toBe('held');
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'pending_reconciliation', revisionVersion: 1 });
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'certified current' });
  });

  it('keeps an exact resolved plaintext replay inert after verified decryption supersedes its content', async () => {
    const c = await context(), original = msg(c), created = await persist(original), revision = msg(c, 'EDIT').key;
    const plain: NormalizedMessagingEvent = { ...original, kind: 'edit', target: original.key, action: revision, patch: { field: 'body', body: 'previous plaintext' } };
    await persist(plain, 'plain-receipt');
    const encrypted = { ivBase64: 'aXY=', payloadBase64: 'c2VjcmV0', senderJids: [PN] };
    const cipher = await persist({ ...original, kind: 'encrypted_edit', target: original.key, action: revision, encrypted });
    expect(cipher.outcome).toBe('held');
    await db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { actionId: cipher.actionId!, target: original.key, revision, expectedRevisionVersion: 1, pendingActionIds: [cipher.actionId!], patch: { field: 'body', body: 'verified current bytes' }, proof: { source: 'authenticated_decryption', requestId: 'verified-new', currentRevisionRequestId: 'verified-current', authorAddress: PN, ivBase64: encrypted.ivBase64, payloadBase64: encrypted.payloadBase64 } }));
    expect((await persist(plain, 'plain-receipt')).outcome).toBe('duplicate');
    expect((await persist(plain, 'new-ingress-known-plain')).outcome).toBe('duplicate');
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'verified current bytes' });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'ready', revisionVersion: 2 });
  });
  it('checks a mixed mirror against its own certified action after a newer snapshot wins', async () => {
    const c = await context(), original = msg(c), created = await persist(original), revision = msg(c, 'OLD').key;
    const encrypted = { ivBase64: 'aXY=', payloadBase64: 'c2VjcmV0', senderJids: [PN] };
    const cipher = await persist({ ...original, kind: 'encrypted_edit', target: original.key, action: revision, encrypted });
    await db.$transaction(tx => store.reconcileRevisionInTransaction(tx, c, { actionId: cipher.actionId!, target: original.key, revision, expectedRevisionVersion: 0, pendingActionIds: [cipher.actionId!], patch: { field: 'body', body: 'verified old' }, proof: { source: 'authenticated_decryption', requestId: 'verified-old', currentRevisionRequestId: 'old-current', authorAddress: PN, ivBase64: encrypted.ivBase64, payloadBase64: encrypted.payloadBase64 } }));
    const snapshot = await persist({ ...original, currentRevision: msg(c, 'NEW').key, content: { ...original.content, body: 'new snapshot body' } });
    await db.$transaction(tx => store.reconcileSnapshotInTransaction(tx, c, { observationId: snapshot.observationId, target: original.key, expectedRevisionVersion: 1, pendingObservationIds: [snapshot.observationId], proof: { source: 'provider_current_revision', requestId: 'new-snapshot' } }));
    const oldMirror = await persist({ ...original, kind: 'edit', target: original.key, action: revision, patch: { field: 'body', body: 'verified old' } });
    expect(oldMirror).toMatchObject({ outcome: 'duplicate', changes: [], reconciliationReasons: [] });
    expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ body: 'new snapshot body' });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'ready', revisionVersion: 2 });
  });

  it.each([
    ['chat', 'applied', 'replay'], ['chat', 'applied', 'reuse'], ['chat', 'superseded', 'replay'], ['chat', 'superseded', 'reuse'],
    ['sender', 'applied', 'replay'], ['sender', 'applied', 'reuse'], ['sender', 'superseded', 'replay'], ['sender', 'superseded', 'reuse']
  ] as const)('preserves action identity after deterministic %s root change (%s/%s)', async (root, state, attempt) => {
    const c = await context(), scoped = { workspaceId: c.workspaceId, channelId: c.channelId }, collision = createCanonicalStore({ hash: () => 'a' });
    const suffix = randomUUID().slice(8), pnId = `00000000${suffix}`, lidId = `ffffffff${suffix}`;
    await db.canonicalAddress.createMany({ data: [{ ...scoped, id: pnId }, { ...scoped, id: lidId }] });
    await db.canonicalAddressAlias.createMany({ data: [{ ...scoped, addressId: pnId, address: PN }, { ...scoped, addressId: lidId, address: LID }] });
    const original = root === 'chat' ? msg(c, 'A', LID) : msg(c, 'A', GROUP, LID);
    const created = await collision.persist(db, original, { receiptKey: 'original' });
    const edit: NormalizedMessagingEvent = { ...original, kind: 'edit', target: original.key, action: (root === 'chat' ? msg(c, 'E', LID) : msg(c, 'E', GROUP, LID)).key, patch: { field: 'body', body: 'edit E' } };
    if (state === 'superseded') await collision.persist(db, { ...edit, action: { ...edit.action, rawId: 'BASE', nativeId: 'BASE' }, patch: { field: 'body', body: 'base edit' } }, { receiptKey: 'base-edit' });
    const action = await collision.persist(db, edit, { receiptKey: 'edit' });
    if (state === 'superseded') {
      const currentRevision = { ...edit.action, rawId: 'CURRENT', nativeId: 'CURRENT' };
      const snapshot = await collision.persist(db, { ...original, currentRevision, content: { ...original.content, body: 'certified newer body' } }, { receiptKey: 'snapshot' });
      await db.$transaction(tx => collision.reconcileSnapshotInTransaction(tx, c, { observationId: snapshot.observationId, target: original.key, expectedRevisionVersion: 1, pendingObservationIds: [snapshot.observationId], pendingActionIds: [action.actionId!], proof: { source: 'provider_current_revision', requestId: 'newer-before-union' } }));
    }
    const before = await db.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: created.identityId! } });
    const provenance = await db.canonicalObservation.findUniqueOrThrow({ where: { id: action.observationId } });
    const nextOriginal = root === 'chat' ? msg(c, 'A', PN) : msg(c, 'A', GROUP, PN);
    const proof = root === 'chat' ? msg(c, 'PROOF', PN) : msg(c, 'PROOF', GROUP, PN);
    proof.addressMappings = [{ role: root, lid: LID, pn: PN, source: root === 'chat' ? 'evolution.remoteJidAlt' : 'evolution.participantAlt' }];
    await collision.persist(db, proof, { receiptKey: 'proof' });
    const after = await db.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: created.identityId! } });
    expect((after.fullTuple as string[])[root === 'chat' ? 2 : 7]).not.toBe((before.fullTuple as string[])[root === 'chat' ? 2 : 7]);
    const target = attempt === 'replay' ? nextOriginal : root === 'chat' ? msg(c, 'B', PN) : msg(c, 'B', GROUP, PN);
    let targetId = created.messageId!;
    if (attempt === 'reuse') targetId = (await collision.persist(db, target, { receiptKey: 'second-original' })).messageId!;
    const result = await collision.persist(db, { ...edit, target: target.key, action: (root === 'chat' ? msg(c, 'E', PN) : msg(c, 'E', GROUP, PN)).key }, { receiptKey: 'fresh-ingress' });
    if (attempt === 'replay') expect(result).toMatchObject({ outcome: 'duplicate', changes: [], reconciliationReasons: [] });
    else expect(result.reconciliationReasons).toContain('action_target_conflict');
    expect(await db.message.findUnique({ where: { id: targetId } })).toMatchObject({ body: attempt === 'reuse' ? 'hello' : state === 'applied' ? 'edit E' : 'certified newer body' });
    expect(after.messageId).toBe(created.messageId);
    expect((await db.canonicalObservation.findUniqueOrThrow({ where: { id: action.observationId } })).payload).toEqual(provenance.payload);
  });
  it('becomes ready after restored-authority recovery drains mirrors without an original budget observation', async () => {
    const c = await context(), original = msg(c), created = await persist(original);
    await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'review' } });
    for (let n = 0; n < 101; n++) await persist({ ...original, kind: 'edit', target: original.key, action: msg(c, 'EDIT').key, patch: { field: 'body', body: 'one edit' } });
    await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'active' } });
    expect(await db.canonicalObservation.count({ where: { identityId: created.identityId!, kind: 'message', state: 'held' } })).toBe(0);
    let afterId: string | undefined, revisit = false; const changes: string[] = [];
    for (let page = 0; page < 4; page++) {
      const result = await db.$transaction(tx => createCanonicalStore().recoverPendingInTransaction(tx, c, { limit: 100, afterId }));
      expect(result.results.every(r => !r.allowOperationalEffects)).toBe(true);
      changes.push(...result.results.flatMap(r => r.changes)); revisit ||= result.revisitFromStart;
      if (result.hasMore) afterId = result.nextCursor!;
      else if (revisit) { afterId = undefined; revisit = false; }
      else break;
    }
    expect(await db.canonicalAction.count({ where: { identityId: created.identityId!, state: 'pending' } })).toBe(0);
    expect(await db.$transaction(tx => store.reconciliationFrontierInTransaction(tx, c, original.key))).toMatchObject({ pendingActionIds: [], pendingObservationIds: [], unresolvedTargets: 0, hasMore: false });
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: 'ready', revisionVersion: 1 });
    expect(changes.filter(change => change === 'message_edited')).toHaveLength(1);
    expect(changes.filter(change => change === 'pending_recovery_completed')).toHaveLength(1);
  }, 15000);

  it('backfills stable action lookup with exact Node serialization, including spaces and quotes', async () => {
    const c = await context(), original = msg(c); await persist(original);
    const edit: NormalizedMessagingEvent = { ...original, kind: 'edit', target: original.key, action: msg(c, 'EDIT with_space "quote"').key, patch: { field: 'body', body: 'edited' } };
    const applied = await persist(edit), before = await db.canonicalAction.findUniqueOrThrow({ where: { id: applied.actionId! } });
    const migration = await readFile(new URL('../../../prisma/migrations/20260930020000_canonical_action_stable_lookup/migration.sql', import.meta.url), 'utf8');
    const update = migration.slice(migration.indexOf('UPDATE "canonical_actions"')).replace(/;\s*$/, ' AND "workspace_id" = $1;');
    await db.$transaction(async tx => {
      await tx.canonicalAction.update({ where: { id: applied.actionId! }, data: { actionLookupHash: null } });
      await tx.$executeRawUnsafe(update, c.workspaceId);
      expect((await tx.canonicalAction.findUniqueOrThrow({ where: { id: applied.actionId! } })).actionLookupHash).toBe(before.actionLookupHash);
    });
    expect((await persist(edit)).outcome).toBe('duplicate');
    const second = msg(c, 'SECOND'); await persist(second);
    expect((await persist({ ...edit, target: second.key })).reconciliationReasons).toContain('action_target_conflict');
  });
  it.each(['snapshot', 'receipt_conflict', 'deleted'] as const)('does not clear the %s gate after unrelated pending receipts drain', async (gate) => {
    const c = await context(), original = msg(c), created = await persist(original);
    const receipt: NormalizedMessagingEvent = { ...original, kind: 'receipt', target: original.key, status: 'read', providerStatus: 'read', recipient: PN };
    if (gate === 'snapshot') await persist({ ...original, content: { ...original.content, body: 'disputed snapshot' } });
    else if (gate === 'receipt_conflict') { await persist(receipt, 'conflicting-receipt'); await persist({ ...receipt, status: 'delivered', providerStatus: 'delivered' }, 'conflicting-receipt'); }
    else await persist({ ...original, kind: 'revoke', target: original.key, action: msg(c, 'DELETE').key });
    await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'review' } });
    await persist(receipt, 'pending-receipt');
    await db.canonicalMessageIdentity.update({ where: { id: created.identityId! }, data: { state: 'active' } });
    const result = await db.$transaction(tx => createCanonicalStore().recoverPendingInTransaction(tx, c));
    expect(result.results.every(r => !r.allowOperationalEffects && !r.changes.includes('pending_recovery_completed'))).toBe(true);
    expect(await db.canonicalMessageIdentity.findUnique({ where: { id: created.identityId! } })).toMatchObject({ contentState: gate === 'deleted' ? 'deleted' : 'pending_reconciliation' });
  });

});
