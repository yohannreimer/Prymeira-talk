import { describe, expect, it, vi } from 'vitest';
import { readOperationalHealth } from './operational-health.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const PHONE = '15550001111';
const base = { status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: PHONE, lastHealthyAt: NOW, lifecycleGeneration: 0 };
function fixture() {
  const empty = { _count: { _all: 0 }, _min: { createdAt: null }, _max: { appliedAt: null, completedAt: null, confirmedAt: null, updatedAt: null } };
  const aggregate = () => vi.fn(async () => empty);
  const db = {
    ingressReceipt: { aggregate: aggregate() }, ingressDelivery: { aggregate: aggregate(), count: vi.fn(async () => 0) },
    ingressApplication: { aggregate: aggregate() }, ingressEffect: { aggregate: aggregate(), count: vi.fn(async () => 0) },
    ingressEventProgress: { count: vi.fn(async () => 0) }, outboundDispatch: { aggregate: aggregate(), count: vi.fn(async () => 0) },
    channelConnection: { findMany: vi.fn(async () => []) },
    channel: { findMany: vi.fn(async () => [{ redundancyEnabled: true, activeConnectionId: 'wa', verifiedMessagingPhoneNumber: PHONE,
      connections: [{ ...base, id: 'ev', provider: 'evolution', status: 'disconnected', eligible: false, verifiedPhoneNumber: null }, { ...base, id: 'wa', provider: 'waha' }] }]) }
  };
  return db;
}
describe('workspace operational health', () => {
  it('keeps WAHA-only operational and distinguishes missing redundancy from outage', async () => {
    const db = fixture();
    const health = await readOperationalHealth(db as never, { workspaceId: 'w', now: NOW });
    expect(health).toMatchObject({ status: 'ok', channels: { status: 'available', usable: 1, withoutRedundancy: 1 }, broker: { status: 'unobserved' } });
    for (const args of db.channel.findMany.mock.calls as unknown as any[]) expect(args[0].where.workspaceId).toBe('w');
    expect(JSON.stringify(health)).not.toContain(PHONE);
  });
  it('reports a stalled transport/worker queue and manual-review obligations without claiming process failure', async () => {
    const db = fixture();
    db.ingressReceipt.aggregate.mockResolvedValue({ _count: { _all: 2 }, _min: { createdAt: new Date(NOW.getTime() - 300_000) }, _max: {} } as never);
    db.ingressApplication.aggregate.mockResolvedValueOnce({ _count: { _all: 1 }, _min: { createdAt: new Date(NOW.getTime() - 180_000) }, _max: {} } as never);
    db.ingressDelivery.count.mockResolvedValue(1);
    db.ingressEventProgress.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    db.outboundDispatch.count.mockResolvedValue(2);
    const health = await readOperationalHealth(db as never, { workspaceId: 'w', now: NOW });
    expect(health).toMatchObject({ status: 'degraded', transport: { status: 'delayed', pending: 2, oldestPendingSeconds: 300, deadLetters: 1 }, application: { status: 'delayed', pending: 1, held: 3, heldMessages: 1, heldControlOrUnclassified: 2 }, outbound: { status: 'attention', uncertain: 2 } });
    expect(health.channels.status).toBe('available');
    expect(db.channelConnection.findMany).toHaveBeenCalledWith({ where: { workspaceId: 'w', status: 'connected', eligible: true, channel: { archivedAt: null } }, select: {
      lifecycleGeneration: true, recoveredThroughAt: true, historyRecoveryFailures: true, historyRecoveryLeaseUntil: true, historyRecoveryNextAttemptAt: true } });
    expect(JSON.stringify(health)).not.toContain('historyRecoveryCursor');
  });
  it('reports only eligible even-generation recovery metadata and classifies known message holds without loading payloads', async () => {
    const db = fixture();
    db.channelConnection.findMany.mockResolvedValue([
      { lifecycleGeneration: 0, recoveredThroughAt: new Date(NOW.getTime()-600_000), historyRecoveryFailures: 2, historyRecoveryLeaseUntil: new Date(NOW.getTime()+60_000), historyRecoveryNextAttemptAt: new Date(NOW.getTime()+30_000) },
      { lifecycleGeneration: 1, recoveredThroughAt: new Date(0), historyRecoveryFailures: 99, historyRecoveryLeaseUntil: null, historyRecoveryNextAttemptAt: null }
    ] as never);
    const health = await readOperationalHealth(db as never, { workspaceId: 'w', now: NOW });
    expect(health.recovery).toMatchObject({ evidence: 'persisted_metadata', runtimeEnabled: 'unobserved', connections: 1, maximumCoverageLagSeconds: 600, consecutiveFailuresTotal: 2, activeLeases: 1, waitingNextAttempt: 1 });
    expect(db.ingressEventProgress.count).toHaveBeenLastCalledWith({ where: { workspaceId: 'w', state: 'held', OR: [
      { result: { path: ['kind'], equals: 'message' } }, { observation: { is: { kind: 'message' } } }
    ] } });
  });

});
