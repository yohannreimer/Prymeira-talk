import { describe, expect, it, vi } from 'vitest';
import { WahaClientError } from '../waha/waha.client.js';

const load = () => import('./channel-connections.js');
const ch = '00000000-0000-4000-8000-000000000001';
const evo = '00000000-0000-4000-8000-000000000002';
const wahaId = '00000000-0000-4000-8000-000000000003';
function fixture() {
  let channel: any = { id: ch, workspaceId: 'ws', provider: 'evolution', providerKey: 'evo-existing', phoneNumber: '+55 47 99999-0000', status: 'connected', displayName: 'Comercial', redundancyEnabled: true, verifiedMessagingPhoneNumber: null, connectionLifecycleGeneration: 0, activeConnectionId: evo, createdAt: new Date(), updatedAt: new Date() };
  const records: any[] = [
    { id: evo, workspaceId: 'ws', channelId: ch, provider: 'evolution', sessionName: 'evo-existing', status: 'connected', health: 'healthy', lifecycleGeneration: 0, verifiedPhoneNumber: '5547999990000', eligible: true },
    { id: wahaId, workspaceId: 'ws', channelId: ch, provider: 'waha', sessionName: 'talk-waha', status: 'connecting', health: 'unknown', lifecycleGeneration: 0, verifiedPhoneNumber: null, eligible: false }
  ];
  const matches = (r: any, where: any) => Object.entries(where).every(([k,v]) => r[k] === v);
  const apply = (record: any, data: any) => { for (const [key, value] of Object.entries(data)) record[key] = value && typeof value === 'object' && 'increment' in value ? (record[key] ?? 0) + (value as any).increment : value; return { ...record }; };
  const prisma: any = {
    channel: { findMany: vi.fn(async ({ where }) => matches(channel, where) ? [{ ...channel }] : []), findFirst: vi.fn(async ({ where }) => matches(channel, where) ? { ...channel } : null), update: vi.fn(async ({ data }) => apply(channel, data)), updateMany: vi.fn(async ({ where, data }) => { if (!matches(channel, where)) return { count: 0 }; apply(channel, data); return { count: 1 }; }) },
    channelConnection: {
      findMany: vi.fn(async ({ where }) => records.filter((r) => matches(r, where)).map((r) => ({ ...r }))),
      findFirst: vi.fn(async ({ where }) => records.find((r) => matches(r, where)) ? { ...records.find((r) => matches(r, where)) } : null),
      upsert: vi.fn(async ({ where, create }) => {
        const record = records.find((r) => matches(r, where.workspaceId_channelId_provider));
        if (record) return { ...record };
        const value = { id: wahaId, ...create }; records.push(value); return value;
      }),
      updateMany: vi.fn(async ({ where, data }) => { const found = records.filter((r) => matches(r, where)); found.forEach((record) => apply(record, data)); return { count: found.length }; }),
      update: vi.fn(async ({ where, data }) => { const record = records.find((r) => matches(r, where.workspaceId_id)); return apply(record, data); })
    },
    $transaction: vi.fn(async (fn) => {
      const beforeChannel = { ...channel }; const beforeRecords = records.map((r) => ({ ...r }));
      try { return await fn(prisma); }
      catch (error) { channel = beforeChannel; records.splice(0, records.length, ...beforeRecords); throw error; }
    })
  };
  const client: any = { getVersion: vi.fn(async () => ({ version: '2026.9.1', engine: 'WPP' })), getSession: vi.fn(async () => ({ name: 'talk-waha', status: 'WORKING', engine: { engine: 'WPP', state: 'CONNECTED' }, config: { metadata: { workspaceId: 'ws', channelId: ch } } })), getMe: vi.fn(async () => ({ id: '5547999990000@c.us' })), getQr: vi.fn(async () => 'secondary-qr'), createSession: vi.fn(), startSession: vi.fn(), stopSession: vi.fn(), logoutSession: vi.fn(), deleteSession: vi.fn() };
  const evolution: any = { mode: 'real', client: { getConnectionState: vi.fn(async () => 'open'), getInstanceIdentity: vi.fn(async () => '5547999990000@s.whatsapp.net'), logoutInstance: vi.fn() } };
  return { prisma, client, evolution, channel: () => channel, records };
}
describe('physical channel lifecycle', () => {
  it.each(['refresh', 'startQr', 'disconnect'] as const)('rejects ambiguous WAHA physical ownership before %s provider I/O', async action => {
    const f = fixture();
    f.records.push({ ...f.records[1], id: 'foreign', workspaceId: 'other', channelId: 'other-channel' });
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await expect(service[action]({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'PHYSICAL_CONNECTION_CONFLICT' });
    expect(f.client.getVersion).not.toHaveBeenCalled();
    expect(f.client.getSession).not.toHaveBeenCalled();
    expect(f.client.logoutSession).not.toHaveBeenCalled();
    expect(f.evolution.client.getInstanceIdentity).not.toHaveBeenCalled();
  });
  it('rejects ambiguous primary ownership before probing it to qualify WAHA', async () => {
    const f = fixture();
    f.prisma.channel.findMany.mockResolvedValue([f.channel(), { ...f.channel(), workspaceId: 'other', id: 'foreign' }]);
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await expect(service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'PHYSICAL_CONNECTION_CONFLICT' });
    expect(f.evolution.client.getInstanceIdentity).not.toHaveBeenCalled();
    expect(f.client.getSession).not.toHaveBeenCalled();
  });
  it('rejects a QR from an enabled snapshot after disable completes without any new provider or persisted effect', async () => {
    const f = fixture();
    f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'STOPPED', engine: {}, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    let release!: () => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    f.prisma.channelConnection.findFirst.mockImplementationOnce(async () => { entered(); await resume; return { ...f.records.find((r) => r.id === wahaId) }; });
    const qr = service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId }).then((result) => result, (error) => error);
    await paused;
    await service.setRedundancy({ workspaceId: 'ws', channelId: ch, enabled: false });
    const channel = { ...f.channel() }; const records = f.records.map((r) => ({ ...r }));
    release();
    expect(await qr).toMatchObject({ code: 'REDUNDANCY_DISABLED', statusCode: 409 });
    expect(f.channel()).toEqual(channel);
    expect(f.records).toEqual(records);
    expect(f.client.getVersion).toHaveBeenCalledTimes(1);
    expect(f.client.getSession).toHaveBeenCalledTimes(1);
    expect(f.client.startSession).not.toHaveBeenCalled();
    expect(f.client.createSession).not.toHaveBeenCalled();
    expect(f.client.getQr).not.toHaveBeenCalled();
  });

  it('rejects enable during a pending disable without changing redundancy settings', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    let release!: () => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    f.client.stopSession.mockImplementationOnce(() => { entered(); return new Promise<void>((resolve) => { release = resolve; }); });
    const disable = service.setRedundancy({ workspaceId: 'ws', channelId: ch, enabled: false });
    await paused;
    const physical = f.records.map((r) => ({ ...r }));
    let attempt: unknown; let enabledDuringStop: boolean;
    try {
      attempt = await service.setRedundancy({ workspaceId: 'ws', channelId: ch, enabled: true }).then((result) => result, (error) => error);
      enabledDuringStop = f.channel().redundancyEnabled;
      expect(f.records).toEqual(physical);
    } finally { release(); await disable; }
    expect(attempt).toMatchObject({ code: 'LIFECYCLE_IN_PROGRESS', statusCode: 409 });
    expect(enabledDuringStop!).toBe(false);
    expect(f.channel().redundancyEnabled).toBe(false);
    expect(f.client.stopSession).toHaveBeenCalledTimes(1);
  });

  it('rejects logout while secondary QR I/O is pending without mutating that remote session', async () => {
    const f = fixture();
    f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'STOPPED', engine: {}, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    let release!: (qr: string) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    f.client.getQr.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const pending = service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    await paused;
    const connecting = { ...f.records.find((r) => r.id === wahaId) };
    await expect(service.disconnect({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'LIFECYCLE_IN_PROGRESS', statusCode: 409 });
    expect(f.records.find((r) => r.id === wahaId)).toEqual(connecting);
    expect(f.client.logoutSession).not.toHaveBeenCalled();
    expect(f.client.stopSession).not.toHaveBeenCalled();
    release('current-qr');
    expect(await pending).toMatchObject({ provider: 'waha', qrCode: 'current-qr' });
    expect(f.evolution.client.logoutInstance).not.toHaveBeenCalled();
  });
  it.each(['changed-owner', 'restricted', 'stopped', 'qualification-failed'] as const)('keeps a newer protective %s observation after releasing an older healthy probe', async (decision) => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    const scope = { workspaceId: 'ws', channelId: ch, connectionId: wahaId };
    await service.refresh(scope);
    let release!: (phone: string) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    f.evolution.client.getInstanceIdentity.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const older = service.refresh(scope);
    await paused;
    const previousGeneration = f.channel().connectionLifecycleGeneration;
    if (decision === 'changed-owner') {
      f.evolution.client.getInstanceIdentity.mockResolvedValue(null);
      f.client.getMe.mockResolvedValue({ id: '5511888882222@c.us' });
    } else if (decision === 'restricted') f.client.getMe.mockResolvedValue({ id: '5547999990000@c.us', reachoutTimelock: { isActive: true } });
    else if (decision === 'stopped') f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'STOPPED', engine: {}, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
    else f.client.getVersion.mockResolvedValue({ version: '2026.7.2', engine: 'NOWEB' });
    if (decision === 'qualification-failed') await expect(service.refresh(scope)).rejects.toMatchObject({ code: 'WAHA_ENGINE_UNSUPPORTED' });
    else await service.refresh(scope);
    const protectedState = f.records.map((r) => ({ ...r }));
    expect(f.records.find((r) => r.id === wahaId).eligible).toBe(false);
    release('5547999990000@s.whatsapp.net');
    const result = await older;
    expect(f.records).toEqual(protectedState);
    expect(f.channel().connectionLifecycleGeneration).toBeGreaterThan(previousGeneration);
    expect(result.channel.connections!.find((r) => r.id === wahaId)?.eligible).toBe(false);
  });
  it('never treats an existing odd token as abandoned during an ordinary lifecycle request', async () => {
    const f = fixture();
    f.records.find((r) => r.id === wahaId).lifecycleGeneration = 7;
    f.channel().activeConnectionId = null;
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    const scope = { workspaceId: 'ws', channelId: ch, connectionId: wahaId };
    await expect(service.startQr(scope)).rejects.toMatchObject({ code: 'LIFECYCLE_IN_PROGRESS' });
    await expect(service.disconnect(scope)).rejects.toMatchObject({ code: 'LIFECYCLE_IN_PROGRESS' });
    await expect(service.setRedundancy({ workspaceId: 'ws', channelId: ch, enabled: true })).rejects.toMatchObject({ code: 'LIFECYCLE_IN_PROGRESS' });
    expect(f.channel().activeConnectionId).toBeNull();
    expect(f.records.find((r) => r.id === wahaId).lifecycleGeneration).toBe(7);
    expect(f.client.getVersion).not.toHaveBeenCalled();
  });
  it('blocks probes completing inside a pending logout and preserves the sending fence', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    let finishLogout!: () => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    f.client.logoutSession.mockImplementationOnce(() => { entered(); return new Promise<void>((resolve) => { finishLogout = resolve; }); });
    const logout = service.disconnect({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    await paused;
    const fenced = { ...f.records.find((r) => r.id === wahaId) };
    expect(fenced).toMatchObject({ eligible: false, verifiedPhoneNumber: null, lastHealthyAt: null });
    expect(fenced.lifecycleGeneration % 2).toBe(1);
    const during = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(during.channel.connections!.find((r) => r.id === wahaId)?.eligible).toBe(false);
    expect(f.records.find((r) => r.id === wahaId)).toEqual(fenced);
    expect(f.client.getMe).toHaveBeenCalledTimes(1);
    finishLogout(); await logout;
    expect(f.records.find((r) => r.id === wahaId)).toMatchObject({ status: 'disconnected', eligible: false });
    expect(f.records.find((r) => r.id === wahaId).lifecycleGeneration % 2).toBe(0);
  });
  it('disconnecting a stuck WAHA (timeout or 5xx) still ends the connection in Talk; a refusal does not', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.client.logoutSession.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await service.disconnect({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(f.records.find((r) => r.id === wahaId)).toMatchObject({ status: 'disconnected', eligible: false, lastError: 'REMOTE_STOP_UNCONFIRMED' });
    expect(f.records.find((r) => r.id === wahaId).lifecycleGeneration % 2).toBe(0);
    f.client.getSession.mockResolvedValueOnce({ name: 'talk-waha', status: 'WORKING', engine: { engine: 'WPP', state: 'CONNECTED' }, config: { metadata: { workspaceId: 'other', channelId: ch } } });
    await expect(service.disconnect({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'WAHA_SESSION_CONFLICT' });
  });
  it('discards a delayed failed Evolution probe after secondary logout', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    let rejectProbe!: (error: Error) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    f.evolution.client.getConnectionState.mockImplementationOnce(() => { entered(); return new Promise((_, reject) => { rejectProbe = reject; }); });
    const probe = service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
    await paused;
    await service.disconnect({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    const primary = { ...f.records.find((r) => r.id === evo) };
    rejectProbe(new Error('delayed network failure')); await probe;
    expect(f.records.find((r) => r.id === evo)).toEqual(primary);
  });

  it.each(['logout', 'disable', 'fresh-qr'] as const)('discards a delayed WAHA probe after %s revokes its lifecycle', async (action) => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    let release!: (owner: string) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    f.evolution.client.getInstanceIdentity.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const oldProbe = service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    await paused;
    if (action === 'logout') await service.disconnect({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    else if (action === 'disable') await service.setRedundancy({ workspaceId: 'ws', channelId: ch, enabled: false });
    else {
      f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'STOPPED', engine: {}, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
      await service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    }
    const revoked = { ...f.records.find((r) => r.id === wahaId) };
    const primary = { ...f.records.find((r) => r.id === evo) };
    release('5547999990000@s.whatsapp.net');
    const result = await oldProbe;
    expect(f.records.find((r) => r.id === wahaId)).toEqual(revoked);
    expect(f.records.find((r) => r.id === evo)).toEqual(primary);
    expect(result.channel.connections!.find((r) => r.id === wahaId)?.eligible).toBe(false);
    if (action === 'disable') expect(result.channel.redundancyEnabled).toBe(false);
  });

  it('persists connecting before a bounded QR retry and reports pending without restarting either session', async () => {
    const f = fixture();
    f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'STOPPED', engine: {}, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
    f.client.getQr.mockRejectedValue(new WahaClientError(422));
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    vi.useFakeTimers();
    try {
      const pending = service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId }).then((result: unknown) => result, (error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ code: 'WAHA_QR_PENDING', statusCode: 503 });
      expect(f.client.getQr).toHaveBeenCalledTimes(3);
      expect(f.records.find((r) => r.id === wahaId).lifecycleGeneration % 2).toBe(0);
      expect(f.client.startSession).toHaveBeenCalledTimes(1);
      expect(f.records.find((r) => r.id === wahaId)).toMatchObject({ status: 'connecting', eligible: false, health: 'unknown' });
      expect(f.evolution.client.logoutInstance).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('provisions a missing session with same-channel metadata and retries a not-yet-ready QR', async () => {
    const f = fixture();
    const stopped = { name: 'talk-waha', status: 'STOPPED', engine: {}, config: { metadata: { workspaceId: 'ws', channelId: ch } } };
    f.client.getSession.mockRejectedValueOnce(new WahaClientError(404)).mockResolvedValue(stopped);
    f.client.getQr.mockRejectedValueOnce(new WahaClientError(422)).mockResolvedValue('new-ready-qr');
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    vi.useFakeTimers();
    try {
      const pending = service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId }).then((result: unknown) => result, (error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ provider: 'waha', connectionId: wahaId, qrCode: 'new-ready-qr' });
      expect(f.client.createSession).toHaveBeenCalledWith({ session: 'talk-waha', workspaceId: 'ws', channelId: ch });
    } finally { vi.useRealTimers(); }
  });
  it('registers the signed ingress webhook of this exact connection when it provisions the session', async () => {
    const f = fixture();
    const stopped = { name: 'talk-waha', status: 'STOPPED', engine: {}, config: { metadata: { workspaceId: 'ws', channelId: ch } } };
    f.client.getSession.mockRejectedValueOnce(new WahaClientError(404)).mockResolvedValue(stopped);
    const webhook = { baseUrl: 'http://ingress:4011', hmacKey: 'shared-hmac-key-1234567' };
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client, webhook }, evolution: f.evolution });
    await service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(f.client.createSession).toHaveBeenCalledWith({ session: 'talk-waha', workspaceId: 'ws', channelId: ch,
      webhook: { url: `http://ingress:4011/webhooks/waha/ws/${wahaId}`, hmacKey: 'shared-hmac-key-1234567' } });
  });
  it('exposes physical connection management', async () => expect((await load()).createChannelConnectionsService).toBeTypeOf('function'));
  it('verifies both provider phones without replacing logical provider, writer or channel phone', async () => {
    const f = fixture(); const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    const result = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(result.channel).toMatchObject({ provider: 'evolution', providerKey: 'evo-existing', activeConnectionId: evo, connectedCount: 2, connectionTotal: 2 });
    expect(result.channel.connections!.find((r: any) => r.id === wahaId)).toMatchObject({ status: 'connected', eligible: true, isActiveWriter: false });
    expect(f.channel().phoneNumber).toBe('+55 47 99999-0000');
  });
  it('quarantines a wrong WhatsApp number as connected but degraded without touching Evolution', async () => {
    const f = fixture(); f.client.getMe.mockResolvedValue({ id: '5511999999999@c.us' });
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    const result = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(result.channel.connections!.find((r: any) => r.id === wahaId)).toMatchObject({ status: 'connected', health: 'degraded', eligible: false, lastError: 'PHONE_MISMATCH' });
    expect(f.channel().activeConnectionId).toBe(evo);
    expect(f.channel().phoneNumber).toBe('+55 47 99999-0000');
    expect(f.evolution.client.logoutInstance).not.toHaveBeenCalled();
  });
  it('requires actual primary identity rather than trusting a manually entered logical phone', async () => {
    const f = fixture(); f.evolution.client.getInstanceIdentity.mockResolvedValue(null); f.records[0].verifiedPhoneNumber = null;
    const result = await (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution }).refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(result.channel.connections!.find((r: any) => r.id === wahaId)).toMatchObject({ eligible: false, lastError: 'PRIMARY_PHONE_UNVERIFIED' });
  });
  it('keeps an already verified secondary healthy during a primary API outage using persisted pairing identity', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.evolution.client.getInstanceIdentity.mockRejectedValue(new Error('primary API unavailable'));
    const refreshed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(refreshed.channel.connections!.find((record) => record.id === wahaId)).toMatchObject({ status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '5547999990000', lastError: null });
    expect(f.channel().activeConnectionId).toBe(evo);
  });
  it('recovers the same proven WAHA after a temporary physical outage while Evolution is offline', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.evolution.client.getConnectionState.mockResolvedValue('close');
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
    f.evolution.client.getInstanceIdentity.mockRejectedValue(new Error('primary offline'));
    const working = await f.client.getSession();
    f.client.getSession.mockResolvedValue({ ...working, status: 'STOPPED', engine: {} });
    const down = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(down.channel.status).toBe('disconnected');
    expect(f.records[1]).toMatchObject({ verifiedPhoneNumber: '5547999990000', lastHealthyAt: expect.any(Date), eligible: false });
    f.client.getSession.mockResolvedValue(working);
    const recovered = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(recovered.channel).toMatchObject({ status: 'connected', activeConnectionId: wahaId });
    expect(recovered.channel.connections!.find(row => row.id === wahaId)?.eligible).toBe(true);
  });
  it('preserves a positively confirmed pairing when Evolution responds successfully without owner information', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.evolution.client.getInstanceIdentity.mockResolvedValue(null);
    const refreshed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(refreshed.channel.connections!.find((record) => record.id === wahaId)).toMatchObject({ status: 'connected', health: 'healthy', eligible: true });
    expect(f.records.find((record) => record.id === evo)).toMatchObject({ verifiedPhoneNumber: '5547999990000' });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
    expect(f.records.find((record) => record.id === evo)).toMatchObject({ verifiedPhoneNumber: '5547999990000' });
    expect(f.records.find((record) => record.id === wahaId)).toMatchObject({ eligible: true });
  });
  it('does not qualify an unpaired secondary from a no-owner response and does not erase cached primary identity', async () => {
    const f = fixture();
    f.evolution.client.getInstanceIdentity.mockResolvedValue(null);
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    for (let probe = 0; probe < 2; probe++) {
      const refreshed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
      expect(refreshed.channel.connections!.find((record) => record.id === wahaId)).toMatchObject({ status: 'connected', health: 'degraded', eligible: false, lastError: 'PRIMARY_PHONE_UNVERIFIED' });
      expect(f.records.find((record) => record.id === evo)).toMatchObject({ verifiedPhoneNumber: '5547999990000' });
    }
  });
  it('revokes confirmed pairing when current WAHA owner changes while Evolution owner is absent', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.evolution.client.getInstanceIdentity.mockResolvedValue(null);
    f.client.getMe.mockResolvedValue({ id: '5511888882222@c.us' });
    const changed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(changed.channel.connections!.find((record) => record.id === wahaId)?.eligible).toBe(false);
    expect(f.records.find((record) => record.id === wahaId).lastHealthyAt).toBeNull();
    f.client.getMe.mockResolvedValue({ id: '5547999990000@c.us' });
    for (let probe = 0; probe < 2; probe++) {
      const refreshed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
      expect(refreshed.channel.connections!.find((record) => record.id === wahaId)?.eligible).toBe(false);
    }
  });
  it('does not qualify an open primary without a current authenticated account identity', async () => {
    const f = fixture(); f.evolution.client.getInstanceIdentity.mockResolvedValue(null);
    const module = await load();
    await module.createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution }).refresh({ workspaceId: 'ws', channelId: ch, connectionId: f.records[0].id });
    expect(f.records[0]).toMatchObject({ status: 'connected', eligible: false });
  });

  it('preserves the last verified primary identity when a status probe reports it offline', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.evolution.client.getConnectionState.mockResolvedValue('close');
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
    expect(f.records.find((record) => record.id === evo)).toMatchObject({ status: 'disconnected', verifiedPhoneNumber: '5547999990000' });
    f.evolution.client.getInstanceIdentity.mockRejectedValue(new Error('primary offline'));
    const refreshed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(refreshed.channel.connections!.find((record) => record.id === wahaId)).toMatchObject({ health: 'healthy', eligible: true });
  });
  it('never qualifies a new secondary from a cached primary identity when the primary API is unavailable', async () => {
    const f = fixture();
    f.evolution.client.getInstanceIdentity.mockRejectedValue(new Error('primary API unavailable'));
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    const refreshed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(refreshed.channel.connections!.find((record) => record.id === wahaId)).toMatchObject({ status: 'connected', health: 'degraded', eligible: false, lastError: 'PRIMARY_PHONE_UNVERIFIED' });
  });
  it.each(['unavailable', 'without-owner'] as const)('revokes old pairing proof on a fresh secondary QR when primary is %s', async (primaryResponse) => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'STOPPED', engine: {}, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
    await service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'WORKING', engine: { engine: 'WPP', state: 'CONNECTED' }, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
    if (primaryResponse === 'unavailable') f.evolution.client.getInstanceIdentity.mockRejectedValue(new Error('primary unavailable'));
    else f.evolution.client.getInstanceIdentity.mockResolvedValue(null);
    for (let probe = 0; probe < 2; probe++) {
      const refreshed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
      expect(refreshed.channel.connections!.find((record) => record.id === wahaId)).toMatchObject({ eligible: false, lastError: 'PRIMARY_PHONE_UNVERIFIED' });
    }
  });
  it('fences a changed Evolution identity while preserving WAHA on the original account', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.evolution.client.getInstanceIdentity.mockResolvedValue('5511888882222@s.whatsapp.net');
    const refreshed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
    expect(refreshed.channel.connections!.find((record) => record.id === evo)).toMatchObject({ eligible: false, lastError: 'PHONE_MISMATCH' });
    expect(refreshed.channel.connections!.find((record) => record.id === wahaId)).toMatchObject({ health: 'healthy', eligible: true });
    expect(f.channel().verifiedMessagingPhoneNumber).toBe('5547999990000');
    expect(f.channel().phoneNumber).toBe('+55 47 99999-0000');
  });
  it('fences a changed primary against its prior verified identity before an anchor exists', async () => {
    const f = fixture();
    f.evolution.client.getInstanceIdentity.mockResolvedValue('5511888882222@s.whatsapp.net');
    const service = (await load()).createChannelConnectionsService(f.prisma, { evolution: f.evolution });
    for (let probe = 0; probe < 2; probe++) {
      const result = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
      expect(f.channel().verifiedMessagingPhoneNumber).toBe('5547999990000');
      expect(result.channel.connections!.find(row => row.id === evo)).toMatchObject({ eligible: false, lastError: 'PHONE_MISMATCH' });
      expect(result.channel.status).toBe('disconnected');
    }
  });
  it('anchors the first positively observed primary phone without using its display phone', async () => {
    const f = fixture();
    f.records[0].verifiedPhoneNumber = null;
    const service = (await load()).createChannelConnectionsService(f.prisma, { evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
    expect(f.channel().verifiedMessagingPhoneNumber).toBe('5547999990000');
    expect(f.records[0].eligible).toBe(true);
  });
  it('persists aggregate reconciliation for legacy callers without rewriting an unchanged channel', async () => {
    const f = fixture();
    Object.assign(f.records[0], { status: 'disconnected', eligible: false });
    Object.assign(f.records[1], { status: 'connected', eligible: true, health: 'healthy', verifiedPhoneNumber: f.records[0].verifiedPhoneNumber, lastHealthyAt: new Date() });
    f.channel().status = 'disconnected';
    const service = (await load()).createChannelConnectionsService(f.prisma);
    expect((await service.reconcile({ workspaceId: 'ws', channelId: ch })).status).toBe('connected');
    expect(f.channel().status).toBe('connected');
    f.prisma.channel.update.mockClear();
    await service.reconcile({ workspaceId: 'ws', channelId: ch });
    expect(f.prisma.channel.update).not.toHaveBeenCalled();
  });
  it('establishes a trusted channel anchor from WAHA alone without claiming Evolution was verified', async () => {
    const f = fixture();
    Object.assign(f.records[0], { status: 'disconnected', eligible: false, verifiedPhoneNumber: null });
    const evolution: any = { mode: 'real', providerConfigured: false, client: null };
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution });
    const result = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(result.channel.status).toBe('connected');
    expect(result.channel.activeConnectionId).toBe(wahaId);
    expect(result.mode).toBe('real');
    expect(f.channel().verifiedMessagingPhoneNumber).toBe('5547999990000');
    expect(f.records[0].verifiedPhoneNumber).toBeNull();
    expect(result.channel.connections!.find(row => row.id === wahaId)?.eligible).toBe(true);
    f.client.getMe.mockResolvedValue({ id: '5511888882222@c.us' });
    const changed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(changed.channel.connections!.find(row => row.id === wahaId)).toMatchObject({ eligible: false, lastError: 'PHONE_MISMATCH' });
    expect(f.channel().verifiedMessagingPhoneNumber).toBe('5547999990000');
    expect(f.records[1].lastHealthyAt).toBeNull();
  });
  it('onboards the first owned WAHA identity while configured Evolution is unreachable', async () => {
    const f = fixture();
    Object.assign(f.records[0], { status: 'disconnected', eligible: false, verifiedPhoneNumber: null });
    f.evolution.providerConfigured = true;
    f.evolution.client.getInstanceIdentity.mockRejectedValue(new Error('primary API unavailable'));
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    const result = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(f.channel().verifiedMessagingPhoneNumber).toBe('5547999990000');
    expect(result.channel).toMatchObject({ status: 'connected', activeConnectionId: wahaId });
    expect(result.channel.connections!.find(row => row.id === wahaId)).toMatchObject({ eligible: true, health: 'healthy' });
    expect(f.records[0]).toMatchObject({ verifiedPhoneNumber: null, eligible: false });
  });
  it.each(['stored-primary', 'observed-primary', 'changed-secondary'] as const)('does not bootstrap WAHA over %s identity evidence during primary outage', async conflict => {
    const f = fixture();
    Object.assign(f.records[0], { status: 'disconnected', eligible: false, verifiedPhoneNumber: conflict === 'stored-primary' ? '5547999990000' : null });
    f.evolution.providerConfigured = true;
    if (conflict === 'observed-primary') f.evolution.client.getInstanceIdentity.mockResolvedValue('5511888882222@s.whatsapp.net');
    else f.evolution.client.getInstanceIdentity.mockRejectedValue(new Error('primary API unavailable'));
    if (conflict === 'changed-secondary') Object.assign(f.records[1], { verifiedPhoneNumber: '5511888882222', lastError: 'PHONE_MISMATCH', lastHealthyAt: null });
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    const result = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(f.channel().verifiedMessagingPhoneNumber).toBeNull();
    expect(result.channel.connections!.find(row => row.id === wahaId)?.eligible).toBe(false);
  });
  it('does not establish an anchor from a conflicting primary, unready or restricted WAHA session', async () => {
    for (const condition of ['primary-conflict', 'engine-unready', 'restricted'] as const) {
      const f = fixture();
      f.records[0].verifiedPhoneNumber = condition === 'primary-conflict' ? '5511888882222' : null;
      if (condition === 'engine-unready') f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'WORKING', engine: { engine: 'WPP' }, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
      if (condition === 'restricted') f.client.getMe.mockResolvedValue({ id: '5547999990000@c.us', reachoutTimelock: { isActive: true } });
      const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: { mode: 'real', providerConfigured: false, client: null } as any });
      const result = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
      expect(result.channel.connections!.find(row => row.id === wahaId)?.eligible).toBe(false);
      expect(f.channel().verifiedMessagingPhoneNumber).toBeNull();
    }
  });
  it('preserves the proven WAHA writer through primary repair, failure, refresh and a changed identity', async () => {
    const f = fixture();
    const { writerCandidates } = await import('./outbound-routing.js');
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    f.evolution.client.getConnectionState.mockResolvedValue('close');
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
    f.evolution.client.getInstanceIdentity.mockRejectedValue(new Error('primary repair failed'));
    const operation = await service.beginPrimaryLifecycle(f.channel());
    expect(writerCandidates({ ...f.channel(), connections: f.records }).map(row => row.provider)).toEqual(['waha']);
    expect((await service.describe(f.channel())).status).toBe('connected');
    const duringRepair = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(duringRepair.channel.connections!.find(row => row.id === wahaId)?.eligible).toBe(true);
    await service.finishPrimaryLifecycle(operation);
    const refreshed = await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(refreshed.channel).toMatchObject({ status: 'connected', connectedCount: 1 });
    expect(f.channel().status).toBe('connected');
    expect(refreshed.channel.connections!.find(row => row.id === wahaId)).toMatchObject({ eligible: true, health: 'healthy' });
    f.evolution.client.getConnectionState.mockResolvedValue('open');
    f.evolution.client.getInstanceIdentity.mockResolvedValue('5511888882222@s.whatsapp.net');
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
    expect(f.records.find(row => row.id === evo)).toMatchObject({ eligible: false, lastHealthyAt: null, lastError: 'PHONE_MISMATCH' });
    expect(f.records.find(row => row.id === wahaId)).toMatchObject({ eligible: true, verifiedPhoneNumber: '5547999990000' });
    f.evolution.client.getConnectionState.mockResolvedValue('close');
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: evo });
    expect(writerCandidates({ ...f.channel(), connections: f.records }).map(row => row.provider)).toEqual(['waha']);
    expect((await service.describe(f.channel())).status).toBe('connected');
  });
  it('completes a primary disconnect without erasing the proven secondary or logical availability', async () => {
    const f = fixture();
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    const operation = await service.beginPrimaryLifecycle(f.channel());
    await service.completePrimaryLifecycle(operation, { status: 'disconnected' });
    expect(f.records.find(row => row.id === evo)).toMatchObject({ status: 'disconnected', verifiedPhoneNumber: '5547999990000' });
    expect(f.records.find(row => row.id === wahaId)).toMatchObject({ eligible: true });
    expect(f.channel().status).toBe('connected');
  });
  it('records probe failures and fences a previously eligible secondary when runtime qualification fails', async () => {
    const f = fixture();
    const secondary = f.records.find((record) => record.id === wahaId)!;
    Object.assign(secondary, { status: 'connected', health: 'healthy', eligible: true });
    f.client.getVersion.mockResolvedValue({ version: '2026.7.2', engine: 'NOWEB' });
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await expect(service.refresh({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'WAHA_ENGINE_UNSUPPORTED' });
    expect(secondary).toMatchObject({ health: 'unhealthy', eligible: false, lastError: 'WAHA_ENGINE_UNSUPPORTED', consecutiveFailures: 1 });
    expect(secondary.failureStartedAt).toBeInstanceOf(Date);
    expect(f.client.getSession).not.toHaveBeenCalled();
  });
  it('rejects wrong tenant/channel before any provider HTTP and Meta redundancy', async () => {
    const f = fixture(); const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await expect(service.startQr({ workspaceId: 'other', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: 'foreign' })).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    f.channel().provider = 'meta_cloud';
    await expect(service.setRedundancy({ workspaceId: 'ws', channelId: ch, enabled: true })).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_UNSUPPORTED' });
    expect(f.client.startSession).not.toHaveBeenCalled();
  });
  it('rejects non-WPP and wrongly owned WAHA sessions', async () => {
    const f = fixture(); const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'SCAN_QR_CODE', engine: { engine: 'NOWEB' }, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
    await expect(service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'WAHA_ENGINE_UNSUPPORTED' });
    f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'SCAN_QR_CODE', engine: { engine: 'WPP', state: 'CONNECTED' }, config: { metadata: { workspaceId: 'other', channelId: ch } } });
    await expect(service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'WAHA_SESSION_CONFLICT' });
    expect(f.client.startSession).not.toHaveBeenCalled();
  });
  it('allows newly provisioned STOPPED sessions with empty engine only after WPP server qualification', async () => {
    const f = fixture(); f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'STOPPED', engine: {}, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    expect((await service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).qrCode).toBe('secondary-qr');
    f.client.getVersion.mockResolvedValue({ version: '2026.9.1', engine: 'NOWEB' });
    await expect(service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'WAHA_ENGINE_UNSUPPORTED' });
    f.client.getVersion.mockResolvedValue({ version: '2026.7.2', engine: 'WPP' });
    await expect(service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId })).rejects.toMatchObject({ code: 'WAHA_VERSION_UNSUPPORTED' });
  });
  it('starts secondary QR independently and disconnects only its session', async () => {
    const f = fixture(); f.client.getSession.mockResolvedValue({ name: 'talk-waha', status: 'SCAN_QR_CODE', engine: { engine: 'WPP', state: 'CONNECTED' }, config: { metadata: { workspaceId: 'ws', channelId: ch } } });
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    const result = await service.startQr({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(result).toMatchObject({ connectionId: wahaId, provider: 'waha', qrCode: 'secondary-qr', channel: { status: 'connected', activeConnectionId: evo } });
    await service.disconnect({ workspaceId: 'ws', channelId: ch, connectionId: wahaId });
    expect(f.client.logoutSession).toHaveBeenCalledWith({ session: 'talk-waha' });
    expect(f.client.stopSession).toHaveBeenCalledWith({ session: 'talk-waha' });
    expect(f.evolution.client.logoutInstance).not.toHaveBeenCalled();
    expect(f.records[0].status).toBe('connected');
  });
  it('safely disables secondary, returning writer to same-channel Evolution first', async () => {
    const f = fixture(); f.channel().activeConnectionId = wahaId;
    f.client.stopSession.mockImplementation(async () => { expect(f.channel().activeConnectionId).toBe(evo); expect(f.channel().redundancyEnabled).toBe(false); });
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    await service.setRedundancy({ workspaceId: 'ws', channelId: ch, enabled: false });
    expect(f.records[1]).toMatchObject({ status: 'disconnected', eligible: false });
  });
  it('does not expose a foreign persisted writer as active', async () => {
    const f = fixture(); f.channel().activeConnectionId = 'foreign';
    const service = (await load()).createChannelConnectionsService(f.prisma, { waha: { enabled: true, client: f.client }, evolution: f.evolution });
    expect((await service.describe(f.channel())).activeConnectionId).toBeNull();
  });
  it('uses unique deterministic session identities even for workspaces with equal slugs and refuses disabled runtime', async () => {
    const module = await load(); expect(module.wahaSessionName('a/b', ch)).not.toBe(module.wahaSessionName('a-b', ch)); expect(module.wahaSessionName('ws', ch).length).toBeLessThanOrEqual(54);
    const f = fixture(); await expect(module.createChannelConnectionsService(f.prisma, { waha: { enabled: false, client: null } }).setRedundancy({ workspaceId: 'ws', channelId: ch, enabled: true })).rejects.toMatchObject({ code: 'WAHA_DISABLED' });
  });
});
