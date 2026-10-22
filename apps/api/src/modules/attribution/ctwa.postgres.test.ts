import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { IngressJournal } from '../ingress/journal.js';
import { IngressPrivateStore } from '../ingress/private-store.js';
import { IngressApplicationService } from '../ingress/application.js';
import { normalizeReceipt } from '../ingress/normalization.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
import { prepareCtwaReceipt } from './ctwa-receipt-import.js';
import { createCtwaService, captureCtwaInTransaction } from './ctwa-service.js';
const url = process.env.CTWA_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgresql:' || parsed.hostname !== '127.0.0.1' || !parsed.port || !['/talk_ctwa_test', '/messaging_test'].includes(parsed.pathname)) throw new Error('Refusing non-disposable CTWA test database');
}
describe.skipIf(!url)('CTWA disposable PostgreSQL persistence, ingress and claims', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused/unused' } } });
  const workspaceId = `ctwa-synthetic-${randomUUID()}`, otherWorkspaceId = `ctwa-synthetic-${randomUUID()}`;
  let root: string, journal: IngressJournal, application: IngressApplicationService, channelId: string, evolutionId: string, wahaId: string;
  const peer = '5500000000000@s.whatsapp.net', phone = '5500000000001';
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'talk-ctwa-')));
    const files = new IngressPrivateStore(root); await files.initialize(); journal = new IngressJournal(db, files); application = new IngressApplicationService(journal);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID(), verifiedMessagingPhoneNumber: phone } }); channelId = channel.id;
    evolutionId = (await db.channelConnection.create({ data: { workspaceId, channelId, provider: 'evolution', sessionName: randomUUID(), verifiedPhoneNumber: phone, status: 'connected', eligible: true, lastHealthyAt: new Date() } })).id;
    wahaId = (await db.channelConnection.create({ data: { workspaceId, channelId, provider: 'waha', sessionName: randomUUID(), verifiedPhoneNumber: phone, status: 'connected', eligible: true, lastHealthyAt: new Date() } })).id;
  });
  afterAll(async () => {
    await db.ingressReceipt.deleteMany({ where: { workspaceId } });
    await db.channel.deleteMany({ where: { workspaceId } });
    await db.contact.deleteMany({ where: { workspaceId } });
    await db.workspaceMirror.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
    await db.$disconnect(); if (root) await rm(root, { recursive: true, force: true });
  });
  async function ingest(provider: 'evolution' | 'waha', stanza: string, click?: string, mode: 'live' | 'history' | 'recovered_live' = 'live', preCtwa = false, providerEventId?: string) {
    const connection = await db.channelConnection.findUniqueOrThrow({ where: { id: provider === 'waha' ? wahaId : evolutionId } });
    const source = { workspaceId, channelId, provider, channelProvider: 'evolution', connectionId: connection.id, lifecycleGeneration: connection.lifecycleGeneration, sessionName: connection.sessionName, mode, observedAt: new Date().toISOString() } as TrustedMessagingContext;
    const raw = provider === 'evolution' ? { event: 'messages.upsert', instance: source.sessionName, data: { key: { id: stanza, remoteJid: peer, fromMe: false }, message: { conversation: 'synthetic owned fixture' }, messageTimestamp: 1792400000 } }
      : { event: 'message.any', session: source.sessionName, payload: { id: `false_${peer}_${stanza}`, from: peer, fromMe: false, body: 'synthetic owned fixture', timestamp: 1792400000, _data: { Info: { Chat: peer, Sender: peer, IsFromMe: false, IsGroup: false, ID: stanza }, Message: { extendedTextMessage: { text: 'synthetic owned fixture', ...(click ? { contextInfo: { externalAdReply: { ctwaClid: click, sourceID: '123' } } } : {}) } } } } };
    if (providerEventId) Object.assign(raw, { id: providerEventId });
    const payload = normalizeReceipt(source, raw);
    if (preCtwa && payload.events[0]?.kind === 'accepted' && payload.events[0].event.kind === 'message') delete payload.events[0].event.ctwa;
    expect(payload.events[0]?.kind).toBe('accepted');
    const receipt = await journal.stage({ source, raw: Buffer.from(JSON.stringify(raw)), payload, transportNamespace: 'talk.isolated.ctwa_test', authentication: provider === 'waha' ? 'waha_raw_hmac_sha512' : 'evolution_constant_time_secret', reauthenticate: async () => {} });
    await application.apply(receipt.id);
    return db.ingressEventProgress.findUniqueOrThrow({ where: { receiptId_eventIndex: { receiptId: receipt.id, eventIndex: 0 } } });
  }
  it('captures a WAHA duplicate after Evolution first persisted the canonical message, once', async () => {
    // Workspace mirrors are optional and unrelated to canonical messaging lock order.
    expect(await db.workspaceMirror.findUnique({ where: { workspaceId } })).toBeNull();
    const first = await ingest('evolution', 'CROSS-PROVIDER');
    const second = await ingest('waha', 'CROSS-PROVIDER', 'Synthetic-Click-1');
    expect(await db.workspaceMirror.findUnique({ where: { workspaceId } })).toBeNull();
    expect(second.state).toBe('applied'); expect(second.messageId).toBe(first.messageId);
    await ingest('waha', 'CROSS-PROVIDER', 'Synthetic-Click-1');
    const attrs = await db.ctwaAttribution.findMany({ where: { workspaceId } }); expect(attrs).toHaveLength(1);
    expect(attrs[0]).toMatchObject({ messageId: first.messageId, conversationId: first.conversationId, sourceMode: 'live', adId: '123' });
    const events = await db.ctwaConversionEvent.findMany({ where: { workspaceId } }); expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ eventName: 'LeadSubmitted', state: 'pending_validation', eventTime: new Date(1792400000000) });
  });
  it.each(['history', 'recovered_live'] as const)('captures %s passively and creates no conversion', async mode => {
    await ingest('waha', `PASSIVE-${mode}`, `Synthetic-${mode}`, mode);
    const attribution = await db.ctwaAttribution.findUniqueOrThrow({ where: { workspaceId_channelId_clickHash: { workspaceId, channelId, clickHash: (await import('./ctwa-payload.js')).hash(`Synthetic-${mode}`) } } });
    expect(await db.ctwaConversionEvent.count({ where: { workspaceId, attributionId: attribution.id } })).toBe(0);
  });
  it('enforces tenant FKs, manual event idempotence/order conflicts and bounded read privacy', async () => {
    const attribution = await db.ctwaAttribution.findFirstOrThrow({ where: { workspaceId, sourceMode: 'live' } });
    await expect(db.ctwaAttribution.create({ data: { workspaceId: otherWorkspaceId, channelId, conversationId: attribution.conversationId, messageId: attribution.messageId, ctwaClid: 'cross-tenant', clickHash: 'x', sourceMode: 'live' } })).rejects.toThrow();
    const service = createCtwaService(db);
    await expect(service.prepare(otherWorkspaceId, attribution.id, 'QualifiedLead')).rejects.toThrow('not_found');
    const qualified = await Promise.all([service.prepare(workspaceId, attribution.id, 'QualifiedLead'), service.prepare(workspaceId, attribution.id, 'QualifiedLead')]); expect(qualified[0]!.id).toBe(qualified[1]!.id);
    const purchase = { orderId: 'synthetic-order-1', value: 100, currency: 'BRL' };
    expect((await service.prepare(workspaceId, attribution.id, 'Purchase', purchase)).id).toBe((await service.prepare(workspaceId, attribution.id, 'Purchase', purchase)).id);
    await expect(service.prepare(workspaceId, attribution.id, 'Purchase', { ...purchase, value: 200 })).rejects.toThrow('order_conflict');
    const passive = await db.ctwaAttribution.findFirstOrThrow({ where: { workspaceId, sourceMode: 'history' } });
    await expect(service.prepare(workspaceId, passive.id, 'Purchase', purchase)).rejects.toThrow('order_conflict');
    await service.prepare(workspaceId, attribution.id, 'Purchase', { ...purchase, orderId: 'synthetic-order-2' });
    const read = await service.list(workspaceId, { limit: 1 }); expect(read).toHaveLength(1); expect(JSON.stringify(read)).not.toMatch(/ctwaClid|Synthetic-Click|synthetic owned fixture|accessToken/);
    expect(await service.list(otherWorkspaceId)).toEqual([]);
  });
  it('real SQL claim allows only one sender and fences network uncertainty', async () => {
    const attribution = await db.ctwaAttribution.findFirstOrThrow({ where: { workspaceId, sourceMode: 'live' } });
    const event = await db.ctwaConversionEvent.findFirstOrThrow({ where: { workspaceId, attributionId: attribution.id, eventName: 'LeadSubmitted' } });
    const fetch = vi.fn(async () => { throw new Error('synthetic connection reset'); });
    const service = createCtwaService(db, { secret: JSON.stringify({ [workspaceId]: { datasetId: '123', whatsappBusinessAccountId: '456', accessToken: 'synthetic-secret', enabled: true } }), fetch });
    await Promise.allSettled([service.dispatch(workspaceId, event.id), service.dispatch(workspaceId, event.id)]);
    expect(fetch).toHaveBeenCalledTimes(1); expect((await db.ctwaConversionEvent.findUniqueOrThrow({ where: { id: event.id } })).state).toBe('unknown');
    await expect(service.dispatch(workspaceId, event.id)).rejects.toThrow('not_dispatchable'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('optional persistence error rolls back its savepoint while canonical transaction remains writable', async () => {
    const attribution = await db.ctwaAttribution.findFirstOrThrow({ where: { workspaceId } });
    await db.$transaction(async tx => {
      await captureCtwaInTransaction(tx, { kind: 'message', ctwa: { ctwaClid: 'Synthetic-bad-fk' }, context: { workspaceId, channelId, provider: 'waha', mode: 'live' }, key: { direction: 'inbound', chatAddress: peer } } as any, { outcome: 'duplicate', messageId: randomUUID(), conversationId: attribution.conversationId } as any);
      await tx.channel.update({ where: { id: channelId }, data: { displayName: 'synthetic transaction survived' } });
    });
    expect((await db.channel.findUniqueOrThrow({ where: { id: channelId } })).displayName).toBe('synthetic transaction survived');
  });
  it('imports original live receipt without replay, preserves original time and existing states, and serializes concurrent repeats', async () => {
    const progress = await ingest('waha', 'PRE-DEPLOYMENT', 'Synthetic-Pre-Deployment', 'live', true);
    const input = { workspaceId, receiptId: progress.receiptId, eventIndex: 0 };
    const before = { messages: await db.message.count({ where: { workspaceId } }), effects: await db.ingressEffect.count({ where: { workspaceId } }),
      attributes: await db.ctwaAttribution.count({ where: { workspaceId } }), events: await db.ctwaConversionEvent.count({ where: { workspaceId } }) };
    const dry = await prepareCtwaReceipt(db, journal.files, input);
    expect(dry).toMatchObject({ apply: false, wouldCreateAttribution: true, wouldCreateEvent: true, eventTime: new Date(1792400000000).toISOString() });
    expect(await db.ctwaAttribution.count({ where: { workspaceId } })).toBe(before.attributes);
    expect(await db.ctwaConversionEvent.count({ where: { workspaceId } })).toBe(before.events);
    // Only historical proof matters; a new physical lifecycle cannot invalidate it.
    await db.channelConnection.update({ where: { id: wahaId }, data: { lifecycleGeneration: { increment: 2 } } });
    await Promise.all([prepareCtwaReceipt(db, journal.files, { ...input, apply: true }), prepareCtwaReceipt(db, journal.files, { ...input, apply: true })]);
    const attribution = await db.ctwaAttribution.findFirstOrThrow({ where: { workspaceId, messageId: progress.messageId! } });
    const events = await db.ctwaConversionEvent.findMany({ where: { attributionId: attribution.id } });
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ state: 'pending_validation', eventTime: new Date(1792400000000), attemptCount: 0 });
    for (const state of ['sending', 'unknown', 'accepted', 'failed']) {
      await db.ctwaConversionEvent.update({ where: { id: events[0]!.id }, data: { state, attemptCount: 3 } });
      await prepareCtwaReceipt(db, journal.files, { ...input, apply: true });
      expect(await db.ctwaConversionEvent.findUniqueOrThrow({ where: { id: events[0]!.id } })).toMatchObject({ state, attemptCount: 3, eventTime: new Date(1792400000000) });
    }
    expect(await db.message.count({ where: { workspaceId } })).toBe(before.messages);
    expect(await db.ingressEffect.count({ where: { workspaceId } })).toBe(before.effects);
    await expect(prepareCtwaReceipt(db, journal.files, { ...input, workspaceId: otherWorkspaceId, apply: true })).rejects.toThrow('receipt_not_found');
    await db.message.update({ where: { id: progress.messageId! }, data: { hiddenByReset: true } });
    await expect(prepareCtwaReceipt(db, journal.files, { ...input, apply: true })).rejects.toThrow('message_not_eligible');
  });
  it('refuses a click already linked to another message and never promotes passive ingress automatically', async () => {
    const first = await ingest('waha', 'IMPORT-CONFLICT-FIRST', 'Synthetic-Import-Conflict');
    const second = await ingest('waha', 'IMPORT-CONFLICT-SECOND', 'Synthetic-Import-Conflict', 'live', true);
    await expect(prepareCtwaReceipt(db, journal.files, { workspaceId, receiptId: second.receiptId, eventIndex: 0, apply: true })).rejects.toThrow('click_scope_conflict');
    expect(await db.ctwaAttribution.count({ where: { workspaceId, messageId: second.messageId! } })).toBe(0);
    const passive = await ingest('waha', 'IMPORT-PASSIVE', 'Synthetic-Import-Passive', 'history');
    await expect(prepareCtwaReceipt(db, journal.files, { workspaceId, receiptId: passive.receiptId, eventIndex: 0, apply: true })).rejects.toThrow('invalid_receipt_source');
    expect(await db.ctwaConversionEvent.count({ where: { workspaceId, messageId: passive.messageId! } })).toBe(0);
    expect(first.messageId).not.toBe(second.messageId);
  });

  it.each([false, true])('same provider receipt conserves old/new normalization in both directions (old first: %s)', async oldFirst => {
    const stanza = `NORMALIZATION-${oldFirst}`, eventId = `synthetic-normalization-${oldFirst}`;
    const first = await ingest('waha', stanza, `Synthetic-Normalization-${oldFirst}`, 'live', oldFirst, eventId);
    const original = await db.canonicalObservation.findUniqueOrThrow({ where: { id: first.observationId! } });
    expect(original.payload).not.toHaveProperty('ctwa');
    const privatePayload = (await journal.readPayload(first.receiptId)).payload;
    if (!oldFirst) expect((privatePayload.events[0] as any).event.ctwa).toBeDefined();
    // Exactly the older rollback image's fact shape: no CTWA field, same native identity/content.
    const { context: _savedContext, ...savedFact } = original.payload as any;
    const { context: _privateContext, ctwa: _privateCtwa, ...rollbackFact } = (privatePayload.events[0] as any).event;
    expect(savedFact).toEqual(rollbackFact);
    const second = await ingest('waha', stanza, `Synthetic-Normalization-${oldFirst}`, 'live', !oldFirst, eventId);
    expect(second.state).toBe('applied'); expect(second.messageId).toBe(first.messageId);
    expect(second.observationId).toBe(first.observationId);
    expect((await db.canonicalObservation.findUniqueOrThrow({ where: { id: first.observationId! } })).payload).toEqual(original.payload);
    expect(await db.message.count({ where: { workspaceId, id: first.messageId! } })).toBe(1);
  });
  it('same canonical message with a different native click cannot create two leads', async () => {
    const first = await ingest('waha', 'AMBIGUOUS-CLICK', 'Synthetic-Ambiguous-1', 'live', false, 'synthetic-ambiguous-1');
    const second = await ingest('waha', 'AMBIGUOUS-CLICK', 'Synthetic-Ambiguous-2', 'live', false, 'synthetic-ambiguous-2');
    expect(second.state).toBe('applied'); expect(second.messageId).toBe(first.messageId);
    expect(await db.ctwaAttribution.count({ where: { workspaceId, messageId: first.messageId! } })).toBe(1);
    expect(await db.ctwaConversionEvent.count({ where: { workspaceId, messageId: first.messageId!, eventName: 'LeadSubmitted' } })).toBe(1);
    await expect(prepareCtwaReceipt(db, journal.files, { workspaceId, receiptId: second.receiptId, eventIndex: 0, apply: true })).rejects.toThrow('message_click_conflict');
  });

});
