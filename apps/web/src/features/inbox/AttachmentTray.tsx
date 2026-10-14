import { useEffect, useMemo, useRef, useState } from 'react';
import { Crop, FileText, LoaderCircle, Plus, Send, Trash2, Video, X } from 'lucide-react';
import { ImageCropper } from './ImageCropper';
import './attachment-tray.css';
import { canOptimizePhoto } from './photo-optimization';

export type PendingAttachment = { id: string; file: File; caption: string; sendOriginal?: boolean };

function kindOf(file: File) {
  return file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
}
function extension(file: File) {
  return (/\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1] ?? (file.type.split('/')[1] ?? 'arq')).toUpperCase();
}
function size(file: File) {
  return file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
}

/**
 * WhatsApp's attachment preview: the chosen files open over the chat, each with its own caption, a strip of thumbnails
 * to switch between them (and drop one), "+" to add more, and one button that sends them all, one message per file.
 */
export function AttachmentTray({ items, activeId, recipient, sending, onSelect, onCaption, onRemove, onAdd, onClose, onSend, onReplace, onOriginalChange, preparationStatus }: {
  items: PendingAttachment[]; activeId: string | null; recipient: string; sending: boolean;
  onSelect: (id: string) => void; onCaption: (id: string, caption: string) => void; onRemove: (id: string) => void;
  onAdd: () => void; onClose: () => void; onSend: () => void;
  onOriginalChange?: (id: string, original: boolean) => void;
  preparationStatus?: string | null;
  /** Swaps a file for its edited version (a cropped or turned picture). */
  onReplace?: (id: string, file: File) => void;
}) {
  const [cropping, setCropping] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const quality = useRef<HTMLDivElement>(null);
  const qualityButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!qualityOpen) return;
    const dismiss = (event: PointerEvent) => { if (!quality.current?.contains(event.target as Node)) setQualityOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [qualityOpen]);
  // Previews follow the files, not the captions: typing must not reload a video or flash the pictures.
  const filesKey = items.map(item => `${item.id}:${item.file.size}:${item.file.lastModified}`).join('|');
  const urls = useMemo(() => new Map(items.filter(item => kindOf(item.file) !== 'file').map(item => [item.id, URL.createObjectURL(item.file)])), [filesKey]);
  useEffect(() => () => { for (const url of urls.values()) URL.revokeObjectURL(url); }, [urls]);
  const active = items.find(item => item.id === activeId) ?? items[0];
  const caption = useRef<HTMLInputElement>(null);
  useEffect(() => { caption.current?.focus(); }, [active?.id]);
  useEffect(() => { setQualityOpen(false); }, [active?.id, active?.file]);
  if (!active) return null;
  const kind = kindOf(active.file), url = urls.get(active.id);
  // Animated GIFs would lose their animation in a canvas: only still pictures are cropped.
  const croppable = Boolean(onReplace) && kind === 'image' && active.file.type !== 'image/gif';
  return <div className="attachment-tray" role="dialog" aria-label="Anexos para enviar"
    onKeyDown={event => { if (event.key === 'Escape') {
      if (qualityOpen) { event.stopPropagation(); setQualityOpen(false); qualityButton.current?.focus(); }
      else if (!sending && !cropping) onClose();
    } }}>
    <button type="button" className="attachment-tray-close" aria-label="Cancelar envio dos anexos" disabled={sending} onClick={onClose}><X size={22} /></button>
    {croppable ? <button type="button" className="attachment-tray-crop" aria-label="Recortar imagem" title="Recortar e girar" disabled={sending} onClick={() => setCropping(true)}><Crop size={20} /></button> : null}
    {canOptimizePhoto(active.file) && onOriginalChange ? <div ref={quality} className="attachment-tray-quality">
      <button ref={qualityButton} type="button" className={`attachment-tray-hd${active.sendOriginal ? ' is-active' : ''}`}
        aria-label={`Qualidade da foto: ${active.sendOriginal ? 'HD' : 'Padrão'}`} aria-expanded={qualityOpen} aria-haspopup="dialog"
        title="Qualidade da foto" disabled={sending} onClick={() => setQualityOpen(open => !open)}>HD</button>
      {qualityOpen ? <div className="attachment-tray-quality-menu" role="dialog" aria-label="Qualidade da foto">
        <strong>Qualidade da foto</strong>
        <div role="radiogroup" aria-label="Qualidade">
          {[{ original: false, title: 'Padrão', detail: 'Arquivo menor, envio mais rápido' },
            { original: true, title: 'HD', detail: `Qualidade original · ${size(active.file)}` }].map(option =>
            <label key={option.title}><input type="radio" name={`photo-quality-${active.id}`} checked={Boolean(active.sendOriginal) === option.original}
              disabled={sending} onChange={() => { onOriginalChange(active.id, option.original); setQualityOpen(false); qualityButton.current?.focus(); }} />
              <span>{option.title}<small>{option.detail}</small></span></label>)}
        </div>
      </div> : null}
    </div> : null}
    {cropping && croppable ? <ImageCropper key={active.id} file={active.file} onCancel={() => setCropping(false)}
      onDone={file => { onReplace!(active.id, file); setCropping(false); }} /> : null}
    <div className="attachment-tray-stage">
      {kind === 'image' && url ? <img src={url} alt={active.file.name} />
        : kind === 'video' && url ? <video src={url} controls playsInline muted />
        : <div className="attachment-tray-document"><FileText size={64} strokeWidth={1.4} aria-hidden="true" />
          <strong>{active.file.name}</strong><small>{extension(active.file)} · {size(active.file)}</small></div>}
    </div>
    <div className="attachment-tray-bottom">
      {preparationStatus ? <p className="attachment-preparation-status" role="status">{preparationStatus}</p> : null}
      <input ref={caption} className="attachment-tray-caption" placeholder="Adicione uma legenda..." value={active.caption} maxLength={1024}
        disabled={sending} onChange={event => onCaption(active.id, event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !sending) { event.preventDefault(); onSend(); } }} />
      <div className="attachment-tray-strip" role="listbox" aria-label="Arquivos escolhidos">
        {items.map(item => {
          const itemKind = kindOf(item.file), itemUrl = urls.get(item.id), selected = item.id === active.id;
          return <div key={item.id} className={`attachment-tray-thumb${selected ? ' is-active' : ''}`} role="option" aria-selected={selected}>
            <button type="button" aria-label={`Ver ${item.file.name}`} disabled={sending} onClick={() => onSelect(item.id)}>
              {itemKind === 'image' && itemUrl ? <img src={itemUrl} alt="" />
                : <span className="attachment-tray-thumb-file">{itemKind === 'video' ? <Video size={20} /> : <FileText size={20} />}<small>{extension(item.file)}</small></span>}
            </button>
            {selected ? <button type="button" className="attachment-tray-remove" aria-label={`Remover ${item.file.name}`} disabled={sending} onClick={() => onRemove(item.id)}><Trash2 size={18} /></button> : null}
          </div>;
        })}
        <button type="button" className="attachment-tray-add" aria-label="Adicionar mais arquivos" disabled={sending} onClick={onAdd}><Plus size={22} /></button>
      </div>
    </div>
    <span className="attachment-tray-recipient">{recipient}</span>
    <button type="button" className="attachment-tray-send" aria-label={`Enviar ${items.length} ${items.length === 1 ? 'arquivo' : 'arquivos'}`} disabled={sending} onClick={onSend}>
      {sending ? <LoaderCircle className="talk-media-loading" size={22} /> : <Send size={22} />}
      {items.length > 1 ? <span className="attachment-tray-count">{items.length}</span> : null}
    </button>
  </div>;
}
