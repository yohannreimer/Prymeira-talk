import { describe, expect, it, vi } from 'vitest';
import { createMetaEvolutionAttestation, createOwnedMetaEvolutionClient } from './meta-evolution-client.js';

const expected = { webhookUrl: 'https://talk.example.test/webhooks/evolution/ws', webhookSecret: 'synthetic-secret' };
function fixture(claim: string | null = 'official') {
  const order: string[] = [];
  const row: any = { id: 'channel', workspaceId: 'ws', provider: 'meta_cloud', providerKey: 'official', providerInstanceClaim: claim, archivedAt: null };
  const dispatch: any = { state: 'sending' };
  const db: any = {
    channel: { findMany: vi.fn(async () => [{ ...row }]), updateMany: vi.fn(async ({ data }) => { Object.assign(row, data); return { count: 1 }; }) },
    channelConnection: { findMany: vi.fn(async () => []) },
    outboundDispatch: {
      create: vi.fn(async () => { order.push('begin'); return { id: 'dispatch' }; }),
      updateMany: vi.fn(async ({ data }) => { order.push(data.state); Object.assign(dispatch, data); return { count: 1 }; })
    },
    $executeRaw: vi.fn(async () => { order.push('attempt'); return 1; })
  };
  const base: any = { sendText: vi.fn(async () => { order.push('send'); return { providerMessageId: 'sent', raw: {} }; }),
    sendTemplate: vi.fn(async () => ({ providerMessageId: 'template', raw: {} })),
    getWebhook: vi.fn(async () => ({ enabled: true, url: expected.webhookUrl, headers: { 'x-prymeira-talk-secret': expected.webhookSecret } })),
    listTemplates: vi.fn(async () => ({ templates: [], raw: {} })) };
  return { db, base, row, dispatch, order, client: createOwnedMetaEvolutionClient(base, db, 'ws', 'official', expected) };
}
const command = { instanceName: 'official', number: '5547999990000', text: 'Olá' };
describe('owned Meta Evolution client', () => {
  it('persists intent before provider I/O and accepts a nullable physical connection', async () => {
    const f = fixture();
    expect(await f.client.sendText(command)).toMatchObject({ providerMessageId: 'sent' });
    expect(f.order).toEqual(['begin', 'send', 'attempt', 'accepted']);
    expect(f.dispatch).toMatchObject({ state: 'accepted', connectionId: null, providerMessageId: 'sent' });
  });
  it.each(['configured-instance', 'logical-collision', 'physical-collision', 'foreign-workspace'] as const)('rejects %s before provider I/O', async conflict => {
    const f = fixture();
    if (conflict === 'logical-collision') f.db.channel.findMany.mockResolvedValue([f.row, { ...f.row, id: 'foreign' }]);
    if (conflict === 'physical-collision') f.db.channelConnection.findMany.mockResolvedValue([{ id: 'physical', workspaceId: 'other', channelId: 'other' }]);
    if (conflict === 'foreign-workspace') f.row.workspaceId = 'other';
    await expect(f.client.sendText({ ...command, instanceName: conflict === 'configured-instance' ? 'other' : command.instanceName })).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED' });
    expect(f.base.sendText).not.toHaveBeenCalled();
    expect(f.base.getWebhook).not.toHaveBeenCalled();
    expect(f.db.outboundDispatch.create).not.toHaveBeenCalled();
  });
  it('attests a valid legacy binding with a read before persisting its claim and sending', async () => {
    const f = fixture(null);
    await f.client.sendText(command);
    expect(f.base.getWebhook).toHaveBeenCalledWith({ instanceName: 'official' });
    expect(f.row.providerInstanceClaim).toBe('official');
    expect(f.base.sendText).toHaveBeenCalledOnce();
  });
  it.each(['url', 'secret', 'disabled'] as const)('does not claim or send an unattested legacy %s', async invalid => {
    const f = fixture(null);
    f.base.getWebhook.mockResolvedValue({ enabled: invalid !== 'disabled', url: invalid === 'url' ? 'https://foreign.test' : expected.webhookUrl,
      headers: { 'x-prymeira-talk-secret': invalid === 'secret' ? 'foreign' : expected.webhookSecret } });
    await expect(f.client.sendText(command)).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED' });
    expect(f.db.channel.updateMany).not.toHaveBeenCalled();
    expect(f.base.sendText).not.toHaveBeenCalled();
  });
  it('fails closed if the ownership claim is superseded', async () => {
    const f = fixture(null);
    f.db.channel.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.client.sendText(command)).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED' });
    expect(f.base.sendText).not.toHaveBeenCalled();
  });
  it('never sends if durable intention persistence fails', async () => {
    const f = fixture();
    f.db.outboundDispatch.create.mockRejectedValue(new Error('storage unavailable'));
    await expect(f.client.sendText(command)).rejects.toThrow('storage unavailable');
    expect(f.base.sendText).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'accepted-journal-failure'] as const)('keeps %s uncertain and never resends', async failure => {
    const f = fixture();
    if (failure === 'timeout') f.base.sendText.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    else f.db.$executeRaw.mockRejectedValue(new Error('journal failure'));
    await expect(f.client.sendText(command)).rejects.toMatchObject({ code: 'OUTBOUND_UNCERTAIN', dispatchId: 'dispatch' });
    expect(f.base.sendText).toHaveBeenCalledOnce();
    expect(f.dispatch.state).toBe('uncertain');
  });
  it('marks a definite rejection failed without a second provider attempt', async () => {
    const f = fixture();
    f.base.sendText.mockRejectedValue(Object.assign(new Error('rejected'), { statusCode: 422 }));
    await expect(f.client.sendText(command)).rejects.toThrow('rejected');
    expect(f.base.sendText).toHaveBeenCalledOnce();
    expect(f.dispatch.state).toBe('failed');
  });
  it('journals template sends and scopes template reads through the same ownership fence', async () => {
    const f = fixture();
    await f.client.sendTemplate!({ instanceName: 'official', number: '5547999990000', name: 'hello', language: 'pt_BR' });
    expect(f.db.outboundDispatch.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'template' }) }));
    await f.client.listTemplates!({ instanceName: 'official' });
    expect(f.base.listTemplates).toHaveBeenCalledOnce();
    await expect(f.client.listTemplates!({ instanceName: 'foreign' })).rejects.toMatchObject({ code: 'CHANNEL_PROVIDER_OWNERSHIP_UNVERIFIED' });
  });
  it('exposes only a boolean attestation for the configured instance before a local binding exists', async () => {
    const f = fixture();
    const attest = createMetaEvolutionAttestation(f.base, 'official', expected);
    expect(await attest('foreign')).toBe(false);
    expect(f.base.getWebhook).not.toHaveBeenCalled();
    expect(await attest('official')).toBe(true);
    expect(f.db.channel.findMany).not.toHaveBeenCalled();
  });
});
