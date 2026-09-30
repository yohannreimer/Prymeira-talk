import { useMemo } from "react";
import { ArrowLeft, Eye, Headphones, RefreshCw, ShieldCheck, X } from "lucide-react";
import { needsHumanAttention, type SupervisionConversation, type MessageDto, type SupervisionUnreadPeriod } from "@prymeira-talk/shared";
import { useTalkAuth } from "../../app/auth";
import { readConfigValue } from "../../app/runtime-config";
import { apiSupervisionMedia, apiSupervisionPreview } from "../../app/supervision-api";
import { InboxMedia, mediaCaption, type InboxMediaTransport } from "../inbox/InboxMedia";
import { LocationMessage } from "../inbox/LocationMessage";
import { contactDisplayName } from "../inbox/conversation-display";
import { WhatsappText } from "../inbox/whatsapp-text";
import { conversationKey, useSupervision } from "./useSupervision";
import "./supervision.css";

const time = (date: string | Date | null | undefined) => date ? new Date(date).toLocaleString("pt-BR", {
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
}) : "";
const fullTime = (date: string) => new Date(date).toLocaleString("pt-BR", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
});
const unreadPeriodLabels: Record<SupervisionUnreadPeriod, string> = {
  "24h": "Últimas 24 horas", "7d": "Últimos 7 dias", all: "Todo o período"
};

function PendingAlert({ conversation }: { conversation: SupervisionConversation }) {
  return needsHumanAttention(conversation)
    ? <span className="supervision-pending"><span aria-hidden="true" />Ação humana necessária</span> : null;
}

