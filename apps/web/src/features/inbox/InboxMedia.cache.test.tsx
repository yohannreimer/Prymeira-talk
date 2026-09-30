// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { MessageDto } from '@prymeira-talk/shared';
import { InboxMedia } from './InboxMedia';
import { SessionBlobCache } from '../../app/session/blob-cache';
import { BlobCacheContext } from '../../app/session/blob-cache-context';
class VisibilityObserver {
  static instances: VisibilityObserver[] = [];
  observe = vi.fn(); disconnect = vi.fn();
  constructor(readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) { VisibilityObserver.instances.push(this); }
  visible(value: boolean) { this.callback([{ isIntersecting: value }]); }
}
const message = (id: string): MessageDto => ({ id, conversationId: 'c1', workspaceId: 'w', providerMessageId: null, direction: 'inbound', type: 'image', body: null, mediaUrl: `https://talk.example.test/api/conversations/c1/messages/${id}/media?v=source`, status: 'read', sentByUserId: null, createdAt: '2026-09-30T00:00:00Z' });
describe('attachment memory lifetime', () => {
  it('defers inline history image decoding without a media request', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal('IntersectionObserver', VisibilityObserver); VisibilityObserver.instances = [];
    const media = vi.fn(); const cache = new SessionBlobCache(10);
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<BlobCacheContext.Provider value={cache}><InboxMedia message={{ ...message('inline'), mediaUrl: 'data:image/png;base64,YQ==' }} getToken={async () => 'token'} transport={{ media, preview: vi.fn() }} /></BlobCacheContext.Provider>));
      const image = container.querySelector('img')!;
      expect(image.getAttribute('loading')).toBe('lazy'); expect(image.getAttribute('decoding')).toBe('async');
      expect(media).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); cache.clear(); container.remove(); vi.unstubAllGlobals(); }
  });
  it('releases offscreen images for eviction and reloads them when visible again', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', VisibilityObserver); VisibilityObserver.instances = [];
    const create = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second').mockReturnValueOnce('blob:reloaded');
    const revoke = vi.fn(); Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true }); Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const cache = new SessionBlobCache(10); const media = vi.fn(async () => new Blob(['123456']));
    const transport = { media, preview: vi.fn() }; const token = async () => 'token';
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    await act(async () => root.render(<BlobCacheContext.Provider value={cache}><InboxMedia message={message('one')} getToken={token} transport={transport} /><InboxMedia message={message('two')} getToken={token} transport={transport} /></BlobCacheContext.Provider>));
    expect(media).not.toHaveBeenCalled();
    await act(async () => VisibilityObserver.instances[0].visible(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(media).toHaveBeenCalledOnce();
    await act(async () => { VisibilityObserver.instances[0].visible(false); VisibilityObserver.instances[1].visible(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(revoke).toHaveBeenCalledWith('blob:first'); expect(cache.sizeBytes).toBe(6);
    await act(async () => { VisibilityObserver.instances[1].visible(false); VisibilityObserver.instances[0].visible(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(media).toHaveBeenCalledTimes(3); expect(container.querySelector<HTMLImageElement>('img')?.src).toBe('blob:reloaded');
    expect(cache.sizeBytes).toBe(6);
    await act(async () => root.unmount()); cache.clear(); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  });
  it('loads compact audio only on play through its authenticated transport IDs', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    const create = vi.fn(() => 'blob:audio'); const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true }); Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const media = vi.fn(async () => new Blob(['audio'], { type: 'audio/ogg' })); const cache = new SessionBlobCache();
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<BlobCacheContext.Provider value={cache}><InboxMedia message={{ ...message('audio'), type: 'audio', body: 'Áudio recebido', attachment: { mimeType: 'audio/ogg', durationSeconds: 73 } }} getToken={async () => 'token'} transport={{ media, preview: vi.fn() }} /></BlobCacheContext.Provider>));
      expect(media).not.toHaveBeenCalled(); expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
      expect(container.querySelector('audio')?.preload).toBe('none'); expect(container.textContent).toContain('1:13');
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reproduzir áudio"]')!.click());
      await act(async () => { await vi.advanceTimersByTimeAsync(40); });
      expect(media).toHaveBeenCalledWith('c1', 'audio', expect.any(Function), expect.any(AbortSignal));
      expect(media).toHaveBeenCalledOnce(); expect(play).toHaveBeenCalledOnce(); expect(container.querySelector('audio')?.getAttribute('src')).toBe('blob:audio');
    } finally { await act(async () => root.unmount()); cache.clear(); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); }
  });
  it('pins a playing offscreen video, then clears its decoded source when paused and reloads after eviction', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', VisibilityObserver); VisibilityObserver.instances = [];
    const create = vi.fn().mockReturnValueOnce('blob:video').mockReturnValueOnce('blob:other').mockReturnValueOnce('blob:video-reloaded');
    const revoke = vi.fn(); Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true }); Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const clearDecoded = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const cache = new SessionBlobCache(10); const media = vi.fn(async () => new Blob(['123456'], { type: 'video/mp4' }));
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    const videoMessage = { ...message('video'), type: 'file' as const, attachment: { mimeType: 'video/mp4' } };
    try {
      await act(async () => root.render(<BlobCacheContext.Provider value={cache}><InboxMedia message={videoMessage} getToken={async () => 'token'} transport={{ media, preview: vi.fn() }} /></BlobCacheContext.Provider>));
      await act(async () => VisibilityObserver.instances[0].visible(true)); expect(media).not.toHaveBeenCalled();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reproduzir vídeo"]')!.click());
      await act(async () => { await vi.advanceTimersByTimeAsync(40); });
      const video = container.querySelector<HTMLVideoElement>('video')!;
      expect(video.preload).toBe('none');
      await act(async () => video.dispatchEvent(new Event('play')));
      await act(async () => VisibilityObserver.instances[0].visible(false));
      expect(video.getAttribute('src')).toBe('blob:video');
      await expect(cache.load('competing', async () => new Blob(['abcdef']))).rejects.toThrow('Feche uma mídia');
      expect(revoke).not.toHaveBeenCalled();
      await act(async () => video.dispatchEvent(new Event('pause')));
      expect(video.getAttribute('src')).toBeNull(); expect(clearDecoded).toHaveBeenCalledOnce();
      expect(container.querySelector('video')).toBeNull();
      await cache.load('competing', async () => new Blob(['abcdef'])); expect(revoke).toHaveBeenCalledWith('blob:video');
      await act(async () => VisibilityObserver.instances[0].visible(true)); expect(media).toHaveBeenCalledOnce();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reproduzir vídeo"]')!.click());
      await act(async () => { await vi.advanceTimersByTimeAsync(40); });
      expect(media).toHaveBeenCalledTimes(2); expect(container.querySelector<HTMLVideoElement>('video')?.src).toBe('blob:video-reloaded');
      expect(cache.sizeBytes).toBe(6);
    } finally { await act(async () => root.unmount()); cache.clear(); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
  });
});
