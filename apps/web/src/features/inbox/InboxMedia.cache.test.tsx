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
  it.each(['compact', 'raw'])('preserves playing audio and pending transcription across %s representation updates and reuses its versioned cache', async first => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    const create = vi.fn().mockReturnValueOnce('blob:original').mockReturnValueOnce('blob:changed');
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const playing = new WeakSet<HTMLMediaElement>();
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) { return !playing.has(this); });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { playing.add(this); this.dispatchEvent(new Event('play')); return Promise.resolve(); });
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) { playing.delete(this); this.dispatchEvent(new Event('pause')); });
    const media = vi.fn(async (_conversation: string, _message: string, _token: unknown, _signal?: AbortSignal) => new Blob(['audio'], { type: 'audio/ogg' }));
    let transcriptSignal!: AbortSignal;
    const transcribe = vi.fn((_conversation: string, _message: string, _token: unknown, signal?: AbortSignal) => { transcriptSignal = signal!; return new Promise<{ text: string }>(() => {}); });
    const transport = { media, preview: vi.fn(), transcribe }; const cache = new SessionBlobCache();
    const raw: MessageDto = { ...message('audio-version'), type: 'audio', body: 'Áudio recebido', mediaUrl: 'data:audio/ogg;base64,YQ==', mediaSourceHash: 'a'.repeat(64) };
    const compact = { ...raw, mediaUrl: 'https://talk.example.test/api/conversations/c1/messages/audio-version/media?v=original' };
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    const render = async (value: MessageDto) => { await act(async () => root.render(<BlobCacheContext.Provider value={cache}><InboxMedia message={value} getToken={async () => 'token'} transport={transport} /></BlobCacheContext.Provider>)); };
    try {
      await render(first === 'compact' ? compact : raw);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reproduzir áudio"]')!.click());
      const audio = container.querySelector('audio')!; audio.currentTime = 23;
      await act(async () => audio.dispatchEvent(new Event('timeupdate')));
      await act(async () => container.querySelector<HTMLButtonElement>('.talk-audio-transcript button')!.click());
      const mediaSignal = media.mock.calls[0][3] as AbortSignal;
      for (const value of [first === 'compact' ? raw : compact, first === 'compact' ? compact : raw]) {
        await render({ ...value, body: 'Transcrição recebida' });
        expect(pause).not.toHaveBeenCalled(); expect(audio.currentTime).toBe(23);
        expect(audio.getAttribute('src')).toBe('blob:original'); expect(mediaSignal.aborted).toBe(false); expect(transcriptSignal.aborted).toBe(false);
        expect(container.querySelector('[aria-label="Pausar áudio"]')).not.toBeNull();
        expect(container.querySelector('.talk-audio-transcript button')?.getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('Transcrição recebida');
      }
      expect(media).toHaveBeenCalledOnce(); expect(cache.sizeBytes).toBe(5);
      await render({ ...compact, mediaSourceHash: 'b'.repeat(64), mediaUrl: compact.mediaUrl + '-changed' });
      expect(pause).toHaveBeenCalledOnce(); expect(mediaSignal.aborted).toBe(true); expect(transcriptSignal.aborted).toBe(true);
      expect(container.querySelector('[aria-label="Reproduzir áudio"]')).not.toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reproduzir áudio"]')!.click());
      expect(media).toHaveBeenCalledTimes(2); expect(audio.getAttribute('src')).toBe('blob:changed');
      await act(async () => root.render(null)); await render(raw);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reproduzir áudio"]')!.click());
      expect(media).toHaveBeenCalledTimes(2); expect(container.querySelector('audio')?.getAttribute('src')).toBe('blob:original');
    } finally { await act(async () => root.unmount()); cache.clear(); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); }
  });
  it('keeps an open image viewer and pending media identity across compact/raw updates, then closes it for new bytes', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', VisibilityObserver); VisibilityObserver.instances = [];
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:image-version'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: vi.fn(), configurable: true });
    const media = vi.fn(async (_conversation: string, _message: string, _token: unknown, _signal?: AbortSignal) => new Blob(['image'], { type: 'image/png' })); const cache = new SessionBlobCache();
    const compact = { ...message('image-version'), mediaSourceHash: 'a'.repeat(64) };
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    const render = async (value: MessageDto) => { await act(async () => root.render(<BlobCacheContext.Provider value={cache}><InboxMedia message={value} getToken={async () => 'token'} transport={{ media, preview: vi.fn() }} /></BlobCacheContext.Provider>)); };
    try {
      await render(compact); await act(async () => VisibilityObserver.instances[0].visible(true));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Ampliar imagem"]')!.click());
      const viewer = container.querySelector('dialog')!; const mediaSignal = media.mock.calls[0][3] as AbortSignal;
      await render({ ...compact, mediaUrl: 'data:image/png;base64,YQ==', body: 'Legenda atualizada' });
      await render(compact);
      expect(container.querySelector('dialog')).toBe(viewer); expect(viewer.querySelector('img')?.getAttribute('src')).toBe('blob:image-version');
      expect(media).toHaveBeenCalledOnce(); expect(mediaSignal.aborted).toBe(false); expect(VisibilityObserver.instances).toHaveLength(1);
      await render({ ...compact, mediaSourceHash: 'b'.repeat(64) });
      expect(container.querySelector('dialog')).toBeNull(); expect(mediaSignal.aborted).toBe(true);
    } finally { await act(async () => root.unmount()); cache.clear(); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
  it('retains an in-flight media read across representations and cancels it when the source hash changes', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:pending-audio'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const completions: Array<(blob: Blob) => void> = [];
    const media = vi.fn((_conversation: string, _message: string, _token: unknown, _signal?: AbortSignal) => new Promise<Blob>(resolve => completions.push(resolve)));
    const cache = new SessionBlobCache(); const compact = { ...message('pending-audio'), type: 'audio' as const, mediaSourceHash: 'a'.repeat(64) };
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    const render = async (value: MessageDto) => { await act(async () => root.render(<BlobCacheContext.Provider value={cache}><InboxMedia message={value} getToken={async () => 'token'} transport={{ media, preview: vi.fn() }} /></BlobCacheContext.Provider>)); };
    try {
      await render(compact); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reproduzir áudio"]')!.click());
      const original = media.mock.calls[0][3]!;
      await render({ ...compact, mediaUrl: 'data:audio/ogg;base64,YQ==' });
      expect(original.aborted).toBe(false); expect(media).toHaveBeenCalledOnce();
      await act(async () => completions[0](new Blob(['audio'], { type: 'audio/ogg' })));
      expect(play).toHaveBeenCalledOnce(); expect(container.querySelector('audio')?.getAttribute('src')).toBe('blob:pending-audio');
      await render({ ...compact, mediaSourceHash: 'b'.repeat(64) });
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reproduzir áudio"]')!.click());
      const replaced = media.mock.calls[1][3]!;
      await render({ ...compact, mediaSourceHash: 'c'.repeat(64) });
      expect(replaced.aborted).toBe(true);
      await act(async () => completions[1](new Blob(['changed'], { type: 'audio/ogg' })));
      expect(play).toHaveBeenCalledOnce(); expect(container.querySelector('.talk-media-error')).toBeNull();
    } finally { await act(async () => root.unmount()); cache.clear(); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); }
  });
  it('preserves the same playing video element across compact/raw updates and pauses it for changed bytes', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', VisibilityObserver); VisibilityObserver.instances = [];
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:video-version'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const media = vi.fn(async () => new Blob(['video'], { type: 'video/mp4' })); const cache = new SessionBlobCache();
    const compact = { ...message('video-version'), type: 'file' as const, mediaSourceHash: 'a'.repeat(64), attachment: { mimeType: 'video/mp4' } };
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    const render = async (value: MessageDto) => { await act(async () => root.render(<BlobCacheContext.Provider value={cache}><InboxMedia message={value} getToken={async () => 'token'} transport={{ media, preview: vi.fn() }} /></BlobCacheContext.Provider>)); };
    try {
      await render(compact); await act(async () => VisibilityObserver.instances[0].visible(true));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reproduzir vídeo"]')!.click());
      const video = container.querySelector('video')!; video.currentTime = 23;
      await act(async () => video.dispatchEvent(new Event('play')));
      await render({ ...compact, mediaUrl: 'data:video/mp4;base64,YQ==' }); await render(compact);
      expect(container.querySelector('video')).toBe(video); expect(video.getAttribute('src')).toBe('blob:video-version');
      expect(video.currentTime).toBe(23); expect(pause).not.toHaveBeenCalled(); expect(media).toHaveBeenCalledOnce();
      await render({ ...compact, mediaSourceHash: 'b'.repeat(64) });
      expect(pause).toHaveBeenCalledOnce(); expect(container.querySelector('video')).toBeNull();
    } finally { await act(async () => root.unmount()); cache.clear(); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
  });
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
      expect(video.preload).toBe('auto'); expect(video.autoplay).toBe(true); // the tap that loaded it also starts it, never a black still frame
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
