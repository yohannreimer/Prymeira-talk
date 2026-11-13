import { describe, expect, it, vi } from 'vitest';
import { newHistoryBackfill, stepHistoryBackfill } from './waha-history-backfill.js';
import type { WahaRecoveryPage } from '../waha/waha.client.js';
const page = (messages: Array<{ id: string; timestamp: number }>, offset = 0): WahaRecoveryPage => ({
  messages, rawCount: messages.length, nextOffset: offset + messages.length, exhausted: !messages.length, rawDigest: 'a'.repeat(64)
});
describe('bounded independent WAHA history backfill', () => {
  it('requires two identical complete scans and keeps holds visible instead of claiming reconciliation', async () => {
    const c = newHistoryBackfill(100, 200), save = vi.fn(async () => {}), persist = vi.fn(async () => ({ inserted: 0, held: 1 }));
    const read = vi.fn(async q => q.offset ? page([], q.offset) : page([{ id: 'a', timestamp: 150 }]));
    await stepHistoryBackfill({ session: 'owned', cursor: c, read, persist, save, maxPages: 2 });
    expect(c.complete).toBe(false);
    await stepHistoryBackfill({ session: 'owned', cursor: c, read, persist, save, maxPages: 2 });
    expect(c.complete).toBe(true); expect(c.holdsByOffset).toEqual({ 0: 1 }); expect(persist).toHaveBeenCalledTimes(2);
  });
  it('does not persist an out-of-range provider result or advance its cursor', async () => {
    const c = newHistoryBackfill(100, 200), persist = vi.fn(), save = vi.fn();
    await expect(stepHistoryBackfill({ session: 'owned', cursor: c, read: async () => page([{ id: 'a', timestamp: 99 }]), persist, save })).rejects.toThrow('HISTORY_FILTER_IGNORED');
    expect(persist).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(c.offset).toBe(0);
  });
  it('does not advance past a persistence failure and accepts raw protocol-only pages', async () => {
    const c = newHistoryBackfill(100, 200), save = vi.fn();
    await expect(stepHistoryBackfill({ session: 'owned', cursor: c, read: async () => page([{ id: 'a', timestamp: 150 }]), persist: async () => { throw new Error('DB'); }, save })).rejects.toThrow('DB');
    expect(c.offset).toBe(0); expect(save).not.toHaveBeenCalled();
    await stepHistoryBackfill({ session: 'owned', cursor: c, read: async () => ({ messages: [], rawDigest: 'a'.repeat(64), rawCount: 50, nextOffset: 50, exhausted: false }), persist: async () => ({ inserted: 0, held: 0 }), save, maxPages: 1 });
    expect(c.offset).toBe(50); expect(c.complete).toBe(false);
  });
  it('rejects excessive ranges and malformed pagination without writes', async () => {
    expect(() => newHistoryBackfill(1, 16 * 86400)).toThrow('BACKFILL_RANGE');
    const c = newHistoryBackfill(100, 200), persist = vi.fn();
    await expect(stepHistoryBackfill({ session: 'owned', cursor: c, read: async () => ({ ...page([]), nextOffset: 50 }), persist, save: vi.fn() })).rejects.toThrow('HISTORY_PAGINATION');
    expect(persist).not.toHaveBeenCalled();
  });
});
