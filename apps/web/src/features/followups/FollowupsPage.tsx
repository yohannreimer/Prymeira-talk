import type { ConversationDto, ConversationFollowupDto, RealtimeEvent } from "@prymeira-talk/shared";
import {
  CalendarClock,
  Check,
  CheckCircle2,
  Clock3,
  Edit3,
  Inbox,
  LoaderCircle,
  MessageCircleReply,
  RefreshCw,
  Send,
  UserRoundCheck,
  X,
  XCircle
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiCancelFollowup,
  apiGetConversations,
  apiListFollowups,
  apiMarkFollowupNoFollowup,
  apiPostponeFollowup,
  apiSendFollowup,
  FollowupStaleError,
  type FollowupListStatus
} from "../../app/api";
import { useTalkAuth } from "../../app/auth";
import { useRealtimeEvents } from "../inbox/useRealtimeEvents";
import {
  followupKindLabel,
  followupMoment,
  followupPurposeLabel,
  followupReasonLabel,
  followupStatusLabel,
  followupStepLabel,
  formatFollowupDate,
  matchesFollowupFilter
} from "./followup-display";
import "./followups.css";

const filters: Array<{
  key: FollowupListStatus;
  label: string;
  shortLabel: string;
  Icon: typeof MessageCircleReply;
}> = [
  { key: "review", label: "Para revisar", shortLabel: "Revisar", Icon: MessageCircleReply },
  { key: "scheduled", label: "Agendados", shortLabel: "Agendados", Icon: CalendarClock },
  { key: "sent", label: "Enviados", shortLabel: "Enviados", Icon: CheckCircle2 },
  { key: "cancelled", label: "Cancelados", shortLabel: "Encerrados", Icon: XCircle }
];

const emptyCopy: Record<FollowupListStatus, { title: string; body: string }> = {
  review: {
    title: "Nenhum acompanhamento esperando revisão",
    body: "Quando uma conversa comercial esfriar, o rascunho seguro aparece aqui."
  },
  scheduled: {
    title: "Nenhum follow-up agendado",
    body: "Os próximos contatos automáticos e adiados aparecerão nesta fila."
  },
  sent: {
    title: "Nenhum follow-up enviado",
    body: "Os acompanhamentos concluídos ficam registrados aqui."
  },
  cancelled: {
    title: "Nenhum acompanhamento encerrado",
    body: "Cancelamentos, dispensas e falhas seguras serão guardados neste histórico."
  }
};

type ConversationSummary = Pick<
  ConversationDto,
  "id" | "contactName" | "contactPhone" | "lastMessagePreview" | "channelName"
>;

