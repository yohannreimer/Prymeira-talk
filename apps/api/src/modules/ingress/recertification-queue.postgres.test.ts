import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { claimRecertification, finishRecertification, selectRecertificationCandidates } from './recertification-queue.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('durable recertification scheduling with PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => { const target = new URL(url!); if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw Error('Owned local messaging_test required'); db = new PrismaClient({ datasources: { db: { url } } }); });
  afterAll(async () => {
    await db.ingressReceipt.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.channel.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.$disconnect();
  });
  async function fixture(count = 1, reason = 'stale_source', resolved = false) {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const rows = Array.from({ length: count }, (_, i) => ({ workspaceId, channelId: channel.id, receiptId: randomUUID(), eventIndex: 0, committedAt: new Date(Date.now() - 1_000_000 + i) }));
    await db.ingressReceipt.createMany({ data: rows.map(r => ({ id: r.receiptId, workspaceId, channelId: channel.id, stageVersion: 1, transportNamespace: 'talk.isolated.queue',
      source: {}, authentication: 'fixture', authenticatedDigest: '0'.repeat(64), rawRef: `${randomUUID()}.blob`, rawDigest: '0'.repeat(64), eventRef: `${randomUUID()}.blob`, eventDigest: '0'.repeat(64), eventCount: 1 })) });
    await db.ingressFrontier.createMany({ data: rows.map(({ committedAt: _, ...r }) => ({ ...r, kind: 'invalid' })) });
    const observation = resolved ? await db.canonicalObservation.create({ data: { workspaceId, channelId: channel.id, channelProvider: 'evolution', provider: 'evolution', receiptHash: '0'.repeat(64), receiptTuple: [], sessionName: 'fixture', lifecycleGeneration: 0, kind: 'receipt', eventType: 'fixture', mode: 'live', receivedAt: new Date(), sourceOrder: {}, payload: {}, state: 'resolved' } }) : null;
    await db.ingressEventProgress.createMany({ data: rows.map(r => ({ ...r, observationId: observation?.id, state: reason === 'stale_source' || reason === 'waha_pairing_changed' ? 'pending_recertification' : 'held', reason, result: {} })) });
    return { workspaceId, channel, rows };
  }
  it('reaches a due event after more than 1,000 deferred older events and excludes other workspaces', async () => {
    const f = await fixture(1002), outside = await fixture();
    await db.ingressRecertificationRetry.createMany({ data: f.rows.slice(0, 1001).map(({ committedAt: _, ...r }) => ({ ...r, nextAttemptAt: new Date(Date.now() + 600_000) })) });
    const candidates = await selectRecertificationCandidates(db, [f.workspaceId], 50);
    expect(candidates.map(r => r.receiptId)).toEqual([f.rows[1001]!.receiptId]);
    expect(candidates.some(r => r.workspaceId === outside.workspaceId)).toBe(false);
  });
  it('excludes a resolved observation without changing the original held fact', async () => {
    const f = await fixture(1, 'target_missing', true), row = f.rows[0]!;
    const before = await db.ingressEventProgress.findUniqueOrThrow({ where: { receiptId_eventIndex: { receiptId: row.receiptId, eventIndex: row.eventIndex } } });
    expect(await selectRecertificationCandidates(db, [f.workspaceId], 50)).toEqual([]);
    expect(await db.ingressEventProgress.findUniqueOrThrow({ where: { receiptId_eventIndex: { receiptId: row.receiptId, eventIndex: row.eventIndex } } })).toEqual(before);
  });
  it('keeps authority events reachable beside old identity holds and includes pairing-changed events', async () => {
    const f = await fixture(20, 'contradictory_sender_declarations');
    const authority = await fixture(1, 'waha_identity_unverified'), pairing = await fixture(1, 'waha_pairing_changed');
    const candidates = await selectRecertificationCandidates(db, [f.workspaceId, authority.workspaceId, pairing.workspaceId], 50);
    expect(candidates[0]!.receiptId).toBe(authority.rows[0]!.receiptId);
    expect(candidates.some(r => r.receiptId === pairing.rows[0]!.receiptId)).toBe(true);
  });
  it('claims once concurrently, persists through another client and fences an expired owner', async () => {
    const f = await fixture(), row = f.rows[0]!, now = new Date();
    const peer = new PrismaClient({ datasources: { db: { url } } });
    try {
      const claims = await Promise.all([claimRecertification(db, row, now), claimRecertification(peer, row, now)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const owner = claims.find(Boolean)!;
      expect(await selectRecertificationCandidates(peer, [f.workspaceId], 50, now)).toEqual([]);
      const later = new Date(now.getTime() + 121_000), successor = await claimRecertification(peer, row, later);
      expect(successor?.attempts).toBe(2);
      expect((await finishRecertification(db, row, owner, 'still_invalid', later)).count).toBe(0);
      expect((await finishRecertification(peer, row, successor!, 'still_invalid', later)).count).toBe(1);
      const retry = await db.ingressRecertificationRetry.findUniqueOrThrow({ where: { receiptId_eventIndex: { receiptId: row.receiptId, eventIndex: row.eventIndex } } });
      expect(retry.nextAttemptAt.getTime() - later.getTime()).toBe(60 * 60_000);
      expect(await selectRecertificationCandidates(peer, [f.workspaceId], 50, later)).toEqual([]);
      expect(await selectRecertificationCandidates(peer, [f.workspaceId], 50, retry.nextAttemptAt)).toHaveLength(1);
    } finally { await peer.$disconnect(); }
  });
});
