// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelsPage } from './ChannelsPage';
const mocks = vi.hoisted(() => ({ apiGetChannels: vi.fn(), apiGetSettings: vi.fn(), apiCreateChannel: vi.fn(), apiCreateTestInbound: vi.fn(), apiDeleteChannel: vi.fn(), apiDisconnectChannel: vi.fn(), apiStartChannelQr: vi.fn(), apiSetChannelRedundancy: vi.fn(), apiStartConnectionQr: vi.fn(), apiDisconnectConnection: vi.fn(), apiGetConnectionState: vi.fn(), getToken: vi.fn(async () => 'token'), onEvent: null as any }));
vi.mock('../../app/api', () => mocks);
vi.mock('../../app/auth', () => ({ useTalkAuth: () => ({ getToken: mocks.getToken }) }));
vi.mock('../inbox/useRealtimeEvents', () => ({ useRealtimeEvents: ({ onEvent }: any) => { mocks.onEvent = onEvent; } }));
vi.mock('./AssistantChannelSettings', () => ({ AssistantChannelSettings: () => null }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async (payload: string) => `data:image/png;base64,${btoa(payload)}`) } }));
const primary = { id: 'evo', channelId: 'channel', provider: 'evolution', sessionName: 'evo-session', status: 'connected', health: 'healthy', verifiedPhoneNumber: '5547999990000', eligible: true, isActiveWriter: true, lastCheckedAt: null };
const secondary = { ...primary, id: 'waha', provider: 'waha', sessionName: 'waha-session', status: 'connecting', health: 'unknown', eligible: false, isActiveWriter: false };
const channel: any = { id: 'channel', workspaceId: 'workspace', provider: 'evolution', providerKey: 'evo-session', phoneNumber: '5547999990000', displayName: 'Comercial', status: 'connected', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), redundancyAvailable: true, redundancyEnabled: false, activeConnectionId: 'evo', connectedCount: 1, connectionTotal: 2, connections: [primary] };
function qr(provider: string, value: string, connectionId: string, nextChannel = channel) { return { mode: 'real', channel: nextChannel, provider, connectionId, qrCode: value, qr: { payload: value, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }; }
describe('same-channel two QR setup', () => {
  let root: Root; let container: HTMLDivElement;
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    Object.entries(mocks).forEach(([key, value]) => { if (key !== 'getToken' && typeof value?.mockReset === 'function') value.mockReset(); });
    mocks.apiGetChannels.mockResolvedValue([channel]); mocks.apiGetSettings.mockResolvedValue({ integrations: [] });
    mocks.apiStartChannelQr.mockResolvedValue(qr('evolution', 'evolution-qr', 'evo'));
    const next = { ...channel, redundancyEnabled: true, connections: [primary, secondary] };
    mocks.apiSetChannelRedundancy.mockResolvedValue({ mode: 'real', channel: next });
    mocks.apiStartConnectionQr.mockResolvedValue(qr('waha', 'waha-qr', 'waha', next));
    mocks.apiGetConnectionState.mockResolvedValue({ mode: 'real', channel: next });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  it.each(['button', 'overlay'] as const)('does not reopen the drawer when a pending Evolution QR resolves after %s dismissal', async (dismissal) => {
    let finish!: (result: unknown) => void;
    mocks.apiStartChannelQr.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => root.render(<ChannelsPage />));
    await act(async () => button('Reconectar').click());
    expect(container.querySelector('[aria-label="Conectar canal via QR"]')).not.toBeNull();
    await act(async () => {
      const close = dismissal === 'button' ? container.querySelector<HTMLButtonElement>('[aria-label="Conectar canal via QR"] [aria-label="Fechar"]') : container.querySelector<HTMLDivElement>('.contact-drawer-overlay');
      close!.click();
    });
    expect(container.querySelector('[aria-label="Conectar canal via QR"]')).toBeNull();
    await act(async () => finish(qr('evolution', 'late-primary-qr', 'evo')));
    expect(container.querySelector('[aria-label="Conectar canal via QR"]')).toBeNull();
    expect(container.querySelectorAll('.qr-image')).toHaveLength(0);
  });
  it.each(['evolution', 'waha'] as const)('shows provider status, %s degradation and the opposite active sender in the channel row', async (degradedProvider) => {
    const records = [
      { ...primary, health: degradedProvider === 'evolution' ? 'degraded' : 'healthy', isActiveWriter: degradedProvider !== 'evolution' },
      { ...secondary, status: 'connected', health: degradedProvider === 'waha' ? 'degraded' : 'healthy', isActiveWriter: degradedProvider !== 'waha' }
    ];
    mocks.apiGetChannels.mockResolvedValue([{ ...channel, redundancyEnabled: true, connections: records }]);
    await act(async () => root.render(<ChannelsPage />));
    const degraded = container.querySelector<HTMLElement>(`.channel-row-main [data-provider="${degradedProvider}"]`);
    const sendingProvider = degradedProvider === 'evolution' ? 'waha' : 'evolution';
    const sender = container.querySelector<HTMLElement>(`.channel-row-main [data-provider="${sendingProvider}"]`);
    expect(degraded?.textContent).toContain('Conectado');
    expect(degraded?.textContent).toContain('Degradada');
    expect(degraded?.textContent).not.toContain('Envio ativo');
    expect(sender?.textContent).toContain('Saudável');
    expect(sender?.textContent).toContain('Envio ativo');
    expect(container.querySelector('.channel-row-main')?.textContent).toContain('2 de 2 conectados');
    await act(async () => mocks.onEvent({ type: 'channel.updated', workspaceId: 'workspace', payload: { ...channel, redundancyEnabled: true, connections: records.map((record) => ({ ...record, status: record.provider === degradedProvider ? 'disconnected' : 'connected' })) } }));
    expect(container.querySelector(`.channel-row-main [data-provider="${degradedProvider}"]`)?.textContent).toContain('Desconectado');
    expect(container.querySelector('.channel-row-main')?.textContent).toContain('1 de 2 conectados');
  });
  it('renders Evolution first, independently generates WAHA on the same channel and preserves each QR under scoped events', async () => {
    await act(async () => root.render(<ChannelsPage />));
    expect(container.textContent).toContain('1 de 2 conectados');
    await act(async () => button('Reconectar').click());
    await act(async () => button('Ativar conexão reserva').click());
    expect(mocks.apiSetChannelRedundancy).toHaveBeenCalledWith(expect.any(Function), 'channel', true);
    expect(mocks.apiStartConnectionQr).toHaveBeenCalledWith(expect.any(Function), 'channel', 'waha');
    const images = [...container.querySelectorAll<HTMLImageElement>('.qr-image')];
    expect(images).toHaveLength(2); expect(images[0]!.alt).toContain('Evolution'); expect(images[1]!.alt).toContain('WAHA');
    const evolutionSrc = images[0]!.src; const secondarySrc = images[1]!.src;
    await act(async () => mocks.onEvent({ type: 'channel.qr_updated', workspaceId: 'workspace', payload: { channelId: 'channel', connectionId: 'other', provider: 'waha', qrCode: 'foreign', expiresAt: new Date(Date.now() + 60_000).toISOString() } }));
    expect(container.querySelectorAll<HTMLImageElement>('.qr-image')[0]!.src).toBe(evolutionSrc);
    expect(container.querySelectorAll<HTMLImageElement>('.qr-image')[1]!.src).toBe(secondarySrc);
    await act(async () => mocks.onEvent({ type: 'channel.updated', workspaceId: 'workspace', payload: { ...channel, redundancyEnabled: true, connections: [primary, { ...secondary, status: 'connected', health: 'degraded', lastError: 'PHONE_MISMATCH' }] } }));
    expect(container.textContent).toContain('2 de 2 conectados'); expect(container.textContent).toContain('Degradada'); expect(container.textContent).toContain('Enviando mensagens por esta conexão'); expect(container.textContent).toContain('lido por outro número');
  });
  it('keeps optional WAHA visible but gated before qualification and leaves Meta without redundancy controls', async () => {
    mocks.apiGetChannels.mockResolvedValue([{ ...channel, redundancyAvailable: false }, { ...channel, id: 'meta', provider: 'meta_cloud', displayName: 'Official', connections: undefined }]);
    await act(async () => root.render(<ChannelsPage />));
    await act(async () => button('Conexões').click());
    expect(button('Ativar conexão reserva')).toBeUndefined();
    expect(container.textContent).toContain('ainda não está liberada');
    expect(mocks.apiSetChannelRedundancy).not.toHaveBeenCalled();
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0);
  });
  it('disconnects secondary without losing the primary QR or invoking the legacy disconnect', async () => {
    await act(async () => root.render(<ChannelsPage />));
    await act(async () => button('Reconectar').click());
    await act(async () => button('Ativar conexão reserva').click());
    const primarySrc = container.querySelector<HTMLImageElement>('.qr-image')!.src;
    mocks.apiDisconnectConnection.mockResolvedValue({ mode: 'real', channel: { ...channel, redundancyEnabled: true, connections: [primary, { ...secondary, status: 'disconnected' }] } });
    await act(async () => button('Desconectar reserva').click());
    expect(mocks.apiDisconnectConnection).toHaveBeenCalledWith(expect.any(Function), 'channel', 'waha');
    expect(mocks.apiDisconnectChannel).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.qr-image')).toHaveLength(1);
    expect(container.querySelector<HTMLImageElement>('.qr-image')!.src).toBe(primarySrc);
  });
  it('ignores an outstanding secondary QR response after selecting another channel', async () => {
    mocks.apiGetChannels.mockResolvedValue([channel, { ...channel, id: 'second', displayName: 'Support' }]);
    let finish!: (qr: unknown) => void;
    mocks.apiStartConnectionQr.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => root.render(<ChannelsPage />));
    await act(async () => button('Reconectar').click());
    await act(async () => button('Ativar conexão reserva').click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.channel-row-main')].find((row) => row.textContent?.includes('Support'))!.click());
    await act(async () => finish(qr('waha', 'late-secondary-qr', 'waha', { ...channel, redundancyEnabled: true, connections: [primary, secondary] })));
    expect(container.querySelectorAll('.qr-image')).toHaveLength(0);
    expect(container.textContent).not.toContain('Gerar outro QR Code da reserva');
  });
  it('polls pending WAHA startup for at most a minute while preserving the primary QR', async () => {
    vi.useFakeTimers();
    try {
      mocks.apiStartConnectionQr.mockRejectedValue(new Error('A sessão WAHA está iniciando.'));
      await act(async () => root.render(<ChannelsPage />));
      await act(async () => button('Reconectar').click());
      await act(async () => button('Ativar conexão reserva').click());
      await act(async () => vi.advanceTimersByTimeAsync(65_000));
      const calls = mocks.apiStartConnectionQr.mock.calls.length;
      expect(calls).toBeLessThanOrEqual(12);
      expect(calls).toBeGreaterThan(1);
      expect(container.textContent).toContain('Gere o QR novamente');
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(mocks.apiStartConnectionQr).toHaveBeenCalledTimes(calls);
    } finally { vi.useRealTimers(); }
  });
});
