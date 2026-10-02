import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChannelsService, type PrismaLike } from './channels.service.js';
import { createChannelConnectionsService } from './channel-connections.js';

const databaseUrl = process.env.CONNECTIONS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('physical connections on PostgreSQL', () => {
  let prisma: PrismaClient;
  const workspaceId = `connections-${randomUUID()}`;
  const otherWorkspace = `connections-${randomUUID()}`;
  let channelId: string;
  const remote: any = { getVersion: vi.fn(async () => ({ version: '2026.9.1', engine: 'WPP' })), createSession: vi.fn(), startSession: vi.fn(), getQr: vi.fn(async () => 'waha-qr'), getMe: vi.fn(async () => ({ id: '5547999990000@c.us' })), stopSession: vi.fn(), logoutSession: vi.fn(), deleteSession: vi.fn(), getSession: vi.fn(async ({ session }) => ({ name: session, status: 'SCAN_QR_CODE', engine: { engine: 'WPP' }, config: { metadata: { workspaceId, channelId } } })) };
  const evolution: any = { mode: 'real', webhookSecret: 'test', publicWebhookUrl: () => 'https://talk.test/webhook', client: { createInstance: vi.fn(async ({ instanceName }) => ({ instanceName, qrCode: 'evolution-qr' })), setWebhook: vi.fn(), logoutInstance: vi.fn(), getConnectionState: vi.fn(async () => 'open'), getInstanceIdentity: vi.fn(async () => '5547999990000@s.whatsapp.net') } };
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (!['postgresql:', 'postgres:'].includes(target.protocol) || !['127.0.0.1', 'localhost'].includes(target.hostname) || !['/campaign_test', '/connections_test'].includes(target.pathname)) throw new Error('Allowlisted local disposable connection database required.');
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => { if (prisma) { await prisma.channel.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspace] } } }); await prisma.$disconnect(); } });
  it('atomically creates the primary writer and maintains it through legacy QR/disconnect', async () => {
    const service = createChannelsService(prisma as unknown as PrismaLike, { evolution });
    const channel = await service.createChannel({ workspaceId, displayName: 'QA', phoneNumber: '+55 47 99999-0000' }); channelId = channel.id;
    expect(channel.connections).toHaveLength(1);
    expect(channel.activeConnectionId).toBe(channel.connections![0]!.id);
    const primaryId = channel.activeConnectionId!;
    const qr = await service.startQrSession({ workspaceId, channelId });
    expect(qr).toMatchObject({ connectionId: primaryId, provider: 'evolution' });
    expect(await prisma.channelConnection.findUnique({ where: { id: primaryId } })).toMatchObject({ status: 'connecting', sessionName: channel.providerKey });
    await service.disconnectChannel({ workspaceId, channelId });
    expect(await prisma.channelConnection.findUnique({ where: { id: primaryId } })).toMatchObject({ status: 'disconnected', eligible: false });
  });
  it('a workspace outside the staged rollout sees no WAHA option and cannot enable it', async () => {
    const service = createChannelConnectionsService(prisma, { evolution, waha: { enabled: true, client: remote, allows: (id: string) => id !== workspaceId } });
    const channel = await prisma.channel.findFirstOrThrow({ where: { workspaceId, id: channelId } });
    expect((await service.describe(channel)).redundancyAvailable).toBe(false);
    await expect(service.setRedundancy({ workspaceId, channelId, enabled: true })).rejects.toMatchObject({ code: 'WAHA_DISABLED' });
    expect((await prisma.channel.findFirstOrThrow({ where: { id: channelId } })).redundancyEnabled).toBe(false);
    expect(await prisma.channelConnection.count({ where: { channelId, provider: 'waha' } })).toBe(0);
  });
  it('allows concurrent idempotent enable and rejects cross-tenant physical records', async () => {
    const service = createChannelConnectionsService(prisma, { evolution, waha: { enabled: true, client: remote } });
    await Promise.all(Array.from({ length: 4 }, () => service.setRedundancy({ workspaceId, channelId, enabled: true })));
    expect(await prisma.channelConnection.count({ where: { workspaceId, channelId } })).toBe(2);
    await expect(prisma.channelConnection.create({ data: { workspaceId: otherWorkspace, channelId, provider: 'waha', sessionName: `foreign-${randomUUID()}` } })).rejects.toMatchObject({ code: 'P2003' });
    const foreign = await prisma.channel.create({ data: { workspaceId: otherWorkspace, provider: 'evolution', providerKey: 'other' } });
    const foreignConnection = await prisma.channelConnection.create({ data: { workspaceId: otherWorkspace, channelId: foreign.id, provider: 'evolution', sessionName: 'other' } });
    await prisma.channel.update({ where: { id: channelId }, data: { activeConnectionId: foreignConnection.id } });
    expect((await service.describe(await prisma.channel.findUniqueOrThrow({ where: { id: channelId } }))).activeConnectionId).toBeNull();
    const repaired = await service.setRedundancy({ workspaceId, channelId, enabled: true });
    expect(repaired.channel.activeConnectionId).toBe(repaired.channel.connections!.find((c) => c.provider === 'evolution')!.id);
  });
  it('persists confirmed pairing across offline primary probes and rejects a changed primary identity', async () => {
    const service = createChannelConnectionsService(prisma, { evolution, waha: { enabled: true, client: remote } });
    const secondary = await prisma.channelConnection.findFirstOrThrow({ where: { workspaceId, channelId, provider: 'waha' } });
    const primary = await prisma.channelConnection.findFirstOrThrow({ where: { workspaceId, channelId, provider: 'evolution' } });
    remote.getSession.mockResolvedValue({ name: secondary.sessionName, status: 'WORKING', engine: { engine: 'WPP' }, config: { metadata: { workspaceId, channelId } } });
    try {
      await service.refresh({ workspaceId, channelId, connectionId: secondary.id });
      expect(await prisma.channelConnection.findUnique({ where: { id: secondary.id } })).toMatchObject({ eligible: true, health: 'healthy', lastHealthyAt: expect.any(Date) });
      evolution.client.getInstanceIdentity.mockResolvedValue(null);
      const missingOwner = await service.refresh({ workspaceId, channelId, connectionId: secondary.id });
      expect(missingOwner.channel.connections!.find((record) => record.id === secondary.id)).toMatchObject({ eligible: true, health: 'healthy' });
      expect(await prisma.channelConnection.findUnique({ where: { id: primary.id } })).toMatchObject({ verifiedPhoneNumber: '5547999990000' });
      evolution.client.getConnectionState.mockResolvedValue('close');
      await service.refresh({ workspaceId, channelId, connectionId: primary.id });
      expect(await prisma.channelConnection.findUnique({ where: { id: primary.id } })).toMatchObject({ status: 'disconnected', verifiedPhoneNumber: '5547999990000' });
      evolution.client.getInstanceIdentity.mockRejectedValue(new Error('primary unavailable'));
      const continued = await service.refresh({ workspaceId, channelId, connectionId: secondary.id });
      expect(continued.channel.connections!.find((record) => record.id === secondary.id)).toMatchObject({ eligible: true, health: 'healthy' });
      evolution.client.getConnectionState.mockResolvedValue('open');
      evolution.client.getInstanceIdentity.mockResolvedValue('5511888882222@s.whatsapp.net');
      const changed = await service.refresh({ workspaceId, channelId, connectionId: primary.id });
      expect(changed.channel.connections!.find((record) => record.id === secondary.id)).toMatchObject({ eligible: false, health: 'degraded', lastError: 'PHONE_MISMATCH' });
    } finally {
      remote.getSession.mockImplementation(async ({ session }: { session: string }) => ({ name: session, status: 'SCAN_QR_CODE', engine: { engine: 'WPP' }, config: { metadata: { workspaceId, channelId } } }));
      evolution.client.getConnectionState.mockResolvedValue('open');
      evolution.client.getInstanceIdentity.mockResolvedValue('5547999990000@s.whatsapp.net');
    }
  });
  it.each(['logout', 'disable', 'fresh-qr', 'primary-logout', 'primary-qr', 'primary-reconnect'] as const)('rejects a WAHA observation begun before %s on real PostgreSQL', async (action) => {
    const channels = createChannelsService(prisma as unknown as PrismaLike, { evolution, waha: { enabled: true, client: remote } });
    const created = await channels.createChannel({ workspaceId, displayName: 'Race QA' });
    const scope = { workspaceId, channelId: created.id };
    const provider: any = { ...remote, getSession: vi.fn(async ({ session }) => ({ name: session, status: 'WORKING', engine: { engine: 'WPP' }, config: { metadata: scope } })) };
    const primaryProvider: any = { ...evolution, client: { ...evolution.client, getInstanceIdentity: vi.fn(async () => '5547999990000@s.whatsapp.net') } };
    const service = createChannelConnectionsService(prisma, { evolution: primaryProvider, waha: { enabled: true, client: provider } });
    const legacy = createChannelsService(prisma as unknown as PrismaLike, { evolution: primaryProvider, waha: { enabled: true, client: provider } });
    const enabled = await service.setRedundancy({ ...scope, enabled: true });
    const secondary = enabled.channel.connections!.find((r) => r.provider === 'waha')!;
    await service.refresh({ ...scope, connectionId: secondary.id });
    let release!: (phone: string) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    primaryProvider.client.getInstanceIdentity.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const pending = service.refresh({ ...scope, connectionId: secondary.id });
    await paused;
    if (action === 'logout') await service.disconnect({ ...scope, connectionId: secondary.id });
    else if (action === 'disable') await service.setRedundancy({ ...scope, enabled: false });
    else if (action === 'fresh-qr') {
      provider.getSession.mockImplementation(async ({ session }: { session: string }) => ({ name: session, status: 'STOPPED', engine: {}, config: { metadata: scope } }));
      await service.startQr({ ...scope, connectionId: secondary.id });
    } else if (action === 'primary-logout') await legacy.disconnectChannel(scope);
    else if (action === 'primary-qr') await legacy.startQrSession(scope);
    else await legacy.reconnectChannel(scope);
    const lifecycleState = await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } });
    release('5547999990000@s.whatsapp.net');
    const observed = await pending;
    expect(await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } })).toEqual(lifecycleState);
    expect(observed.channel.connections!.find((r) => r.provider === 'waha')?.eligible).toBe(false);
    expect(await prisma.channel.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ connectionLifecycleGeneration: expect.any(Number) });
    if (action === 'disable') expect(observed.channel.redundancyEnabled).toBe(false);
    if (action === 'logout' || action === 'fresh-qr') expect(lifecycleState.find((r) => r.provider === 'waha')).toMatchObject({ verifiedPhoneNumber: null, lastHealthyAt: null });
  });
  it('discards a delayed Evolution identity after primary logout on real PostgreSQL', async () => {
    const primaryProvider: any = { ...evolution, client: { ...evolution.client, getInstanceIdentity: vi.fn(async () => '5547999990000@s.whatsapp.net') } };
    const legacy = createChannelsService(prisma as unknown as PrismaLike, { evolution: primaryProvider });
    const created = await legacy.createChannel({ workspaceId, displayName: 'Primary race QA' });
    const scope = { workspaceId, channelId: created.id };
    const service = createChannelConnectionsService(prisma, { evolution: primaryProvider });
    let release!: (phone: string) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    primaryProvider.client.getInstanceIdentity.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const pending = service.refresh({ ...scope, connectionId: created.activeConnectionId! });
    await paused;
    await legacy.disconnectChannel(scope);
    const disconnected = await prisma.channelConnection.findUniqueOrThrow({ where: { id: created.activeConnectionId! } });
    release('5547999990000@s.whatsapp.net');
    await pending;
    expect(await prisma.channelConnection.findUnique({ where: { id: disconnected.id } })).toEqual(disconnected);
    expect(disconnected).toMatchObject({ status: 'disconnected', eligible: false, verifiedPhoneNumber: null });
  });
  it('finishes independent Evolution and WAHA QR requests even when they overlap', async () => {
    const primaryProvider: any = { ...evolution, client: { ...evolution.client, createInstance: vi.fn() } };
    let release!: (result: unknown) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    primaryProvider.client.createInstance.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const legacy = createChannelsService(prisma as unknown as PrismaLike, { evolution: primaryProvider });
    const created = await legacy.createChannel({ workspaceId, displayName: 'Independent QR QA' });
    const scope = { workspaceId, channelId: created.id };
    const provider: any = { ...remote, getSession: vi.fn(async ({ session }) => ({ name: session, status: 'STOPPED', engine: {}, config: { metadata: scope } })) };
    const service = createChannelConnectionsService(prisma, { evolution: primaryProvider, waha: { enabled: true, client: provider } });
    const enabled = await service.setRedundancy({ ...scope, enabled: true });
    const secondary = enabled.channel.connections!.find((r) => r.provider === 'waha')!;
    const first = legacy.startQrSession(scope);
    await paused;
    const second = await service.startQr({ ...scope, connectionId: secondary.id });
    release({ instanceName: created.providerKey, qrCode: 'independent-evolution-qr' });
    expect(await first).toMatchObject({ provider: 'evolution', qrCode: 'independent-evolution-qr' });
    expect(second).toMatchObject({ provider: 'waha', qrCode: 'waha-qr' });
    expect(await prisma.channelConnection.findMany({ where: scope })).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'evolution', status: 'connecting', eligible: false }),
      expect.objectContaining({ provider: 'waha', status: 'connecting', eligible: false })
    ]));
  });
  it.each(['logout', 'disable', 'fresh-qr', 'primary-logout', 'primary-qr'] as const)('keeps probes fenced while %s I/O is pending on PostgreSQL', async (action) => {
    const primaryProvider: any = { ...evolution, client: { ...evolution.client, createInstance: vi.fn(async ({ instanceName }: { instanceName: string }) => ({ instanceName, qrCode: 'evo-qr' })), logoutInstance: vi.fn(), getInstanceIdentity: vi.fn(async () => '5547999990000@s.whatsapp.net') } };
    const legacy = createChannelsService(prisma as unknown as PrismaLike, { evolution: primaryProvider });
    const created = await legacy.createChannel({ workspaceId, displayName: 'Pending lifecycle QA' });
    const scope = { workspaceId, channelId: created.id };
    const provider: any = { ...remote, getMe: vi.fn(async () => ({ id: '5547999990000@c.us' })), getQr: vi.fn(async () => 'waha-qr'), logoutSession: vi.fn(), stopSession: vi.fn(), getSession: vi.fn(async ({ session }: { session: string }) => ({ name: session, status: 'WORKING', engine: { engine: 'WPP' }, config: { metadata: scope } })) };
    const service = createChannelConnectionsService(prisma, { evolution: primaryProvider, waha: { enabled: true, client: provider } });
    const enabled = await service.setRedundancy({ ...scope, enabled: true });
    const secondary = enabled.channel.connections!.find((r) => r.provider === 'waha')!;
    await service.refresh({ ...scope, connectionId: secondary.id });
    let release!: (value?: unknown) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const remoteStep = action === 'logout' ? provider.logoutSession : action === 'disable' ? provider.stopSession : action === 'fresh-qr' ? provider.getQr : action === 'primary-logout' ? primaryProvider.client.logoutInstance : primaryProvider.client.createInstance;
    remoteStep.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    if (action === 'fresh-qr') provider.getSession.mockImplementation(async ({ session }: { session: string }) => ({ name: session, status: 'STOPPED', engine: {}, config: { metadata: scope } }));
    const pending = action === 'logout' ? service.disconnect({ ...scope, connectionId: secondary.id }) : action === 'disable' ? service.setRedundancy({ ...scope, enabled: false }) : action === 'fresh-qr' ? service.startQr({ ...scope, connectionId: secondary.id }) : action === 'primary-logout' ? legacy.disconnectChannel(scope) : legacy.startQrSession(scope);
    await paused;
    const fenced = await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } });
    const operating = fenced.find((r) => r.provider === (action.startsWith('primary') ? 'evolution' : 'waha'))!;
    expect(operating.lifecycleGeneration % 2).toBe(1);
    expect(fenced.find((r) => r.provider === 'waha')).toMatchObject({ eligible: false, lastHealthyAt: null });
    const observed = await service.refresh({ ...scope, connectionId: secondary.id });
    expect(observed.channel.connections!.find((r) => r.provider === 'waha')?.eligible).toBe(false);
    expect(await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } })).toEqual(fenced);
    expect(provider.getMe).toHaveBeenCalledTimes(1);
    release(action === 'fresh-qr' ? 'waha-qr' : action === 'primary-qr' ? { instanceName: created.providerKey, qrCode: 'evo-qr' } : undefined);
    await pending;
    expect((await prisma.channelConnection.findUniqueOrThrow({ where: { id: operating.id } })).lifecycleGeneration % 2).toBe(0);
  });
  it.each(['changed-owner', 'restricted'] as const)('persistently fences an older WAHA probe after a newer %s observation', async (decision) => {
    const primaryProvider: any = { ...evolution, client: { ...evolution.client, getInstanceIdentity: vi.fn(async () => '5547999990000@s.whatsapp.net') } };
    const legacy = createChannelsService(prisma as unknown as PrismaLike, { evolution: primaryProvider });
    const created = await legacy.createChannel({ workspaceId, displayName: 'Protective observation QA' });
    const scope = { workspaceId, channelId: created.id };
    const provider: any = { ...remote, getMe: vi.fn(async () => ({ id: '5547999990000@c.us' })), getSession: vi.fn(async ({ session }: { session: string }) => ({ name: session, status: 'WORKING', engine: { engine: 'WPP' }, config: { metadata: scope } })) };
    const service = createChannelConnectionsService(prisma, { evolution: primaryProvider, waha: { enabled: true, client: provider } });
    const enabled = await service.setRedundancy({ ...scope, enabled: true });
    const secondary = enabled.channel.connections!.find((r) => r.provider === 'waha')!;
    await service.refresh({ ...scope, connectionId: secondary.id });
    let release!: (phone: string) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    primaryProvider.client.getInstanceIdentity.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const oldProbe = service.refresh({ ...scope, connectionId: secondary.id });
    await paused;
    if (decision === 'changed-owner') {
      provider.getMe.mockResolvedValue({ id: '5511888882222@c.us' });
      primaryProvider.client.getInstanceIdentity.mockResolvedValue(null);
    } else provider.getMe.mockResolvedValue({ id: '5547999990000@c.us', messageCapping: { cappingStatus: 'CAPPED' } });
    await service.refresh({ ...scope, connectionId: secondary.id });
    const protectedRecords = await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } });
    expect(protectedRecords.find((r) => r.provider === 'waha')?.eligible).toBe(false);
    if (decision === 'changed-owner') expect(protectedRecords.find((r) => r.provider === 'waha')?.lastHealthyAt).toBeNull();
    release('5547999990000@s.whatsapp.net');
    const result = await oldProbe;
    expect(await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } })).toEqual(protectedRecords);
    expect(result.channel.connections!.find((r) => r.id === secondary.id)?.eligible).toBe(false);
  });
  it.each(['evolution', 'waha'] as const)('rejects a second lifecycle for %s while its first remote mutation is pending', async (providerName) => {
    const primaryProvider: any = { ...evolution, client: { ...evolution.client, logoutInstance: vi.fn(), createInstance: vi.fn(async ({ instanceName }: { instanceName: string }) => ({ instanceName, qrCode: 'evo-qr' })) } };
    const legacy = createChannelsService(prisma as unknown as PrismaLike, { evolution: primaryProvider });
    const created = await legacy.createChannel({ workspaceId, displayName: 'Exclusive lifecycle QA' });
    const scope = { workspaceId, channelId: created.id };
    const provider: any = { ...remote, getSession: vi.fn(async ({ session }: { session: string }) => ({ name: session, status: 'SCAN_QR_CODE', engine: { engine: 'WPP' }, config: { metadata: scope } })), startSession: vi.fn(), getQr: vi.fn(async () => 'waha-qr'), logoutSession: vi.fn(), stopSession: vi.fn() };
    const service = createChannelConnectionsService(prisma, { evolution: primaryProvider, waha: { enabled: true, client: provider } });
    const enabled = await service.setRedundancy({ ...scope, enabled: true });
    const target = enabled.channel.connections!.find((r) => r.provider === providerName)!;
    let release!: (state?: unknown) => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const remoteStep = providerName === 'waha' ? provider.getSession : primaryProvider.client.logoutInstance;
    remoteStep.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const logout = providerName === 'waha' ? service.disconnect({ ...scope, connectionId: target.id }) : legacy.disconnectChannel(scope);
    await paused;
    const current = await prisma.channelConnection.findUniqueOrThrow({ where: { id: target.id } });
    const nextQr = providerName === 'waha' ? service.startQr({ ...scope, connectionId: target.id }) : legacy.startQrSession(scope);
    await expect(nextQr).rejects.toMatchObject({ code: 'LIFECYCLE_IN_PROGRESS', statusCode: 409 });
    expect(await prisma.channelConnection.findUnique({ where: { id: target.id } })).toEqual(current);
    expect(primaryProvider.client.createInstance).not.toHaveBeenCalled();
    expect(provider.startSession).not.toHaveBeenCalled();
    expect(provider.getQr).not.toHaveBeenCalled();
    if (providerName === 'waha') {
      const beforeDisable = await prisma.channel.findUniqueOrThrow({ where: { id: created.id } });
      await expect(service.setRedundancy({ ...scope, enabled: false })).rejects.toMatchObject({ code: 'LIFECYCLE_IN_PROGRESS' });
      expect(await prisma.channel.findUnique({ where: { id: created.id } })).toEqual(beforeDisable);
    }
    release(providerName === 'waha' ? { name: target.sessionName, status: 'SCAN_QR_CODE', engine: { engine: 'WPP' }, config: { metadata: scope } } : undefined);
    await logout;
    expect(await prisma.channelConnection.findUnique({ where: { id: target.id } })).toMatchObject({ status: 'disconnected', eligible: false, lifecycleGeneration: current.lifecycleGeneration + 1 });
  });
  it('claims the same physical lifecycle only once when both callers read an idle snapshot', async () => {
    const legacy = createChannelsService(prisma as unknown as PrismaLike, { evolution });
    const created = await legacy.createChannel({ workspaceId, displayName: 'Concurrent lifecycle QA' });
    const scope = { workspaceId, channelId: created.id };
    let release!: (qr: string) => void; let entered!: () => void; let rejected!: () => void;
    const remotePending = new Promise<void>((resolve) => { entered = resolve; });
    const rejectedRequest = new Promise<void>((resolve) => { rejected = resolve; });
    const provider: any = { ...remote, getSession: vi.fn(async ({ session }: { session: string }) => ({ name: session, status: 'SCAN_QR_CODE', engine: { engine: 'WPP' }, config: { metadata: scope } })), getQr: vi.fn(() => { entered(); return new Promise((resolve) => { release = resolve; }); }) };
    const service = createChannelConnectionsService(prisma, { evolution, waha: { enabled: true, client: provider } });
    const enabled = await service.setRedundancy({ ...scope, enabled: true });
    const secondary = enabled.channel.connections!.find((r) => r.provider === 'waha')!;
    const request = () => service.startQr({ ...scope, connectionId: secondary.id }).then((result) => ({ result }), (error: unknown) => { rejected(); return { error }; });
    const first = request(); const second = request();
    await remotePending; await rejectedRequest;
    expect(provider.getQr).toHaveBeenCalledTimes(1);
    release('only-current-qr');
    const settled = await Promise.all([first, second]);
    expect(settled).toEqual(expect.arrayContaining([
      expect.objectContaining({ result: expect.objectContaining({ qrCode: 'only-current-qr' }) }),
      expect.objectContaining({ error: expect.objectContaining({ code: 'LIFECYCLE_IN_PROGRESS', statusCode: 409 }) })
    ]));
    expect((await prisma.channelConnection.findUniqueOrThrow({ where: { id: secondary.id } })).lifecycleGeneration).toBe(2);
  });
  it('checks the persisted WAHA token under the channel lock before enabling during disable I/O', async () => {
    const legacy = createChannelsService(prisma as unknown as PrismaLike, { evolution });
    const created = await legacy.createChannel({ workspaceId, displayName: 'Enable while stopping QA' });
    const scope = { workspaceId, channelId: created.id };
    let release!: () => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const provider: any = { ...remote, getSession: vi.fn(async ({ session }: { session: string }) => ({ name: session, status: 'SCAN_QR_CODE', engine: { engine: 'WPP' }, config: { metadata: scope } })), stopSession: vi.fn(() => { entered(); return new Promise<void>((resolve) => { release = resolve; }); }) };
    const service = createChannelConnectionsService(prisma, { evolution, waha: { enabled: true, client: provider } });
    await service.setRedundancy({ ...scope, enabled: true });
    const disable = service.setRedundancy({ ...scope, enabled: false });
    await paused;
    const before = await prisma.channel.findUniqueOrThrow({ where: { id: created.id } });
    const physical = await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } });
    expect(physical.find((r) => r.provider === 'waha')!.lifecycleGeneration % 2).toBe(1);
    let attempt: unknown; let after: typeof before | undefined;
    try {
      attempt = await service.setRedundancy({ ...scope, enabled: true }).then((result) => result, (error) => error);
      after = await prisma.channel.findUniqueOrThrow({ where: { id: created.id } });
      expect(await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } })).toEqual(physical);
      // The other provider remains independently operable while WAHA is stopping.
      expect(await legacy.startQrSession(scope)).toMatchObject({ provider: 'evolution', qrCode: 'evolution-qr' });
    } finally { release(); await disable; }
    expect(attempt).toMatchObject({ code: 'LIFECYCLE_IN_PROGRESS', statusCode: 409 });
    expect(after).toEqual(before);
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: created.id } })).redundancyEnabled).toBe(false);
    expect(provider.stopSession).toHaveBeenCalledTimes(1);
    expect((await service.setRedundancy({ ...scope, enabled: true })).channel.redundancyEnabled).toBe(true);
  });
  it('rolls back a WAHA QR claim whose enabled snapshot became disabled before the channel lock', async () => {
    const legacy = createChannelsService(prisma as unknown as PrismaLike, { evolution });
    const created = await legacy.createChannel({ workspaceId, displayName: 'Disabled QR snapshot QA' });
    const scope = { workspaceId, channelId: created.id };
    const provider: any = { ...remote, getVersion: vi.fn(async () => ({ version: '2026.9.1', engine: 'WPP' })), getSession: vi.fn(async ({ session }: { session: string }) => ({ name: session, status: 'STOPPED', engine: {}, config: { metadata: scope } })), startSession: vi.fn(), createSession: vi.fn(), stopSession: vi.fn(), getQr: vi.fn(async () => 'stale-enabled-qr') };
    const service = createChannelConnectionsService(prisma, { evolution, waha: { enabled: true, client: provider } });
    const enabled = await service.setRedundancy({ ...scope, enabled: true });
    const secondary = enabled.channel.connections!.find((r) => r.provider === 'waha')!;
    let release!: () => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const readPhysical = prisma.channelConnection.findFirst.bind(prisma.channelConnection);
    // Suspend the awaited query only; this service does not use Prisma relation chaining.
    const delayedRead = async (args: Parameters<typeof readPhysical>[0]) => { entered(); await resume; return readPhysical(args); };
    const read = vi.spyOn(prisma.channelConnection, 'findFirst').mockImplementationOnce(delayedRead as unknown as typeof prisma.channelConnection.findFirst);
    const qr = service.startQr({ ...scope, connectionId: secondary.id }).then((result) => result, (error) => error);
    let disabled!: Awaited<ReturnType<typeof prisma.channel.findUniqueOrThrow>>; let records!: Awaited<ReturnType<typeof prisma.channelConnection.findMany>>;
    try {
      await paused;
      await service.setRedundancy({ ...scope, enabled: false });
      disabled = await prisma.channel.findUniqueOrThrow({ where: { id: created.id } });
      records = await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } });
    } finally { release(); read.mockRestore(); }
    expect(await qr).toMatchObject({ code: 'REDUNDANCY_DISABLED', statusCode: 409 });
    expect(await prisma.channel.findUnique({ where: { id: created.id } })).toEqual(disabled);
    expect(await prisma.channelConnection.findMany({ where: scope, orderBy: { id: 'asc' } })).toEqual(records);
    expect(provider.getVersion).toHaveBeenCalledTimes(1);
    expect(provider.getSession).toHaveBeenCalledTimes(1);
    expect(provider.startSession).not.toHaveBeenCalled();
    expect(provider.createSession).not.toHaveBeenCalled();
    expect(provider.getQr).not.toHaveBeenCalled();
  });
  it('secondary lifecycle leaves primary/history intact and deletion cascades physical identities', async () => {
    const service = createChannelConnectionsService(prisma, { evolution, waha: { enabled: true, client: remote } });
    const secondary = await prisma.channelConnection.findFirstOrThrow({ where: { workspaceId, channelId, provider: 'waha' } });
    await service.startQr({ workspaceId, channelId, connectionId: secondary.id });
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    const primary = await prisma.channelConnection.findFirstOrThrow({ where: { workspaceId, channelId, provider: 'evolution' } });
    await service.disconnect({ workspaceId, channelId, connectionId: secondary.id });
    expect(await prisma.channelConnection.findUnique({ where: { id: primary.id } })).toEqual(primary);
    const after = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(after.connectionLifecycleGeneration).toBeGreaterThan(channel.connectionLifecycleGeneration);
    const logical = ({ connectionLifecycleGeneration: _generation, updatedAt: _updatedAt, ...rest }: typeof channel) => rest;
    expect(logical(after)).toEqual(logical(channel));
    const channels = createChannelsService(prisma as unknown as PrismaLike, { evolution, waha: { enabled: true, client: remote } });
    await channels.deleteChannel({ workspaceId, channelId });
    expect(await prisma.channelConnection.count({ where: { workspaceId, channelId } })).toBe(0);
    expect(remote.deleteSession).toHaveBeenCalledWith({ session: secondary.sessionName });
    const meta = await channels.createChannel({ workspaceId, provider: 'meta_cloud', providerKey: 'meta', displayName: 'Official' });
    expect(meta.provider).toBe('meta_cloud');
    expect(await prisma.channelConnection.count({ where: { channelId: meta.id } })).toBe(0);
  });
});
