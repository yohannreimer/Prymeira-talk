import { describe, expect, it, vi } from 'vitest';
import { createIdleBackoff, createSweepCadence } from './idle-backoff.js';
import { startEffectLoop } from './effect-runner.js';
describe('quiet background work', () => {
  it('caps SQL polling and resets immediately after work', () => {
    const wait = createIdleBackoff(500, 5_000);
    expect(Array.from({ length: 8 }, () => wait.next(false))).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000, 5000]);
    expect(wait.next(true)).toBe(500);
    expect(wait.next(false)).toBe(500);
  });
  it('runs independent graph/history jobs at most once per five minutes', () => {
    let at = 100; const due = createSweepCadence(() => at);
    expect(due('lids', 300_000)).toBe(true);
    expect(due('lids', 300_000)).toBe(false);
    expect(due('history', 300_000)).toBe(true);
    at += 30_000; expect(due('lids', 300_000)).toBe(false);
    at += 270_000; expect(due('lids', 300_000)).toBe(true);
  });
  it('aborts an idle effect worker without waiting for the full backoff', async () => {
    const abort = new AbortController(), drain = vi.fn(async () => 0);
    const running = startEffectLoop({ drain }, { signal: abort.signal, idleMs: 5000 });
    await Promise.resolve(); abort.abort(); await running;
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
