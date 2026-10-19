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
    db.ingressEventProgress.count.mockResolvedValue(3);
    db.outboundDispatch.count.mockResolvedValue(2);
    const health = await readOperationalHealth(db as never, { workspaceId: 'w', now: NOW });
    expect(health).toMatchObject({ status: 'degraded', transport: { status: 'delayed', pending: 2, oldestPendingSeconds: 300, deadLetters: 1 }, application: { status: 'delayed', pending: 1, held: 3 }, outbound: { status: 'attention', uncertain: 2 } });
    expect(health.channels.status).toBe('available');
  });
});