function ThreadMessage({ message, transport, getToken }: { message: MessageDto; transport: InboxMediaTransport; getToken: () => Promise<string | null> }) {
  const media = message.type === "audio" || message.type === "image" || message.type === "file";
  const body = media ? mediaCaption(message) : message.body;
  return <article className={`supervision-message ${message.direction === "outbound" ? "is-outbound" : "is-inbound"}`}>
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

export function SupervisionPage() {
  const { getToken } = useTalkAuth();
  const view = useSupervision(getToken);
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
  const totals = summary?.sellers.reduce((total, seller) => ({
    nextAction: total.nextAction + seller.nextActionCount, unread: total.unread + seller.unreadConversationCount
  }), { nextAction: 0, unread: 0 });
  function indicator(sellerCustomerId: string | undefined, kind: "nextAction" | "unread") {
    view.changeFilters({ ...filters, status: "active", sellerCustomerId, nextAction: kind === "nextAction", unread: kind === "unread" });
  }
  function allSellerConversations(sellerCustomerId: string) {
    view.changeFilters({ ...filters, sellerCustomerId, status: "all", nextAction: false, unread: false });
  }
  const unreadPeriod = filters.unreadPeriod ?? "24h";
  const displayedConversation = thread?.conversation ?? selected;

  return <main className="supervision-page">
    <header className="supervision-header">
      <div className="supervision-brand"><span className="supervision-brand-mark"><Headphones size={23} aria-hidden="true" /></span>
        <strong>Talk</strong><span className="supervision-header-divider" /><span>Supervisão</span></div>
      <a href={readConfigValue("VITE_PRYMEIRA_HUB_URL") ?? "https://account.prymeira.com"}><ArrowLeft size={16} aria-hidden="true" /> Voltar ao Hub</a>
    </header>
    <div className="supervision-content">
      <div className="supervision-title-row"><div><p className="supervision-eyebrow">VISÃO DA EQUIPE</p><h1>Supervisão de atendimento</h1>
        <p>Acompanhe as conversas e as próximas ações de cada vendedor.</p></div>
        <div className="supervision-refresh"><span><Eye size={14} aria-hidden="true" /> Somente leitura</span>
          <button type="button" onClick={view.refresh} disabled={view.loading && !view.denied}><RefreshCw size={16} aria-hidden="true" className={view.loading ? "is-refreshing" : ""} />Atualizar</button>
          {view.updatedAt ? <small>Atualizado às {view.updatedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small> : null}
        </div>
      </div>
      {view.denied ? <section className="supervision-denied" role="alert"><ShieldCheck size={32} aria-hidden="true" /><h2>Acesso à supervisão indisponível</h2><p>{view.denied}</p><button type="button" onClick={view.refresh}>Verificar acesso novamente</button></section> : <>
        <section className="supervision-summary" aria-label="Resumo por vendedor"><div className="supervision-section-heading"><h2>Resumo por vendedor</h2><span>Totais da fila ativa</span></div>
          <div className="supervision-table-scroll"><table><thead><tr><th scope="col">Vendedor</th><th scope="col">Próxima ação</th><th scope="col">Não lidas pelo vendedor<small className="supervision-period-label">{unreadPeriodLabels[unreadPeriod]}</small></th></tr></thead>
            <tbody>{summary?.sellers.map(seller => <tr key={seller.sellerCustomerId} className={filters.sellerCustomerId === seller.sellerCustomerId ? "is-selected" : ""}>
              <th scope="row"><button type="button" className="supervision-seller-button" aria-label={`Ver todas as conversas de ${seller.sellerName}`} onClick={() => allSellerConversations(seller.sellerCustomerId)}><strong>{seller.sellerName}</strong><small>Todas as conversas <span aria-hidden="true">↗</span></small></button><span>{seller.sellerEmail}</span></th>
              <td><button type="button" className={`supervision-count${seller.nextActionCount ? " has-pending" : ""}`} aria-label={`Próxima ação de ${seller.sellerName}: ${seller.nextActionCount}`} onClick={() => indicator(seller.sellerCustomerId, "nextAction")}>{seller.nextActionCount}<span aria-hidden="true">↗</span></button></td>
              <td><button type="button" className="supervision-count" aria-label={`Não lidas de ${seller.sellerName}: ${seller.unreadConversationCount}`} onClick={() => indicator(seller.sellerCustomerId, "unread")}>{seller.unreadConversationCount}<span aria-hidden="true">↗</span></button></td>
            </tr>)}</tbody>
            {totals ? <tfoot><tr><th scope="row">Todos os vendedores</th><td><button type="button" className={`supervision-count${totals.nextAction ? " has-pending" : ""}`} aria-label={`Próxima ação de todos: ${totals.nextAction}`} onClick={() => indicator(undefined, "nextAction")}>{totals.nextAction}<span aria-hidden="true">↗</span></button></td><td><button type="button" className="supervision-count" aria-label={`Não lidas de todos: ${totals.unread}`} onClick={() => indicator(undefined, "unread")}>{totals.unread}<span aria-hidden="true">↗</span></button></td></tr></tfoot> : null}
          </table></div>
          {!summary ? <p className="supervision-empty" role="status">{view.loading ? "Carregando resumo…" : "Resumo indisponível. Atualize para tentar novamente."}</p> : !summary.sellers.length ? <p className="supervision-empty">Nenhum vendedor disponível para supervisão.</p> : null}
        </section>
        <section className="supervision-inbox" aria-label="Caixa de entrada da supervisão">
          <div className="supervision-filters"><label>Vendedor<select value={filters.sellerCustomerId ?? ""} onChange={event => view.changeFilters({ ...filters, sellerCustomerId: event.target.value || undefined })}><option value="">Todos os vendedores</option>{summary?.sellers.map(seller => <option key={seller.sellerCustomerId} value={seller.sellerCustomerId}>{seller.sellerName}</option>)}</select></label>
            <label>Conversas<select value={filters.status} onChange={event => view.changeFilters({ ...filters, status: event.target.value as typeof filters.status })}><option value="active">Ativas</option><option value="closed">Encerradas</option><option value="all">Todas</option></select></label>
            <label>Período das não lidas<select value={unreadPeriod} onChange={event => view.changeFilters({ ...filters, unreadPeriod: event.target.value as SupervisionUnreadPeriod })}>{Object.entries(unreadPeriodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="supervision-toggle-group" aria-label="Indicadores"><button type="button" className={`supervision-filter-pending${filters.nextAction ? " is-active" : ""}`} aria-pressed={filters.nextAction} onClick={() => view.changeFilters({ ...filters, nextAction: !filters.nextAction })}>Próxima ação</button>
              <button type="button" className={filters.unread ? "is-active" : ""} aria-pressed={filters.unread} onClick={() => view.changeFilters({ ...filters, unread: !filters.unread })}>Não lidas</button></div>
          </div>
          {view.queueError ? <div className="supervision-error" role="alert">{view.queueError}<button type="button" onClick={view.refresh}>Tentar novamente</button></div> : null}
          <div className={`supervision-columns${selected ? " has-selection" : ""}`}>
            <aside className="supervision-queue" aria-label="Conversas filtradas"><div className="supervision-queue-heading"><h2>Conversas</h2><span>{view.conversations.length} carregadas{view.loading ? " · atualizando…" : ""}</span></div>
              <div className="supervision-queue-list">{view.conversations.map(conversation => <button type="button" key={conversationKey(conversation)} className={`supervision-conversation${selected && conversationKey(selected) === conversationKey(conversation) ? " is-selected" : ""}${needsHumanAttention(conversation) ? " has-pending" : ""}`} aria-pressed={!!selected && conversationKey(selected) === conversationKey(conversation)} onClick={() => view.selectConversation(conversation)}>
                <div className="supervision-contact-line"><span className="supervision-avatar" aria-hidden="true">{contactDisplayName(conversation).slice(0, 2).toUpperCase()}</span><strong>{contactDisplayName(conversation)}</strong><time dateTime={conversation.lastMessageAt ?? undefined} title={conversation.lastMessageAt ? fullTime(conversation.lastMessageAt) : undefined}>{time(conversation.lastMessageAt)}</time></div>
                <p className="supervision-seller-line">{conversation.sellerName} <span>· {conversation.channelPhoneNumber ?? "WhatsApp sem número"}</span></p>
                <p className="supervision-preview">{conversation.lastMessagePreview ?? "Conversa sem mensagens"}</p>
                <div className="supervision-conversation-flags"><PendingAlert conversation={conversation} />{conversation.unreadCount > 0 ? <span className="supervision-unread">{conversation.unreadCount} não lida{conversation.unreadCount > 1 ? "s" : ""}</span> : null}{conversation.status === "closed" ? <span className="supervision-closed">Encerrada</span> : null}</div>
              </button>)}
                {!view.conversations.length ? <p className="supervision-empty" role="status">{view.loading ? "Carregando conversas…" : view.queueError ? "Fila indisponível." : "Nenhuma conversa com estes filtros."}</p> : null}
                {view.nextCursor ? <button type="button" className="supervision-load-more" onClick={() => void view.loadMore()} disabled={view.loadingMore || view.loading}>{view.loadingMore ? "Carregando…" : "Carregar mais conversas"}</button> : null}
              </div>
            </aside>
            <section className="supervision-thread" aria-label="Histórico da conversa" key={selected ? conversationKey(selected) : "empty"}>
              {displayedConversation ? <><header className="supervision-thread-header"><div><h2>{contactDisplayName(displayedConversation)}</h2><p>{displayedConversation.contactPhone}</p><p><strong>{displayedConversation.sellerName}</strong> · {displayedConversation.channelPhoneNumber ?? "WhatsApp"}</p><PendingAlert conversation={displayedConversation} /></div><button type="button" aria-label="Fechar conversa" onClick={() => view.selectConversation(null)}><X size={20} /></button></header>
                {view.threadError ? <div className="supervision-error" role="alert">{view.threadError}<button type="button" onClick={view.refresh}>Tentar novamente</button></div> : null}
                <div className="supervision-history">{thread?.messages.map(message => <ThreadMessage key={message.id} message={message} getToken={getToken} transport={transport} />)}
                  {!thread ? <p className="supervision-empty" role="status">{view.threadLoading ? "Carregando histórico…" : "Histórico indisponível."}</p> : !thread.messages.length ? <p className="supervision-empty">Esta conversa ainda não tem mensagens.</p> : null}</div>
                <footer className="supervision-read-only"><Eye size={16} aria-hidden="true" /><span>Somente leitura. As ações e a leitura de mensagens continuam com o vendedor.</span></footer>
              </> : <div className="supervision-thread-empty"><Eye size={30} aria-hidden="true" /><h2>Uma visão de cada conversa</h2><p>Selecione uma conversa para acompanhar o histórico e as próximas ações.</p>{view.threadError ? <p role="alert">{view.threadError}</p> : null}</div>}
            </section>
          </div>
        </section>
      </>}
    </div>
  </main>;
}
