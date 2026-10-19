import type { ConversationFollowupDto, MessageDto } from '@prymeira-talk/shared';
import { ChevronLeft, ChevronRight, Clock3, ExternalLink, List, LoaderCircle, MoreHorizontal, Send, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { apiGetConversationMessages } from '../../app/api';
import { InboxMedia, mediaCaption } from '../inbox/InboxMedia';
import { LocationMessage } from '../inbox/LocationMessage';
import { MessageTicks } from '../inbox/MessageTicks';
import { parsePoll, threadWithReactions } from '../inbox/message-threading';
import { PollMessage } from '../inbox/RichMessages';
import { WhatsappText } from '../inbox/whatsapp-text';
import { followupPurposeLabel, followupReasonLabel, formatFollowupDate } from './followup-display';
import './followup-review.css';

type Props = {
  followups: ConversationFollowupDto[];
  getToken: () => Promise<string | null>;
  busyId: string | null;
  errors: Record<string, string>;
  contextRevisions: Record<string, number>;
  onSend: (item: ConversationFollowupDto, body: string, version: string) => void;
  onPostpone: (item: ConversationFollowupDto) => void;
  onCancel: (item: ConversationFollowupDto) => void;
  onNoFollowup: (item: ConversationFollowupDto) => void;
  onOpenConversation: (id: string) => void;
};
type History = { key: string; messages: MessageDto[]; loading: boolean; error: string | null };
const dayFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const nameOf = (item: ConversationFollowupDto) => item.contact.name?.trim() || item.contact.phone || 'Cliente';

export function FollowupReview(props: Props) {
  const { followups, getToken, busyId, errors, contextRevisions } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIndex = useRef(0);
  const active = followups.find(item => item.id === selectedId) ?? followups[Math.min(selectedIndex.current, followups.length - 1)];
  const index = active ? followups.indexOf(active) : 0;
  const [queueOpen, setQueueOpen] = useState(() => window.matchMedia?.('(min-width: 1101px)').matches ?? false);
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const revision = active ? contextRevisions[active.conversationId] ?? 0 : 0;
  const key = active ? `${active.id}:${active.updatedAt}:${revision}` : '';
  const body = drafts[key] ?? active?.draftBody ?? '';
  const [history, setHistory] = useState<History>({ key: '', messages: [], loading: true, error: null });
  const [retry, setRetry] = useState(0);
  const [visibleCount, setVisibleCount] = useState(20);
  const [confirmation, setConfirmation] = useState<'cancel' | 'no-followup' | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const previousContext = useRef({ id: active?.id, key });
  const transcript = useRef<HTMLDivElement>(null);
  const contactHeading = useRef<HTMLHeadingElement>(null);
  const queue = useRef<HTMLElement>(null);
  const queueTrigger = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const previousConfirmation = useRef<typeof confirmation>(null);
  const busy = busyId !== null;
  const historyReady = history.key === key && !history.loading && !history.error;
  const contextMessages = useMemo(() => threadWithReactions(history.key === key ? history.messages.filter(m => !m.hiddenByReset) : []).visible, [history, key]);
  const shownMessages = contextMessages.slice(-visibleCount);

  useEffect(() => {
    if (active) { selectedIndex.current = index; setSelectedId(active.id); }
  }, [active?.id, index]);

  useEffect(() => {
    const previous = previousContext.current;
    if (previous.id === active?.id && previous.key !== key) {
      setContextNotice('O contexto mudou. Confira a conversa e o rascunho atualizado antes de enviar.');
    } else if (previous.id !== active?.id) {
      setContextNotice(null);
      if (previous.id) contactHeading.current?.focus({ preventScroll: true });
    }
    previousContext.current = { id: active?.id, key };
    setConfirmation(null);
    setMoreOpen(false);
  }, [active?.id, key]);

  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    setHistory({ key, messages: [], loading: true, error: null });
    setVisibleCount(20);
    void apiGetConversationMessages(active.conversationId, getToken, abort.signal).then(messages => {
      if (!abort.signal.aborted) setHistory({ key, messages, loading: false, error: null });
    }).catch(error => {
      if (!abort.signal.aborted) setHistory({ key, messages: [], loading: false, error: error instanceof Error ? error.message : 'Não foi possível carregar a conversa.' });
    });
    return () => abort.abort();
  }, [active?.conversationId, key, retry, getToken]);

  useEffect(() => {
    if (historyReady && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [key, historyReady]);

  useEffect(() => {
    if (confirmation) {
      previousConfirmation.current = confirmation;
      confirmButton.current?.focus();
    } else if (previousConfirmation.current) {
      (previousConfirmation.current === 'cancel' ? cancelTrigger : moreTrigger).current?.focus();
      previousConfirmation.current = null;
    }
  }, [confirmation]);

  useEffect(() => {
    if (!queueOpen) return;
    const narrow = window.matchMedia?.('(max-width: 1100px)').matches ?? true;
    if (narrow) queue.current?.querySelector<HTMLInputElement>('input')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setQueueOpen(false); queueTrigger.current?.focus(); }
      if (event.key !== 'Tab' || !narrow) return;
      const targets = queue.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input');
      const first = targets?.[0], last = targets?.[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [queueOpen]);

  function select(item: ConversationFollowupDto) {
    if (busy) return;
    selectedIndex.current = followups.indexOf(item);
    setSelectedId(item.id);
    if (window.matchMedia?.('(max-width: 1100px)').matches ?? true) setQueueOpen(false);
  }
  function move(direction: number) { if (followups.length && !busy) select(followups[(index + direction + followups.length) % followups.length]); }
  if (!active) return null;
  const filtered = followups.filter(item => [nameOf(item), item.contact.phone, item.channel.displayName].join(' ').toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')));
  const explain = active.analysis?.pendingItem || active.analysis?.nextStep || followupPurposeLabel(active);

  return <div className={`followup-review${queueOpen ? ' is-queue-open' : ''}`}>
    {queueOpen ? <button className="fr-backdrop" type="button" aria-label="Fechar lista de conversas" onClick={() => { setQueueOpen(false); queueTrigger.current?.focus(); }} /> : null}
    <aside className="fr-queue" aria-label="Fila de revisão" ref={queue}>
      <header><strong>Para revisar <span>{followups.length}</span></strong><button type="button" aria-label="Fechar fila" onClick={() => { setQueueOpen(false); queueTrigger.current?.focus(); }}><X size={17} /></button></header>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar conversa" aria-label="Buscar conversa" />
      <div className="fr-queue-items">
        {filtered.map(item => <button key={item.id} type="button" disabled={busy} className={`fr-queue-item${item.id === active.id ? ' is-active' : ''}`} aria-current={item.id === active.id ? 'true' : undefined} onClick={() => select(item)}>
          <span className="fr-avatar" aria-hidden="true">{nameOf(item).slice(0, 1).toUpperCase()}</span>
          <span><strong>{nameOf(item)}</strong><span className="fr-excerpt">{item.anchorMessage.body || 'Conversa com anexo'}</span><small>{formatFollowupDate(item.anchorMessage.createdAt ?? item.scheduledAt)} · {item.channel.displayName}</small></span>
        </button>)}
        {!filtered.length ? <p className="fr-search-empty">Nenhuma conversa encontrada.</p> : null}
      </div>
    </aside>
    <section className="fr-chat" aria-label={`Revisar conversa de ${nameOf(active)}`}>
      <header className="fr-chat-head">
        <span className="fr-avatar" aria-hidden="true">{nameOf(active).slice(0, 1).toUpperCase()}</span>
        <div className="fr-contact"><h2 ref={contactHeading} tabIndex={-1}>{nameOf(active)}</h2><p>{[active.contact.phone, active.channel.displayName].filter(Boolean).join(' · ')}</p></div>
        <div className="fr-navigation">
          <button type="button" disabled={busy || followups.length < 2} aria-label="Conversa anterior" onClick={() => move(-1)}><ChevronLeft size={19} /></button>
          <span aria-label={`Item ${index + 1} de ${followups.length}`}>{index + 1} / {followups.length}</span>
          <button type="button" disabled={busy || followups.length < 2} aria-label="Próxima conversa" onClick={() => move(1)}><ChevronRight size={19} /></button>
        </div>
        <button className="fr-all" type="button" ref={queueTrigger} aria-expanded={queueOpen} onClick={() => setQueueOpen(!queueOpen)}><List size={16} /><span>Ver todos</span></button>
      </header>
      <div className="fr-timeline" ref={transcript} aria-label="Mensagens da conversa" aria-busy={!historyReady && !history.error}>
        {history.key !== key || history.loading ? <p className="fr-history-state" role="status"><LoaderCircle size={18} className="followups-spin" />Carregando conversa…</p> : history.error ? <div className="fr-history-state" role="alert"><p>Não foi possível carregar a conversa.</p><button type="button" onClick={() => setRetry(retry + 1)}>Tentar novamente</button></div> : <div className="fr-messages">
          {contextMessages.length > visibleCount ? <button type="button" className="fr-older" onClick={() => { const node = transcript.current; const before = node?.scrollHeight ?? 0; setVisibleCount(count => count + 20); requestAnimationFrame(() => { if (node) node.scrollTop += node.scrollHeight - before; }); }}>Carregar mensagens anteriores</button> : <button className="fr-older" type="button" onClick={() => props.onOpenConversation(active.conversationId)}><ExternalLink size={12} />Abrir no atendimento{history.messages.length >= 100 ? ' para ver mais' : ''}</button>}
          {!shownMessages.length ? <p className="fr-history-state">Nenhuma mensagem disponível nesta conversa.</p> : null}
          {shownMessages.map((message, i) => {
            const day = dayFormat.format(new Date(message.createdAt));
            return <Fragment key={message.id}>
              {i === 0 || day !== dayFormat.format(new Date(shownMessages[i - 1].createdAt)) ? <div className="fr-day">{day}</div> : null}
              <div className={`fr-message${message.direction === 'outbound' ? ' fr-outbound' : ''}${message.type === 'internal_note' ? ' is-note' : ''}`}>
                <span className="fr-author">{message.type === 'internal_note' ? 'Nota interna' : message.type === 'system' ? 'Evento do atendimento' : message.direction === 'outbound' ? 'Equipe' : message.senderName || nameOf(active)}</span>
                <ReviewMessage message={message} getToken={getToken} />
                <div className="fr-message-meta"><time dateTime={message.createdAt}>{timeFormat.format(new Date(message.createdAt))}</time>{message.editedAt ? <span>Editada</span> : null}{message.direction === 'outbound' && !message.deletedAt ? <MessageTicks status={message.status} /> : null}</div>
              </div>
            </Fragment>;
          })}
        </div>}
      </div>
      <footer className="fr-composer" aria-busy={busy}>
        <div className="fr-compose-inner">
          {contextNotice ? <p className="fr-context-notice" role="status">{contextNotice}</p> : null}
          {errors[active.id] ? <p className="fr-action-error" role="alert">{errors[active.id]}</p> : null}
          {confirmation ? <div className="fr-confirmation">
            <span>{confirmation === 'cancel' ? 'Cancelar este acompanhamento?' : 'Não acompanhar mais esta conversa?'}</span>
            <button type="button" disabled={busy} ref={confirmButton} onClick={() => { previousConfirmation.current = null; setConfirmation(null); if (confirmation === 'cancel') props.onCancel(active); else props.onNoFollowup(active); }}>{confirmation === 'cancel' ? 'Confirmar cancelamento' : 'Confirmar não acompanhar'}</button>
            <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Voltar</button>
          </div> : null}
          <div className="fr-draft-label"><label htmlFor="followup-review-draft">Sugestão de follow-up</label><details><summary>Contexto do follow-up</summary><p>{explain}</p><p>{active.analysis ? active.analysis.rationale : <>Motivo: {followupReasonLabel(active.reasonCode, active.status)}</>}</p><p>{active.analysis?.timingNote} · Previsto {formatFollowupDate(active.scheduledAt)}</p></details></div>
          <div className="fr-draft-row">
            <textarea id="followup-review-draft" aria-label="Mensagem de follow-up" maxLength={4000} rows={2} value={body} disabled={busy} onChange={e => setDrafts(current => ({ ...current, [key]: e.target.value }))} />
            <button className="fr-send" type="button" aria-label="Enviar follow-up" disabled={busy || !historyReady || !body.trim() || body.trim().length > 4000} onClick={event => { if (event.detail < 2) props.onSend(active, body, active.updatedAt); }}>{busyId === active.id ? <LoaderCircle size={17} className="followups-spin" /> : <Send size={16} />}<span>Enviar</span></button>
          </div>
          <div className="fr-secondary">
            <button type="button" disabled={busy} title="Adiar para o próximo horário útil" onClick={() => props.onPostpone(active)}><Clock3 size={14} />Adiar</button><span className="fr-separator" />
            <button type="button" disabled={busy} ref={cancelTrigger} onClick={() => { setMoreOpen(false); setConfirmation('cancel'); }}>Cancelar follow-up</button>
            <button type="button" disabled={busy} ref={moreTrigger} aria-label="Mais opções" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}><MoreHorizontal size={18} /></button>
            {moreOpen ? <div className="fr-more" onKeyDown={event => { if (event.key === 'Escape') { setMoreOpen(false); moreTrigger.current?.focus(); } }}><button type="button" disabled={busy} onClick={() => { setMoreOpen(false); setConfirmation('no-followup'); }}>Não acompanhar esta conversa</button><button type="button" onClick={() => { setMoreOpen(false); moreTrigger.current?.focus(); }}>Fechar</button></div> : null}
            <button className="fr-skip" type="button" disabled={busy || followups.length < 2} onClick={() => move(1)}>Pular<ChevronRight size={14} /></button>
          </div>
        </div>
      </footer>
    </section>
  </div>;
}

function ReviewMessage({ message, getToken }: { message: MessageDto; getToken: Props['getToken'] }) {
  if (message.deletedAt) return <p className="fr-deleted">Mensagem apagada</p>;
  const isMedia = ['audio', 'image', 'file'].includes(message.type);
  const poll = parsePoll(message.body);
  return <>
    {message.quoted?.body ? <blockquote className="fr-quote">{message.quoted.body}</blockquote> : null}
    {isMedia ? <><InboxMedia message={message} getToken={getToken} />{mediaCaption(message) ? <p><WhatsappText text={mediaCaption(message)!} /></p> : null}</> : message.location ? <LocationMessage location={message.location} /> : message.contactCards?.length ? <div>{message.contactCards.map((card, i) => <p key={i}><strong>{card.fullName}</strong>{card.phoneNumber ? ` · ${card.phoneNumber}` : ''}</p>)}</div> : poll ? <PollMessage poll={poll} /> : <p><WhatsappText text={message.body || 'Mensagem sem texto'} /></p>}
  </>;
}
