import { describe, expect, it, vi } from 'vitest';
import { IngressApplicationService } from './application.js';

import * as schedule from './recertification-queue.js';
vi.mock('./recertification-queue.js', () => ({ selectRecertificationCandidates: vi.fn(), claimRecertification: vi.fn(), finishRecertification: vi.fn() }));
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ workspaceId: 'fixture', channelId: 'fixture', receiptId: `r${i}`, eventIndex: 0 }));
describe('recertification sweep orchestration', () => {
  it('continues after an event error, persists its outcome and keeps private content out of logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(schedule.selectRecertificationCandidates).mockResolvedValue(rows(3));
    vi.mocked(schedule.claimRecertification).mockResolvedValue({ token: '00000000-0000-4000-8000-000000000001', attempts: 1 });
    vi.mocked(schedule.finishRecertification).mockResolvedValue({ count: 1 });
    const service = new IngressApplicationService({ db: {} } as never);
    const recertify = vi.spyOn(service, 'recertify').mockImplementation(async id => {
      if (id === 'r0') throw Object.assign(Error('private-message-query'), { code: 'InvalidArg' });
      return { state: 'applied' };
    });
    try {
      expect(await service.recertifyPending({ limit: 3 })).toEqual({ examined: 3, applied: 2 });
      expect(recertify.mock.calls.map(c => c[0])).toEqual(['r0', 'r1', 'r2']);
      expect(schedule.finishRecertification).toHaveBeenCalledWith(expect.anything(), rows(3)[0], expect.anything(), 'error');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
    } finally { warn.mockRestore(); vi.clearAllMocks(); }
  });
  it('ends a long sweep without pre-claiming the remaining events', async () => {
    let at = 0; const clock = vi.spyOn(Date, 'now').mockImplementation(() => at);
    vi.mocked(schedule.selectRecertificationCandidates).mockResolvedValue(rows(3));
    vi.mocked(schedule.claimRecertification).mockResolvedValue({ token: '00000000-0000-4000-8000-000000000001', attempts: 1 });
    const service = new IngressApplicationService({ db: {} } as never);
    const recertify = vi.spyOn(service, 'recertify').mockImplementation(async () => { at += 11_000; return { state: 'still_stale' }; });
    try {
      expect(await service.recertifyPending({ limit: 3 })).toEqual({ examined: 1, applied: 0 });
      expect(recertify).toHaveBeenCalledTimes(1);
      expect(schedule.claimRecertification).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); vi.clearAllMocks(); }
  });
  it('skips events claimed by another worker and observes the per-sweep limit', async () => {
    vi.mocked(schedule.selectRecertificationCandidates).mockResolvedValue(rows(4));
    vi.mocked(schedule.claimRecertification).mockResolvedValue({ token: '00000000-0000-4000-8000-000000000001', attempts: 1 }).mockResolvedValueOnce(null);
    vi.mocked(schedule.finishRecertification).mockResolvedValue({ count: 1 });
    const service = new IngressApplicationService({ db: {} } as never);
    const recertify = vi.spyOn(service, 'recertify').mockResolvedValue({ state: 'applied' });
    expect(await service.recertifyPending({ limit: 2 })).toEqual({ examined: 2, applied: 2 });
    expect(recertify.mock.calls.map(c => c[0])).toEqual(['r1', 'r2']);
    vi.clearAllMocks();
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
