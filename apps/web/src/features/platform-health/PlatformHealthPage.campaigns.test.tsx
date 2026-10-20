// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformHealthChannel } from '../../app/supervision-api';
import { PlatformHealthPage } from './PlatformHealthPage';

const mocks = vi.hoisted(() => ({ getToken: vi.fn(), health: vi.fn() }));
vi.mock('../../app/auth', () => ({ useTalkAuth: () => ({ getToken: mocks.getToken }) }));
vi.mock('../../app/supervision-api', async importOriginal => ({
  ...await importOriginal<typeof import('../../app/supervision-api')>(), apiPlatformHealth: mocks.health
}));

const channel: PlatformHealthChannel = {
  workspaceId: 'customer', workspaceName: 'Cliente', channelId: 'number', name: 'Vendas', phone: '5547999990000',
  status: 'connected', connections: [], level: 'ok', issues: [],
  traffic: { lastInboundAt: null, lastOutboundAt: null, inbound1h: 0, inbound24h: 80, outbound24h: 90 },
  acks: { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0 },
  history: { status: null, completedAt: null }
};
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { await act(async () => { roots.splice(0).forEach(root => root.unmount()); }); document.body.replaceChildren(); });

describe('campaign counts on the number health card', () => {
  it.each([
    [{ today: 30, yesterday: 50 }, '30', '50'],
    [{ today: 0, yesterday: 0 }, '0', '0'],
    [undefined, '—', '—']
  ] as const)('renders daily campaign counts independently of 24-hour traffic (%j)', async (campaigns, today, yesterday) => {
    mocks.health.mockResolvedValue({ generatedAt: '2026-10-20T14:00:00Z', channels: [{ ...channel, campaigns }] });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); roots.push(root);
    await act(async () => { root.render(<PlatformHealthPage />); });
    const values = Object.fromEntries([...container.querySelectorAll('dl > div')].map(row => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent]));
    expect(values).toMatchObject({ 'Disparos hoje': today, 'Disparos ontem': yesterday, 'Enviadas 24 h': '90' });
  });
});
