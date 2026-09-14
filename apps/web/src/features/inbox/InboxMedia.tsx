import { useEffect, useRef, useState } from 'react';
import { Download, FileText, LoaderCircle, Mic, Pause, Play, RotateCcw, X } from 'lucide-react';
import type { MessageDto } from '@prymeira-talk/shared';
import { apiGetInboxMedia, apiGetPdfPreview } from '../../app/api';
import { mediaDataUrl } from './media-data-url';
import './inbox-media.css';

type MediaMessage = Pick<MessageDto, 'type' | 'body'> & Partial<Pick<MessageDto, 'mediaUrl' | 'attachment'>>;
const placeholder = /^(Imagem recebida|Figurinha recebida|Arquivo recebido|Áudio recebido|Áudio enviado|Vídeo recebido)$/i;
const filename = /^[^\n]{1,240}\.(pdf|docx?|xlsx?|csv|txt|zip|png|jpe?g|webp|mp4|ogg|mp3)$/i;
export function mediaFileName(message: MediaMessage) {
  if (message.attachment?.fileName?.trim()) return message.attachment.fileName;
  const body = message.body?.trim();
  if (body && filename.test(body)) return body;
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

function PdfPages({ message, getToken }: { message: MessageDto; getToken: () => Promise<string | null> }) {
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<{ imageUrl: string; pages: number } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const token = useRef(getToken); token.current = getToken;
  useEffect(() => {
    const abort = new AbortController(); setPreview(null); setError(false);
    void apiGetPdfPreview(message.conversationId, message.id, page, () => token.current(), abort.signal)
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

function MediaViewer({ src, kind, name, message, getToken, onClose }: { src: string; kind: 'image' | 'pdf' | 'video'; name: string; message: MessageDto; getToken: () => Promise<string | null>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="talk-media-viewer" ref={dialog} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <header><strong>{name}</strong><a href={src} download={name} aria-label="Baixar arquivo"><Download size={20} /></a>
      <button type="button" aria-label="Fechar visualização" onClick={onClose} autoFocus><X size={22} /></button></header>
    <div className="talk-media-viewer-content">
      {kind === 'image' ? <img src={src} alt={name} /> : kind === 'video' ? <video src={src} controls /> : <PdfPages message={message} getToken={getToken} />}
    </div>
    {kind === 'pdf' ? <footer>Se a prévia não aparecer, <a href={src} download={name}>baixe o PDF</a> para abrir no seu dispositivo.</footer> : null}
  </dialog>;
}

/** Fetches privately on demand; local media URLs comply with production CSP. */
export function InboxMedia({ message, getToken }: { message: MessageDto; getToken: () => Promise<string | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const controller = useRef<AbortController | null>(null);
  const resource = useRef<{ url: string; blob: Blob } | null>(null);
  const pending = useRef<Promise<{ url: string; blob: Blob }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [src, setSrc] = useState<string | null>(() => message.type === 'image' && /^data:image\/(jpeg|png|webp|gif);/i.test(message.mediaUrl ?? '') ? message.mediaUrl : null);
  const [viewer, setViewer] = useState<'image' | 'pdf' | 'video' | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(message.attachment?.durationSeconds ?? 0);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);
  const name = mediaFileName(message);
  const isImage = message.type === 'image';
  const isAudio = message.type === 'audio';
  const isVideo = /^data:video\//i.test(message.mediaUrl ?? '') || /\.(mp4|mov|webm)(\?|$)/i.test(message.mediaUrl ?? '');
  useEffect(() => {
    setSrc(message.type === 'image' && /^data:image\/(jpeg|png|webp|gif);/i.test(message.mediaUrl ?? '') ? message.mediaUrl : null);
    setError(false); setViewer(null); setPlaying(false); setLoading(false);
    setPosition(0); setDuration(message.attachment?.durationSeconds ?? 0);
    return () => {
      controller.current?.abort();
      audio.current?.pause();
      resource.current = null; pending.current = null;
    };
  }, [message.id, message.mediaUrl]);

  async function load() {
    if (resource.current) return resource.current;
    if (pending.current) return pending.current;
    controller.current = new AbortController();
    setLoading(true); setError(false);
    const signal = controller.current.signal;
    const job = (async () => {
      const blob = await apiGetInboxMedia(message.conversationId, message.id, getToken, signal);
      const url = await mediaDataUrl(blob);
      signal.throwIfAborted();
      const item = { blob, url };
      resource.current = item; setSrc(item.url);
      return item;
    })();
    pending.current = job;
    try { return await job; }
    catch (e) { if (!signal.aborted) setError(true); throw e; }
    finally { if (pending.current === job) pending.current = null; if (!signal.aborted) setLoading(false); }
  }

  // Only visible remote images load: opening a long history must not fetch every attachment.
  useEffect(() => {
    if (!isImage || src || !root.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load().catch(() => {}); }
    }, { rootMargin: '100px' });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [message.id, message.mediaUrl, src]);

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
  const transcript = isAudio && message.body?.trim() && !placeholder.test(message.body.trim()) && message.body !== 'Não foi possível transcrever este áudio.' ? message.body : null;
  return <div className="talk-attachment" ref={root}>
    {isAudio ? <>
      <div className="talk-voice-note">
        <span className="talk-voice-icon" aria-hidden="true"><Mic size={24} /></span>
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
      {transcript ? <details className="talk-audio-transcript"><summary>Ver transcrição</summary><p>{transcript}</p></details> : null}
    </> : isImage ? <button className={`talk-image-preview${message.body === 'Figurinha recebida' ? ' is-sticker' : ''}`} type="button" aria-label="Ampliar imagem" onClick={() => void open()}>
      {src && !error ? <img src={src} alt={mediaCaption(message) || 'Imagem da conversa'} onError={() => setError(true)} /> : <span>{loading ? 'Carregando imagem…' : 'Abrir imagem'}</span>}
    </button> : <div className="talk-document-card">
      <button type="button" className="talk-document-open" aria-label="Abrir documento" onClick={() => void open()} disabled={loading}>
        <span className="talk-document-icon"><FileText size={27} /><small>{isVideo ? 'VÍDEO' : /pdf/i.test(name + message.mediaUrl?.slice(0, 40)) ? 'PDF' : 'ARQ'}</small></span>
        <span className="talk-document-title"><strong>{name}</strong><small>{loading ? 'Carregando…' : isVideo ? 'Abrir vídeo' : 'Abrir documento'}</small></span>
      </button>
      <button className="talk-document-download" type="button" aria-label="Baixar documento" disabled={loading} onClick={() => void open(true)}><Download size={20} /></button>
    </div>}
    {error ? <div className="talk-media-error" role="status"><span>Não foi possível carregar {isAudio ? 'o áudio' : 'o arquivo'}.</span>
      <button type="button" onClick={() => { setError(false); if (isAudio) void play(); else void open(); }}><RotateCcw size={13} /> Tentar novamente</button></div> : null}
    {viewer && src ? <MediaViewer src={src} kind={viewer} message={message} getToken={getToken} name={isImage ? 'Imagem da conversa' : name} onClose={() => setViewer(null)} /> : null}
  </div>;
}
