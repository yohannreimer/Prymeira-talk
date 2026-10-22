import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { IngressPrivateStore } from '../ingress/private-store.js';
import { normalizeReceipt } from '../ingress/normalization.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
import { prepareCtwaReceipt } from './ctwa-receipt-import.js';

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ctwa-receipt-unit-'))); roots.push(root);
  const files = new IngressPrivateStore(root); await files.initialize();
  const workspaceId = 'synthetic-workspace', channelId = randomUUID(), connectionId = randomUUID(), receiptId = randomUUID();
  const source: TrustedMessagingContext = { workspaceId, channelId, connectionId, sessionName: 'synthetic-session',
    provider: 'waha', channelProvider: 'evolution', lifecycleGeneration: 0, mode: 'live', observedAt: '2026-10-01T00:00:00.000Z' };
  const raw = { event: 'message.any', session: source.sessionName, payload: { id: 'false_5500000000000@c.us_SYNTHETIC',
    from: '5500000000000@c.us', fromMe: false, timestamp: 1790800000, body: 'synthetic private body',
    _data: { Message: { extendedTextMessage: { contextInfo: { externalAdReply: { ctwaClid: 'Synthetic-Private-Click' } } } } } } };
  const payload = normalizeReceipt(source, raw);
  if (payload.events[0]?.kind !== 'accepted' || payload.events[0].event.kind !== 'message') throw new Error('Invalid fixture');
  const key = payload.events[0].event.key;
  delete payload.events[0].event.ctwa; // Pre-feature normalized blob.
  const rawBlob = await files.put(Buffer.from(JSON.stringify(raw))), eventBlob = await files.put(Buffer.from(JSON.stringify(payload)));
  const receipt = { id: receiptId, workspaceId, channelId, source: { ...source, acceptedFacts: {} }, authentication: 'waha_raw_hmac_sha512',
    stageVersion: 1, authenticatedDigest: 'a'.repeat(64), rawRef: rawBlob.ref, rawDigest: rawBlob.digest,
    eventRef: eventBlob.ref, eventDigest: eventBlob.digest, eventCount: 1 };
  const progress = { workspaceId, channelId, receiptId, eventIndex: 0, state: 'applied', messageId: randomUUID(), conversationId: randomUUID(), observationId: randomUUID() };
  const observation = { identityId: randomUUID(), payload: { kind: 'message', key },
    receiptTuple: ['waha', connectionId, source.sessionName, 'message.any', 'ingress', `${receiptId}:0`] };
  const identity = { rawId: key.rawId, identityFormat: key.identityFormat };
  const message = { id: progress.messageId, conversationId: progress.conversationId };
  const attribution = { id: randomUUID(), workspaceId, channelId, messageId: message.id, conversationId: message.conversationId,
    ctwaClid: 'Synthetic-Private-Click', sourceMode: 'recovered_live' };
  const createAttribution = vi.fn(async () => attribution), createEvent = vi.fn(async () => ({}));
  const tx = { $queryRaw: vi.fn(async () => [{ isolation: 'read committed' }]), $executeRaw: vi.fn(async () => 1),
    ingressReceipt: { findUnique: vi.fn(async () => receipt) }, ingressEventProgress: { findUnique: vi.fn(async () => progress) },
    canonicalObservation: { findFirst: vi.fn(async () => observation) }, canonicalMessageIdentity: { findFirst: vi.fn(async () => identity) },
    message: { findFirst: vi.fn(async () => message) },
    ctwaAttribution: { findUnique: vi.fn(async (): Promise<typeof attribution | null> => null),
      findFirst: vi.fn(async (): Promise<typeof attribution | null> => null), create: createAttribution },
    ctwaConversionEvent: { findUnique: vi.fn(async (): Promise<any> => null), create: createEvent } };
  const db = { ingressReceipt: { findFirst: vi.fn(async () => receipt) }, $transaction: vi.fn(async (work: any) => work(tx)) };
  const input = { workspaceId, receiptId, eventIndex: 0 };
  const run = (apply = false) => prepareCtwaReceipt(db as any, files, { ...input, apply });
  const rewritePayload = async () => { const blob = await files.put(Buffer.from(JSON.stringify(payload))); receipt.eventRef = blob.ref; receipt.eventDigest = blob.digest; };
  const rewriteRaw = async () => { const blob = await files.put(Buffer.from(JSON.stringify(raw))); receipt.rawRef = blob.ref; receipt.rawDigest = blob.digest; };
  return { files, raw, payload, receipt, progress, observation, identity, attribution, tx, db, input, run, rewritePayload, rewriteRaw, createAttribution, createEvent };
}
describe('bounded immutable receipt CTWA import', () => {
  it('dry run verifies both blobs and writes no attribution, conversion, message, progress or effect', async () => {
    const f = await fixture(); const result = await f.run();
    expect(result).toMatchObject({ apply: false, wouldCreateAttribution: true, wouldCreateEvent: true });
    expect(f.createAttribution).not.toHaveBeenCalled(); expect(f.createEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/Synthetic-Private|synthetic private body|ctwaClid|550000/);
  });
  it.each(['rawDigest', 'eventDigest'] as const)('refuses invalid %s before transaction', async field => {
    const f = await fixture(); f.receipt[field] = 'b'.repeat(64);
    await expect(f.run(true)).rejects.toThrow('invalid_receipt_blobs'); expect(f.db.$transaction).not.toHaveBeenCalled();
  });
  it('reports the committed state after first apply, with no work remaining in the preview', async () => {
    const f = await fixture();
    expect(await f.run(true)).toMatchObject({ apply: true, attributionExists: true, eventExists: true,
      wouldCreateAttribution: false, wouldCreateEvent: false, state: 'pending_validation' });
    expect(f.createAttribution).toHaveBeenCalledTimes(1); expect(f.createEvent).toHaveBeenCalledTimes(1);
  });
  it.each(['authentication', 'workspace', 'channel', 'mode', 'connection', 'observedAt'] as const)('refuses invalid source %s', async field => {
    const f = await fixture();
    if (field === 'authentication') f.receipt.authentication = 'unverified';
    else Object.assign(f.receipt.source, { [({ workspace: 'workspaceId', channel: 'channelId', mode: 'mode', connection: 'connectionId', observedAt: 'observedAt' } as const)[field]]: 'invalid' });
    await expect(f.run(true)).rejects.toThrow('invalid_receipt_source'); expect(f.createEvent).not.toHaveBeenCalled();
  });
  it('refuses a forged normalized key even though its blob has a valid digest', async () => {
    const f = await fixture(); (f.payload.events[0] as any).event.key.rawId = 'FORGED'; await f.rewritePayload();
    await expect(f.run(true)).rejects.toThrow('native_key_mismatch'); expect(f.db.$transaction).not.toHaveBeenCalled();
  });
  it('refuses contradictory original native direction and original session mismatch', async () => {
    const f = await fixture(); f.raw.payload.fromMe = true; await f.rewriteRaw();
    await expect(f.run(true)).rejects.toThrow('invalid_native_declarations'); expect(f.db.$transaction).not.toHaveBeenCalled();
    const g = await fixture(); g.raw.session = 'different-session'; await g.rewriteRaw();
    await expect(g.run(true)).rejects.toThrow('native_session_mismatch'); expect(g.createEvent).not.toHaveBeenCalled();
  });
  it('refuses a nonaccepted original normalized event and an out-of-range event index', async () => {
    const f = await fixture(); f.payload.events[0] = { kind: 'invalid', reason: 'synthetic invalid' }; await f.rewritePayload();
    await expect(f.run(true)).rejects.toThrow('invalid_stored_event');
    const g = await fixture(); g.input.eventIndex = 1;
    await expect(g.run(true)).rejects.toThrow('invalid_event_index'); expect(g.createEvent).not.toHaveBeenCalled();
  });
  it.each(['held', 'pending_recertification', 'ignored'])('refuses %s progress', async state => {
    const f = await fixture(); f.progress.state = state;
    await expect(f.run(true)).rejects.toThrow('event_not_applied'); expect(f.createEvent).not.toHaveBeenCalled();
  });
  it('refuses a different canonical native key and a missing/reset message', async () => {
    const f = await fixture(); f.observation.payload.key = { ...f.observation.payload.key, rawId: 'OTHER' };
    await expect(f.run(true)).rejects.toThrow('canonical_key_mismatch');
    const g = await fixture(); g.tx.message.findFirst.mockResolvedValue(null as any);
    await expect(g.run(true)).rejects.toThrow('message_not_eligible'); expect(g.createEvent).not.toHaveBeenCalled();
  });
  it('only this explicit command prepares an exact-scope existing passive attribution; existing event is immutable', async () => {
    const f = await fixture(); f.tx.ctwaAttribution.findUnique.mockResolvedValue(f.attribution);
    await f.run(true); expect(f.createAttribution).not.toHaveBeenCalled(); expect(f.createEvent).toHaveBeenCalledTimes(1);
    expect(f.createEvent.mock.calls[0]).toBeDefined();
    for (const state of ['sending', 'unknown', 'accepted', 'failed']) {
      f.createEvent.mockClear(); f.tx.ctwaConversionEvent.findUnique.mockResolvedValue({ state, eventTime: new Date('2026-09-01T00:00:00Z'), attemptCount: 4 });
      expect(await f.run(true)).toMatchObject({ state, eventTime: '2026-09-01T00:00:00.000Z' });
      expect(f.createEvent).not.toHaveBeenCalled();
    }
  });
  it('refuses click reparenting and a changed immutable SQL receipt', async () => {
    const f = await fixture(); f.tx.ctwaAttribution.findUnique.mockResolvedValue({ ...f.attribution, messageId: randomUUID() });
    await expect(f.run(true)).rejects.toThrow('click_scope_conflict'); expect(f.createEvent).not.toHaveBeenCalled();
    const g = await fixture(); g.tx.ingressReceipt.findUnique.mockResolvedValue({ ...g.receipt, rawDigest: 'b'.repeat(64) });
    await expect(g.run(true)).rejects.toThrow('receipt_changed');
  });
  it('refuses different-click metadata already attached to the same canonical message', async () => {
    const f = await fixture();
    f.tx.ctwaAttribution.findFirst.mockResolvedValue({ ...f.attribution, ctwaClid: 'Synthetic-Other-Click' });
    await expect(f.run(true)).rejects.toThrow('message_click_conflict');
    expect(f.createAttribution).not.toHaveBeenCalled(); expect(f.createEvent).not.toHaveBeenCalled();
  });
});
