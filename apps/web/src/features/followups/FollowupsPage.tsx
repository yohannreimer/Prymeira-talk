import type { ConversationFollowupDto, MessageType, RealtimeEvent } from "@prymeira-talk/shared";
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

type FollowupEditingState = {
  id: string;
  body: string;
  expectedUpdatedAt: string;
};

type FollowupConfirmation = {
  id: string;
  action: "cancel" | "no-followup";
};

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
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<FollowupEditingState | null>(null);
  const [confirmation, setConfirmation] = useState<FollowupConfirmation | null>(null);
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const realtimeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterRef = useRef(filter);
  const followupsRef = useRef<ConversationFollowupDto[]>([]);
  const editingRef = useRef<FollowupEditingState | null>(null);
  const confirmationRef = useRef<FollowupConfirmation | null>(null);

  const load = useCallback(async (showLoading = true) => {
    const sequence = ++loadSequence.current;
    if (showLoading) setIsLoading(true);
    setLoadError(null);

    try {
      const nextFollowups = await apiListFollowups(getToken, filter);
      if (sequence !== loadSequence.current) return;

      const sorted = sortFollowups(nextFollowups, filter);
      followupsRef.current = sorted;
      setFollowups(sorted);
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
    }, 300);
  }, [load]);

  useEffect(() => () => {
    if (realtimeTimer.current) clearTimeout(realtimeTimer.current);
  }, []);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type === "conversation_followup.updated") {
      loadSequence.current += 1;
      setIsLoading(false);
      const activeFilter = filterRef.current;
      setFollowups((current) => {
        const withoutCurrent = current.filter((item) => item.id !== event.payload.id);
        const next = matchesFollowupFilter(event.payload, activeFilter)
          ? sortFollowups([...withoutCurrent, event.payload], activeFilter)
          : withoutCurrent;
        followupsRef.current = next;
        return next;
      });

      if (
        editingRef.current?.id === event.payload.id &&
        editingRef.current.expectedUpdatedAt !== event.payload.updatedAt
      ) {
        editingRef.current = null;
        setEditing(null);
        setNotice("O contexto mudou. O rascunho aberto foi descartado e o card foi atualizado.");
      }
      if (confirmationRef.current?.id === event.payload.id) {
        confirmationRef.current = null;
        setConfirmation(null);
      }
      return;
    }
    if (event.type === "message.created" || event.type === "conversation.updated") {
      const conversationId = event.type === "message.created"
        ? event.payload.conversationId
        : event.payload.id;
      if (followupsRef.current.some((followup) => followup.conversationId === conversationId)) {
        scheduleRealtimeReload();
      }
    }
  }, [scheduleRealtimeReload]);

  useRealtimeEvents({ token: realtimeToken, onEvent: handleRealtimeEvent });

  const counts = useMemo(() => ({ current: followups.length }), [followups.length]);

  function replaceOrRemove(updated: ConversationFollowupDto) {
    const activeFilter = filterRef.current;
    setFollowups((current) => {
      const withoutUpdated = current.filter((item) => item.id !== updated.id);
      const next = matchesFollowupFilter(updated, activeFilter)
        ? sortFollowups([...withoutUpdated, updated], activeFilter)
        : withoutUpdated;
      followupsRef.current = next;
      return next;
    });
  }

  async function runAction(
    followup: ConversationFollowupDto,
    action: () => Promise<ConversationFollowupDto>,
    successMessage: string
  ) {
    if (busyId) return;
    editingRef.current = null;
    confirmationRef.current = null;
    setEditing(null);
    setConfirmation(null);
    setBusyId(followup.id);
    setNotice(null);
    setCardErrors((current) => ({ ...current, [followup.id]: "" }));

    try {
      const updated = await action();
      replaceOrRemove(updated);
      setNotice(successMessage);
    } catch (error) {
      if (error instanceof FollowupStaleError) {
        replaceOrRemove(error.followup);
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

  function sendBody(
    followup: ConversationFollowupDto,
    body: string,
    expectedUpdatedAt = followup.updatedAt
  ) {
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
        expectedUpdatedAt
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
              disabled={busyId !== null}
              key={key}
              onClick={() => {
                if (busyId) return;
                filterRef.current = key;
                setFilter(key);
                setNotice(null);
                editingRef.current = null;
                confirmationRef.current = null;
                setEditing(null);
                setConfirmation(null);
              }}
              type="button"
              aria-disabled={busyId !== null}
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

      <div className="followups-content">
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
                confirmation={confirmation?.id === followup.id ? confirmation.action : null}
                editing={editing?.id === followup.id ? editing : null}
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
                onAskCancel={() => {
                  const next = { id: followup.id, action: "cancel" } as const;
                  confirmationRef.current = next;
                  setConfirmation(next);
                }}
                onAskNoFollowup={() => {
                  const next = { id: followup.id, action: "no-followup" } as const;
                  confirmationRef.current = next;
                  setConfirmation(next);
                }}
                onCloseConfirmation={() => {
                  confirmationRef.current = null;
                  setConfirmation(null);
                }}
                onCloseEditor={() => {
                  editingRef.current = null;
                  setEditing(null);
                }}
                onEdit={() => {
                  const next = {
                    id: followup.id,
                    body: followup.draftBody ?? "",
                    expectedUpdatedAt: followup.updatedAt
                  };
                  confirmationRef.current = null;
                  editingRef.current = next;
                  setConfirmation(null);
                  setEditing(next);
                }}
                onEditedBodyChange={(body) => {
                  const current = editingRef.current;
                  if (!current || current.id !== followup.id) return;
                  const next = { ...current, body };
                  editingRef.current = next;
                  setEditing(next);
                }}
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
                onSend={(body, expectedUpdatedAt) => sendBody(followup, body, expectedUpdatedAt)}
              />
            ))}
          </div>
        ) : null}
      </div>
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
  busy: boolean;
  confirmation: FollowupConfirmation["action"] | null;
  editing: FollowupEditingState | null;
  cardError?: string;
  onSend: (body: string, expectedUpdatedAt?: string) => void;
  onEdit: () => void;
  onCloseEditor: () => void;
  onEditedBodyChange: (body: string) => void;
  onPostpone: () => void;
  onAskCancel: () => void;
  onAskNoFollowup: () => void;
  onCloseConfirmation: () => void;
  onCancel: () => void;
  onNoFollowup: () => void;
}) {
  const {
    followup,
    busy,
    confirmation,
    editing,
    cardError,
    onSend,
    onEdit,
    onCloseEditor,
    onEditedBodyChange,
    onPostpone,
    onAskCancel,
    onAskNoFollowup,
    onCloseConfirmation,
    onCancel,
    onNoFollowup
  } = props;
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const noFollowupTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<FollowupConfirmation["action"] | null>(null);

  useEffect(() => {
    if (confirmation) {
      confirmButtonRef.current?.focus();
      return;
    }

    const trigger = restoreFocusRef.current;
    if (!trigger) return;
    restoreFocusRef.current = null;
    (trigger === "cancel" ? cancelTriggerRef : noFollowupTriggerRef).current?.focus();
  }, [confirmation]);

  const contactName = followup.contact.name?.trim() || `Conversa ${followup.conversationId.slice(0, 8)}`;
  const contactDetail = [followup.contact.phone, followup.channel.displayName].filter(Boolean).join(" · ") || `ID ${followup.conversationId}`;
  const messagePreview = followup.anchorMessage.body?.trim() || anchorTypeLabel(followup.anchorMessage.type);
  const terminalReason = "reason" in followup ? followup.reason : null;
  const reason = followupReasonLabel(terminalReason ?? followup.reasonCode, followup.status);
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
  const validationError = editing !== null && (editing.body.trim().length < 1 || editing.body.trim().length > 4000);

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
          <div className="followup-preview" title={followup.anchorMessage.id ?? undefined}>
            <span>
              Mensagem âncora
              {followup.anchorMessage.createdAt ? ` · ${formatFollowupDate(followup.anchorMessage.createdAt)}` : ""}
            </span>
            <p>{messagePreview}</p>
          </div>
          <dl className="followup-facts">
            <div><dt>Tipo</dt><dd>{followupKindLabel(followup.kind)}</dd></div>
            <div><dt>Sequência</dt><dd>{followupStepLabel(followup.stepIndex)}</dd></div>
            <div><dt>Finalidade</dt><dd>{followupPurposeLabel(followup)}</dd></div>
            <div><dt>Quando</dt><dd>{datePrefix} {formatFollowupDate(followupMoment(followup))}</dd></div>
          </dl>
        </div>

        {reason ? (
          <p className="followup-reason">
            <Clock3 size={15} aria-hidden="true" />
            <span><strong>Motivo:</strong> {reason}</span>
          </p>
        ) : null}

        {text ? (
          <blockquote className="followup-copy">
            <span>{followup.status === "sent" ? "Mensagem enviada" : "Rascunho sugerido"}</span>
            <p>{text}</p>
          </blockquote>
        ) : isReview ? (
          <p className="followup-missing-copy">Este item não possui rascunho. Edite a mensagem antes de enviar.</p>
        ) : null}

        {editing !== null ? (
          <form
            className="followup-editor"
            onSubmit={(event) => {
              event.preventDefault();
              onSend(editing.body, editing.expectedUpdatedAt);
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
              value={editing.body}
            />
            <div className="followup-editor-meta">
              <span className={validationError ? "is-invalid" : ""}>
                {editing.body.trim().length.toLocaleString("pt-BR")} / 4.000
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

        {confirmation ? (
          <div
            aria-describedby={`followup-confirmation-description-${followup.id}`}
            aria-labelledby={`followup-confirmation-${followup.id}`}
            aria-modal="false"
            className="followup-confirmation"
            role="alertdialog"
          >
            <div>
              <strong id={`followup-confirmation-${followup.id}`}>
                {confirmation === "cancel"
                  ? "Cancelar este acompanhamento?"
                  : "Não acompanhar mais esta conversa?"}
              </strong>
              <p id={`followup-confirmation-description-${followup.id}`}>
                {confirmation === "cancel"
                  ? "O follow-up será encerrado e ficará no histórico de cancelados."
                  : "A conversa deixará de receber novos follow-ups automáticos desta sequência."}
              </p>
            </div>
            <div className="followup-confirmation-actions">
              <button
                className="followups-button followups-button-ghost"
                disabled={busy}
                onClick={() => {
                  restoreFocusRef.current = confirmation;
                  onCloseConfirmation();
                }}
                type="button"
              >
                Voltar
              </button>
              <button
                className="followups-button followups-button-danger"
                disabled={busy}
                onClick={confirmation === "cancel" ? onCancel : onNoFollowup}
                ref={confirmButtonRef}
                type="button"
              >
                {confirmation === "cancel" ? "Confirmar cancelamento" : "Confirmar não acompanhar"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {(isReview || isScheduled) && editing === null && confirmation === null ? (
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
          <button className="followups-button" disabled={busy} onClick={onAskCancel} ref={cancelTriggerRef} type="button">
            <X size={14} aria-hidden="true" /> Cancelar
          </button>
          {isReview ? (
            <button
              className="followups-button followups-button-quiet"
              disabled={busy}
              onClick={onAskNoFollowup}
              ref={noFollowupTriggerRef}
              type="button"
            >
              <UserRoundCheck size={14} aria-hidden="true" /> Não acompanhar
            </button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

function anchorTypeLabel(type: MessageType | null) {
  const labels: Partial<Record<MessageType, string>> = {
    audio: "Mensagem de áudio",
    image: "Imagem enviada",
    file: "Arquivo enviado",
    template: "Mensagem de modelo",
    system: "Evento do atendimento",
    internal_note: "Nota interna"
  };
  return type ? labels[type] ?? "Mensagem de texto" : "Mensagem âncora indisponível.";
}
