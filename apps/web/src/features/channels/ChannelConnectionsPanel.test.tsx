import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelConnectionsPanel } from './ChannelConnectionsPanel';
vi.mock('../../app/api', () => ({ apiDisconnectConnection: vi.fn(), apiGetConnectionState: vi.fn(), apiSetChannelRedundancy: vi.fn(), apiStartConnectionQr: vi.fn(), apiCompareChannelHistory: vi.fn() }));

const conn = (provider: 'evolution' | 'waha', over: Record<string, unknown> = {}) => ({ id: provider, channelId: 'c', provider, sessionName: provider, status: 'connected', health: 'healthy', verifiedPhoneNumber: null, eligible: true, isActiveWriter: provider === 'evolution', lastCheckedAt: null, ...over });
const channel = (connections: unknown[]) => ({ id: 'c', workspaceId: 'w', provider: 'evolution', providerKey: 'k', phoneNumber: '5547999990000', displayName: 'Prymeira', status: 'connected', redundancyEnabled: true, redundancyAvailable: true,
  connections, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' }) as never;
const render = (value: never) => renderToStaticMarkup(<ChannelConnectionsPanel channel={value} primaryQr={null} qrEvent={null} getToken={async () => null} onChannel={() => {}} onPrimaryQr={() => {}} />);

describe('connections panel', () => {
  it('when healthy: a calm summary, no QR area and no technical notices', () => {
    const html = render(channel([conn('evolution', { lastError: 'PRIMARY_PHONE_UNVERIFIED' }), conn('waha', { lastError: 'REMOTE_STOP_UNCONFIRMED' })]));
    expect(html).toContain('Tudo funcionando'); expect(html).toContain('+55 (47) 99999-0000');
    expect(html).not.toContain('qr-box'); expect(html).not.toContain('connection-callout');
    expect(html).toContain('Diagnóstico avançado');
  });
  it('when a connection fell: says so and offers its QR as the main action', () => {
    const html = render(channel([conn('evolution'), conn('waha', { status: 'disconnected', health: 'unhealthy', lastError: 'ENGINE_NOT_READY' })]));
    expect(html).toContain('Uma conexão caiu'); expect(html).toContain('Desconectada'); expect(html).toContain('Gerar QR Code da reserva');
    expect(html).toContain('não carregou nesta conexão'); expect(html).not.toContain('Diagnóstico avançado');
  });
});
