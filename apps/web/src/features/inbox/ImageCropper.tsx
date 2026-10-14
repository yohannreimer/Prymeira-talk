import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Check, RotateCw, X } from 'lucide-react';
import './image-cropper.css';

/** The part of the picture to keep, as fractions of its width and height (0–1). */
export type CropRect = { x: number; y: number; w: number; h: number };
type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

const ASPECTS: Array<{ label: string; ratio: number | null }> = [
  { label: 'Livre', ratio: null }, { label: 'Quadrado', ratio: 1 }, { label: '4:3', ratio: 4 / 3 }, { label: '3:4', ratio: 3 / 4 }, { label: '16:9', ratio: 16 / 9 }
];
const MIN = 0.06;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The largest centered rect with this width:height ratio (in picture pixels), or the whole picture when free. */
export function fittedRect(ratio: number | null, width: number, height: number): CropRect {
  if (!ratio || !width || !height) return { x: 0, y: 0, w: 1, h: 1 };
  const w = Math.min(1, (height * ratio) / width), h = Math.min(1, (width / ratio) / height);
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Moves or resizes the rect by a pointer delta (fractions), keeping it inside the picture and, when set, its ratio. */
export function dragRect(start: CropRect, handle: Handle, dx: number, dy: number, ratio: number | null, width: number, height: number): CropRect {
  if (handle === 'move') return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  const left = handle === 'nw' || handle === 'sw', top = handle === 'nw' || handle === 'ne';
  const fixedX = left ? start.x + start.w : start.x, fixedY = top ? start.y + start.h : start.y;
  let w = clamp(left ? start.w - dx : start.w + dx, MIN, left ? fixedX : 1 - fixedX);
  let h = clamp(top ? start.h - dy : start.h + dy, MIN, top ? fixedY : 1 - fixedY);
  if (ratio && width && height) {
    // In fractions the ratio depends on the picture's own shape.
    const k = (ratio * height) / width;
    if (w / h > k) w = h * k; else h = w / k;
    const maxW = left ? fixedX : 1 - fixedX, maxH = top ? fixedY : 1 - fixedY;
    if (w > maxW) { w = maxW; h = w / k; }
    if (h > maxH) { h = maxH; w = h * k; }
  }
  return { x: left ? fixedX - w : fixedX, y: top ? fixedY - h : fixedY, w, h };
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file), image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não foi possível abrir a imagem.')); };
    image.src = url;
  });
}
function canvasFile(canvas: HTMLCanvasElement, file: File) {
  const type = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/jpeg';
  return new Promise<File>((resolve, reject) => canvas.toBlob(blob => blob
    ? resolve(new File([blob], file.name, { type, lastModified: Date.now() }))
    : reject(new Error('Não foi possível gerar a imagem.')), type, 0.92));
}
/** The kept part of the picture, at full resolution, as a new file with the same name. */
export async function cropFile(file: File, rect: CropRect) {
  const image = await loadImage(file);
  const sx = Math.round(rect.x * image.naturalWidth), sy = Math.round(rect.y * image.naturalHeight);
  const sw = Math.max(1, Math.round(rect.w * image.naturalWidth)), sh = Math.max(1, Math.round(rect.h * image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = sw; canvas.height = sh;
  canvas.getContext('2d')!.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvasFile(canvas, file);
}
/** The picture turned a quarter clockwise. */
export async function rotateFile(file: File) {
  const image = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalHeight; canvas.height = image.naturalWidth;
  const context = canvas.getContext('2d')!;
  context.translate(canvas.width, 0); context.rotate(Math.PI / 2);
  context.drawImage(image, 0, 0);
  return canvasFile(canvas, file);
}

/** WhatsApp's crop tool: a frame over the picture to drag and resize, fixed shapes and a quarter turn. */
export function ImageCropper({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (file: File) => void }) {
  const [source, setSource] = useState(file);
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ratio, setRatio] = useState<number | null>(null);
  const [rect, setRect] = useState<CropRect>({ x: 0, y: 0, w: 1, h: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; x: number; y: number; start: CropRect } | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(source);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [source]);

  const begin = (handle: Handle) => (event: ReactPointerEvent) => {
    event.preventDefault(); event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    drag.current = { handle, x: event.clientX, y: event.clientY, start: rect };
  };
  const move = (event: ReactPointerEvent) => {
    const current = drag.current, box = frame.current?.getBoundingClientRect();
    if (!current || !box?.width || !box.height) return;
    setRect(dragRect(current.start, current.handle, (event.clientX - current.x) / box.width, (event.clientY - current.y) / box.height, ratio, size.width, size.height));
  };
  const end = () => { drag.current = null; };
  const pick = (next: number | null) => { setRatio(next); setRect(fittedRect(next, size.width, size.height)); };
  const rotate = async () => {
    setBusy(true); setError(null);
    try { setSource(await rotateFile(source)); setRect(fittedRect(null, 1, 1)); setRatio(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível girar.'); }
    finally { setBusy(false); }
  };
  const done = async () => {
    setBusy(true); setError(null);
    const whole = rect.x <= 0.001 && rect.y <= 0.001 && rect.w >= 0.999 && rect.h >= 0.999;
    try { onDone(whole ? source : await cropFile(source, rect)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível recortar.'); setBusy(false); }
  };

  return <div className="image-cropper" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
    <div className="image-cropper-stage">
      {url ? <div className="image-cropper-frame" ref={frame} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <img src={url} alt="Imagem para recortar" draggable={false}
          onLoad={event => { const image = event.currentTarget; setSize({ width: image.naturalWidth, height: image.naturalHeight }); }} />
        <div className="image-cropper-rect" role="group" aria-label="Área do recorte"
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
          onPointerDown={begin('move')}>
          <span className="image-cropper-grid" aria-hidden="true" />
          {(['nw', 'ne', 'sw', 'se'] as const).map(handle => <span key={handle} className={`image-cropper-handle is-${handle}`} onPointerDown={begin(handle)} aria-hidden="true" />)}
        </div>
      </div> : null}
    </div>
    <div className="image-cropper-bar">
      <div className="image-cropper-aspects" role="radiogroup" aria-label="Formato">
        {ASPECTS.map(option => <button key={option.label} type="button" role="radio" aria-checked={ratio === option.ratio}
          className={ratio === option.ratio ? 'is-active' : undefined} disabled={busy} onClick={() => pick(option.ratio)}>{option.label}</button>)}
      </div>
      <div className="image-cropper-actions">
        <button type="button" className="image-cropper-icon" aria-label="Girar" title="Girar" disabled={busy} onClick={() => { void rotate(); }}><RotateCw size={18} /></button>
        <button type="button" className="image-cropper-icon" aria-label="Cancelar recorte" title="Cancelar" disabled={busy} onClick={onCancel}><X size={18} /></button>
        <button type="button" className="image-cropper-done" disabled={busy} onClick={() => { void done(); }}><Check size={16} />Concluir</button>
      </div>
    </div>
    {error ? <p className="image-cropper-error" role="alert">{error}</p> : null}
  </div>;
}
