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
  it('secondary lifecycle leaves primary/history intact and deletion cascades physical identities', async () => {
    const service = createChannelConnectionsService(prisma, { evolution, waha: { enabled: true, client: remote } });
    const secondary = await prisma.channelConnection.findFirstOrThrow({ where: { workspaceId, channelId, provider: 'waha' } });
    await service.startQr({ workspaceId, channelId, connectionId: secondary.id });
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    const primary = await prisma.channelConnection.findFirstOrThrow({ where: { workspaceId, channelId, provider: 'evolution' } });
    await service.disconnect({ workspaceId, channelId, connectionId: secondary.id });
    expect(await prisma.channelConnection.findUnique({ where: { id: primary.id } })).toEqual(primary);
    expect(await prisma.channel.findUnique({ where: { id: channelId } })).toEqual(channel);
    const channels = createChannelsService(prisma as unknown as PrismaLike, { evolution, waha: { enabled: true, client: remote } });
    await channels.deleteChannel({ workspaceId, channelId });
    expect(await prisma.channelConnection.count({ where: { workspaceId, channelId } })).toBe(0);
    expect(remote.deleteSession).toHaveBeenCalledWith({ session: secondary.sessionName });
    const meta = await channels.createChannel({ workspaceId, provider: 'meta_cloud', providerKey: 'meta', displayName: 'Official' });
    expect(meta.provider).toBe('meta_cloud');
    expect(await prisma.channelConnection.count({ where: { channelId: meta.id } })).toBe(0);
  });
});
