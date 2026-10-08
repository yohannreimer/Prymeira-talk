import { describe, expect, it, vi } from 'vitest';
import { IngressApplicationService } from './application.js';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ receiptId: `r${i}`, eventIndex: 0 }));

describe('recertification sweep', () => {
  it('continues after a failed event and retries it after backoff without discarding its receipt', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const findMany = vi.fn().mockImplementation(async (args: { where: { reason?: unknown } }) => args.where.reason ? [] : rows(3));
      const service = new IngressApplicationService({ db: { ingressEventProgress: { findMany } } } as never);
      const recertify = vi.spyOn(service, 'recertify').mockImplementation(async (id: string) => {
        if (id === 'r0') throw Object.assign(new Error('private message content must not enter logs'), { code: 'InvalidArg' });
        return { state: 'applied' } as never;
      });
      expect(await service.recertifyPending({ limit: 3 })).toEqual({ examined: 3, applied: 2 });
      expect(recertify.mock.calls.map(call => call[0])).toEqual(['r0', 'r1', 'r2']);
      expect(warn).toHaveBeenCalledWith('Recertification event failed', { receiptId: 'r0', eventIndex: 0, code: 'InvalidArg' });
      recertify.mockClear();
      await service.recertifyPending({ limit: 3 });
      expect(recertify.mock.calls.map(call => call[0])).toEqual(['r1', 'r2']);
      vi.advanceTimersByTime(10 * 60_000);
      recertify.mockResolvedValue({ state: 'applied' });
      recertify.mockClear();
      expect(await service.recertifyPending({ limit: 3 })).toEqual({ examined: 3, applied: 3 });
      expect(recertify.mock.calls[0]![0]).toBe('r0');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
  it('an event that stays invalid waits its backoff instead of blocking the events behind it', async () => {
    // The main queue has four; the WAHA-proof queue is empty.
    const findMany = vi.fn().mockImplementation(async (args: { where: { reason?: unknown } }) => args.where.reason ? [] : rows(4));
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
    expect(reasons).toEqual(expect.arrayContaining(['legacy_identity_requires_adoption', 'target_missing', 'contradictory_sender_declarations']));
    // WAHA messages received while the connection was not yet proven again (applied once it is, never to another number).
    expect(findMany.mock.calls[1]![0].where.reason.in).toEqual(['waha_identity_unverified']);
  });
  it('WAHA messages waiting for proof have their own queue: old holds that never resolve cannot starve them', async () => {
    const stuck = Array.from({ length: 1000 }, (_, i) => ({ receiptId: `old${i}`, eventIndex: 0 }));
    const findMany = vi.fn().mockImplementation(async (args: { where: { reason?: unknown } }) => args.where.reason ? [{ receiptId: 'waha1', eventIndex: 0 }] : stuck);
    const service = new IngressApplicationService({ db: { ingressEventProgress: { findMany } } } as never);
    const recertify = vi.spyOn(service, 'recertify').mockImplementation(async (receiptId: string) =>
      (receiptId === 'waha1' ? { state: 'applied' } : { state: 'still_invalid', reason: 'x' }) as never);
    expect(await service.recertifyPending({ limit: 4 })).toEqual({ examined: 4, applied: 1 });
    expect(recertify.mock.calls[0]![0]).toBe('waha1');
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
