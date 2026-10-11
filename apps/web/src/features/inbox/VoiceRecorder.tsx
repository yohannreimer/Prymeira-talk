import { ApiRequestError } from '../../app/api';
import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2, Send, LoaderCircle, Play, Pause } from 'lucide-react';
import { mediaDataUrl } from './media-data-url';
import { audioTime } from './InboxMedia';
import './composer-enhancements.css';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SECONDS = 300;
export function recordingMime(supported: (mime: string) => boolean) {
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(supported);
}
function AudioReview({ src, seconds }: { src: string; seconds: number }) {
  const audio = useRef<HTMLAudioElement>(null); const [playing, setPlaying] = useState(false); const [error, setError] = useState(false);
  useEffect(() => { const element = audio.current; return () => { element?.pause(); }; }, []);
  return <div className="voice-review">
    <audio ref={audio} src={src} preload="metadata" onPlay={() => { setPlaying(true); setError(false); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setError(true)} />
    <button type="button" aria-label={playing ? 'Pausar prévia' : 'Ouvir gravação'} onClick={() => { if (playing) audio.current?.pause(); else void audio.current?.play().catch(() => setError(true)); }}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
    <span>{error ? 'Não foi possível ouvir. Grave novamente.' : `Áudio · ${audioTime(seconds)}`}</span>
  </div>;
}
export function VoiceRecorder({ disabled, onSend }: { disabled: boolean; onSend(file: File): Promise<void> }) {
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'ready' | 'sending'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const sending = useRef(false);
  /** Send pressed while still recording: stop and send at once, like WhatsApp. */
  const sendOnStop = useRef(false);
  function release() { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (timer.current) clearInterval(timer.current); timer.current = null; }
  function discard() {
    generation.current++; active.current = false;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null; release(); setPreview(null); setPhase('idle'); setError(null); setSeconds(0);
  }
  useEffect(() => () => {
    generation.current++; active.current = false;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release();
  }, []);
  async function start() {
    if (active.current || disabled) return;
    const version = ++generation.current; active.current = true; sendOnStop.current = false;
    setError(null); setPhase('requesting'); setSeconds(0);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Este navegador não permite gravar áudio. Abra o Talk no Chrome, Edge ou Safari atualizado.');
      const mimeType = recordingMime(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('Este navegador não oferece um formato de áudio compatível.');
      const input = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (version !== generation.current) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const recording = new MediaRecorder(input, { mimeType, audioBitsPerSecond: 64000 }); recorder.current = recording;
      const chunks: Blob[] = []; let size = 0; let tooLarge = false;
      recording.ondataavailable = event => {
        if (version !== generation.current) return;
        size += event.data.size;
        if (size > MAX_BYTES) { tooLarge = true; if (recording.state === 'recording') recording.stop(); release(); }
        else if (event.data.size) chunks.push(event.data);
      };
      recording.onerror = () => { if (version === generation.current) { discard(); setError('A gravação foi interrompida. Tente novamente.'); } };
      recording.onstop = async () => {
        if (version !== generation.current) return;
        release();
        try {
          if (tooLarge || !size) throw new Error(tooLarge ? 'O áudio ultrapassou 8 MB. Grave uma mensagem menor.' : 'Nenhum áudio foi capturado. Confira seu microfone.');
          const mime = recording.mimeType || mimeType;
          // The bare type ("audio/webm"): Safari adds "; codecs=…" with spaces and quotes that travel badly.
          const file = new File(chunks, `audio.${mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'}`, { type: mime.split(';')[0]!.trim() });
          const url = await mediaDataUrl(file);
          if (version !== generation.current) return;
          setPreview({ file, url }); setPhase('ready');
          if (sendOnStop.current) { sendOnStop.current = false; void deliver(file); }
        } catch (e) { active.current = false; setPhase('idle'); setError(e instanceof Error ? e.message : 'Não foi possível preparar o áudio.'); }
      };
      recording.start(250); setPhase('recording');
      const began = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - began) / 1000); setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS && recording.state === 'recording') { recording.stop(); release(); }
      }, 250);
    } catch (e) {
      if (version !== generation.current) return;
      release(); active.current = false; setPhase('idle');
      const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : '';
      setError(name === 'NotAllowedError' ? 'Permita o microfone nas configurações deste site para gravar.' : name === 'NotFoundError' ? 'Nenhum microfone encontrado. Conecte um e tente novamente.' : name === 'NotReadableError' ? 'Não consegui acessar o microfone. Confira se outro aplicativo está usando ele.' : e instanceof Error ? e.message : 'Não foi possível acessar o microfone.');
    }
  }
  function send() {
    if (!preview || phase !== 'ready') return;
    void deliver(preview.file);
  }
  function stopAndSend() {
    if (recorder.current?.state !== 'recording' || disabled) return;
    sendOnStop.current = true; setPhase('sending');
    recorder.current.stop(); release();
  }
  async function deliver(file: File) {
    if (disabled || sending.current) return;
    sending.current = true;
    const version = generation.current; setPhase('sending'); setError(null);
    try { await onSend(file); if (version === generation.current) discard(); }
    catch (e) {
      if (version !== generation.current) return;
      // The recording stays here to try again. A refusal says why; a lost connection may still have delivered it.
      setPhase('ready');
      setError(e instanceof ApiRequestError && e.code ? e.message : 'O envio não foi confirmado. Confira a conversa antes de tentar novamente.');
    }
    finally { sending.current = false; }
  }
  return <div className={`composer-voice${phase !== 'idle' ? ' is-expanded' : ''}`}>
    {phase === 'idle' ? <button className="composer-tool" type="button" aria-label="Gravar áudio" title="Gravar áudio" disabled={disabled} onClick={() => void start()}><Mic size={19} /></button> : <div className="composer-recording" aria-label="Gravação de áudio">
      {phase === 'recording' ? <><span className="recording-dot" /><span role="status">Gravando {audioTime(seconds)}</span><button type="button" aria-label="Parar e ouvir antes" title="Parar e ouvir antes" onClick={() => { if (recorder.current?.state === 'recording') recorder.current.stop(); release(); }}><Square size={17} /></button>
        <button type="button" className="voice-send" aria-label="Enviar áudio" title="Enviar agora" disabled={disabled} onClick={stopAndSend}><Send size={17} /></button></> : phase === 'requesting' ? <span role="status"><LoaderCircle size={16} /> Aguardando microfone…</span> : <>
        {preview ? <AudioReview src={preview.url} seconds={seconds} /> : null}
        <button type="button" className="voice-send" aria-label="Enviar áudio" disabled={disabled || phase === 'sending'} onClick={send}>{phase === 'sending' ? <LoaderCircle size={17} /> : <Send size={17} />}</button>
      </>}
      <button type="button" aria-label="Descartar gravação" disabled={phase === 'sending'} onClick={discard}><Trash2 size={17} /></button>
    </div>}
    {error ? <p className="voice-error" role="alert">{error}</p> : null}
  </div>;
}
