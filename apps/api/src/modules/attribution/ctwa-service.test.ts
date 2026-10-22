import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { captureCtwaInTransaction, createCtwaService } from './ctwa-service.js';
const config = { datasetId: '123', whatsappBusinessAccountId: '789', accessToken: 'synthetic-secret', enabled: true };
const attr = { id: 'a', workspaceId: 'w', channelId: 'c', conversationId: 'conv', messageId: 'm', ctwaClid: 'Synthetic-Click' };
const event = { ...attr, id: 'e', attributionId: 'a', eventName: 'LeadSubmitted', eventTime: new Date('2026-10-19T12:00:00Z'), orderId: null, state: 'pending_validation', attemptCount: 0, attribution: attr };
function fixture(response: () => Promise<Response> = async () => Response.json({ events_received: 1 })) {
  let state = 'pending_validation', attemptCount = 0;
  const db = { ctwaConversionEvent: { findFirst: vi.fn(async () => ({ ...event, state, attemptCount })), updateMany: vi.fn(async ({ where, data }) => {
    if (where.attemptCount !== undefined && where.attemptCount !== attemptCount) return { count: 0 };
    if (where.state?.in && !where.state.in.includes(state)) return { count: 0 };
    if (typeof where.state === 'string' && where.state !== state) return { count: 0 };
    state = data.state; if (data.attemptCount?.increment) attemptCount += data.attemptCount.increment; return { count: 1 };
  }) } };
  const fetch = vi.fn(response);
  return { db, fetch, service: createCtwaService(db as unknown as PrismaClient, { secret: JSON.stringify({ w: config }), fetch }) };
}
describe('manual CTWA sender', () => {
  it('disabled/missing/wrong-workspace config does no claim or fetch', async () => {
    const { db, fetch } = fixture();
    for (const secret of [undefined, JSON.stringify({ other: config }), JSON.stringify({ w: { ...config, enabled: false } })]) {
      await expect(createCtwaService(db as unknown as PrismaClient, { secret, fetch }).dispatch('w', 'e')).rejects.toThrow('sending_disabled');
    }
    expect(db.ctwaConversionEvent.findFirst).not.toHaveBeenCalled(); expect(db.ctwaConversionEvent.updateMany).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('only one concurrent manual claim sends and accepted cannot resend', async () => {
    const { service, fetch } = fixture();
    const result = await Promise.allSettled([service.dispatch('w', 'e'), service.dispatch('w', 'e')]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.find(item => item.status === 'fulfilled')).toMatchObject({ value: { state: 'accepted', eventsReceived: 1, outcomeCode: 'meta_accepted_not_attribution' } });
    await expect(service.dispatch('w', 'e')).rejects.toThrow('not_dispatchable');
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit]; expect(url).not.toContain('synthetic-secret'); expect(options.headers).toMatchObject({ Authorization: 'Bearer synthetic-secret' });
  });
  it.each([async () => { throw new Error('timeout token=synthetic-secret'); }, async () => Response.json({ success: true }), async () => Response.json({ error: { message: 'synthetic-secret' } }, { status: 503 }), async () => new Response('x'.repeat(65537))])('fences ambiguous outcomes without raw error leakage', async response => {
    const { service, fetch } = fixture(response);
    const result = await service.dispatch('w', 'e'); expect(result.state).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    await expect(service.dispatch('w', 'e')).rejects.toThrow('not_dispatchable'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('a stale concurrent caller cannot retry after another request completes a rejection', async () => {
    const { db, service, fetch } = fixture(async () => Response.json({ error: { message: 'rejected' } }, { status: 400 }));
    let finishSecondRead!: (value: any) => void;
    const delayedRead = new Promise<any>(resolve => { finishSecondRead = resolve; });
    db.ctwaConversionEvent.findFirst.mockImplementationOnce(async () => ({ ...event, state: 'pending_validation', attemptCount: 0 }));
    db.ctwaConversionEvent.findFirst.mockImplementationOnce(() => delayedRead);
    const first = service.dispatch('w', 'e');
    const staleSecond = service.dispatch('w', 'e');
    expect((await first).state).toBe('failed');
    finishSecondRead({ ...event, state: 'pending_validation', attemptCount: 0 });
    await expect(staleSecond).rejects.toThrow('not_dispatchable');
    expect(fetch).toHaveBeenCalledTimes(1);
    // A fresh explicit owner action reads the updated attempt and can retry definite rejection.
    expect((await service.dispatch('w', 'e')).state).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('requires events_received proof, and permits only explicit retry of definite rejection', async () => {
    const { service, fetch } = fixture(async () => Response.json({ error: { message: 'secret' } }, { status: 400 }));
    expect((await service.dispatch('w', 'e')).state).toBe('failed'); expect(fetch).toHaveBeenCalledTimes(1);
    expect((await service.dispatch('w', 'e')).state).toBe('failed'); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
describe('purchase input validation before storage', () => {
  it.each([0.00001, 1.23456, 1000000000001])('refuses unrepresentable %s before any database write', async value => {
    const db = { ctwaAttribution: { findFirst: vi.fn() }, ctwaConversionEvent: { upsert: vi.fn() } };
    await expect(createCtwaService(db as unknown as PrismaClient).prepare('w', 'a', 'Purchase', { orderId: 'order', value, currency: 'BRL' })).rejects.toThrow();
    expect(db.ctwaAttribution.findFirst).not.toHaveBeenCalled(); expect(db.ctwaConversionEvent.upsert).not.toHaveBeenCalled();
  });
});
describe('accepted canonical CTWA hook', () => {
  const incoming = { kind: 'message', context: { provider: 'waha', workspaceId: 'w', channelId: 'c', mode: 'live', observedAt: '2026-10-19T12:10:00Z' }, key: { direction: 'inbound', chatAddress: '5500000000000@c.us' }, order: { timestampMs: new Date('2026-10-19T12:00:00Z').getTime() }, ctwa: { ctwaClid: 'synthetic' } } as any;
  const result = { outcome: 'duplicate', messageId: 'm', conversationId: 'conv' } as any;
  function tx(inserted = 1) { return { $executeRawUnsafe: vi.fn(async () => 1), ctwaAttribution: { createMany: vi.fn(async () => ({ count: inserted })), findUniqueOrThrow: vi.fn(async () => attr) }, ctwaConversionEvent: { create: vi.fn(async () => ({})) } }; }
  it('captures provider duplicate and uses occurrence timestamp rather than queue application time', async () => {
    const db = tx(); await captureCtwaInTransaction(db as any, incoming, result);
    expect(db.ctwaConversionEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventName: 'LeadSubmitted', eventTime: new Date('2026-10-19T12:00:00Z') }) });
  });
  it.each(['history', 'recovered_live'])('preserves passive %s context without business events', async mode => {
    const db = tx(); await captureCtwaInTransaction(db as any, { ...incoming, context: { ...incoming.context, mode } }, result);
    expect(db.ctwaAttribution.createMany).toHaveBeenCalledOnce(); expect(db.ctwaConversionEvent.create).not.toHaveBeenCalled();
  });
  it('duplicates never reparent or create second events', async () => {
    const db = tx(0); await captureCtwaInTransaction(db as any, incoming, result); expect(db.ctwaConversionEvent.create).not.toHaveBeenCalled(); expect(db.ctwaAttribution.findUniqueOrThrow).not.toHaveBeenCalled();
  });
  it('malformed or held events perform no optional writes; storage failures rollback only savepoint', async () => {
    const db = tx(); await captureCtwaInTransaction(db as any, { ...incoming, ctwa: { ctwaClid: '\u0000' } }, result); await captureCtwaInTransaction(db as any, incoming, { ...result, outcome: 'held' }); expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    db.ctwaAttribution.createMany.mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(captureCtwaInTransaction(db as any, incoming, result)).resolves.toBeUndefined(); expect(db.$executeRawUnsafe).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT ctwa_capture');
  });
});
