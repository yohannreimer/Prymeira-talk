import { describe, expect, it, vi } from 'vitest';
import { IngressApplicationService } from './application.js';
function fixture(failures: string[]) {
  const receipt = { id: 'receipt', workspaceId: 'workspace', channelId: 'channel', eventCount: 0, source: { workspaceId: 'workspace', channelId: 'channel', provider: 'evolution', mode: 'live', observedAt: new Date().toISOString(), sessionName: 'synthetic' } };
  const tx = { $queryRaw: vi.fn(async () => [{ isolation: 'read committed' }]), $executeRaw: vi.fn(), ingressEventProgress: { findMany: vi.fn(async () => []) }, ingressApplication: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({ state: 'applied' })) }, ingressDelivery: { findUniqueOrThrow: vi.fn(async () => ({})), update: vi.fn() } };
  const db = { ingressDelivery: { findUniqueOrThrow: vi.fn(async () => ({ recoveries: 0 })) }, $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => { const code = failures.shift(); if (code) throw Object.assign(Error('synthetic contention'), { code }); return work(tx); }) };
  const journal = { db, readPayload: vi.fn(async () => ({ receipt, payload: { events: [] } })), files: { read: vi.fn(async () => Buffer.from('{}')) } };
  return { db, tx, service: new IngressApplicationService(journal as never) };
}
describe('receipt contention retry', () => {
  it('retries only bounded transactional contention with the same durable receipt', async () => {
    const { service, db, tx } = fixture(['P2028', 'P2034']);
    expect(await service.apply('receipt')).toEqual({ state: 'applied' });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(tx.ingressApplication.upsert).toHaveBeenCalledTimes(1);
  });
  it('does not retry validation errors or exhaust unbounded attempts', async () => {
    const terminal = fixture(['P2003']);
    await expect(terminal.service.apply('receipt')).rejects.toMatchObject({ code: 'P2003' });
    expect(terminal.db.$transaction).toHaveBeenCalledTimes(1);
    const contended = fixture(['P2028', 'P2028', 'P2028', 'P2028']);
    await expect(contended.service.apply('receipt')).rejects.toMatchObject({ code: 'P2028' });
    expect(contended.db.$transaction).toHaveBeenCalledTimes(3);
  });
});
