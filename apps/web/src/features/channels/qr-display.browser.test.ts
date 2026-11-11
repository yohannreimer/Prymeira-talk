// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPairingQr } from './qr-display';
const key = 'A'.repeat(43) + '=';
const pairing = `2@synthetic-reference-for-tests,${key},${key},${key}`;
class ProviderImage {
  static last: ProviderImage;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 300; naturalHeight = 300; src = '';
  constructor() { ProviderImage.last = this; }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('provider image reading', () => {
  it('checks raw pairing without creating an image', async () => {
    const image = vi.fn(); vi.stubGlobal('Image', image);
    expect(await readPairingQr(pairing)).toBe(pairing);
    expect(await readPairingQr('https://example.com/setup')).toBeNull();
    expect(image).not.toHaveBeenCalled();
  });
  it('settles an unreadable image without exposing its source', async () => {
    vi.stubGlobal('Image', ProviderImage);
    const result = readPairingQr('data:image/png;base64,broken');
    ProviderImage.last.onerror!();
    expect(await result).toBeNull();
    expect(ProviderImage.last.onload).toBeNull();
  });
  it('bounds stalled image loading and cancels a replaced image', async () => {
    vi.useFakeTimers(); vi.stubGlobal('Image', ProviderImage);
    const controller = new AbortController();
    const first = readPairingQr('data:image/png;base64,stalled', controller.signal);
    controller.abort();
    expect(await first).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const second = readPairingQr('data:image/png;base64,stalled');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await second).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects oversized images before allocating a canvas', async () => {
    vi.stubGlobal('Image', ProviderImage);
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const result = readPairingQr('data:image/png;base64,large');
    ProviderImage.last.naturalWidth = ProviderImage.last.naturalHeight = 10_000;
    ProviderImage.last.onload!();
    expect(await result).toBeNull();
    expect(context).not.toHaveBeenCalled();
  });
});
