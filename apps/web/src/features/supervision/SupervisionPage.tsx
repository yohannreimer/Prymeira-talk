import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCheck, Clock3, Eye, Headphones, Hourglass, ListTodo, MailWarning, MessageSquareText, RefreshCw, Search, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { needsHumanAttention, type SupervisionConversation, type MessageDto, type SupervisionUnreadPeriod } from "@prymeira-talk/shared";
import type { SupervisionSummary } from "@prymeira-talk/shared";
import { useTalkAuth } from "../../app/auth";
import { readConfigValue } from "../../app/runtime-config";
import { apiSupervisionDismissWaiting, apiSupervisionMedia, apiSupervisionPreview, apiSupervisionReply } from "../../app/supervision-api";
import { InboxMedia, mediaCaption, type InboxMediaTransport } from "../inbox/InboxMedia";
import { LocationMessage } from "../inbox/LocationMessage";
import { contactDisplayName } from "../inbox/conversation-display";
import { WhatsappText } from "../inbox/whatsapp-text";
import { conversationKey, useSupervision } from "./useSupervision";
import "./supervision.css";

type Seller = SupervisionSummary["sellers"][number];
const time = (date: string | Date | null | undefined) => date ? new Date(date).toLocaleString("pt-BR", {
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
}) : "";
const fullTime = (date: string) => new Date(date).toLocaleString("pt-BR", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
});
const unreadPeriodLabels: Record<SupervisionUnreadPeriod, string> = {
  "24h": "Últimas 24 horas", "7d": "Últimos 7 dias", all: "Todo o período"
};

