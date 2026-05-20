import { useAuth } from "@clerk/clerk-react";
import type { ConversationDto, RealtimeEvent } from "@prymeira-talk/shared";
import { Bot, Inbox, Link2, MessageSquare, Settings, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGetConversations } from "../../app/api";
import { useRealtimeEvents } from "./useRealtimeEvents";

function formatTime(value: string | null) {
  if (!value) return "Sem mensagens";

  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function statusLabel(status: ConversationDto["status"]) {
  const labels: Record<ConversationDto["status"], string> = {
    open: "Aberta",
    pending: "Pendente",
    closed: "Fechada"
  };

  return labels[status];
}

function priorityLabel(priority: ConversationDto["priority"]) {
  const labels: Record<ConversationDto["priority"], string> = {
    low: "Baixa",
    normal: "Normal",
    high: "Alta"
  };

  return labels[priority];
}

export function InboxPage() {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadConversations() {
      setIsLoading(true);
      setError(null);

      try {
        const authToken = await getToken();

        if (!authToken) {
          throw new Error("Sessao sem token de autenticacao.");
        }

        const nextConversations = await apiGetConversations(async () => authToken);

        if (!isMounted) return;

        setToken(authToken);
        setConversations(nextConversations);
        setSelectedConversationId((current) => current ?? nextConversations[0]?.id ?? null);
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar conversas.");
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadConversations();

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type !== "conversation.updated") return;

    setConversations((current) => {
      const withoutUpdated = current.filter((conversation) => conversation.id !== event.payload.id);
      return [event.payload, ...withoutUpdated];
    });

    setSelectedConversationId((current) => current ?? event.payload.id);
  }, []);

  useRealtimeEvents({
    token,
    onEvent: handleRealtimeEvent
  });

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId]
  );

  const openCount = conversations.filter((conversation) => conversation.status === "open").length;
  const unreadCount = conversations.reduce((total, conversation) => total + conversation.unreadCount, 0);

  return (
    <main className="talk-shell">
      <aside className="app-rail" aria-label="Navegacao principal">
        <div className="rail-logo">
          <Bot size={22} aria-hidden="true" />
        </div>
        <nav className="rail-nav" aria-label="Secoes">
          <button className="rail-button is-active" aria-label="Inbox">
            <Inbox size={20} aria-hidden="true" />
          </button>
          <button className="rail-button" aria-label="Conversas">
            <MessageSquare size={20} aria-hidden="true" />
          </button>
          <button className="rail-button" aria-label="Contatos">
            <Users size={20} aria-hidden="true" />
          </button>
        </nav>
        <button className="rail-button rail-settings" aria-label="Configuracoes">
          <Settings size={20} aria-hidden="true" />
        </button>
      </aside>

      <section className="conversation-list" aria-label="Conversas">
        <header className="list-header">
          <div>
            <p className="eyebrow">Prymeira Talk</p>
            <h1>Inbox</h1>
          </div>
          <span className="live-indicator">{token ? "Online" : "Conectando"}</span>
        </header>

        <div className="queue-summary" aria-label="Resumo da fila">
          <div>
            <span>{openCount}</span>
            <p>Abertas</p>
          </div>
          <div>
            <span>{unreadCount}</span>
            <p>Novas</p>
          </div>
        </div>

        {isLoading ? <p className="list-note">Carregando conversas...</p> : null}
        {error ? <p className="error-note">{error}</p> : null}

        <div className="conversation-items">
          {!isLoading && conversations.length === 0 ? (
            <p className="list-note">Nenhuma conversa encontrada.</p>
          ) : null}
          {conversations.map((conversation) => (
            <button
              className={
                conversation.id === selectedConversationId
                  ? "conversation-card is-selected"
                  : "conversation-card"
              }
              key={conversation.id}
              onClick={() => setSelectedConversationId(conversation.id)}
              type="button"
            >
              <span className="conversation-avatar" aria-hidden="true">
                {conversation.contactId.slice(0, 2).toUpperCase()}
              </span>
              <span className="conversation-content">
                <span className="conversation-row">
                  <strong>Contato {conversation.contactId.slice(0, 8)}</strong>
                  <time>{formatTime(conversation.lastMessageAt)}</time>
                </span>
                <span className="conversation-preview">
                  {conversation.lastMessagePreview ?? "Conversa iniciada sem mensagem recente."}
                </span>
                <span className="conversation-meta">
                  <span>{statusLabel(conversation.status)}</span>
                  <span>{priorityLabel(conversation.priority)}</span>
                  {conversation.unreadCount > 0 ? <b>{conversation.unreadCount}</b> : null}
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="chat-panel" aria-label="Area de atendimento">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Atendimento</p>
            <h2>{selectedConversation ? `Contato ${selectedConversation.contactId.slice(0, 8)}` : "Selecione uma conversa"}</h2>
          </div>
          {selectedConversation ? (
            <span className={`status-pill status-${selectedConversation.status}`}>
              {statusLabel(selectedConversation.status)}
            </span>
          ) : null}
        </header>

        <div className="chat-empty-state">
          <MessageSquare size={34} aria-hidden="true" />
          <h3>{selectedConversation ? "Historico pronto para carregar" : "Nenhuma conversa selecionada"}</h3>
          <p>
            {selectedConversation
              ? "A lista em tempo real ja esta conectada. O proximo passo e ligar as mensagens desta conversa."
              : "Escolha uma conversa na fila para acompanhar o atendimento."}
          </p>
        </div>

        <form className="composer" aria-label="Compositor de mensagem">
          <input
            aria-label="Mensagem"
            disabled
            placeholder="Escreva uma mensagem"
            type="text"
          />
          <button disabled type="button">
            Enviar
          </button>
        </form>
      </section>

      <aside className="contact-panel" aria-label="Detalhes do contato">
        <header>
          <p className="eyebrow">Contato</p>
          <h2>{selectedConversation ? selectedConversation.contactId.slice(0, 12) : "Sem selecao"}</h2>
        </header>
        <dl className="detail-list">
          <div>
            <dt>Status</dt>
            <dd>{selectedConversation ? statusLabel(selectedConversation.status) : "-"}</dd>
          </div>
          <div>
            <dt>Prioridade</dt>
            <dd>{selectedConversation ? priorityLabel(selectedConversation.priority) : "-"}</dd>
          </div>
          <div>
            <dt>Departamento</dt>
            <dd>{selectedConversation?.departmentId ?? "Nao atribuido"}</dd>
          </div>
          <div>
            <dt>Responsavel</dt>
            <dd>{selectedConversation?.assignedUserId ?? "Fila geral"}</dd>
          </div>
          <div>
            <dt>Canal</dt>
            <dd>{selectedConversation?.channelId ?? "-"}</dd>
          </div>
        </dl>
        <section className="crm-ready-panel" aria-label="Integracao com Atomic CRM">
          <div>
            <p className="eyebrow">Atomic CRM</p>
            <h3>{selectedConversation ? "Sem vinculo no Atomic CRM" : "Aguardando contato"}</h3>
            <p>
              {selectedConversation
                ? "O Talk segue standalone; este espaco fica pronto para vincular lead ou cliente."
                : "Selecione uma conversa para preparar o vinculo futuro."}
            </p>
          </div>
          <button disabled type="button">
            <Link2 size={16} aria-hidden="true" />
            Vincular depois
          </button>
        </section>
      </aside>
    </main>
  );
}