function sortFollowups(items: ConversationFollowupDto[], filter: FollowupListStatus) {
  return [...items].sort((left, right) => {
    const leftTime = new Date(followupMoment(left)).getTime();
    const rightTime = new Date(followupMoment(right)).getTime();
    return filter === "review" || filter === "scheduled"
      ? leftTime - rightTime
      : rightTime - leftTime;
  });
}
export function FollowupsPage() {
  const { getToken } = useTalkAuth();
  const [filter, setFilter] = useState<FollowupListStatus>("review");
  const [followups, setFollowups] = useState<ConversationFollowupDto[]>([]);
  const [conversations, setConversations] = useState<Map<string, ConversationSummary>>(() => new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedBody, setEditedBody] = useState("");
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const realtimeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (showLoading = true) => {
    const sequence = ++loadSequence.current;
    if (showLoading) setIsLoading(true);
    setLoadError(null);

    try {
      const [nextFollowups, nextConversations] = await Promise.all([
        apiListFollowups(getToken, filter),
        apiGetConversations(getToken, { status: "all" }).catch(() => [] as ConversationDto[])
      ]);
      if (sequence !== loadSequence.current) return;

      setFollowups(sortFollowups(nextFollowups, filter));
      setConversations(new Map(nextConversations.map((conversation) => [conversation.id, conversation])));
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setLoadError(error instanceof Error ? error.message : "Não foi possível carregar os follow-ups.");
    } finally {
      if (sequence === loadSequence.current) setIsLoading(false);
    }
  }, [filter, getToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((token) => {
        if (active) setRealtimeToken(token);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [getToken]);

  const scheduleRealtimeReload = useCallback(() => {
    if (realtimeTimer.current) clearTimeout(realtimeTimer.current);
    realtimeTimer.current = setTimeout(() => {
      realtimeTimer.current = null;
      void load(false);
    }, 100);
  }, [load]);

  useEffect(() => () => {
    if (realtimeTimer.current) clearTimeout(realtimeTimer.current);
  }, []);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type === "conversation_followup.updated") {
      setFollowups((current) => {
        const withoutCurrent = current.filter((item) => item.id !== event.payload.id);
        if (!matchesFollowupFilter(event.payload, filter)) return withoutCurrent;
        return sortFollowups([...withoutCurrent, event.payload], filter);
      });
      scheduleRealtimeReload();
      return;
    }
    if (event.type === "message.created" || event.type === "conversation.updated") {
      scheduleRealtimeReload();
    }
  }, [filter, scheduleRealtimeReload]);

  useRealtimeEvents({ token: realtimeToken, onEvent: handleRealtimeEvent });

  const counts = useMemo(() => ({ current: followups.length }), [followups.length]);

  function replaceOrRemove(updated: ConversationFollowupDto) {
    setFollowups((current) => {
      const withoutUpdated = current.filter((item) => item.id !== updated.id);
      if (!matchesFollowupFilter(updated, filter)) return withoutUpdated;
      return sortFollowups([...withoutUpdated, updated], filter);
    });
  }

  async function runAction(
    followup: ConversationFollowupDto,
    action: () => Promise<ConversationFollowupDto>,
    successMessage: string
  ) {
    if (busyId) return;
    setBusyId(followup.id);
    setNotice(null);
    setCardErrors((current) => ({ ...current, [followup.id]: "" }));

    try {
      const updated = await action();
      replaceOrRemove(updated);
      setEditingId(null);
      setNotice(successMessage);
    } catch (error) {
      if (error instanceof FollowupStaleError) {
        replaceOrRemove(error.followup);
        setEditingId(null);
        setNotice("O contexto mudou. A fila foi atualizada e nenhuma mensagem foi reenviada.");
      } else {
        setCardErrors((current) => ({
          ...current,
          [followup.id]: error instanceof Error ? error.message : "Não foi possível concluir a ação."
        }));
      }
    } finally {
      setBusyId(null);
    }
  }

  function sendBody(followup: ConversationFollowupDto, body: string) {
    const trimmed = body.trim();
    if (trimmed.length < 1 || trimmed.length > 4000) {
      setCardErrors((current) => ({
        ...current,
        [followup.id]: "Escreva uma mensagem entre 1 e 4.000 caracteres."
      }));
      return;
    }
    void runAction(
      followup,
      () => apiSendFollowup(getToken, followup.id, {
        body: trimmed,
        expectedUpdatedAt: followup.updatedAt
      }),
      "Follow-up enviado."
    );
  }

  return (
    <section className="talk-workspace followups-page" aria-labelledby="followups-title">
      <header className="followups-header">
        <div className="followups-title-block">
          <span className="followups-kicker">Central de continuidade</span>
          <div className="followups-heading-row">
            <div>
              <h1 id="followups-title">Follow-ups</h1>
              <p>Retome conversas no momento certo, com contexto e controle humano.</p>
            </div>
            <div className="followups-quiet-count" aria-label={`${counts.current} itens no filtro atual`}>
              <strong>{counts.current}</strong>
              <span>{counts.current === 1 ? "item" : "itens"}</span>
            </div>
          </div>
        </div>

        <nav className="followups-filters" aria-label="Filtros de follow-up">
          {filters.map(({ key, label, shortLabel, Icon }) => (
            <button
              className={filter === key ? "is-active" : ""}
              key={key}
              onClick={() => {
                setFilter(key);
                setNotice(null);
                setEditingId(null);
              }}
              type="button"
              aria-pressed={filter === key}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="followups-filter-long">{label}</span>
              <span className="followups-filter-short">{shortLabel}</span>
            </button>
          ))}
        </nav>
      </header>

      <div className="followups-feedback" aria-live="polite" aria-atomic="true">
        {notice ? <p className="followups-notice"><Check size={15} aria-hidden="true" />{notice}</p> : null}
      </div>

      <main className="followups-content">
        {isLoading ? <FollowupsLoading /> : null}

        {!isLoading && loadError ? (
          <div className="followups-state followups-state-error" role="alert">
            <XCircle size={28} aria-hidden="true" />
            <h2>Não foi possível abrir esta fila</h2>
            <p>{loadError}</p>
            <button className="followups-button followups-button-primary" onClick={() => void load()} type="button">
              <RefreshCw size={15} aria-hidden="true" /> Tentar novamente
            </button>
          </div>
        ) : null}

        {!isLoading && !loadError && followups.length === 0 ? (
          <div className="followups-state">
            <div className="followups-empty-mark"><Inbox size={28} aria-hidden="true" /></div>
            <h2>{emptyCopy[filter].title}</h2>
            <p>{emptyCopy[filter].body}</p>
          </div>
        ) : null}

        {!isLoading && !loadError && followups.length > 0 ? (
          <div className="followups-list" aria-label={`Follow-ups: ${filters.find((item) => item.key === filter)?.label}`}>
            {followups.map((followup) => (
              <FollowupCard
                busy={busyId === followup.id}
                cardError={cardErrors[followup.id]}
                conversation={conversations.get(followup.conversationId)}
                editedBody={editingId === followup.id ? editedBody : null}
                followup={followup}
                key={followup.id}
                onCancel={() => void runAction(
                  followup,
                  () => apiCancelFollowup(getToken, followup.id, {
                    reason: "manual_cancelled",
                    expectedUpdatedAt: followup.updatedAt
                  }),
                  "Acompanhamento cancelado."
                )}
                onCloseEditor={() => setEditingId(null)}
                onEdit={() => {
                  setEditedBody(followup.draftBody ?? "");
                  setEditingId(followup.id);
                }}
                onEditedBodyChange={setEditedBody}
                onNoFollowup={() => void runAction(
                  followup,
                  () => apiMarkFollowupNoFollowup(getToken, followup.id, followup.updatedAt),
                  "Conversa marcada para não acompanhar."
                )}
                onPostpone={() => void runAction(
                  followup,
                  () => apiPostponeFollowup(getToken, followup.id, followup.updatedAt),
                  "Follow-up adiado para o próximo horário útil."
                )}
                onSend={(body) => sendBody(followup, body)}
              />
            ))}
          </div>
        ) : null}
      </main>
    </section>
  );
}

