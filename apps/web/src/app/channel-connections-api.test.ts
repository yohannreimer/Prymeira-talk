import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('physical channel API helpers', () => {
  const channel = { id: 'channel-1', workspaceId: 'workspace', provider: 'evolution', providerKey: 'primary', displayName: null, phoneNumber: null, status: 'connecting', createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' };
  it('uses authenticated channel and connection endpoints and validates their envelopes', async () => {
    const qr = { mode: 'real', channel, provider: 'waha', connectionId: 'secondary-1', qrCode: 'qr', qr: { payload: 'qr', expiresAt: '2026-09-30T00:01:00.000Z' } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'real', channel })))
      .mockResolvedValueOnce(new Response(JSON.stringify(qr)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'real', channel })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'real', channel })));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./api');
    const getToken = async () => 'physical-token';
    await expect(api.apiSetChannelRedundancy(getToken, channel.id, true)).resolves.toMatchObject({ channel });
    await expect(api.apiStartConnectionQr(getToken, channel.id, 'secondary-1')).resolves.toEqual(qr);
    await api.apiGetConnectionState(getToken, channel.id, 'secondary-1');
    await api.apiDisconnectConnection(getToken, channel.id, 'secondary-1');
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      ['http://localhost:3002/channels/channel-1/redundancy', 'PATCH'],
      ['http://localhost:3002/channels/channel-1/connections/secondary-1/qr', 'POST'],
      ['http://localhost:3002/channels/channel-1/connections/secondary-1/state', 'GET'],
      ['http://localhost:3002/channels/channel-1/connections/secondary-1/disconnect', 'POST']
    ]);
    for (const [, options] of fetchMock.mock.calls) expect(options.headers.Authorization).toBe('Bearer physical-token');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ enabled: true });
  });
  it('surfaces a pending QR error from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'WAHA_QR_PENDING', error: 'A sessão está iniciando.' }), { status: 503 })));
    const { apiStartConnectionQr } = await import('./api');
    await expect(apiStartConnectionQr(async () => 'token', 'channel-1', 'secondary-1')).rejects.toThrow('A sessão está iniciando.');
  });
});
