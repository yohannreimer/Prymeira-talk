import { memo, useContext, useEffect, useRef, useState } from 'react';
import { Download, FileText, LoaderCircle, Mic, Pause, Play, RotateCcw, Sticker, Video, X } from 'lucide-react';
import type { MessageDto } from '@prymeira-talk/shared';
import { apiGetAudioTranscription, apiGetInboxMedia, apiGetPdfPreview } from '../../app/api';
import { SessionBlobCache } from '../../app/session/blob-cache';
import { BlobCacheContext } from '../../app/session/blob-cache-context';
import { ContactAvatar } from './ContactAvatar';
import './inbox-media.css';

export type InboxMediaTransport = {
  media: typeof apiGetInboxMedia;
  preview: typeof apiGetPdfPreview;
  transcribe?: typeof apiGetAudioTranscription;
};
const defaultTransport: InboxMediaTransport = { media: apiGetInboxMedia, preview: apiGetPdfPreview, transcribe: apiGetAudioTranscription };

type MediaMessage = Pick<MessageDto, 'type' | 'body'> & Partial<Pick<MessageDto, 'mediaUrl' | 'attachment'>>;
const placeholder = /^(Imagem recebida|Figurinha recebida|Arquivo recebido|Áudio recebido|Áudio enviado|Vídeo recebido|Vídeo enviado)$/i;
const pendingAudio = /^(Áudio recebido|Áudio enviado|Processando áudio\.\.\.|Não foi possível transcrever este áudio\.)$/i;
function audioTranscript(body: string | null) {
  const text = body?.trim();
  return text && !pendingAudio.test(text) ? text : null;
}
const filename = /^[^\n]{1,240}\.(pdf|docx?|xlsx?|csv|txt|zip|png|jpe?g|webp|mp4|ogg|mp3)$/i;
function compactPreviewMime(message: MediaMessage) {
  const source = message.mediaUrl;
  if (!source || source.length > 1_024 || !/^https?:\/\//i.test(source) || !source.includes('previewMime=')) return undefined;
  try {
    const url = new URL(source);
    if (!/^\/api\/conversations\/[^/]+\/messages\/[^/]+\/media$/.test(url.pathname)) return undefined;
    const mimeType = url.searchParams.get('previewMime')?.toLowerCase();
    return mimeType && /^(application\/pdf|video\/[a-z0-9.+-]+)$/.test(mimeType) ? mimeType : undefined;
  } catch { return undefined; }
}
export function mediaFileName(message: MediaMessage) {
  if (message.attachment?.fileName?.trim()) return message.attachment.fileName;
  const body = message.body?.trim();
  if (body && filename.test(body)) return body;
  if (message.attachment?.mimeType?.toLowerCase().startsWith('video/')) return 'Vídeo.mp4';
  if (message.attachment?.mimeType?.toLowerCase() === 'application/pdf' || compactPreviewMime(message) === 'application/pdf') return 'Documento.pdf';
  return /(?:application\/pdf|\.pdf(?:\?|$))/i.test(message.mediaUrl ?? '') ? 'Documento.pdf' : 'Documento';
}
export function mediaCaption(message: MediaMessage) {
  if (message.attachment?.caption?.trim()) return message.attachment.caption;
  const body = message.body?.trim();
  if (!body || placeholder.test(body) || message.type === 'audio' || (message.type === 'file' && filename.test(body))) return null;
  return body;
}
export function audioTime(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function PdfPages({ message, getToken, transport }: { message: MessageDto; getToken: () => Promise<string | null>; transport: InboxMediaTransport }) {
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<{ imageUrl: string; pages: number } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const token = useRef(getToken); token.current = getToken;
  useEffect(() => {
    const abort = new AbortController(); setPreview(null); setError(false);
    void transport.preview(message.conversationId, message.id, page, () => token.current(), abort.signal)
      .then(data => { if (!abort.signal.aborted) setPreview(data); }).catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, [message.id, page, retry]);
  return <div className="talk-pdf-pages">
    <nav aria-label="Páginas do PDF"><button type="button" disabled={page === 1 || !preview} onClick={() => setPage(page - 1)}>Anterior</button>
      <span>Página {page}{preview ? ` de ${preview.pages}` : ''}</span>
      <button type="button" disabled={!preview || page >= preview.pages} onClick={() => setPage(page + 1)}>Próxima</button></nav>
    <div className="talk-pdf-sheet">{preview ? <img src={preview.imageUrl} alt={`Página ${page} do PDF`} /> : error ? <p>Prévia indisponível. <button type="button" onClick={() => setRetry(retry + 1)}>Tentar novamente</button></p> : <p role="status">Carregando página…</p>}</div>
  </div>;
}

function MediaViewer({ src, kind, name, message, getToken, transport, onClose }: { src: string; kind: 'image' | 'pdf' | 'video'; name: string; message: MessageDto; getToken: () => Promise<string | null>; transport: InboxMediaTransport; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="talk-media-viewer" ref={dialog} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <header><strong>{name}</strong><a href={src} download={name} aria-label="Baixar arquivo"><Download size={20} /></a>
      <button type="button" aria-label="Fechar visualização" onClick={onClose} autoFocus><X size={22} /></button></header>
    <div className="talk-media-viewer-content">
      {kind === 'image' ? <img src={src} alt={name} /> : kind === 'video' ? <video src={src} controls /> : <PdfPages message={message} getToken={getToken} transport={transport} />}
    </div>
    {kind === 'pdf' ? <footer>Se a prévia não aparecer, <a href={src} download={name}>baixe o PDF</a> para abrir no seu dispositivo.</footer> : null}
  </dialog>;
}

/** Fetches privately on demand; local media URLs comply with production CSP. */
/** A received voice note shows who sent it, like WhatsApp: the contact's photo (or initials in a group) with a mic badge. */
export const InboxMedia = memo(function InboxMedia({ message, getToken, transport = defaultTransport, avatarConversationId, avatarChannelId, avatarName }: {
  message: MessageDto; getToken: () => Promise<string | null>; transport?: InboxMediaTransport; avatarConversationId?: string; avatarChannelId?: string; avatarName?: string | null;
}) {
  const sharedCache = useContext(BlobCacheContext);
  const [localCache] = useState(() => new SessionBlobCache());
  const cache = sharedCache ?? localCache;
  const mediaIdentity = message.mediaSourceHash ?? message.mediaUrl ?? '';
  const cacheKey = `media:${message.conversationId}:${message.id}:${mediaIdentity}`;
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const videoVisibleRef = useRef(false);
  const videoPlayingRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const transcriptController = useRef<AbortController | null>(null);
  const pending = useRef<Promise<{ url: string; blob: Blob }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const initialMediaSource = () => /^(data:image\/(jpeg|png|webp|gif)|data:video\/(mp4|webm|quicktime));/i.test(message.mediaUrl ?? '') ? message.mediaUrl : null;
  const [src, setSrc] = useState<string | null>(initialMediaSource);
  const [viewer, setViewer] = useState<'image' | 'pdf' | 'video' | null>(null);
  const [playing, setPlaying] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoVisible, setVideoVisible] = useState(false);
  const [duration, setDuration] = useState(message.attachment?.durationSeconds ?? 0);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [requestedTranscript, setRequestedTranscript] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState(false);
  const name = mediaFileName(message);
  const isImage = message.type === 'image';
  const isAudio = message.type === 'audio';
  // WhatsApp's animated (lottie) stickers arrive as application/was, which browsers cannot draw.
  const isSticker = isImage && message.body === 'Figurinha recebida';
  const previewMime = compactPreviewMime(message);
  const isVideo = message.attachment?.mimeType?.toLowerCase().startsWith('video/') || previewMime?.startsWith('video/') || /^data:video\//i.test(message.mediaUrl ?? '') || /\.(mp4|mov|webm)(\?|$)/i.test(message.mediaUrl ?? '');
  const isGif = Boolean(isVideo && message.attachment?.isGif);
  const [autoStart, setAutoStart] = useState(false);
  const { width: mediaWidth, height: mediaHeight } = message.attachment ?? {};
  // Like WhatsApp: a clip keeps its shape, and a tall one is sized by its height, never stretched to the bubble width.
  const aspect = mediaWidth && mediaHeight ? { aspectRatio: `${mediaWidth} / ${mediaHeight}`,
    ...(mediaHeight > mediaWidth ? { width: `min(${Math.round(320 * mediaWidth / mediaHeight)}px, 58vw)`, minHeight: 0 } : {}) } : undefined;
  const isPdf = message.attachment?.mimeType?.toLowerCase() === 'application/pdf' || previewMime === 'application/pdf' || /pdf/i.test(name + message.mediaUrl?.slice(0, 40));
  useEffect(() => {
    setSrc(initialMediaSource());
    setError(false); setViewer(null); setPlaying(false); setLoading(false);
    setPosition(0); setDuration(message.attachment?.durationSeconds ?? 0);
    setVideoPlaying(false); videoPlayingRef.current = false; setAutoStart(false);
    setTranscriptOpen(false); setRequestedTranscript(null); setTranscriptLoading(false); setTranscriptError(false);
    return () => {
      controller.current?.abort();
      transcriptController.current?.abort();
      audio.current?.pause();
      video.current?.pause();
      pending.current = null;
      if (!sharedCache) localCache.clear();
    };
  }, [message.id, mediaIdentity, cache, cacheKey, sharedCache, localCache]);
  useEffect(() => {
    if (!(viewer || playing || videoPlaying || (isVideo && videoVisible && src))) return;
    cache.retain(cacheKey);
    return () => cache.release(cacheKey);
  }, [cache, cacheKey, viewer, playing, videoPlaying, isVideo, videoVisible, src]);

  function releasePausedVideo() {
    if (videoPlayingRef.current) return;
    const element = video.current;
    if (element?.getAttribute('src')) { element.removeAttribute('src'); element.load(); }
    setSrc(null);
  }

  async function load() {
    const cached = cache.get(cacheKey);
    if (cached) { setSrc(cached.url); return cached; }
    if (pending.current) return pending.current;
    controller.current = new AbortController();
    setLoading(true); setError(false);
    const signal = controller.current.signal;
    cache.retain(cacheKey);
    const job = (async () => {
      const item = await cache.load(cacheKey, () => transport.media(message.conversationId, message.id, getToken, signal));
      signal.throwIfAborted();
      setSrc(item.url);
      return item;
    })();
    pending.current = job;
    try { return await job; }
    catch (e) { if (!signal.aborted) setError(true); throw e; }
    finally {
      if (pending.current === job) pending.current = null;
      if (!signal.aborted) setLoading(false);
      // Keep the URL alive until playback/viewer state has committed.
      requestAnimationFrame(() => cache.release(cacheKey));
    }
  }

  // Only visible remote images load: opening a long history must not fetch every attachment.
  useEffect(() => {
    if ((!isImage && !isVideo) || !root.current) return;
    let visible = false;
    const observer = new IntersectionObserver(entries => {
      const nextVisible = entries.some(entry => entry.isIntersecting);
      if (nextVisible === visible) return;
      visible = nextVisible;
      if (isVideo) {
        videoVisibleRef.current = visible; setVideoVisible(visible);
        // A GIF plays once by itself when it comes on screen, like WhatsApp; off screen it stops and frees its bytes.
        if (isGif && visible) { void load().catch(() => {}); return; }
        if (isGif) { video.current?.pause(); videoPlayingRef.current = false; }
        if (!visible) releasePausedVideo();
        return;
      }
      if (!visible) { cache.release(cacheKey); return; }
      cache.retain(cacheKey);
      if (initialMediaSource()) return;
      if (!cache.get(cacheKey)) setSrc(null);
      void load().catch(() => {});
    }, { rootMargin: '100px' });
    observer.observe(root.current);
    return () => { observer.disconnect(); if (visible && isImage) cache.release(cacheKey); };
  }, [message.id, mediaIdentity, cache, cacheKey, isVideo, isImage, isGif]);

  async function play() {
    if (!audio.current || loading) return;
    if (!audio.current.paused) { audio.current.pause(); return; }
    try {
      const item = await load();
      if (!audio.current) return;
      if (audio.current.src !== item.url) audio.current.src = item.url;
      audio.current.playbackRate = speed;
      await audio.current.play();
    } catch { if (!controller.current?.signal.aborted) setError(true); }
  }
  async function open(download = false) {
    try {
      if (isImage && src && !error && !download) { setViewer('image'); return; }
      const item = await load();
      const kind = isImage ? 'image' : item.blob.type === 'application/pdf' ? 'pdf' : item.blob.type.startsWith('video/') ? 'video' : null;
      if (download || !kind) {
        const anchor = document.createElement('a'); anchor.href = item.url; anchor.download = name;
        anchor.click();
      } else setViewer(kind);
    } catch { /* Visible retry is shared by every attachment type. */ }
  }
  const transcript = audioTranscript(message.body) ?? requestedTranscript;
  async function showTranscript() {
    if (transcriptOpen) { setTranscriptOpen(false); return; }
    setTranscriptOpen(true);
    if (transcript || transcriptLoading || !transport.transcribe) return;
    transcriptController.current?.abort();
    const abort = new AbortController();
    transcriptController.current = abort;
    setTranscriptLoading(true); setTranscriptError(false);
    try {
      const result = await transport.transcribe(message.conversationId, message.id, getToken, abort.signal);
      if (!abort.signal.aborted) setRequestedTranscript(result.text);
    } catch {
      if (!abort.signal.aborted) setTranscriptError(true);
    } finally {
      if (!abort.signal.aborted) setTranscriptLoading(false);
    }
  }
  return <div className="talk-attachment" ref={root}>
    {isAudio ? <>
      <div className="talk-voice-note">
        {avatarConversationId || avatarChannelId || avatarName ? <span className="talk-voice-avatar" aria-hidden="true">
          <ContactAvatar conversationId={avatarConversationId} channelId={avatarChannelId} name={avatarName} className="talk-voice-avatar-photo" />
          <Mic className="talk-voice-avatar-mic" size={15} />
        </span> : <span className="talk-voice-icon" aria-hidden="true"><Mic size={24} /></span>}
        <button className="talk-media-play" type="button" aria-label={playing ? 'Pausar áudio' : 'Reproduzir áudio'} disabled={loading} onClick={() => void play()}>
          {loading ? <LoaderCircle className="talk-media-loading" size={23} /> : playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
        </button>
        <div className="talk-voice-track">
          <input aria-label="Posição do áudio" type="range" min={0} max={duration || 1} step={0.1} value={position} disabled={!duration}
            onChange={e => { if (audio.current) { audio.current.currentTime = Number(e.target.value); setPosition(Number(e.target.value)); } }} />
          <span>{duration ? audioTime(playing || position ? position : duration) : loading ? 'Carregando…' : 'Áudio'}</span>
        </div>
        <button className="talk-voice-speed" type="button" aria-label={`Velocidade do áudio: ${speed}x`} onClick={() => {
          const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; setSpeed(next); if (audio.current) audio.current.playbackRate = next;
        }}>{speed}×</button>
        <audio ref={audio} preload="none" onLoadedMetadata={() => setDuration(Number.isFinite(audio.current?.duration) ? audio.current!.duration : 0)}
          onDurationChange={() => setDuration(Number.isFinite(audio.current?.duration) ? audio.current!.duration : 0)}
          onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)} onPlay={() => { setPlaying(true); setError(false); }}
          onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPosition(0); }} onError={() => { setError(true); setPlaying(false); }} />
      </div>
      <div className="talk-audio-transcript">
        {(transcript || transport.transcribe) ? <button type="button" aria-expanded={transcriptOpen} onClick={() => void showTranscript()}>{transcriptOpen ? 'Ocultar transcrição' : 'Ver transcrição'}</button> : null}
        {transcriptOpen ? <p role="status">{transcript ?? (transcriptLoading ? 'Transcrevendo áudio…' : transcriptError ? 'Transcrição indisponível. Feche e tente novamente.' : 'Transcrição indisponível.')}</p> : null}
      </div>
    </> : isSticker && error ? <span className="talk-sticker-fallback" role="img" aria-label="Figurinha animada">
      <Sticker size={30} aria-hidden="true" /><small>Figurinha animada</small>
    </span> : isImage ? <button className={`talk-image-preview${isSticker ? ' is-sticker' : ''}`} type="button" aria-label="Ampliar imagem" onClick={() => void open()}>
      {src && !error ? <img src={src} loading="lazy" decoding="async" alt={mediaCaption(message) || (isSticker ? 'Figurinha' : 'Imagem da conversa')} onError={() => setError(true)} /> : <span>{loading ? (isSticker ? 'Carregando figurinha…' : 'Carregando imagem…') : isSticker ? 'Figurinha' : 'Abrir imagem'}</span>}
    </button> : isGif ? <button type="button" className="talk-gif-preview" style={aspect} aria-label={videoPlaying ? 'Pausar GIF' : 'Tocar GIF'}
      onClick={() => { const element = video.current; if (element) void (element.paused ? element.play().catch(() => {}) : element.pause()); }}>
      {src && !error ? <video ref={video} src={src} autoPlay muted playsInline preload="auto" aria-hidden="true" onError={() => setError(true)}
        onPlay={() => { videoPlayingRef.current = true; setVideoPlaying(true); }}
        onPause={() => { videoPlayingRef.current = false; setVideoPlaying(false); }}
        onEnded={() => { videoPlayingRef.current = false; setVideoPlaying(false); }} />
        : loading ? <LoaderCircle className="talk-media-loading" size={26} /> : null}
      {videoPlaying ? null : <span className="talk-gif-badge">GIF</span>}
    </button> : isVideo ? <div className="talk-video-preview" style={aspect}>
      {src ? <video ref={video} src={src} controls playsInline autoPlay={autoStart} preload={autoStart ? 'auto' : 'none'} aria-label="Vídeo da conversa"
        onPlay={() => { videoPlayingRef.current = true; setVideoPlaying(true); }}
        onPause={() => { videoPlayingRef.current = false; setVideoPlaying(false); if (!videoVisibleRef.current) releasePausedVideo(); }}
        onEnded={() => { videoPlayingRef.current = false; setVideoPlaying(false); if (!videoVisibleRef.current) releasePausedVideo(); }} /> :
        <button type="button" aria-label="Reproduzir vídeo" disabled={loading} onClick={() => { setAutoStart(true); void load().catch(() => {}); }}>
          {loading ? <LoaderCircle className="talk-media-loading" size={28} /> : <><Video size={28} /><span>Reproduzir vídeo</span></>}
        </button>}
    </div> : <div className="talk-document-card">
      <button type="button" className="talk-document-open" aria-label="Abrir documento" onClick={() => void open()} disabled={loading}>
        <span className="talk-document-icon"><FileText size={27} /><small>{isVideo ? 'VÍDEO' : isPdf ? 'PDF' : 'ARQ'}</small></span>
        <span className="talk-document-title"><strong>{name}</strong><small>{loading ? 'Carregando…' : isVideo ? 'Abrir vídeo' : 'Abrir documento'}</small></span>
      </button>
      <button className="talk-document-download" type="button" aria-label="Baixar documento" disabled={loading} onClick={() => void open(true)}><Download size={20} /></button>
    </div>}
    {error && !isSticker ? <div className="talk-media-error" role="status"><span>Não foi possível carregar {isAudio ? 'o áudio' : 'o arquivo'}.</span>
      <button type="button" onClick={() => { setError(false); if (isAudio) void play(); else void open(); }}><RotateCcw size={13} /> Tentar novamente</button></div> : null}
    {viewer && src ? <MediaViewer src={src} kind={viewer} message={message} getToken={getToken} transport={transport} name={isImage ? 'Imagem da conversa' : name} onClose={() => setViewer(null)} /> : null}
  </div>;
});
