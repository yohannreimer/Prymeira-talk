import { describe, expect, it, vi } from 'vitest';
import type { ChannelDto, ChannelQrResultDto } from '@prymeira-talk/shared';
import { createExtensionConnectionService, extensionConnectionAvailable } from './browser-extension-connection.js';

const channelId = '00000000-0000-4000-8000-000000000001';
const auth = { workspaceId: 'workspace-A', clerkUserId: 'user-A', role: 'owner' as const };
const account = { channelId, selfAddress: '5547991234567@s.whatsapp.net' };
const now = Date.parse('2026-11-12T12:00:00Z');
function fixture() {
  const row = { id: channelId, workspaceId: auth.workspaceId, provider: 'evolution', phoneNumber: '5547991234567',
    verifiedMessagingPhoneNumber: '5547991234567', redundancyEnabled: true, archivedAt: null };
  let dto: ChannelDto = { ...row, provider: 'evolution', providerKey: 'owned-session', displayName: 'Prymeira', status: 'disconnected',
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), connections: [
      { id: 'primary', channelId, provider: 'evolution', sessionName: 'owned-session', status: 'disconnected', health: 'unknown', eligible: false, isActiveWriter: false, verifiedPhoneNumber: row.phoneNumber, lastCheckedAt: new Date(now).toISOString() },
      { id: 'reserve', channelId, provider: 'waha', sessionName: 'owned-reserve', status: 'disconnected', health: 'unknown', eligible: false, isActiveWriter: false, verifiedPhoneNumber: row.phoneNumber, lastCheckedAt: new Date(now).toISOString() },
    ] };
  const db = { userProfile: { findFirst: vi.fn(async () => ({ id: 'profile-A' })) },
    channel: { findFirst: vi.fn(async ({ where }) => where.workspaceId === row.workspaceId && where.id === row.id && !row.archivedAt ? row : null) } };
  const qr = (): ChannelQrResultDto => ({ mode: 'real', channel: dto, connectionId: 'reserve', provider: 'waha', qrCode: '2@private-qr', qr: { payload: '2@private-qr', expiresAt: new Date(now + 20_000).toISOString() } });
  const physical = { describe: vi.fn(async () => dto), ensurePrimary: vi.fn(), refresh: vi.fn(async () => ({ mode: 'real' as const, channel: dto })), startQr: vi.fn(async () => qr()) };
  const primary = { startQrSession: vi.fn(async () => ({ ...qr(), provider: 'evolution' as const, connectionId: 'primary' })) };
  const wahaEnabled = vi.fn(() => true);
  const clearManualDisconnect = vi.fn();
  const service = createExtensionConnectionService(db as never, { physical, primary, wahaEnabled, clearManualDisconnect, now: () => now });
  const healthy = (index: number) => { dto.connections![index] = { ...dto.connections![index]!, status: 'connected', health: 'healthy', eligible: true }; };
  return { service, db, row, dto, physical, primary, wahaEnabled, clearManualDisconnect, healthy, qr };
}
describe('reconnect only when the WhatsApp has no usable connection', () => {
  it.each([0, 1])('one usable connection (%s) is healthy and clicking reconnect never starts any QR', async index => {
    const f = fixture(); f.healthy(index);
    expect((await f.service.status(auth, account)).available).toBe(true);
    expect(await f.service.reconnect(auth, account)).toMatchObject({ available: true, qr: null });
    expect(f.physical.startQr).not.toHaveBeenCalled(); expect(f.primary.startQrSession).not.toHaveBeenCalled();
  });
  it('does not mistake a connected but ineligible, wrong-number or unhealthy session for availability', () => {
    const f = fixture(); f.dto.connections![0]!.status = 'connected'; f.dto.connections![0]!.health = 'healthy';
    expect(extensionConnectionAvailable(f.dto)).toBe(false);
    f.healthy(0); f.dto.connections![0]!.health = 'unhealthy';
    expect(extensionConnectionAvailable(f.dto)).toBe(false);
  });
  it('returns only the QR and public account status for an already-enabled connection', async () => {
    const f = fixture();
    expect(await f.service.reconnect(auth, account)).toEqual({ channelId, phoneNumber: '5547991234567', available: false, canReconnect: true,
      qr: { connectionId: 'reserve', provider: 'waha', code: '2@private-qr', expiresAt: new Date(now + 20_000).toISOString() } });
    expect(f.physical.startQr).toHaveBeenCalledWith({ workspaceId: auth.workspaceId, channelId, connectionId: 'reserve' });
    expect(f.clearManualDisconnect).toHaveBeenCalledWith(channelId);
  });
  it('uses Evolution without enabling a disabled reserve', async () => {
    const f = fixture(); f.row.redundancyEnabled = false;
    expect((await f.service.reconnect(auth, account)).qr?.provider).toBe('evolution');
    expect(f.physical.startQr).not.toHaveBeenCalled();
  });
  it('does not count a reserve that is outside this workspace rollout', async () => {
    const f = fixture(); f.healthy(1); f.wahaEnabled.mockReturnValue(false);
    expect((await f.service.status(auth, account)).available).toBe(false);
    expect((await f.service.reconnect(auth, account)).qr?.provider).toBe('evolution');
    expect(f.physical.startQr).not.toHaveBeenCalled();
  });
  it('falls back to the existing primary when the reserve server is unavailable', async () => {
    const f = fixture(); f.physical.startQr.mockRejectedValue(new Error('network unavailable'));
    expect((await f.service.reconnect(auth, account)).qr?.provider).toBe('evolution');
  });
  it('does not hide an ownership conflict by generating another provider QR', async () => {
    const f = fixture(); f.physical.startQr.mockRejectedValue(Object.assign(new Error('conflict'), { code: 'WAHA_SESSION_CONFLICT' }));
    await expect(f.service.reconnect(auth, account)).rejects.toMatchObject({ code: 'WAHA_SESSION_CONFLICT' });
    expect(f.primary.startQrSession).not.toHaveBeenCalled();
  });
  it('waits for a starting reserve instead of creating two parallel QR sessions', async () => {
    const f = fixture(); f.physical.startQr.mockRejectedValue(Object.assign(new Error('pending'), { code: 'WAHA_QR_PENDING' }));
    await expect(f.service.reconnect(auth, account)).rejects.toMatchObject({ code: 'EXTENSION_QR_PENDING' });
    expect(f.primary.startQrSession).not.toHaveBeenCalled();
  });
  it('blocks another tenant, number, unverified number and archived channel before provider I/O', async () => {
    for (const kind of ['tenant', 'number', 'unverified', 'archived']) {
      const f = fixture();
      if (kind === 'unverified') f.row.verifiedMessagingPhoneNumber = null as never;
      if (kind === 'archived') f.row.archivedAt = new Date() as never;
      await expect(f.service.reconnect(kind === 'tenant' ? { ...auth, workspaceId: 'workspace-B' } : auth,
        kind === 'number' ? { ...account, selfAddress: '5511999999999@s.whatsapp.net' } : account)).rejects.toBeInstanceOf(Error);
      expect(f.physical.refresh).not.toHaveBeenCalled(); expect(f.physical.startQr).not.toHaveBeenCalled();
    }
  });
  it('allows agents to see availability but not reconnect a channel', async () => {
    const f = fixture(); const agent = { ...auth, role: 'agent' as const };
    expect((await f.service.status(agent, account)).canReconnect).toBe(false);
    await expect(f.service.reconnect(agent, account)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.physical.startQr).not.toHaveBeenCalled();
  });
  it('discards a QR if another connection recovered while it was being generated', async () => {
    const f = fixture(); f.physical.startQr.mockImplementation(async () => { f.healthy(0); return f.qr(); });
    expect(await f.service.reconnect(auth, account)).toMatchObject({ available: true, qr: null });
  });
  it('rejects an expired or simulated QR rather than showing success', async () => {
    for (const kind of ['expired', 'simulated']) {
      const f = fixture(); f.physical.startQr.mockResolvedValue({ ...f.qr(), ...(kind === 'simulated' ? { mode: 'simulated' as const } : { qr: { payload: 'old', expiresAt: new Date(now - 1).toISOString() } }) });
      await expect(f.service.reconnect(auth, account)).rejects.toMatchObject({ code: 'EXTENSION_QR_UNAVAILABLE' });
    }
  });
  it('uses one shared probe when multiple panels query stale status', async () => {
    const f = fixture(); f.dto.connections!.forEach(c => { c.lastCheckedAt = null; });
    await Promise.all([f.service.status(auth, account), f.service.status(auth, account)]);
    expect(f.physical.refresh).toHaveBeenCalledTimes(2); // once per enabled provider, not once per panel
  });
  it('never serves a cached QR after that reserve is disabled', async () => {
    const f = fixture(); await f.service.reconnect(auth, account); f.row.redundancyEnabled = false;
    await expect(f.service.reconnect(auth, account)).rejects.toMatchObject({ code: 'EXTENSION_QR_UNAVAILABLE' });
    expect(f.physical.startQr).toHaveBeenCalledTimes(1);
  });
  it('shares a slow QR operation and returns its issued code on retry instead of restarting it', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let release!: (value: ChannelQrResultDto) => void;
      f.physical.startQr.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      const first = f.service.reconnect(auth, account);
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await first).toMatchObject({ available: false, pending: true, qr: null });
      expect(f.physical.startQr).toHaveBeenCalledTimes(1);
      release(f.qr()); await vi.advanceTimersByTimeAsync(1);
      expect((await f.service.reconnect(auth, account)).qr?.code).toBe('2@private-qr');
      expect(f.physical.startQr).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('does not accept a QR issued for another physical connection', async () => {
    const f = fixture(); f.physical.startQr.mockResolvedValue({ ...f.qr(), connectionId: 'unrelated-connection' });
    await expect(f.service.reconnect(auth, account)).rejects.toMatchObject({ code: 'EXTENSION_QR_UNAVAILABLE' });
  });
});
