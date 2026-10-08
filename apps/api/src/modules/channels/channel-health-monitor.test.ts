import { describe, expect, it } from 'vitest';

describe('channel status follows its connections', () => {
  it('stays connected on WAHA proven on the same phone while Evolution is down', async () => {
    const { logicalChannelStatus } = await import('./channel-health-monitor.js');
    expect(logicalChannelStatus([{ provider: 'evolution', status: 'disconnected', eligible: false }, { provider: 'waha', status: 'connected', eligible: true }])).toBe('connected');
    expect(logicalChannelStatus([{ provider: 'evolution', status: 'disconnected', eligible: false }, { provider: 'waha', status: 'connected', eligible: false }])).toBe('disconnected');
    expect(logicalChannelStatus([{ provider: 'evolution', status: 'connected', eligible: true }])).toBe('connected');
    expect(logicalChannelStatus([])).toBeNull();
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
