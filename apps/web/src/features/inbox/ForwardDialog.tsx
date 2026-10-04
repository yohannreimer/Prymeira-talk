import { useEffect, useMemo, useState } from 'react';
import { Check, Forward, Search, Send, X } from 'lucide-react';
import type { ConversationDto, MessageDto } from '@prymeira-talk/shared';
import { apiForwardMessages, apiGetConversations } from '../../app/api';
import { ContactAvatar } from './ContactAvatar';
import { contactDisplayName } from './conversation-display';
import './forward-dialog.css';

const MAX_TARGETS = 5;
const fold = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/** "5547999990001" → "+55 47 99999-0001"; anything else stays as it came. */
export function displayPhone(phone: string | null | undefined) {
  const match = /^55(\d{2})(\d{4,5})(\d{4})$/.exec((phone ?? '').replace(/\D/g, ''));
  return match ? `+55 ${match[1]} ${match[2]}-${match[3]}` : phone ?? '';
}

/** What is being forwarded, in one line: the text, or the kind of file and its caption. */
export function forwardSummary(message: MessageDto) {
  if (message.contactCards?.length) return message.contactCards.length === 1 ? `Contato · ${message.contactCards[0]!.fullName}` : `${message.contactCards.length} contatos`;
  const caption = message.attachment?.caption?.trim();
  if (message.type === 'audio') return 'Áudio';
  if (message.type === 'image') return caption ? `Foto · ${caption}` : 'Foto';
  if (message.type === 'file') {
    const kind = message.attachment?.mimeType?.startsWith('video/') ? 'Vídeo' : message.attachment?.fileName?.trim() || 'Arquivo';
    return caption ? `${kind} · ${caption}` : kind;
  }
  return message.body?.trim() ?? '';
}

export function canForward(message: MessageDto) {
  return !message.deletedAt && !message.reaction && !message.location &&
    (message.contactCards?.length ? message.contactCards.some(card => card.phoneNumber)
      : ['image', 'audio', 'file'].includes(message.type) || (['text', 'template'].includes(message.type) && Boolean(message.body?.trim()))) &&
    !(message.direction === 'outbound' && ['pending', 'failed'].includes(message.status));
}

/** Matches a conversation by name or number, ignoring accents, case and phone punctuation. */
export function conversationMatches(conversation: ConversationDto, query: string) {
  const text = fold(query.trim());
  if (!text) return true;
  const digits = query.replace(/\D/g, '');
  return fold(contactDisplayName(conversation)).includes(text) || (digits.length >= 3 && (conversation.contactPhone ?? '').replace(/\D/g, '').includes(digits));
}

/** WhatsApp's "Enviar para": recent conversations first, a search, up to five picks, one send. */
/** "Foto · Planta" for one message, "3 mensagens" for several. */
export function forwardSelectionSummary(messages: MessageDto[]) {
  return messages.length === 1 ? forwardSummary(messages[0]!) : `${messages.length} mensagens`;
}

