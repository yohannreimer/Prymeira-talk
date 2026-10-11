// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canOptimizePhoto, optimizePhoto } from './photo-optimization';
import { compressPhoto, fittedPhotoSize, jpegDimensions } from './photo-optimization-engine';

const photo = (name = 'foto.jpg', type = 'image/jpeg', size = 800_000) => new File([new Uint8Array(size)], name, { type, lastModified: 123 });
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn(); postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  reply(blob: Blob | null, reason = 'optimized') { this.onmessage?.({ data: { blob, reason } } as MessageEvent); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('photo policy', () => {
  it('only considers large JPEGs; documents, screenshots and animated-capable formats remain untouched', async () => {
    expect(canOptimizePhoto(photo())).toBe(true);
    for (const type of ['image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/heic', 'application/pdf', 'video/mp4', 'audio/ogg', '']) {
      const f = photo('arquivo', type); expect(canOptimizePhoto(f)).toBe(false); expect((await optimizePhoto(f)).file).toBe(f);
    }
    const small = photo('small.jpg', 'image/jpeg', 512 * 1024);
    expect((await optimizePhoto(small)).file).toBe(small); expect(FakeWorker.instances).toHaveLength(0);
  });
  it('does not upscale and retains portrait, landscape and extreme aspect ratios', () => {
    expect(fittedPhotoSize(4000, 3000)).toEqual({ width: 2560, height: 1920 });
    expect(fittedPhotoSize(3000, 4000)).toEqual({ width: 1920, height: 2560 });
    expect(fittedPhotoSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fittedPhotoSize(60000, 1)).toEqual({ width: 2560, height: 1 });
    expect(() => fittedPhotoSize(0, 1)).toThrow();
  });
  it('reads JPEG frame dimensions and rejects malformed/truncated headers before decode', () => {
    const h = Uint8Array.from([255,216,255,224,0,4,0,0,255,192,0,8,8,11,184,15,160,0]);
    expect(jpegDimensions(h)).toEqual({ width: 4000, height: 3000 });
    expect(jpegDimensions(h.slice(0, 14))).toBeNull();
    expect(jpegDimensions(Uint8Array.from([255,216,255,224,0,0]))).toBeNull();
    expect(jpegDimensions(new Uint8Array(10))).toBeNull();
  });
});
describe('bounded worker preparation', () => {
  it('original option bypasses processing byte for byte', async () => {
    const f = photo(); expect(await optimizePhoto(f, true)).toEqual({ file: f, reason: 'original' });
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('uses the smaller JPEG, keeps its filename/lastModified and terminates its worker', async () => {
    const f = photo(); const p = optimizePhoto(f); await flush();
    const worker = FakeWorker.instances[0]!; worker.reply(new Blob([new Uint8Array(100_000)], { type: 'image/jpeg' }));
    const r = await p; expect(r.reason).toBe('optimized'); expect(r.file.size).toBe(100_000);
    expect(r.file.name).toBe(f.name); expect(r.file.lastModified).toBe(123); expect(f.size).toBe(800_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it.each(['larger', 'negligible', 'empty', 'wrong-type', 'invalid'])('keeps original for %s worker output', async kind => {
    const f = photo(); const p = optimizePhoto(f); await flush();
    const blob = kind === 'invalid' ? null : new Blob([new Uint8Array(kind === 'larger' ? 900_000 : kind === 'negligible' ? 790_000 : kind === 'empty' ? 0 : 100_000)], { type: kind === 'wrong-type' ? 'image/png' : 'image/jpeg' });
    FakeWorker.instances[0]!.reply(blob); expect((await p).file).toBe(f);
  });
  it('keeps original without a Worker or if its creation fails', async () => {
    vi.stubGlobal('Worker', undefined); const f = photo(); expect((await optimizePhoto(f)).file).toBe(f);
    vi.stubGlobal('Worker', class { constructor() { throw Error('CSP'); } }); expect((await optimizePhoto(photo())).file.size).toBe(800_000);
  });
  it.each(['error', 'messageerror', 'timeout'])('falls back and releases the worker on %s', async kind => {
    vi.useFakeTimers(); const f = photo(); const p = optimizePhoto(f); await flush(); const worker = FakeWorker.instances[0]!;
    if (kind === 'error') worker.onerror?.({ preventDefault() {} } as ErrorEvent);
    else if (kind === 'messageerror') worker.onmessageerror?.();
    else await vi.advanceTimersByTimeAsync(8000);
    expect((await p).file).toBe(f); expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('runs only one worker at a time even for several images requested together', async () => {
    const p = [optimizePhoto(photo('1.jpg')), optimizePhoto(photo('2.jpg')), optimizePhoto(photo('3.jpg'))];
    await flush(); expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.instances[0]!.reply(null, 'unchanged'); await p[0]; await flush(); expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1]!.reply(null, 'unchanged'); await p[1]; await flush(); expect(FakeWorker.instances).toHaveLength(3);
    FakeWorker.instances[2]!.reply(null, 'unchanged'); await Promise.all(p);
  });
  it('bounds waiting images and allows subsequent preparation after the queue drains', async () => {
    const pending = Array.from({ length: 4 }, (_, i) => optimizePhoto(photo(`${i}.jpg`)));
    const excess = photo('excess.jpg');
    expect(await optimizePhoto(excess)).toEqual({ file: excess, reason: 'busy' });
    for (let i = 0; i < 4; i++) { await flush(); FakeWorker.instances[i]!.reply(null); await pending[i]; }
    const next = optimizePhoto(photo('next.jpg')); await flush();
    expect(FakeWorker.instances).toHaveLength(5); FakeWorker.instances[4]!.reply(null); await next;
  });
  it('releases a worker when posting the file fails', async () => {
    vi.stubGlobal('Worker', class extends FakeWorker { postMessage = vi.fn(() => { throw Error('DataCloneError'); }); });
    const f = photo(); expect(await optimizePhoto(f)).toEqual({ file: f, reason: 'unavailable' });
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});

describe('engine resource and orientation guards', () => {
  const jpeg = (w: number, h: number) => Uint8Array.from([255,216,255,192,0,8,8,h >> 8,h & 255,w >> 8,w & 255,0]);
  const fileWith = (bytes: Uint8Array) => ({ slice: () => ({ arrayBuffer: async () => bytes.buffer }) }) as unknown as File;
  it('does not decode malformed or over-60MP headers and handles unsupported browsers', async () => {
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode); vi.stubGlobal('OffscreenCanvas', class {});
    expect(await compressPhoto(fileWith(new Uint8Array(100)))).toBeNull();
    expect(await compressPhoto(fileWith(jpeg(10000, 10000)))).toBeNull(); expect(decode).not.toHaveBeenCalled();
    vi.stubGlobal('OffscreenCanvas', undefined); expect(await compressPhoto(fileWith(jpeg(4000, 3000)))).toBeNull();
  });
  it.each([false, true])('uses oriented dimensions, 85% JPEG and closes the bitmap (encoder fails: %s)', async fails => {
    const bitmap = { width: 3000, height: 4000, close: vi.fn() }; const draw = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const convert = vi.fn(async () => { if (fails) throw Error('encode'); return new Blob(['jpeg'], { type: 'image/jpeg' }); });
    const sizes: number[][] = [];
    vi.stubGlobal('OffscreenCanvas', class { constructor(w: number, h: number) { sizes.push([w, h]); } getContext() { return { drawImage: draw }; } convertToBlob = convert; });
    const result = compressPhoto(fileWith(jpeg(4000, 3000)));
    if (fails) await expect(result).rejects.toThrow('encode'); else expect((await result)?.type).toBe('image/jpeg');
    expect(sizes).toEqual([[1920, 2560]]); expect(convert).toHaveBeenCalledWith({ type: 'image/jpeg', quality: .85 });
    expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 1920, 2560); expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
