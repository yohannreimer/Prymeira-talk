import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBlobCache } from './blob-cache';
afterEach(() => vi.restoreAllMocks());
describe('shared session Blob budget', () => {
  it('deduplicates photos/media and revokes LRU URLs on discard', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL'); const cache = new SessionBlobCache(10);
    const fetch = vi.fn(async () => new Blob(['123456']));
    const [first, duplicate] = await Promise.all([cache.load('photo', fetch), cache.load('photo', fetch)]);
    expect(first).toBe(duplicate); expect(fetch).toHaveBeenCalledOnce();
    await cache.load('media', async () => new Blob(['123456']));
    expect(revoke).toHaveBeenCalledWith(first.url); expect(cache.sizeBytes).toBe(6);
    cache.clear(); expect(cache.sizeBytes).toBe(0); expect(revoke).toHaveBeenCalledTimes(2);
  });
  it('never revokes playing/visible resources and never exceeds the byte budget', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL'); const cache = new SessionBlobCache(10);
    cache.retain('audio'); const audio = await cache.load('audio', async () => new Blob(['123456']));
    await expect(cache.load('video', async () => new Blob(['123456']))).rejects.toThrow('Feche');
    expect(cache.sizeBytes).toBe(6); expect(revoke).not.toHaveBeenCalled();
    cache.release('audio'); await cache.load('video', async () => new Blob(['123456']));
    expect(revoke).toHaveBeenCalledWith(audio.url); cache.clear();
  });
  it('discards late work from a cleared auth scope before creating an object URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL'); const cache = new SessionBlobCache();
    let release!: (blob: Blob) => void;
    const pending = cache.load('photo', () => new Promise(resolve => { release = resolve; }));
    cache.clear(); release(new Blob(['late']));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(create).not.toHaveBeenCalled(); expect(cache.sizeBytes).toBe(0);
  });
});
