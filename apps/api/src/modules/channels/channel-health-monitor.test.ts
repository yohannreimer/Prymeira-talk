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
