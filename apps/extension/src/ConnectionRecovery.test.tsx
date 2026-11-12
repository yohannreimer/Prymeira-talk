// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRecovery } from './ConnectionRecovery';
import { runtimeRequest } from './protocol';
vi.mock('./protocol', () => ({ runtimeRequest: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,aGVsbG8=') } }));
const context = { windowId: 1, tabId: 2, scope: 'user:workspace:owner', selfAddress: '5547991234567@s.whatsapp.net' };
const account = { channelId: '00000000-0000-4000-8000-000000000001', selfAddress: context.selfAddress };
const state = { channelId: account.channelId, phoneNumber: '5547991234567', available: false, canReconnect: true, qr: null };
let host: HTMLDivElement, root: Root;
const request = vi.mocked(runtimeRequest);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-12T12:00:00Z')); request.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
async function mount(initialAvailable = false, onAvailability = vi.fn()) {
  await act(async () => root.render(<ConnectionRecovery context={context} account={account} initialAvailable={initialAvailable} onAvailability={onAvailability}/>));
  return onAvailability;
}
async function reconnect() { await act(async () => host.querySelector('button')!.click()); }
describe('connection recovery in the extension', () => {
  it('renders nothing for one functional connection, including when the other provider is down', async () => {
    request.mockResolvedValue({ ...state, available: true }); await mount(true);
    expect(host.textContent).toBe(''); expect(host.querySelector('button')).toBeNull();
  });
  it('opens and renders QR locally only after the user chooses reconnect, then disappears on recovery', async () => {
    request.mockResolvedValue(state); const changed = await mount();
    expect(host.textContent).toContain('Nenhuma conexão'); expect(host.querySelector('img')).toBeNull();
    request.mockResolvedValueOnce({ ...state, qr: { connectionId: 'physical', provider: 'waha', code: '2@private', expiresAt: new Date(Date.now() + 20_000).toISOString() } });
    await reconnect();
    expect(request).toHaveBeenLastCalledWith({ type: 'CONNECTION', context, account, reconnect: true });
    expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png/);
    request.mockResolvedValue({ ...state, available: true });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(host.textContent).toBe(''); expect(changed).toHaveBeenLastCalledWith(true);
  });
  it('renews an expiring QR without overlapping status requests', async () => {
    request.mockResolvedValue(state); await mount();
    const qr = { connectionId: 'physical', provider: 'waha' as const, code: '2@first', expiresAt: new Date(Date.now() + 20_000).toISOString() };
    request.mockImplementation(async input => input.type === 'CONNECTION' && input.reconnect ? { ...state, qr: { ...qr, expiresAt: new Date(Date.now() + 20_000).toISOString() } } : state);
    await reconnect(); await act(async () => vi.advanceTimersByTimeAsync(19_000));
    expect(request.mock.calls.filter(([input]) => input.type === 'CONNECTION' && input.reconnect).length).toBe(2);
  });
  it('does not show another account a late QR response after unmount', async () => {
    request.mockResolvedValue(state); await mount();
    let resolve!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await reconnect(); await act(async () => root.unmount());
    await act(async () => resolve({ ...state, qr: { code: 'old-private-qr' } }));
    expect(host.textContent).toBe(''); root = createRoot(host);
  });
  it('blocks duplicate clicks while a reconnect is in flight and keeps provider errors retryable', async () => {
    request.mockResolvedValue(state); await mount();
    let reject!: (cause: Error) => void;
    request.mockImplementationOnce(() => new Promise((_r, r) => { reject = r; }));
    await reconnect(); await reconnect();
    expect(request.mock.calls.filter(([input]) => input.type === 'CONNECTION' && input.reconnect).length).toBe(1);
    await act(async () => reject(new Error('Serviço temporariamente indisponível.')));
    expect(host.textContent).toContain('Serviço temporariamente indisponível.'); expect(host.querySelector('button')!.disabled).toBe(false);
  });
  it('shows the responsible person instruction for an agent and never offers a QR action', async () => {
    request.mockResolvedValue({ ...state, canReconnect: false }); await mount();
    expect(host.textContent).toContain('Peça ao responsável'); expect(host.querySelector('button')).toBeNull();
  });
});
