import { describe, expect, it, vi } from 'vitest';
import { createChannelsService } from './channels.service.js';
import { EvolutionClientError } from '../evolution/evolution.client.js';

function fixture() {
  const channel = { id: 'c', workspaceId: 'w', provider: 'evolution', providerKey: 'foreign-instance', providerInstanceClaim: null as string | null, displayName: 'test', phoneNumber: null, status: 'disconnected', createdAt: new Date(), updatedAt: new Date() };
  const channels = [channel];
  const prisma = { channel: { findFirst: vi.fn(async () => channel), findMany: vi.fn(async () => channels), create: vi.fn(async ({ data }: any) => ({ ...channel, ...data })), update: vi.fn(async ({ data }: any) => { Object.assign(channel, data); return channel; }) } };
  const client = { createInstance: vi.fn(async ({ instanceName }: any) => ({ instanceName, qrCode: 'qr', raw: {} })), connectInstance: vi.fn(async ({ instanceName }: any) => ({ instanceName, qrCode: 'qr', raw: {} })), setWebhook: vi.fn(), getConnectionState: vi.fn(), logoutInstance: vi.fn(), sendText: vi.fn(), sendMedia: vi.fn() };
  const service = createChannelsService(prisma as never, { evolution: { mode: 'real', client, webhookSecret: 'synthetic', publicWebhookUrl: () => 'https://example.invalid/hook', localWebhookUrl: () => 'http://example.invalid/hook' } });
  const qr = () => service.startQrSession({ workspaceId: 'w', channelId: 'c' });
  return { channel, channels, prisma, client, service, qr };
}

