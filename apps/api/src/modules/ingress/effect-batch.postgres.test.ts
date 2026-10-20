import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { IngressApplicationService } from './application.js';
import { IngressJournal } from './journal.js';
import { IngressPrivateStore } from './private-store.js';
import { createReceiptEffectBatch } from './effect-batch.js';
import { normalizeReceipt } from './normalization.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;
const makeClient = () => new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
describe.skipIf(!url)('receipt effect batching on owned PostgreSQL', () => {
  let db: ReturnType<typeof makeClient>, journal: IngressJournal, service: IngressApplicationService, root: string;
  const workspaces: string[] = [], queries: string[] = [];
  let capture = false;
  beforeAll(async () => {
    const u = new URL(url!);
    if (u.hostname !== '127.0.0.1' || u.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || u.pathname !== '/messaging_test') throw Error('Owned messaging_test only');
    db = makeClient();
    db.$on('query', e => { if (capture) queries.push(e.query); });
    root = await realpath(await mkdtemp(join(tmpdir(), 'talk-effect-batch-')));
    const files = new IngressPrivateStore(root); await files.initialize();
    journal = new IngressJournal(db, files); service = new IngressApplicationService(journal);
  });
  afterAll(async () => {
    if (!db) return;
    const where = { workspaceId: { in: workspaces } };
    await db.ingressReceipt.deleteMany({ where });
    await db.channel.deleteMany({ where });
    await db.contact.deleteMany({ where });
    await db.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID(), verifiedMessagingPhoneNumber: '15550008888' } });
    const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, verifiedPhoneNumber: '15550008888' } });
    const source = await db.$transaction(async tx => {
      await enterCanonicalWorkspaceTransaction(tx, workspaceId);
      return deriveTrustedMessagingContext(tx, { workspaceId, channelId: channel.id, authenticatedSource: { provider: 'evolution', connectionId: connection.id }, mode: 'live', observedAt: '2026-10-20T10:00:00.000Z' });
    });
    async function stage(id = randomUUID()) {
      const raw = { event: 'MESSAGES_UPSERT', instance: connection.sessionName, data: { key: { id, remoteJid: '15550001111@s.whatsapp.net', fromMe: false }, message: { conversation: 'synthetic batching fixture' }, messageTimestamp: 1700000000 } };
      return journal.stage({ transportNamespace: 'talk.isolated.effect_batch', source, raw: Buffer.from(JSON.stringify(raw)), payload: normalizeReceipt(source, raw), authentication: 'evolution_constant_time_secret', reauthenticate: async () => {} });
    }
    return { workspaceId, channel, stage };
  }
  it('reads immutable frontier once and inserts live obligations in one statement per event', async () => {
    const f = await fixture(), receipt = await f.stage();
    queries.length = 0; capture = true;
    try { await service.apply(receipt.id); } finally { capture = false; }
    expect.soft(queries.filter(q => q.includes('FROM "public"."ingress_frontiers"'))).toHaveLength(1);
    expect.soft(queries.filter(q => q.startsWith('INSERT INTO "public"."ingress_effects"'))).toHaveLength(1);
    const effects = await db.ingressEffect.findMany({ where: { receiptId: receipt.id } });
    expect(effects).toHaveLength(10);
    const frontier = await db.ingressFrontier.findUniqueOrThrow({ where: { receiptId_eventIndex: { receiptId: receipt.id, eventIndex: 0 } } });
    expect(effects.every(e => (e.cause as { frontierId: string }).frontierId === String(frontier.id))).toBe(true);
    await service.apply(receipt.id);
    expect(await db.ingressEffect.findMany({ where: { receiptId: receipt.id }, orderBy: { id: 'asc' } })).toEqual([...effects].sort((a, b) => a.id.localeCompare(b.id)));
  });
  it('preserves existing lifecycle/evidence and the first duplicate frozen input in a batch', async () => {
    const f = await fixture(), receipt = await f.stage(); await service.apply(receipt.id);
    const original = await db.ingressEffect.findFirstOrThrow({ where: { receiptId: receipt.id, kind: 'realtime.message' } });
    await db.ingressEffect.update({ where: { id: original.id }, data: { state: 'done', attempts: 2, completedAt: new Date(), result: { preserved: true } } });
    const before = await db.ingressEffect.findUniqueOrThrow({ where: { id: original.id } });
    await db.$transaction(async tx => {
      await enterCanonicalWorkspaceTransaction(tx, f.workspaceId);
      const batch = createReceiptEffectBatch(tx, receipt, 0);
      batch.add(original.kind, original.logicalKey, original.messageId, original.conversationId, null, { mustNotReplace: true });
      batch.add('realtime.conversation', 'batch-first-wins', original.messageId, original.conversationId, null, { version: 'first' });
      batch.add('realtime.conversation', 'batch-first-wins', original.messageId, original.conversationId, randomUUID(), { version: 'second' });
      await batch.flush();
    });
    expect(await db.ingressEffect.findUniqueOrThrow({ where: { id: original.id } })).toEqual(before);
    expect(await db.ingressEffect.findMany({ where: { workspaceId: f.workspaceId, logicalKey: 'batch-first-wins' } })).toEqual([
      expect.objectContaining({ frozen: { version: 'first' }, cause: expect.objectContaining({ observationId: null }), state: 'pending', attempts: 0 })
    ]);
  });
  it('rolls back all domain/progress/obligations if a middle obligation fails, then retries without multiplying effects', async () => {
    const f = await fixture(), receipt = await f.stage(), name = 'batch_fault_' + randomUUID().replaceAll('-', '');
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${f.workspaceId}' AND NEW.kind = 'handoff.brief' THEN RAISE EXCEPTION 'fixture middle obligation'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON ingress_effects FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await expect(service.apply(receipt.id)).rejects.toThrow('fixture middle obligation');
      for (const count of [await db.message.count({ where: { workspaceId: f.workspaceId } }), await db.contact.count({ where: { workspaceId: f.workspaceId } }),
        await db.ingressEventProgress.count({ where: { receiptId: receipt.id } }), await db.ingressEffect.count({ where: { receiptId: receipt.id } }),
        await db.ingressApplication.count({ where: { receiptId: receipt.id } })]) expect(count).toBe(0);
      expect(await db.ingressReceipt.findUnique({ where: { id: receipt.id } })).not.toBeNull();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON ingress_effects`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
    await service.apply(receipt.id); await service.apply(receipt.id);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 1 });
    expect(await db.ingressEffect.count({ where: { receiptId: receipt.id } })).toBe(10);
  });
});
