import { describe, expect, it } from 'vitest';
import { channelSchema, channelQrResultSchema } from './domain.js';
import { realtimeEventSchema } from './realtime.js';

const channel = { id: 'ch', workspaceId: 'ws', provider: 'evolution', providerKey: 'existing', phoneNumber: null, displayName: 'Channel', status: 'connected', createdAt: '2026-09-30T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z' };
const connection = { id: 'physical', channelId: 'ch', provider: 'waha', sessionName: 'globally-unique', status: 'connected', health: 'degraded', verifiedPhoneNumber: '5547999990000', eligible: false, isActiveWriter: false, lastCheckedAt: null };
describe('additive physical connection contracts', () => {
  it('keeps logical providers and legacy DTOs while preserving separate health and connected count', () => {
    expect(channelSchema.safeParse(channel).success).toBe(true);
    const value = channelSchema.parse({ ...channel, redundancyEnabled: true, activeConnectionId: 'evo', connections: [connection], connectedCount: 1, connectionTotal: 2 });
    expect(value).toMatchObject({ provider: 'evolution', redundancyEnabled: true, connectedCount: 1, connectionTotal: 2, connections: [connection] });
    expect(channelSchema.safeParse({ ...channel, provider: 'waha' }).success).toBe(false);
  });
  it('preserves QR provider and physical identity in responses and events', () => {
    const qr = { mode: 'real', channel, qrCode: 'raw', connectionId: 'physical', provider: 'waha', qr: { payload: 'raw', expiresAt: '2026-09-30T12:01:00.000Z', issuedAt: '2026-09-30T12:00:00.000Z' } };
    expect(channelQrResultSchema.parse(qr)).toMatchObject({ connectionId: 'physical', provider: 'waha', qr: { issuedAt: qr.qr.issuedAt } });
    expect(realtimeEventSchema.parse({ type: 'channel.qr_updated', workspaceId: 'ws', payload: { channelId: 'ch', connectionId: 'physical', provider: 'waha', qrCode: 'raw', expiresAt: qr.qr.expiresAt, issuedAt: qr.qr.issuedAt } })).toMatchObject({ payload: { connectionId: 'physical', provider: 'waha', issuedAt: qr.qr.issuedAt } });
  });
});
