import { describe, expect, it, vi } from 'vitest';
import { createOutboundRouter, OutboundUncertainError } from './outbound-router.js';
import { createDeliveryProbe } from './outbound-probes.js';

const at = new Date('2026-10-15T15:00:00.500Z');
function fixture() {
  const channel = { id: 'c', workspaceId: 'w', provider: 'evolution', providerKey: 'evo', redundancyEnabled: true, activeConnectionId: 'e' };
  const channels = [channel];
  const connection = { workspaceId: 'w', channelId: 'c', status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '15550000000', lastHealthyAt: at, lifecycleGeneration: 0 };
  const connections = [{ ...connection, id: 'e', provider: 'evolution', sessionName: 'evo' }, { ...connection, id: 'wa', provider: 'waha', sessionName: 'wa' }];
  const findMany = vi.fn(async () => channels);
  const db = { channel: { findFirst: vi.fn(async () => channels[0]), findMany }, channelConnection: { findMany: vi.fn(async ({ where }: any) => where.OR ? connections : connections.filter(c => c.workspaceId === where.workspaceId && c.channelId === where.channelId)) } };
  const sent = { providerMessageId: 'sent', raw: {} };
  const base = { createInstance: vi.fn(), connectInstance: vi.fn(), setWebhook: vi.fn(), logoutInstance: vi.fn(), getConnectionState: vi.fn(), getInstanceIdentity: vi.fn(), fetchMedia: vi.fn(), listTemplates: vi.fn(), sendTemplate: vi.fn(), sendText: vi.fn(async () => sent), sendMedia: vi.fn(), sendAudio: vi.fn(), sendContact: vi.fn(), deleteMessageForEveryone: vi.fn(), editMessage: vi.fn(), fetchProfilePicture: vi.fn(), getGroupInfo: vi.fn(), checkWhatsappNumbersAvailability: vi.fn() };
  const waha = { sendText: vi.fn(async () => sent), sendMedia: vi.fn(), sendVoice: vi.fn(), sendContact: vi.fn(), deleteMessage: vi.fn(), editMessage: vi.fn(), getContactProfilePicture: vi.fn(), getGroup: vi.fn(), checkNumber: vi.fn() };
  const journal = { begin: vi.fn(async () => 'dispatch'), recordAttempt: vi.fn(), accept: vi.fn(), markUncertain: vi.fn(), fail: vi.fn() };
  const make = (extra: Record<string, unknown> = {}) => createOutboundRouter({ base, waha, db, journal, probeDelayMs: 0, now: () => at, ...extra } as never);
  const send = (client = make(), scope = {}) => client.sendText({ instanceName: 'evo', number: '15550000001', text: 'Olá', ...scope });
  const expectNoNetwork = () => { for (const fn of [...Object.values(base), ...Object.values(waha)]) expect(fn).not.toHaveBeenCalled(); };
  return { channels, channel, connections, db, base, waha, journal, make, send, expectNoNetwork };
}

