import { describe, expect, it } from 'vitest';
import type { ChannelConnection } from '@prisma/client';
import { recoveryLanes, dueRecoveryLane, RECENT_WINDOW_MS } from './waha-recovery-lanes.js';
const now = Date.parse('2026-11-13T12:00:00Z');
const fixture = (extra: Partial<ChannelConnection> = {}) => ({ sessionName: 'owned', verifiedPhoneNumber: '15550000000', lifecycleGeneration: 2,
  recoveredThroughAt: new Date(now - 20 * 86400_000), disconnectedAt: null, historyRecoveryCursor: null,
  historyRecoveryFailures: 0, historyRecoveryNextAttemptAt: null, ...extra }) as ChannelConnection;
describe('separate recovery coverage and scheduling', () => {
  it('keeps short queues on the legacy path and bootstraps unknown outages conservatively', () => {
    expect(recoveryLanes(fixture({ recoveredThroughAt: new Date(now - 60_000) }), now)).toBeNull();
    const state = recoveryLanes(fixture(), now)!;
    expect(state.recentFromAt).toBe(now - 15 * 60_000); expect(state.recentThroughAt).toBeNull();
    expect(dueRecoveryLane(state, now)).toBe('recent');
  });
  it('keeps the full known outage within the initial supported horizon', () => {
    expect(recoveryLanes(fixture({ disconnectedAt: new Date(now - 86400_000) }), now)!.recentFromAt).toBe(now - 86400_000);
    expect(recoveryLanes(fixture({ recoveredThroughAt: null, disconnectedAt: new Date(now - 86400_000) }), now)!.recentFromAt).toBe(now - 86400_000);
    expect(recoveryLanes(fixture({ disconnectedAt: new Date(now - 18 * 86400_000) }), now)!.recentFromAt).toBe(now - RECENT_WINDOW_MS);
  });
  it('does not inherit confirmed coverage from a different account or session', () => {
    const state = recoveryLanes(fixture(), now)!; state.recentThroughAt = new Date(now - 30_000).toISOString();
    const changed = recoveryLanes(fixture({ historyRecoveryCursor: state, sessionName: 'different-session' }), now)!;
    expect(changed.recentThroughAt).toBeNull(); expect(changed.owner).not.toBe(state.owner);
    const otherAccount = recoveryLanes(fixture({ historyRecoveryCursor: state, verifiedPhoneNumber: '15550000001' }), now)!;
    expect(otherAccount.recentThroughAt).toBeNull();
  });
  it('preserves confirmed coverage on restart, resets pages on generation change and runs new outages immediately', () => {
    const state = recoveryLanes(fixture(), now)!; state.recentThroughAt = new Date(now - 30_000).toISOString(); state.recent.nextAttemptAt = now + 3600_000;
    expect(dueRecoveryLane(recoveryLanes(fixture({ historyRecoveryCursor: state }), now)!, now)).toBe('backlog');
    const changed = recoveryLanes(fixture({ historyRecoveryCursor: state, lifecycleGeneration: 4 }), now)!;
    expect(changed.recentThroughAt).toBe(state.recentThroughAt); expect(dueRecoveryLane(changed, now)).toBe('recent');
    const outage = recoveryLanes(fixture({ historyRecoveryCursor: state, disconnectedAt: new Date(now - 1000) }), now)!;
    expect(dueRecoveryLane(outage, now)).toBe('recent');
  });
  it('fails closed for corrupt or future-version metadata instead of losing its coverage', () => {
    expect(() => recoveryLanes(fixture({ historyRecoveryCursor: { version: 2 } }), now)).toThrow('HISTORY_CURSOR_INVALID');
    expect(() => recoveryLanes(fixture({ recoveredThroughAt: new Date(now), historyRecoveryCursor: { version: 3 } }), now)).toThrow('HISTORY_CURSOR_INVALID');
  });
});
