import { useEffect, useMemo, useRef, useState } from 'react';
import { Crop, FileText, LoaderCircle, Plus, Send, Trash2, Video, X } from 'lucide-react';
import { ImageCropper } from './ImageCropper';
import './attachment-tray.css';

export type PendingAttachment = { id: string; file: File; caption: string };

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
export function AttachmentTray({ items, activeId, recipient, sending, onSelect, onCaption, onRemove, onAdd, onClose, onSend, onReplace }: {
  items: PendingAttachment[]; activeId: string | null; recipient: string; sending: boolean;
  onSelect: (id: string) => void; onCaption: (id: string, caption: string) => void; onRemove: (id: string) => void;
  onAdd: () => void; onClose: () => void; onSend: () => void;
  /** Swaps a file for its edited version (a cropped or turned picture). */
  onReplace?: (id: string, file: File) => void;
}) {
  const [cropping, setCropping] = useState(false);
  // Previews follow the files, not the captions: typing must not reload a video or flash the pictures.
  const filesKey = items.map(item => `${item.id}:${item.file.size}:${item.file.lastModified}`).join('|');
  const urls = useMemo(() => new Map(items.filter(item => kindOf(item.file) !== 'file').map(item => [item.id, URL.createObjectURL(item.file)])), [filesKey]);
  useEffect(() => () => { for (const url of urls.values()) URL.revokeObjectURL(url); }, [urls]);
  const active = items.find(item => item.id === activeId) ?? items[0];
  const caption = useRef<HTMLInputElement>(null);
  useEffect(() => { caption.current?.focus(); }, [active?.id]);
  if (!active) return null;
  const kind = kindOf(active.file), url = urls.get(active.id);
  // Animated GIFs would lose their animation in a canvas: only still pictures are cropped.
  const croppable = Boolean(onReplace) && kind === 'image' && active.file.type !== 'image/gif';
  return <div className="attachment-tray" role="dialog" aria-label="Anexos para enviar"
    onKeyDown={event => { if (event.key === 'Escape' && !sending && !cropping) onClose(); }}>
    <button type="button" className="attachment-tray-close" aria-label="Cancelar envio dos anexos" disabled={sending} onClick={onClose}><X size={22} /></button>
    {croppable ? <button type="button" className="attachment-tray-crop" aria-label="Recortar imagem" title="Recortar e girar" disabled={sending} onClick={() => setCropping(true)}><Crop size={20} /></button> : null}
    {cropping && croppable ? <ImageCropper key={active.id} file={active.file} onCancel={() => setCropping(false)}
      onDone={file => { onReplace!(active.id, file); setCropping(false); }} /> : null}
    <div className="attachment-tray-stage">
      {kind === 'image' && url ? <img src={url} alt={active.file.name} />
        : kind === 'video' && url ? <video src={url} controls playsInline muted />
        : <div className="attachment-tray-document"><FileText size={64} strokeWidth={1.4} aria-hidden="true" />
          <strong>{active.file.name}</strong><small>{extension(active.file)} · {size(active.file)}</small></div>}
    </div>
    <div className="attachment-tray-bottom">
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
