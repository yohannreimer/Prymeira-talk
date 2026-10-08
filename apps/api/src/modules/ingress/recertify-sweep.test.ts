import { describe, expect, it, vi } from 'vitest';
import { IngressApplicationService } from './application.js';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ receiptId: `r${i}`, eventIndex: 0 }));

describe('recertification sweep', () => {
  it('an event that stays invalid waits its backoff instead of blocking the events behind it', async () => {
    const findMany = vi.fn().mockResolvedValue(rows(4));
    const service = new IngressApplicationService({ db: { ingressEventProgress: { findMany } } } as never);
    const recertify = vi.spyOn(service, 'recertify').mockImplementation(async (receiptId: string) =>
      (receiptId === 'r0' || receiptId === 'r1' ? { state: 'still_invalid', reason: 'x' } : { state: 'applied' }) as never);
    expect(await service.recertifyPending({ limit: 2 })).toEqual({ examined: 2, applied: 0 });
    // Next sweep: r0 and r1 wait; r2 and r3 are finally reached.
    expect(await service.recertifyPending({ limit: 2 })).toEqual({ examined: 2, applied: 2 });
    expect(recertify.mock.calls.map(call => call[0])).toEqual(['r0', 'r1', 'r2', 'r3']);
  });
  it('also re-reads Talk-send echoes awaiting adoption and receipts whose message was missing', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await new IngressApplicationService({ db: { ingressEventProgress: { findMany } } } as never).recertifyPending({});
    const reasons = findMany.mock.calls[0]![0].where.OR[1].reason.in;
    expect(reasons).toEqual(expect.arrayContaining(['legacy_identity_requires_adoption', 'target_missing', 'contradictory_sender_declarations',
      // WAHA messages received while the connection was not yet proven again (applied once it is, never to another number).
      'waha_identity_unverified']));
  });
});

describe('store-held events are replayed on their own observation', () => {
  function setup(replayed: { outcome: string; reconciliationReasons: string[] } | null) {
    const created: unknown[] = [];
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ isolation: 'read committed' }]), $executeRaw: vi.fn().mockResolvedValue(0),
      ingressEventProgress: { findUnique: vi.fn().mockResolvedValue({ state: 'held', reason: 'target_missing', observationId: 'obs1' }) },
      ingressEventRecertification: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(async (args: unknown) => { created.push(args); }) },
      canonicalObservation: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'obs1', payload: { kind: 'receipt', context: { mode: 'live' } } }) }
    };
    const receipt = { id: 'r1', workspaceId: 'w', channelId: 'ch', rawRef: 'raw', rawDigest: 'd',
      source: { workspaceId: 'w', channelId: 'ch', provider: 'waha', mode: 'live', observedAt: '2026-10-03T20:00:00Z', connectionId: 'conn' } };
    const journal = { db: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) }, readPayload: vi.fn().mockResolvedValue({ receipt, payload: { events: [{ kind: 'accepted' }] } }),
      files: { read: vi.fn().mockResolvedValue(Buffer.from('{}')) } };
    const service = new IngressApplicationService(journal as never);
    const store = (service as unknown as { store: { replayResolvableHeldInTransaction: unknown } }).store;
    const replay = vi.fn().mockResolvedValue(replayed && { ...replayed, observationId: 'obs1', conversationId: 'c', messageId: 'm', changes: ['recipient_receipt_advanced'] });
    store.replayResolvableHeldInTransaction = replay;
    const afterPersist = vi.spyOn(service as unknown as { afterPersist: () => Promise<void> }, 'afterPersist').mockResolvedValue(undefined);
    return { service, replay, afterPersist, created };
  }
  it('applies a receipt whose message now exists, without creating a second observation', async () => {
    const s = setup({ outcome: 'duplicate', reconciliationReasons: [] });
    expect(await s.service.recertify('r1', 0)).toEqual({ state: 'applied' });
    expect(s.replay).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'w', channelId: 'ch', observationId: 'obs1' });
    expect(s.afterPersist).toHaveBeenCalledOnce();
    expect(s.created).toEqual([expect.objectContaining({ data: expect.objectContaining({ outcome: 'applied', observationId: 'obs1' }) })]);
  });
  it('a hold that is not resolvable yet is not recorded, so a later sweep can still recover it', async () => {
    const s = setup({ outcome: 'held', reconciliationReasons: ['target_missing'] });
    expect(await s.service.recertify('r1', 0)).toEqual({ state: 'still_invalid', reason: 'target_missing' });
    expect(s.created).toEqual([]);
    expect(s.afterPersist).not.toHaveBeenCalled();
  });
});