describe('physical Evolution instance ownership', () => {
  it('generates server-owned global names instead of accepting a foreign physical key', async () => {
    const f = fixture(); await f.service.createChannel({ workspaceId: 'w', displayName: 'test', providerKey: 'foreign-instance' });
    expect(f.prisma.channel.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ providerKey: expect.stringMatching(/^talk-w-[0-9a-f-]{36}$/) }) }));
    expect(f.client.createInstance).not.toHaveBeenCalled();
  });
  it('does not schedule unavailable Evolution history during WAHA-only onboarding', async () => {
    const f = fixture();
    const service = createChannelsService(f.prisma as never, { evolution: { mode: 'real', providerConfigured: false, client: null,
      webhookSecret: 'synthetic', publicWebhookUrl: () => 'https://example.invalid/hook', localWebhookUrl: () => 'http://example.invalid/hook' } });
    await service.createChannel({ workspaceId: 'w', displayName: 'WAHA only' });
    const data = f.prisma.channel.create.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty('historyImportStatus'); expect(data).not.toHaveProperty('historyImportNextAt');
  });

  it('rejects duplicate logical ownership before QR, connect, state lookup or webhook mutation', async () => {
    const f = fixture(); f.channels.push({ ...f.channel, id: 'victim', workspaceId: 'victim-w' });
    await expect(f.qr()).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED', statusCode: 409 });
    for (const fn of Object.values(f.client)) expect(fn).not.toHaveBeenCalled();
  });
  it('does not adopt a provider-occupied instance without a durable ownership claim', async () => {
    const f = fixture(); f.client.createInstance.mockRejectedValue(new EvolutionClientError(403, { message: 'Instance name already in use' }));
    await expect(f.qr()).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED', statusCode: 409 });
    expect(f.client.connectInstance).not.toHaveBeenCalled(); expect(f.client.setWebhook).not.toHaveBeenCalled(); expect(f.client.getConnectionState).not.toHaveBeenCalled();
  });
  it('attests an existing legacy instance from its exact remote webhook before reconnecting', async () => {
    const f = fixture(); f.client.createInstance.mockRejectedValue(new EvolutionClientError(403, { message: 'Instance name already in use' }));
    Object.assign(f.client, { getWebhook: vi.fn(async () => ({ enabled: true, url: 'https://example.invalid/hook', headers: { 'x-prymeira-talk-secret': 'synthetic' } })) });
    await expect(f.qr()).resolves.toMatchObject({ qrCode: 'qr' });
    expect(f.channel.providerInstanceClaim).toBe(f.channel.providerKey);
    expect(f.client.connectInstance).toHaveBeenCalledTimes(1);
  });
  it('refuses remote webhook proof belonging to another workspace', async () => {
    const f = fixture(); f.client.createInstance.mockRejectedValue(new EvolutionClientError(403, { message: 'Instance name already in use' }));
    Object.assign(f.client, { getWebhook: vi.fn(async () => ({ enabled: true, url: 'https://foreign.invalid/hook', headers: { 'x-prymeira-talk-secret': 'synthetic' } })) });
    await expect(f.qr()).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED' });
    expect(f.client.connectInstance).not.toHaveBeenCalled(); expect(f.client.setWebhook).not.toHaveBeenCalled();
  });
  it('allows reconnect of a previously created instance with a matching durable claim', async () => {
    const f = fixture(); f.channel.providerInstanceClaim = f.channel.providerKey;
    f.client.createInstance.mockRejectedValue(new EvolutionClientError(403, { message: 'Instance name already in use' }));
    await expect(f.qr()).resolves.toMatchObject({ qrCode: 'qr' });
    expect(f.client.connectInstance).toHaveBeenCalledTimes(1); expect(f.client.setWebhook).toHaveBeenCalledTimes(1);
  });
  it('persists ownership after creation before a webhook mutation', async () => {
    const f = fixture(); f.client.setWebhook.mockImplementation(async () => { expect(f.channel.providerInstanceClaim).toBe(f.channel.providerKey); });
    await f.qr(); expect(f.prisma.channel.update).toHaveBeenCalledWith(expect.objectContaining({ data: { providerInstanceClaim: f.channel.providerKey } }));
  });
  it('rejects mismatched provider responses before mutating any webhook', async () => {
    const f = fixture(); f.client.createInstance.mockResolvedValue({ instanceName: 'victim-instance', qrCode: 'qr', raw: {} });
    await expect(f.qr()).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED' });
    expect(f.client.setWebhook).not.toHaveBeenCalled();
  });
  it('does not configure a Meta webhook on an already claimed Evolution physical key', async () => {
    const f = fixture(); const setWebhook = vi.fn();
    const service = createChannelsService(f.prisma as never, { metaEvolutionWebhook: { client: { setWebhook }, publicWebhookUrl: () => 'https://example.invalid', webhookSecret: 'synthetic' } });
    await expect(service.createChannel({ workspaceId: 'other-w', displayName: 'meta', provider: 'meta_cloud', providerKey: f.channel.providerKey })).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED' });
    expect(setWebhook).not.toHaveBeenCalled(); expect(f.prisma.channel.create).not.toHaveBeenCalled();
  });
  it('binds a unique configured Meta session after read-only webhook attestation without changing its webhook', async () => {
    const f = fixture(); f.channels.splice(0);
    const setWebhook = vi.fn(), attestInstance = vi.fn(async () => true);
    const prisma = { ...f.prisma, channelConnection: { findMany: vi.fn(async () => []) } };
    const service = createChannelsService(prisma as never, { metaEvolutionWebhook: { client: { setWebhook }, attestInstance,
      publicWebhookUrl: () => 'https://example.invalid', webhookSecret: 'synthetic' } });
    await expect(service.createChannel({ workspaceId: 'w', displayName: 'meta', provider: 'meta_cloud', providerKey: 'official' })).resolves.toMatchObject({ provider: 'meta_cloud', providerKey: 'official' });
    expect(attestInstance).toHaveBeenCalledWith('official');
    expect(f.prisma.channel.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ providerInstanceClaim: 'official' }) }));
    expect(setWebhook).not.toHaveBeenCalled();
  });
  it('rejects a new Meta binding with a foreign physical owner before remote attestation', async () => {
    const f = fixture(); f.channels.splice(0);
    const attestInstance = vi.fn(async () => true);
    const prisma = { ...f.prisma, channelConnection: { findMany: vi.fn(async () => [{ workspaceId: 'other', channelId: 'foreign' }]) } };
    const service = createChannelsService(prisma as never, { metaEvolutionWebhook: { client: { setWebhook: vi.fn() }, attestInstance,
      publicWebhookUrl: () => 'https://example.invalid', webhookSecret: 'synthetic' } });
    await expect(service.createChannel({ workspaceId: 'w', displayName: 'meta', provider: 'meta_cloud', providerKey: 'official' })).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED' });
    expect(attestInstance).not.toHaveBeenCalled(); expect(f.prisma.channel.create).not.toHaveBeenCalled();
  });
});