function FollowupsLoading() {
  return (
    <div className="followups-loading" aria-label="Carregando follow-ups" role="status">
      <LoaderCircle className="followups-spin" size={22} aria-hidden="true" />
      <span>Organizando acompanhamentos…</span>
    </div>
  );
}

function FollowupCard(props: {
  followup: ConversationFollowupDto;
  conversation?: ConversationSummary;
  busy: boolean;
  editedBody: string | null;
  cardError?: string;
  onSend: (body: string) => void;
  onEdit: () => void;
  onCloseEditor: () => void;
  onEditedBodyChange: (body: string) => void;
  onPostpone: () => void;
  onCancel: () => void;
  onNoFollowup: () => void;
}) {
  const {
    followup,
    conversation,
    busy,
    editedBody,
    cardError,
    onSend,
    onEdit,
    onCloseEditor,
    onEditedBodyChange,
    onPostpone,
    onCancel,
    onNoFollowup
  } = props;
  const contactName = conversation?.contactName?.trim() || `Conversa ${followup.conversationId.slice(0, 8)}`;
  const contactDetail = conversation?.contactPhone || conversation?.channelName || `ID ${followup.conversationId}`;
  const messagePreview = conversation?.lastMessagePreview?.trim() || "Última mensagem não disponível nesta listagem.";
  const reason = "reason" in followup ? followupReasonLabel(followup.reason) : null;
  const text = followup.status === "sent" ? followup.finalBody : followup.draftBody;
  const datePrefix = followup.status === "sent"
    ? "Enviado"
    : followup.status === "review"
      ? "Previsto"
      : followup.status === "scheduled"
        ? "Agendado"
        : "Atualizado";
  const isReview = followup.status === "review";
  const isScheduled = followup.status === "scheduled";
  const defaultBody = followup.draftBody ?? "";
  const validationError = editedBody !== null && (editedBody.trim().length < 1 || editedBody.trim().length > 4000);

  return (
    <article className={`followup-card followup-card-${followup.status}`} aria-busy={busy}>
      <div className="followup-card-accent" aria-hidden="true" />
      <div className="followup-card-main">
        <header className="followup-card-header">
          <div className="followup-contact">
            <div className="followup-avatar" aria-hidden="true">{contactName.slice(0, 1).toUpperCase()}</div>
            <div>
              <h2>{contactName}</h2>
              <p title={contactDetail}>{contactDetail}</p>
            </div>
          </div>
          <span className={`followup-status followup-status-${followup.status}`}>
            <span aria-hidden="true" />
            {followupStatusLabel(followup.status)}
          </span>
        </header>

        <div className="followup-context-grid">
          <div className="followup-preview">
            <span>Última conversa</span>
            <p>{messagePreview}</p>
          </div>
          <dl className="followup-facts">
            <div><dt>Tipo</dt><dd>{followupKindLabel(followup.kind)}</dd></div>
            <div><dt>Sequência</dt><dd>{followupStepLabel(followup.stepIndex)}</dd></div>
            <div><dt>Finalidade</dt><dd>{followupPurposeLabel(followup)}</dd></div>
            <div><dt>Quando</dt><dd>{datePrefix} {formatFollowupDate(followupMoment(followup))}</dd></div>
          </dl>
        </div>

        {reason ? <p className="followup-reason"><Clock3 size={15} aria-hidden="true" />{reason}</p> : null}

        {text ? (
          <blockquote className="followup-copy">
            <span>{followup.status === "sent" ? "Mensagem enviada" : "Rascunho sugerido"}</span>
            <p>{text}</p>
          </blockquote>
        ) : isReview ? (
          <p className="followup-missing-copy">Este item não possui rascunho. Edite a mensagem antes de enviar.</p>
        ) : null}

        {editedBody !== null ? (
          <form
            className="followup-editor"
            onSubmit={(event) => {
              event.preventDefault();
              onSend(editedBody);
            }}
          >
            <label htmlFor={`followup-body-${followup.id}`}>Mensagem para o cliente</label>
            <textarea
              autoFocus
              disabled={busy}
              id={`followup-body-${followup.id}`}
              maxLength={4000}
              onChange={(event) => onEditedBodyChange(event.target.value)}
              rows={4}
              value={editedBody}
            />
            <div className="followup-editor-meta">
              <span className={validationError ? "is-invalid" : ""}>
                {editedBody.trim().length.toLocaleString("pt-BR")} / 4.000
              </span>
              <div>
                <button className="followups-button followups-button-ghost" disabled={busy} onClick={onCloseEditor} type="button">
                  Voltar
                </button>
                <button className="followups-button followups-button-primary" disabled={busy || validationError} type="submit">
                  <Send size={14} aria-hidden="true" /> Confirmar envio
                </button>
              </div>
            </div>
          </form>
        ) : null}

        {cardError ? <p className="followup-card-error" role="alert">{cardError}</p> : null}
      </div>

      {(isReview || isScheduled) && editedBody === null ? (
        <footer className="followup-actions">
          {isReview ? (
            <>
              <button
                className="followups-button followups-button-primary"
                disabled={busy || defaultBody.trim().length < 1}
                onClick={() => onSend(defaultBody)}
                type="button"
              >
                {busy ? <LoaderCircle className="followups-spin" size={14} aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                Enviar
              </button>
              <button className="followups-button" disabled={busy} onClick={onEdit} type="button">
                <Edit3 size={14} aria-hidden="true" /> Editar e enviar
              </button>
            </>
          ) : null}
          <button className="followups-button" disabled={busy} onClick={onPostpone} type="button">
            <CalendarClock size={14} aria-hidden="true" /> Adiar
          </button>
          <button className="followups-button" disabled={busy} onClick={onCancel} type="button">
            <X size={14} aria-hidden="true" /> Cancelar
          </button>
          {isReview ? (
            <button className="followups-button followups-button-quiet" disabled={busy} onClick={onNoFollowup} type="button">
              <UserRoundCheck size={14} aria-hidden="true" /> Não acompanhar
            </button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
