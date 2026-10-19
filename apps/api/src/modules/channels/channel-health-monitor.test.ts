import { describe, expect, it, vi } from 'vitest';

describe('channel status follows its connections', () => {
  const primary = { id: 'ev', provider: 'evolution' as const, status: 'connected', eligible: true, health: 'healthy' as const, verifiedPhoneNumber: '5547999990000', lastHealthyAt: new Date(), lifecycleGeneration: 0 };
  const secondary = { ...primary, id: 'wa', provider: 'waha' as const };
  it('uses routing identity and lifecycle fences for WAHA-only, Evolution-only and both-down states', async () => {
    const { logicalChannelStatus } = await import('./channel-health-monitor.js');
    const offline = { ...primary, status: 'disconnected', eligible: false };
    expect(logicalChannelStatus([offline, secondary])).toBe('connected');
    expect(logicalChannelStatus([offline, { ...secondary, eligible: false }])).toBe('disconnected');
    expect(logicalChannelStatus([offline, { ...secondary, verifiedPhoneNumber: '5511888882222' }])).toBe('disconnected');
    expect(logicalChannelStatus([offline, { ...secondary, lastHealthyAt: null }])).toBe('disconnected');
    expect(logicalChannelStatus([offline, { ...secondary, health: 'unhealthy' }])).toBe('disconnected');
    expect(logicalChannelStatus([offline, { ...secondary, lifecycleGeneration: 1 }])).toBe('disconnected');
    expect(logicalChannelStatus([offline, secondary], false)).toBe('disconnected');
    expect(logicalChannelStatus([primary, { ...secondary, status: 'disconnected', eligible: false }])).toBe('connected');
    expect(logicalChannelStatus([{ ...primary, lifecycleGeneration: 1 }, secondary])).toBe('connected');
    expect(logicalChannelStatus([{ ...primary, health: 'unhealthy' }])).toBe('disconnected');
    expect(logicalChannelStatus([])).toBeNull();
  });
  it('publishes a status transition already persisted by the probe and never reverts a healthy WAHA', async () => {
    const { createChannelHealthMonitor } = await import('./channel-health-monitor.js');
    const channel = { id: 'c', workspaceId: 'w', status: 'disconnected', redundancyEnabled: true, activeConnectionId: secondary.id };
    const connections = [{ ...primary, status: 'disconnected', eligible: false }, secondary];
    const onStatusChange = vi.fn();
    const db = {
      channel: { findMany: async () => [{ ...channel }], findFirst: async () => ({ ...channel }), updateMany: async ({ where, data }: any) => { if (where.status && channel.status !== where.status) return { count: 0 }; if (data.status) channel.status = data.status; return { count: 1 }; } },
      channelConnection: { findMany: async () => connections }, $queryRaw: async () => []
    };
    (db as any).$transaction = async (run: any) => run(db);
    const monitor = createChannelHealthMonitor({ db: db as never, probe: async () => { channel.status = 'connected'; }, onStatusChange });
    await monitor.tick();
    expect(channel.status).toBe('connected');
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'w', channelId: 'c' });
    await monitor.tick();
    expect(channel.status).toBe('connected');
    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });
});

describe('a probe that never answers', () => {
  it('times out and the round goes on to the other numbers; the next round starts normally', async () => {
    const { createChannelHealthMonitor } = await import('./channel-health-monitor.js');
    const channels = [{ id: 'c1', workspaceId: 'w', status: 'connected' }, { id: 'c2', workspaceId: 'w', status: 'connected' }];
    const db = {
      channel: {
        findMany: async () => channels,
        findFirst: async ({ where }: any) => ({ id: where.id, workspaceId: 'w', redundancyEnabled: false, activeConnectionId: null }),
        updateMany: async () => ({ count: 0 })
      },
      channelConnection: { findMany: async ({ where }: any) => [{ id: `${where.channelId}-conn`, provider: 'waha', status: 'connected', eligible: true }] },
      $queryRaw: async () => []
    };
    (db as any).$transaction = async (run: any) => run(db);
    const probed: string[] = [];
    const warnings: string[] = [];
    const monitor = createChannelHealthMonitor({ db: db as never, probeTimeoutMs: 30,
      probe: async (scope) => { probed.push(scope.connectionId); if (scope.channelId === 'c1') await new Promise(() => {}); },
      logger: { warn: (_fields, message) => { warnings.push(message); } } });
    await monitor.tick();
    expect(probed).toEqual(['c1-conn', 'c2-conn']);
    expect(warnings).toContain('Connection probe failed');
    await monitor.tick();
    expect(probed).toEqual(['c1-conn', 'c2-conn', 'c1-conn', 'c2-conn']);
  });

  it('a round stuck for longer than the limit no longer blocks the next one', async () => {
    const { createChannelHealthMonitor } = await import('./channel-health-monitor.js');
    let calls = 0;
    const db = { channel: { findMany: async () => { calls += 1; if (calls === 1) await new Promise(() => {}); return []; } },
      channelConnection: { findMany: async () => [] }, $queryRaw: async () => [] };
    const monitor = createChannelHealthMonitor({ db: db as never, probe: async () => undefined, stuckTickMs: 20, logger: { warn: () => undefined } });
    void monitor.tick();
    await monitor.tick();
    expect(calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await monitor.tick();
    expect(calls).toBe(2);
  });
});
