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
    expect(reasons).toEqual(expect.arrayContaining(['legacy_identity_requires_adoption', 'target_missing', 'contradictory_sender_declarations']));
  });
});
