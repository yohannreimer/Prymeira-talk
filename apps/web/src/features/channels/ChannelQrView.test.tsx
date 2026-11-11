// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelQrView } from './ChannelQrView';
const mocks = vi.hoisted(() => ({ read: vi.fn(), render: vi.fn() }));
vi.mock('./qr-display', async (actual) => ({ ...await actual<object>(), readPairingQr: mocks.read }));
vi.mock('qrcode', () => ({ default: { toDataURL: mocks.render } }));
const key = 'A'.repeat(43) + '=';
const pairing = `2@synthetic-reference-for-tests,${key},${key},${key}`;
describe('QR scanning readiness', () => {
  let root: Root, container: HTMLDivElement;
  const show = (code: string, expiresAt = new Date(Date.now() + 60_000).toISOString()) => root.render(<ChannelQrView qrCode={code} expiresAt={expiresAt} provider="Evolution">{(ready) => <p>{ready ? 'Escaneie agora' : 'Aguarde'}</p>}</ChannelQrView>);
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mocks.read.mockReset(); mocks.render.mockReset();
    mocks.render.mockResolvedValue('data:image/png;base64,verified');
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  it('withholds a provider image and scanning instructions while decoding, including a placeholder', async () => {
    let finish!: (value: string | null) => void;
    mocks.read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => show('data:image/png;base64,provisional'));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('Escaneie agora');
    await act(async () => finish(null));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('Escaneie agora');
  });
  it('renders verified content in black and white, then permits scanning', async () => {
    mocks.read.mockResolvedValue(pairing);
    await act(async () => show(pairing));
    expect(mocks.render).toHaveBeenCalledWith(pairing, expect.objectContaining({ color: { dark: '#000000', light: '#ffffff' } }));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,verified');
    expect(container.textContent).toContain('Escaneie agora');
  });
  it('discards late validation from the previous QR and removes it while its replacement loads', async () => {
    let finishOld!: (value: string) => void, finishNew!: (value: string | null) => void;
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    await act(async () => show('old'));
    await act(async () => show('new'));
    await act(async () => finishOld(pairing));
    expect(container.querySelector('img')).toBeNull();
    await act(async () => finishNew(null));
    expect(container.querySelector('img')).toBeNull();
  });
  it('hides an already rendered QR immediately on replacement, and after expiry', async () => {
    vi.useFakeTimers(); mocks.read.mockResolvedValueOnce(pairing).mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => show(pairing));
    expect(container.querySelector('img')).not.toBeNull();
    await act(async () => show('replacement'));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('Escaneie agora');
    mocks.read.mockResolvedValueOnce(pairing);
    await act(async () => show('third', new Date(Date.now() + 1_000).toISOString()));
    expect(container.querySelector('img')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('expirado');
    expect(container.textContent).not.toContain('Escaneie agora');
  });
});
