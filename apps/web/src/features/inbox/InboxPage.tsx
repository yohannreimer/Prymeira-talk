import { useAuth } from "@clerk/clerk-react";
import type { ConversationDto, MessageDto, RealtimeEvent } from "@prymeira-talk/shared";
import { Bot, Link2, MessageSquare, Send, StickyNote, UserCheck } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiCreateConversationMessage,
  apiGetConversationContext,
  apiGetConversationMessages,
  apiGetConversations,
  apiRunConversationAction,
  type ContactContextDto,
  type ConversationActionBody,
  type ConversationActionResultDto
} from "../../app/api";
import { useRealtimeEvents } from "./useRealtimeEvents";

function formatTime(value: string | null) {
  if (!value) return "Sem mensagens";

  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatMessageTime(value: string) {
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

function contactDisplayName(conversation: ConversationDto) {
  return conversation.contactName ?? `Contato ${conversation.contactId.slice(0, 8)}`;
}

function formatNoteDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function upsertConversation(list: ConversationDto[], conversation: ConversationDto) {
  const withoutUpdated = list.filter((item) => item.id !== conversation.id);
  return [conversation, ...withoutUpdated];
}

export function InboxPage() {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [contactContext, setContactContext] = useState<ContactContextDto | null>(null);
  const [isLoadingContext, setIsLoadingContext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isRunningAction, setIsRunningAction] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [crmStatus, setCrmStatus] = useState<string | null>(null);
  const selectedConversationIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<ConversationDto[]>([]);
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    let isMounted = true;

    async function loadConversations() {
      setIsLoading(true);
      setError(null);

      try {
        const authToken = await getToken();
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

  useEffect(() => {
    let isMounted = true;

    async function loadMessages() {
      if (!selectedConversationId || !token) {
        setMessages([]);
        return;
      }

      setIsLoadingMessages(true);
      setMessageError(null);

      try {
        const nextMessages = await apiGetConversationMessages(selectedConversationId, async () => token);

        if (!isMounted) return;

        setMessages(nextMessages);
      } catch (loadError) {
        if (!isMounted) return;
        setMessageError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar mensagens.");
      } finally {
        if (isMounted) {
          setIsLoadingMessages(false);
        }
      }
    }

    void loadMessages();

    return () => {
      isMounted = false;
    };
  }, [selectedConversationId, token]);

  useEffect(() => {
    let isMounted = true;

    async function loadContext() {
      if (!selectedConversationId || !token) {
        setContactContext(null);
        return;
      }

      setIsLoadingContext(true);
      setContextError(null);
      setAiSuggestion(null);
      setCrmStatus(null);

      try {
        const nextContext = await apiGetConversationContext(selectedConversationId, async () => token);

        if (!isMounted) return;

        setContactContext(nextContext);
      } catch (loadError) {
        if (!isMounted) return;
        setContextError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar contexto.");
      } finally {
        if (isMounted) {
          setIsLoadingContext(false);
        }
      }
    }

    void loadContext();

    return () => {
      isMounted = false;
    };
  }, [selectedConversationId, token]);

  const refreshSelectedContext = useCallback((targetConversationId: string) => {
    void apiGetConversationContext(targetConversationId, async () => tokenRef.current)
      .then((nextContext) => {
        if (selectedConversationIdRef.current === targetConversationId) {
          setContactContext(nextContext);
        }
      })
      .catch(() => undefined);
  }, []);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type === "message.created") {
      setMessages((current) => {
        if (event.payload.conversationId !== selectedConversationIdRef.current) return current;
        if (current.some((message) => message.id === event.payload.id)) return current;
        return [...current, event.payload];
      });
      return;
    }

    if (event.type === "contact.updated") {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.contactId === event.payload.id
            ? {
                ...conversation,
                contactName: event.payload.name,
                contactPhone: event.payload.phone
              }
            : conversation
        )
      );

      const selectedConversation = conversationsRef.current.find(
        (conversation) => conversation.id === selectedConversationIdRef.current
      );
      if (selectedConversation?.contactId === event.payload.id && selectedConversationIdRef.current) {
        refreshSelectedContext(selectedConversationIdRef.current);
      }
      return;
    }

    if (event.type === "board_membership.updated") {
      const selectedConversation = conversationsRef.current.find(
        (conversation) => conversation.id === selectedConversationIdRef.current
      );
      if (
        selectedConversation?.contactId === event.payload.contactId &&
        selectedConversationIdRef.current
      ) {
        refreshSelectedContext(selectedConversationIdRef.current);
      }
      return;
    }

    if (event.type !== "conversation.updated") return;

    setConversations((current) => upsertConversation(current, event.payload));

    setSelectedConversationId((current) => current ?? event.payload.id);
  }, [refreshSelectedContext]);

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

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedConversationId || !token || !draft.trim()) return;

    const targetConversationId = selectedConversationId;
    const messageBody = draft.trim();
    setIsSending(true);
    setMessageError(null);

    try {
      const createdMessage = await apiCreateConversationMessage(
        targetConversationId,
        messageBody,
        async () => token
      );

      setMessages((current) => {
        if (
          selectedConversationIdRef.current !== targetConversationId ||
          createdMessage.conversationId !== targetConversationId
        ) {
          return current;
        }
        if (current.some((message) => message.id === createdMessage.id)) return current;
        return [...current, createdMessage];
      });
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === targetConversationId
            ? {
                ...conversation,
                lastMessageAt: createdMessage.createdAt,
                lastMessagePreview: createdMessage.body
              }
            : conversation
        )
      );
      if (selectedConversationIdRef.current === targetConversationId) {
        setDraft("");
      }
    } catch (sendError) {
      if (selectedConversationIdRef.current === targetConversationId) {
        setMessageError(sendError instanceof Error ? sendError.message : "Nao foi possivel enviar a mensagem.");
      }
    } finally {
      setIsSending(false);
    }
  }

  async function runAction(body: ConversationActionBody) {
    if (!selectedConversationId || !token) return null;

    const targetConversationId = selectedConversationId;
    setIsRunningAction(true);
    setContextError(null);

    try {
      const result = await apiRunConversationAction(targetConversationId, body, async () => token);
      applyActionResult(result, targetConversationId);
      return result;
    } catch (actionError) {
      if (selectedConversationIdRef.current === targetConversationId) {
        setContextError(actionError instanceof Error ? actionError.message : "Nao foi possivel executar a acao.");
      }
      return null;
    } finally {
      setIsRunningAction(false);
    }
  }

  function applyActionResult(result: ConversationActionResultDto, targetConversationId: string) {
    setConversations((current) => upsertConversation(current, result.conversation));
    if (
      selectedConversationIdRef.current !== targetConversationId ||
      result.conversation.id !== targetConversationId
    ) {
      return;
    }

    setContactContext(result.context);
    if (result.aiSuggestion) {
      setAiSuggestion(result.aiSuggestion);
    }
    if (result.crmAction) {
      setCrmStatus(`Nota simulada enviada ao CRM (${result.crmAction.status}).`);
    }
  }

  async function handleAddNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!noteDraft.trim()) return;

    const result = await runAction({ action: "add_note", body: noteDraft.trim() });
    if (result) {
      setNoteDraft("");
    }
  }

  return (
    <section className="talk-workspace talk-workspace-atendimento" aria-label="Atendimento">
      <section className="conversation-list" aria-label="Atendimento">
        <header className="list-header">
          <div>
            <p className="eyebrow">Prymeira Talk</p>
            <h1>Atendimento</h1>
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
                  <strong>{contactDisplayName(conversation)}</strong>
                  <time>{formatTime(conversation.lastMessageAt)}</time>
                </span>
                <span className="conversation-preview">
                  {conversation.lastMessagePreview ?? "Conversa iniciada sem mensagem recente."}
                </span>
                <span className="conversation-meta">
                  <span>{statusLabel(conversation.status)}</span>
                  <span>{priorityLabel(conversation.priority)}</span>
                  {conversation.departmentName ? <span>{conversation.departmentName}</span> : null}
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
            <h2>
              {selectedConversation
                ? contactDisplayName(selectedConversation)
                : "Selecione uma conversa"}
            </h2>
          </div>
          {selectedConversation ? (
            <span className={`status-pill status-${selectedConversation.status}`}>
              {statusLabel(selectedConversation.status)}
            </span>
          ) : null}
        </header>

        {selectedConversation ? (
          <div className="message-thread" aria-label="Historico da conversa">
            {isLoadingMessages ? <p className="thread-note">Carregando mensagens...</p> : null}
            {messageError ? <p className="error-note">{messageError}</p> : null}
            {!isLoadingMessages && messages.length === 0 ? (
              <p className="thread-note">Ainda nao ha mensagens nesta conversa.</p>
            ) : null}
            {messages.map((message) => (
              <article
                className={
                  message.direction === "outbound"
                    ? "message-bubble is-outbound"
                    : "message-bubble is-inbound"
                }
                key={message.id}
              >
                <p>{message.body ?? "Mensagem sem texto."}</p>
                <time>{formatMessageTime(message.createdAt)}</time>
              </article>
            ))}
          </div>
        ) : (
          <div className="chat-empty-state">
            <MessageSquare size={34} aria-hidden="true" />
            <h3>Nenhuma conversa selecionada</h3>
            <p>Escolha uma conversa na fila para acompanhar o atendimento.</p>
          </div>
        )}

        <form className="composer" aria-label="Compositor de mensagem" onSubmit={handleSendMessage}>
          <input
            aria-label="Mensagem"
            disabled={!selectedConversation || isSending}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Escreva uma mensagem"
            type="text"
            value={draft}
          />
          <button disabled={!selectedConversation || !draft.trim() || isSending} type="submit">
            <Send size={16} aria-hidden="true" />
            {isSending ? "Enviando" : "Enviar"}
          </button>
        </form>
      </section>

      <aside className="contact-panel" aria-label="Detalhes do contato">
        <header>
          <p className="eyebrow">Contato</p>
          <h2>{selectedConversation ? contactDisplayName(selectedConversation) : "Sem selecao"}</h2>
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
            <dd>{selectedConversation?.departmentName ?? "Nao atribuido"}</dd>
          </div>
          <div>
            <dt>Responsavel</dt>
            <dd>{selectedConversation?.assignedUserName ?? "Fila geral"}</dd>
          </div>
          <div>
            <dt>Canal</dt>
            <dd>{selectedConversation?.channelName ?? selectedConversation?.channelId ?? "-"}</dd>
          </div>
        </dl>
        <section className="contact-context-panel" aria-label="Contexto do contato">
          <div className="context-panel-head">
            <div>
              <p className="eyebrow">Contexto</p>
              <h3>
                {contactContext?.primaryBoardStage
                  ? contactContext.primaryBoardStage.stageName
                  : "Sem etapa principal"}
              </h3>
            </div>
            {isLoadingContext ? <span>Carregando</span> : null}
          </div>

          {contextError ? <p className="error-note compact">{contextError}</p> : null}

          <div className="tag-row" aria-label="Tags">
            {contactContext?.tags.length ? (
              contactContext.tags.map((tag) => (
                <span key={tag.id} style={{ borderColor: tag.color }}>
                  {tag.name}
                </span>
              ))
            ) : (
              <span>Sem tags</span>
            )}
          </div>

          <form className="quick-note-form" onSubmit={handleAddNote}>
            <input
              aria-label="Nova nota"
              disabled={!selectedConversation || isRunningAction}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="Adicionar nota"
              value={noteDraft}
            />
            <button
              aria-label="Adicionar nota"
              disabled={!selectedConversation || !noteDraft.trim() || isRunningAction}
              type="submit"
            >
              <StickyNote size={15} aria-hidden="true" />
            </button>
          </form>

          <div className="quick-actions">
            <button
              disabled={!selectedConversation || isRunningAction}
              onClick={() => void runAction({ action: "assign_current_user" })}
              type="button"
            >
              <UserCheck size={15} aria-hidden="true" />
              Assumir
            </button>
            <button
              disabled={!selectedConversation || isRunningAction}
              onClick={() => void runAction({ action: "request_ai_suggestion" })}
              type="button"
            >
              <Bot size={15} aria-hidden="true" />
              IA
            </button>
            <button
              disabled={!selectedConversation || isRunningAction}
              onClick={() => void runAction({ action: "create_crm_note" })}
              type="button"
            >
              <Link2 size={15} aria-hidden="true" />
              CRM
            </button>
          </div>

          <label className="context-field">
            <span>Departamento</span>
            <select
              disabled={!selectedConversation || isRunningAction}
              onChange={(event) =>
                void runAction({
                  action: "change_department",
                  departmentId: event.target.value || null
                })
              }
              value={selectedConversation?.departmentId ?? ""}
            >
              <option value="">Fila geral</option>
              {contactContext?.departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>

          <label className="context-field">
            <span>Prioridade</span>
            <select
              disabled={!selectedConversation || isRunningAction}
              onChange={(event) =>
                void runAction({
                  action: "change_priority",
                  priority: event.target.value as ConversationDto["priority"]
                })
              }
              value={selectedConversation?.priority ?? "normal"}
            >
              <option value="low">Baixa</option>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
            </select>
          </label>

          <label className="context-field">
            <span>Etapa</span>
            <select
              disabled={!selectedConversation || !contactContext?.boardStages.length || isRunningAction}
              onChange={(event) =>
                void runAction({
                  action: "change_primary_board_stage",
                  stageId: event.target.value
                })
              }
              value={contactContext?.primaryBoardStage?.stageId ?? ""}
            >
              <option disabled={Boolean(contactContext?.boardStages.length)} value="">
                Sem etapa
              </option>
              {contactContext?.boardStages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.boardName} / {stage.name}
                </option>
              ))}
            </select>
          </label>

          {aiSuggestion ? <p className="assistant-suggestion">{aiSuggestion}</p> : null}
          {crmStatus ? <p className="success-note compact">{crmStatus}</p> : null}

          <div className="notes-list" aria-label="Notas do contato">
            {contactContext?.notes.length ? (
              contactContext.notes.map((note) => (
                <article key={note.id}>
                  <p>{note.body}</p>
                  <time>{formatNoteDate(note.createdAt)}</time>
                </article>
              ))
            ) : (
              <p className="list-note compact">Sem notas recentes.</p>
            )}
          </div>
        </section>
      </aside>
    </section>
  );
}