export function ForwardDialog({ messages, sourceConversationId, conversations, getToken, onClose, onSent }: {
  messages: MessageDto[];
  sourceConversationId: string;
  conversations: ConversationDto[];
  getToken: () => Promise<string | null>;
  onClose(): void;
  onSent(notice: string): void;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ConversationDto[]>([]);
  const [selected, setSelected] = useState<ConversationDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  // Conversations not loaded in the list (older ones) come from the server as the person types.
  useEffect(() => {
    if (query.trim().length < 2) { setFound([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void apiGetConversations(getToken, { status: 'all', search: query.trim() }, controller.signal).then(setFound).catch(() => {});
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [getToken, query]);

  const list = useMemo(() => {
    const seen = new Set<string>([sourceConversationId]);
    const rows: ConversationDto[] = [];
    for (const conversation of [...conversations.filter(item => conversationMatches(item, query)), ...found]) {
      if (seen.has(conversation.id)) continue;
      seen.add(conversation.id); rows.push(conversation);
    }
    return rows.slice(0, query.trim() ? 40 : 30);
  }, [conversations, found, query, sourceConversationId]);

  const isSelected = (id: string) => selected.some(item => item.id === id);
  function toggle(conversation: ConversationDto) {
    setError(null);
    setSelected(current => current.some(item => item.id === conversation.id) ? current.filter(item => item.id !== conversation.id)
      : current.length >= MAX_TARGETS ? current : [...current, conversation]);
  }

  async function send() {
    if (!selected.length || busy) return;
    setBusy(true); setError(null);
    try {
      const { results } = await apiForwardMessages(sourceConversationId, messages.map(item => item.id), selected.map(item => item.id), getToken);
      const failed = results.filter(item => !item.ok);
      if (failed.length === results.length) throw new Error(failed[0]?.error ?? 'Não foi possível encaminhar.');
      const name = (id: string) => contactDisplayName(selected.find(item => item.id === id)!);
      if (failed.length) {
        setSelected(current => current.filter(item => failed.some(fail => fail.conversationId === item.id)));
        setError(`Não foi para ${failed.map(item => name(item.conversationId)).join(', ')}. ${failed[0]?.error ?? ''}`.trim());
        return;
      }
      const what = messages.length === 1 ? 'Mensagem encaminhada' : `${messages.length} mensagens encaminhadas`;
      onSent(results.length === 1 ? `${what} para ${name(results[0]!.conversationId)}.` : `${what} para ${results.length} conversas.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Não foi possível encaminhar.');
    } finally { setBusy(false); }
  }

  return <div className="inbox-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="forward-dialog" role="dialog" aria-modal="true" aria-labelledby="forward-title">
      <header>
        <button type="button" className="forward-close" aria-label="Fechar" onClick={onClose} disabled={busy}><X size={18} /></button>
        <h2 id="forward-title">Encaminhar para</h2>
        <small>{selected.length}/{MAX_TARGETS}</small>
      </header>
      <div className="forward-search"><Search size={16} aria-hidden="true" />
        <input autoFocus placeholder="Pesquisar nome ou número" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
        {query ? <button type="button" aria-label="Limpar pesquisa" onClick={() => setQuery('')}><X size={14} /></button> : null}
      </div>
      <div className="forward-list" role="listbox" aria-multiselectable="true" aria-label="Conversas">
        <h3>{query.trim() ? 'Resultados' : 'Conversas recentes'}</h3>
        {list.length ? list.map(conversation => {
          const checked = isSelected(conversation.id);
          const full = !checked && selected.length >= MAX_TARGETS;
          return <button key={conversation.id} type="button" role="option" aria-selected={checked} disabled={busy || full}
            className={`forward-row${checked ? ' is-selected' : ''}`} onClick={() => toggle(conversation)}>
            <ContactAvatar conversationId={conversation.id} name={contactDisplayName(conversation)} className="conversation-avatar forward-avatar" />
            <span className="forward-row-text"><strong>{contactDisplayName(conversation)}</strong>
              <small>{conversation.isGroup ? 'Grupo' : displayPhone(conversation.contactPhone)}</small></span>
            <span className="forward-check" aria-hidden="true">{checked ? <Check size={14} strokeWidth={3} /> : null}</span>
          </button>;
        }) : <p className="forward-empty">Nenhuma conversa encontrada.</p>}
      </div>
      <footer className={selected.length ? 'is-ready' : ''}>
        <div className="forward-what"><Forward size={14} aria-hidden="true" /><span>{forwardSelectionSummary(messages)}</span></div>
        {error ? <p className="forward-error" role="alert">{error}</p> : null}
        <div className="forward-send">
          <span className="forward-names">{selected.length ? selected.map(contactDisplayName).join(', ') : 'Escolha até 5 conversas'}</span>
          <button type="button" className="forward-send-button" aria-label="Encaminhar" disabled={!selected.length || busy} onClick={() => void send()}>
            {busy ? <span className="forward-spinner" /> : <Send size={18} />}
          </button>
        </div>
      </footer>
    </section>
  </div>;
}