/** "12 min", "1h32", "2 dias": how long a customer has been waiting. */
export function waitLabel(since: string | null | undefined, now: number) {
  if (!since) return null;
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
  const days = Math.floor(minutes / (24 * 60));
  return `${days} ${days === 1 ? "dia" : "dias"}`;
}
/** Up to 15 min is fine, up to an hour needs a look, beyond is late. */
export function waitTone(since: string | null | undefined, now: number) {
  if (!since) return "ok";
  const minutes = (now - Date.parse(since)) / 60_000;
  return minutes < 15 ? "ok" : minutes < 60 ? "warning" : "late";
}
export function responseLabel(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)}h${String(Math.round((seconds % 3600) / 60)).padStart(2, "0")}`;
}
/** Sellers registered without a name show their e-mail's name part ("vendas5"), never the e-mail twice. */
export function sellerLabel(seller: { sellerName: string; sellerEmail: string }) {
  const name = seller.sellerName.trim();
  return name && !name.includes("@") ? name : (name || seller.sellerEmail).split("@")[0]!;
}
function initials(value: string) {
  // "vendas5" reads better as V5 than as VE.
  const numbered = /^(\p{L})\p{L}*(\d+)$/u.exec(value.trim());
  if (numbered) return (numbered[1]! + numbered[2]!).toUpperCase().slice(0, 3);
  const parts = value.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
}
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
  return now;
}

function PendingAlert({ conversation }: { conversation: SupervisionConversation }) {
  return needsHumanAttention(conversation)
    ? <span className="supervision-pending"><span aria-hidden="true" />Ação humana necessária</span> : null;
}
function WaitBadge({ since, now }: { since: string | null | undefined; now: number }) {
  const label = waitLabel(since, now);
  return label ? <span className={`supervision-wait is-${waitTone(since, now)}`}><Hourglass size={12} aria-hidden="true" />esperando há {label}</span> : null;
}
/** Many "waiting" customers only sent a greeting or an automatic welcome. The supervisor takes them out of the queue;
 * they come back only if the customer writes again. Nothing is sent to anyone. */
function WaitingDismiss({ conversation, getToken, onChanged }: { conversation: SupervisionConversation; getToken: () => Promise<string | null>; onChanged: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function mark(value: boolean) {
    setBusy(true); setError(null);
    try { await apiSupervisionDismissWaiting(conversation.workspaceId, conversation.id, value, getToken); setDismissed(value); onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar. Tente novamente."); }
    finally { setBusy(false); }
  }
  if (dismissed) return <span className="supervision-dismissed" role="status"><CheckCheck size={13} aria-hidden="true" />Fora de “esperando resposta” até o cliente escrever de novo
    <button type="button" onClick={() => void mark(false)} disabled={busy}>Desfazer</button>{error ? <em role="alert">{error}</em> : null}</span>;
  if (!conversation.waitingSince) return null;
  return <><button type="button" className="supervision-dismiss" onClick={() => void mark(true)} disabled={busy}
    title="Ex.: só um bom dia ou uma mensagem automática. Volta se o cliente escrever de novo.">
    <CheckCheck size={13} aria-hidden="true" />{busy ? "Salvando…" : "Não precisa responder"}</button>{error ? <em className="supervision-dismiss-error" role="alert">{error}</em> : null}</>;
}
function NextAction({ text }: { text?: string | null }) {
  return text ? <p className="supervision-next-action"><Sparkles size={13} aria-hidden="true" /><span><strong>Próxima ação:</strong> {text}</span></p> : null;
}

function ThreadMessage({ message, transport, getToken }: { message: MessageDto; transport: InboxMediaTransport; getToken: () => Promise<string | null> }) {
  const media = message.type === "audio" || message.type === "image" || message.type === "file";
  const body = media ? mediaCaption(message) : message.body;
  return <article className={`supervision-message ${message.direction === "outbound" ? "is-outbound" : "is-inbound"}${message.sentBySupervisor ? " is-supervisor" : ""}`}>
    {message.sentBySupervisor ? <strong className="supervision-message-supervisor"><ShieldCheck size={12} aria-hidden="true" />Você (supervisor)</strong> : null}
    {message.senderName ? <strong className="supervision-message-sender">{message.senderName}</strong> : null}
    {message.deletedAt ? <p className="supervision-message-deleted">Mensagem apagada</p> : <>
      {media ? <InboxMedia message={message} transport={transport} getToken={getToken} /> : null}
      {message.location ? <LocationMessage location={message.location} /> : null}
      {body ? <p><WhatsappText text={body} /></p> : null}
      {message.contactCards?.map((contact, index) => <p key={index}>{contact.fullName}{contact.phoneNumber ? ` · ${contact.phoneNumber}` : ""}</p>)}
      {!media && !body && !message.location && !message.contactCards?.length ? <p>Mensagem sem texto</p> : null}
    </>}
    <footer><time dateTime={message.createdAt}>{fullTime(message.createdAt)}</time>{message.editedAt ? " · editada" : ""}</footer>
  </article>;
}

/** The supervisor's reply box: the message leaves through the seller's WhatsApp, and the seller sees in Talk that the
 * supervisor answered. Nothing is sent without pressing Enviar. */
function SupervisorReply({ conversation, getToken, onSent }: { conversation: SupervisionConversation; getToken: () => Promise<string | null>; onSent: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true); setError(null);
    try { await apiSupervisionReply(conversation.workspaceId, conversation.id, body, getToken); setText(""); onSent(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível enviar. Tente novamente."); }
    finally { setSending(false); }
  }
  return <form className="supervision-reply" onSubmit={event => { event.preventDefault(); void send(); }}>
    <p className="supervision-reply-note"><ShieldCheck size={14} aria-hidden="true" />Sua resposta sai pelo WhatsApp de <strong>{sellerLabel(conversation)}</strong>. No Talk, o vendedor verá que foi o supervisor.</p>
    <div className="supervision-reply-row">
      <textarea aria-label="Resposta do supervisor" placeholder="Responder ao cliente como supervisor…" rows={2} maxLength={4000} value={text} disabled={sending}
        onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
      <button type="submit" disabled={!text.trim() || sending} aria-label="Enviar resposta do supervisor"><Send size={17} aria-hidden="true" />Enviar</button>
    </div>
    {error ? <p className="supervision-reply-error" role="alert">{error}</p> : null}
  </form>;
}

/** Opens on the latest message, like WhatsApp, and follows new ones (or late images) while the reader stays at the
 * bottom; reading older messages is never interrupted by a refresh. */
function ThreadHistory({ lastMessageId, children }: { lastMessageId: string | undefined; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const element = box.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [lastMessageId]);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (atBottom.current) element.scrollTop = element.scrollHeight; });
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [lastMessageId]);
  return <div className="supervision-history" ref={box}
    onScroll={event => { const el = event.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>{children}</div>;
}

function sellerState(seller: Seller, now: number) {
  const waiting = seller.waitingCount ?? 0;
  if (waiting && waitTone(seller.oldestWaitingSince, now) === "late") return { tone: "late", label: `Atrasado · ${waitLabel(seller.oldestWaitingSince, now)}` };
  if (waiting) return { tone: "warning", label: `${waiting} esperando` };
  if (seller.nextActionCount) return { tone: "warning", label: `${seller.nextActionCount} pendente${seller.nextActionCount > 1 ? "s" : ""}` };
  return { tone: "ok", label: "Em dia" };
}

export function SupervisionPage() {
  const { getToken } = useTalkAuth();
  const view = useSupervision(getToken);
  const now = useNow();
  const { filters, summary, selected, thread } = view;
  const workspaceId = selected?.workspaceId;
  const transport = useMemo<InboxMediaTransport>(() => ({
    media: async (conversationId, messageId, token, signal) => {
      try { return await apiSupervisionMedia(workspaceId!, conversationId, messageId, token, signal); }
      catch (error) { if (!signal?.aborted) view.handleAccessError(error); throw error; }
    },
    preview: async (conversationId, messageId, page, token, signal) => {
      try { return await apiSupervisionPreview(workspaceId!, conversationId, messageId, page, token, signal); }
      catch (error) { if (!signal?.aborted) view.handleAccessError(error); throw error; }
    }
  }), [workspaceId, view.handleAccessError]);
  const sellers = summary?.sellers ?? [];
  const insights = sellers.some(seller => seller.waitingCount !== undefined);
  const totals = summary ? sellers.reduce((total, seller) => ({
    nextAction: total.nextAction + seller.nextActionCount, unread: total.unread + seller.unreadConversationCount,
    waiting: total.waiting + (seller.waitingCount ?? 0),
    oldest: seller.oldestWaitingSince && (!total.oldest || seller.oldestWaitingSince < total.oldest) ? seller.oldestWaitingSince : total.oldest,
    conversations: total.conversations + (seller.today?.conversations ?? 0), sent: total.sent + (seller.today?.sent ?? 0)
  }), { nextAction: 0, unread: 0, waiting: 0, oldest: null as string | null, conversations: 0, sent: 0 }) : null;
  // The team's typical first answer: the median of the sellers that answered someone today.
  const teamResponse = (() => {
    const values = sellers.map(seller => seller.today?.medianResponseSeconds).filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
    return values.length ? values[Math.floor((values.length - 1) / 2)]! : null;
  })();
  function indicator(sellerCustomerId: string | undefined, kind: "nextAction" | "unread" | "waiting") {
    view.changeFilters({ ...filters, status: "active", sellerCustomerId, nextAction: kind === "nextAction", unread: kind === "unread", waiting: kind === "waiting" || undefined, search: undefined });
  }
  function allSellerConversations(sellerCustomerId: string) {
    view.changeFilters({ ...filters, sellerCustomerId, status: "all", nextAction: false, unread: false, waiting: undefined, search: undefined });
  }
  const unreadPeriod = filters.unreadPeriod ?? "24h";
  const displayedConversation = thread?.conversation ?? selected;
  const today = new Date(now).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  const queueTitle = filters.waiting ? "Clientes esperando resposta" : filters.nextAction && filters.unread ? "Próxima ação e não lidas"
    : filters.nextAction ? "Próximas ações" : filters.unread ? "Não lidas pelo vendedor" : filters.search ? `Busca: “${filters.search}”` : filters.status === "closed" ? "Conversas encerradas" : filters.status === "all" ? "Todas as conversas" : "Conversas ativas";

  return <main className="supervision-page">
    <header className="supervision-header">
      <div className="supervision-brand"><span className="supervision-brand-mark"><Headphones size={23} aria-hidden="true" /></span>
        <strong>Talk</strong><span className="supervision-header-divider" /><span>Supervisão</span></div>
      <a href={readConfigValue("VITE_PRYMEIRA_HUB_URL") ?? "https://account.prymeira.com"}><ArrowLeft size={16} aria-hidden="true" /> Voltar ao Hub</a>
    </header>
    <div className="supervision-content">
      <div className="supervision-title-row"><div><p className="supervision-eyebrow">Supervisão · {today}</p><h1>Sua equipe hoje</h1>
        <p>Quem está esperando resposta, o que ficou pendente e como foi o atendimento do dia. Você lê todas as conversas e pode responder quando precisar.</p></div>
        <div className="supervision-refresh"><span><Eye size={14} aria-hidden="true" /> Leitura e respostas do supervisor</span>
          <button type="button" onClick={view.refresh} disabled={view.loading && !view.denied}><RefreshCw size={16} aria-hidden="true" className={view.loading ? "is-refreshing" : ""} />Atualizar</button>
          {view.updatedAt ? <small>Atualizado às {view.updatedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small> : null}
        </div>
      </div>
      {view.denied ? <section className="supervision-denied" role="alert"><ShieldCheck size={32} aria-hidden="true" /><h2>Acesso à supervisão indisponível</h2><p>{view.denied}</p><button type="button" onClick={view.refresh}>Verificar acesso novamente</button></section> : <>
        <section className="supervision-pulse" aria-label="Resumo da equipe">
          {insights ? <button type="button" className={`supervision-tile is-${totals?.waiting ? waitTone(totals.oldest, now) : "ok"}${filters.waiting && !filters.sellerCustomerId ? " is-active" : ""}`}
            aria-label={`Esperando resposta de todos: ${totals?.waiting ?? 0}`} onClick={() => indicator(undefined, "waiting")}>
            <span className="supervision-tile-label"><Hourglass size={15} aria-hidden="true" />Esperando resposta</span>
            <strong>{totals?.waiting ?? "–"}</strong>
            <small>{totals?.oldest ? <>maior espera: <b>{waitLabel(totals.oldest, now)}</b></> : "ninguém esperando agora"}</small>
          </button> : null}
          <button type="button" className={`supervision-tile${totals?.nextAction ? " is-warning" : " is-ok"}${filters.nextAction && !filters.sellerCustomerId ? " is-active" : ""}`}
            aria-label={`Próxima ação de todos: ${totals?.nextAction ?? 0}`} onClick={() => indicator(undefined, "nextAction")}>
            <span className="supervision-tile-label"><ListTodo size={15} aria-hidden="true" />Próximas ações</span>
            <strong>{totals?.nextAction ?? "–"}</strong><small>conversas que a IA passou para o vendedor</small>
          </button>
          <button type="button" className={`supervision-tile is-neutral${filters.unread && !filters.sellerCustomerId ? " is-active" : ""}`}
            aria-label={`Não lidas de todos: ${totals?.unread ?? 0}`} onClick={() => indicator(undefined, "unread")}>
            <span className="supervision-tile-label"><MailWarning size={15} aria-hidden="true" />Não lidas pelo vendedor</span>
            <strong>{totals?.unread ?? "–"}</strong><small className="supervision-period-label">{unreadPeriodLabels[unreadPeriod]}</small>
          </button>
          {insights ? <div className="supervision-tile is-neutral is-static">
            <span className="supervision-tile-label"><MessageSquareText size={15} aria-hidden="true" />Atendimento de hoje</span>
            <strong>{totals?.conversations ?? 0}</strong>
            <small>conversas · {totals?.sent ?? 0} mensagens enviadas{teamResponse !== null ? <> · 1ª resposta em <b>~{responseLabel(teamResponse)}</b></> : null}</small>
          </div> : null}
        </section>

        <section className="supervision-summary" aria-label="Resumo por vendedor">
          <div className="supervision-section-heading"><h2>Vendedores</h2><span>Clique em um número para ver as conversas</span></div>
          <div className="supervision-sellers">{sellers.map(seller => {
            const state = sellerState(seller, now), name = sellerLabel(seller);
            const active = filters.sellerCustomerId === seller.sellerCustomerId;
            return <article key={seller.sellerCustomerId} className={`supervision-seller is-${state.tone}${active ? " is-selected" : ""}`}>
              <header>
                <span className="supervision-seller-avatar" aria-hidden="true">{initials(name)}</span>
                <button type="button" className="supervision-seller-button" aria-label={`Ver todas as conversas de ${seller.sellerName}`} onClick={() => allSellerConversations(seller.sellerCustomerId)}>
                  <strong>{name}</strong><small>{seller.sellerEmail}</small></button>
                <span className={`supervision-seller-state is-${state.tone}`}>{state.label}</span>
              </header>
              <div className="supervision-seller-stats">
                {insights ? <button type="button" className={`supervision-stat${seller.waitingCount ? ` is-${waitTone(seller.oldestWaitingSince, now)}` : ""}`}
                  aria-label={`Esperando resposta de ${seller.sellerName}: ${seller.waitingCount ?? 0}`} onClick={() => indicator(seller.sellerCustomerId, "waiting")}>
                  <strong>{seller.waitingCount ?? 0}</strong><span>esperando</span>
                </button> : null}
                <button type="button" className={`supervision-stat supervision-count${seller.nextActionCount ? " has-pending" : ""}`} aria-label={`Próxima ação de ${seller.sellerName}: ${seller.nextActionCount}`} onClick={() => indicator(seller.sellerCustomerId, "nextAction")}>
                  <strong>{seller.nextActionCount}</strong><span>pendentes</span></button>
                <button type="button" className="supervision-stat supervision-count" aria-label={`Não lidas de ${seller.sellerName}: ${seller.unreadConversationCount}`} onClick={() => indicator(seller.sellerCustomerId, "unread")}>
                  <strong>{seller.unreadConversationCount}</strong><span>não lidas</span></button>
              </div>
              {seller.today ? <footer><Clock3 size={13} aria-hidden="true" />
                <span>Hoje: <b>{seller.today.conversations}</b> conversa{seller.today.conversations === 1 ? "" : "s"} · <b>{seller.today.sent}</b> enviadas
                  {seller.today.medianResponseSeconds !== null ? <> · 1ª resposta <b>~{responseLabel(seller.today.medianResponseSeconds)}</b></> : null}</span></footer> : null}
            </article>;
          })}</div>
          {!summary ? <p className="supervision-empty" role="status">{view.loading ? "Carregando resumo…" : "Resumo indisponível. Atualize para tentar novamente."}</p> : !summary.sellers.length ? <p className="supervision-empty">Nenhum vendedor disponível para supervisão.</p> : null}
        </section>

        <section className="supervision-inbox" aria-label="Caixa de entrada da supervisão">
          <div className="supervision-filters"><label className="supervision-search">Buscar cliente<span><Search size={14} aria-hidden="true" /><input key={filters.search ?? ""} type="search" placeholder="Nome ou telefone" defaultValue={filters.search ?? ""}
              onKeyDown={event => { if (event.key === "Enter") view.changeFilters({ ...filters, search: event.currentTarget.value.trim() || undefined, waiting: undefined, nextAction: false, unread: false, status: event.currentTarget.value.trim() ? "all" : filters.status }); }}
              onBlur={event => { const value = event.currentTarget.value.trim() || undefined; if (value !== filters.search) view.changeFilters({ ...filters, search: value, waiting: undefined, nextAction: false, unread: false, status: value ? "all" : filters.status }); }} /></span></label>
            <label>Vendedor<select value={filters.sellerCustomerId ?? ""} onChange={event => view.changeFilters({ ...filters, sellerCustomerId: event.target.value || undefined })}><option value="">Todos os vendedores</option>{sellers.map(seller => <option key={seller.sellerCustomerId} value={seller.sellerCustomerId}>{sellerLabel(seller)}</option>)}</select></label>
            <label>Conversas<select value={filters.status} onChange={event => view.changeFilters({ ...filters, status: event.target.value as typeof filters.status, waiting: undefined })}><option value="active">Ativas</option><option value="closed">Encerradas</option><option value="all">Todas</option></select></label>
            <label>Período das não lidas<select value={unreadPeriod} onChange={event => view.changeFilters({ ...filters, unreadPeriod: event.target.value as SupervisionUnreadPeriod })}>{Object.entries(unreadPeriodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="supervision-toggle-group" aria-label="Indicadores">
              {insights ? <button type="button" className={`supervision-filter-waiting${filters.waiting ? " is-active" : ""}`} aria-pressed={!!filters.waiting} onClick={() => view.changeFilters({ ...filters, status: "active", nextAction: false, unread: false, waiting: filters.waiting ? undefined : true })}>Esperando resposta</button> : null}
              <button type="button" className={`supervision-filter-pending${filters.nextAction ? " is-active" : ""}`} aria-pressed={filters.nextAction} onClick={() => view.changeFilters({ ...filters, nextAction: !filters.nextAction, waiting: undefined })}>Próxima ação</button>
              <button type="button" className={filters.unread ? "is-active" : ""} aria-pressed={filters.unread} onClick={() => view.changeFilters({ ...filters, unread: !filters.unread, waiting: undefined })}>Não lidas</button>
              <button type="button" className={!filters.waiting && !filters.nextAction && !filters.unread && filters.status === "all" ? "is-active" : ""} onClick={() => view.changeFilters({ ...filters, status: "all", nextAction: false, unread: false, waiting: undefined })}>Todas as conversas</button></div>
          </div>
          {view.queueError ? <div className="supervision-error" role="alert">{view.queueError}<button type="button" onClick={view.refresh}>Tentar novamente</button></div> : null}
          <div className={`supervision-columns${selected ? " has-selection" : ""}`}>
            <aside className="supervision-queue" aria-label="Conversas filtradas"><div className="supervision-queue-heading"><h2>{queueTitle}</h2><span>{view.conversations.length} carregadas{view.loading ? " · atualizando…" : ""}</span></div>
              <div className="supervision-queue-list">{view.conversations.map(conversation => {
                const isSelected = !!selected && conversationKey(selected) === conversationKey(conversation);
                return <button type="button" key={conversationKey(conversation)} className={`supervision-conversation${isSelected ? " is-selected" : ""}${needsHumanAttention(conversation) ? " has-pending" : ""}${conversation.waitingSince ? ` is-waiting is-${waitTone(conversation.waitingSince, now)}` : ""}`} aria-pressed={isSelected} onClick={() => view.selectConversation(conversation)}>
                  <div className="supervision-contact-line"><span className="supervision-avatar" aria-hidden="true">{initials(contactDisplayName(conversation))}</span><strong>{contactDisplayName(conversation)}</strong>
                    {conversation.waitingSince ? <WaitBadge since={conversation.waitingSince} now={now} /> : <time dateTime={conversation.lastMessageAt ?? undefined} title={conversation.lastMessageAt ? fullTime(conversation.lastMessageAt) : undefined}>{time(conversation.lastMessageAt)}</time>}</div>
                  <p className="supervision-seller-line">{sellerLabel(conversation)}</p>
                  <p className="supervision-preview">{conversation.lastMessagePreview ?? "Conversa sem mensagens"}</p>
                  <NextAction text={conversation.nextActionText} />
                  <div className="supervision-conversation-flags"><PendingAlert conversation={conversation} />{conversation.unreadCount > 0 ? <span className="supervision-unread">{conversation.unreadCount} não lida{conversation.unreadCount > 1 ? "s" : ""}</span> : null}{conversation.status === "closed" ? <span className="supervision-closed">Encerrada</span> : null}</div>
                </button>;
              })}
                {!view.conversations.length ? <p className="supervision-empty" role="status">{view.loading ? "Carregando conversas…" : view.queueError ? "Fila indisponível." : filters.waiting ? "Ninguém esperando resposta agora. 👏" : "Nenhuma conversa com estes filtros."}</p> : null}
                {view.nextCursor ? <button type="button" className="supervision-load-more" onClick={() => void view.loadMore()} disabled={view.loadingMore || view.loading}>{view.loadingMore ? "Carregando…" : "Carregar mais conversas"}</button> : null}
              </div>
            </aside>
            <section className="supervision-thread" aria-label="Histórico da conversa" key={selected ? conversationKey(selected) : "empty"}>
              {displayedConversation ? <><header className="supervision-thread-header"><div>
                  <h2>{contactDisplayName(displayedConversation)}</h2>
                  <p>{[displayedConversation.contactPhone, `Atendido por ${sellerLabel(displayedConversation)}`, displayedConversation.channelPhoneNumber].filter(Boolean).join(" · ")}</p>
                  <div className="supervision-thread-flags"><WaitBadge since={displayedConversation.waitingSince} now={now} />
                    <WaitingDismiss conversation={displayedConversation} getToken={getToken} onChanged={view.refresh} /><PendingAlert conversation={displayedConversation} /></div>
                  <NextAction text={displayedConversation.nextActionText} />
                </div><button type="button" aria-label="Fechar conversa" onClick={() => view.selectConversation(null)}><X size={20} /></button></header>
                {view.threadError ? <div className="supervision-error" role="alert">{view.threadError}<button type="button" onClick={view.refresh}>Tentar novamente</button></div> : null}
                <ThreadHistory lastMessageId={thread?.messages.at(-1)?.id}>{thread?.messages.map(message => <ThreadMessage key={message.id} message={message} getToken={getToken} transport={transport} />)}
                  {!thread ? <p className="supervision-empty" role="status">{view.threadLoading ? "Carregando histórico…" : "Histórico indisponível."}</p> : !thread.messages.length ? <p className="supervision-empty">Esta conversa ainda não tem mensagens.</p> : null}</ThreadHistory>
                <SupervisorReply key={conversationKey(displayedConversation)} conversation={displayedConversation} getToken={getToken} onSent={view.refresh} />
              </> : <div className="supervision-thread-empty"><Eye size={30} aria-hidden="true" /><h2>Escolha uma conversa</h2><p>Você vê o histórico completo, o que o cliente pediu e o que o vendedor precisa fazer.</p>{view.threadError ? <p role="alert">{view.threadError}</p> : null}</div>}
            </section>
          </div>
        </section>
      </>}
    </div>
  </main>;
}