describe('outbound authorization and durable intent', () => {
  it('rejects an ambiguous legacy provider key before any provider I/O, including rollout exclusion', async () => {
    const f = fixture(); f.channels.push({ ...f.channel, id: 'other-c', workspaceId: 'other-w' });
    await expect(f.send(f.make({ routes: () => false }))).rejects.toThrow();
    f.expectNoNetwork(); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it('rejects scope that does not own the unique provider key', async () => {
    const f = fixture(); await expect(f.send(f.make(), { workspaceId: 'other-w', channelId: 'other-c' })).rejects.toThrow();
    f.expectNoNetwork();
  });
  it('rejects a duplicated physical WAHA session across workspaces', async () => {
    const f = fixture(); f.channel.activeConnectionId = 'wa'; f.connections.push({ ...f.connections[1]!, id: 'other-wa', workspaceId: 'other-w', channelId: 'other-c' });
    await expect(f.send()).rejects.toThrow(); f.expectNoNetwork();
  });
  it('rejects unknown channels rather than bypassing the router', async () => {
    const f = fixture(); f.channels.length = 0; await expect(f.send()).rejects.toThrow(); f.expectNoNetwork();
  });
  it('fails closed on channel lookup failure', async () => {
    const f = fixture(); f.db.channel.findFirst.mockRejectedValue(new Error('DB unavailable')); f.db.channel.findMany.mockRejectedValue(new Error('DB unavailable'));
    await expect(f.send()).rejects.toThrow('DB unavailable'); f.expectNoNetwork();
  });
  it('fails before network if the dispatch intention cannot be persisted', async () => {
    const f = fixture(); f.journal.begin.mockRejectedValue(new Error('journal unavailable'));
    await expect(f.send()).rejects.toThrow('journal unavailable'); f.expectNoNetwork();
  });
  it('does not call a disconnected provider when there is no eligible writer', async () => {
    const f = fixture(); f.connections.forEach(c => { c.status = 'disconnected'; c.eligible = false; });
    await expect(f.send()).rejects.toThrow('NO_CONNECTION_AVAILABLE'); f.expectNoNetwork();
  });
  it.each(['deleteMessageForEveryone', 'editMessage', 'fetchProfilePicture', 'getGroupInfo', 'checkWhatsappNumbersAvailability', 'createInstance', 'connectInstance', 'setWebhook', 'logoutInstance', 'getConnectionState', 'getInstanceIdentity', 'fetchMedia', 'listTemplates', 'sendTemplate'] as const)('authorizes %s before the first provider call', async method => {
    const f = fixture(); f.channels.push({ ...f.channel, id: 'other-c', workspaceId: 'other-w' });
    await expect((f.make()[method] as any)({ instanceName: 'evo', id: 'm', remoteJid: '15550000001@s.whatsapp.net', fromMe: true, text: 'text', number: '15550000001', numbers: [], groupJid: '123@g.us' })).rejects.toThrow();
    f.expectNoNetwork();
  });
  it('preserves explicit rollout exclusion after resolving unique ownership', async () => {
    const f = fixture(); await expect(f.send(f.make({ routes: () => false }))).resolves.toMatchObject({ providerMessageId: 'sent' });
    expect(f.base.sendText).toHaveBeenCalledTimes(1); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it('does not reinterpret a confirmed send as a retry when its journal write fails', async () => {
    const f = fixture(); f.journal.accept.mockRejectedValue(new Error('journal unavailable'));
    await expect(f.send()).rejects.toBeInstanceOf(OutboundUncertainError);
    expect(f.base.sendText).toHaveBeenCalledTimes(1); expect(f.waha.sendText).not.toHaveBeenCalled();
  });
  it('does not fail over if recording a proven provider rejection fails', async () => {
    const f = fixture(); f.base.sendText.mockRejectedValue(Object.assign(new Error('rejected'), { statusCode: 404 }));
    f.journal.recordAttempt.mockRejectedValue(new Error('journal unavailable'));
    await expect(f.send()).rejects.toBeInstanceOf(OutboundUncertainError);
    expect(f.base.sendText).toHaveBeenCalledTimes(1); expect(f.waha.sendText).not.toHaveBeenCalled();
  });
  it('does not fallback to an unavailable read provider when no connection is eligible', async () => {
    const f = fixture(); f.connections.forEach(connection => { connection.eligible = false; });
    await expect(f.make().fetchProfilePicture!({ instanceName: 'evo', number: '15550000001' })).rejects.toThrow('NO_CONNECTION_AVAILABLE');
    f.expectNoNetwork();
  });

  it('keeps an old identical text uncertain after timeout and never retries it', async () => {
    const f = fixture(); f.base.sendText.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    const probe = createDeliveryProbe({ history: { recentMessages: vi.fn(async () => [{ key: { id: 'PREVIOUS', fromMe: true, remoteJid: '15550000001@s.whatsapp.net' }, messageTimestamp: Math.floor(at.getTime() / 1000) - 4, message: { conversation: 'Olá' } }]) } as never, waha: null });
    await expect(f.send(f.make({ probe }))).rejects.toBeInstanceOf(OutboundUncertainError);
    expect(f.journal.accept).not.toHaveBeenCalled(); expect(f.journal.markUncertain).toHaveBeenCalled(); expect(f.waha.sendText).not.toHaveBeenCalled();
  });
});
