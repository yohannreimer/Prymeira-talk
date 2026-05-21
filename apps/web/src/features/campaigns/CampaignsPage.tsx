import { useAuth } from "@clerk/clerk-react";
import { CalendarClock, Eye, FlaskConical, Play, Plus, Save, Send } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  apiCreateCampaign,
  apiGetBoards,
  apiGetCampaignRecipients,
  apiGetCampaigns,
  apiResolveCampaignAudience,
  apiSendCampaignSimulated,
  apiUpdateCampaign,
  type CampaignAudienceContactDto,
  type CampaignDto,
  type CampaignRecipientDto,
  type ContactBoardWithStagesDto
} from "../../app/api";

interface CampaignFormState {
  name: string;
  boardId: string;
  stageId: string;
  messageBody: string;
  scheduledAt: string;
}

const emptyForm: CampaignFormState = {
  name: "Reativacao VIP",
  boardId: "",
  stageId: "",
  messageBody: "Oi {{name}}, temos uma novidade para voce.",
  scheduledAt: ""
};

function mergeCampaign(campaigns: CampaignDto[], campaign: CampaignDto) {
  const withoutCampaign = campaigns.filter((current) => current.id !== campaign.id);
  return [campaign, ...withoutCampaign];
}

function toInputDateTime(value: string | null) {
  if (!value) return "";

  const date = new Date(value);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function toApiDateTime(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function toFormState(campaign: CampaignDto): CampaignFormState {
  return {
    name: campaign.name,
    boardId: campaign.audience.boardId,
    stageId: campaign.audience.stageId ?? "",
    messageBody: campaign.messageBody,
    scheduledAt: toInputDateTime(campaign.scheduledAt)
  };
}

function formatDateTime(value: string | null) {
  if (!value) return "Sem agendamento";

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function previewMessage(messageBody: string, name = "Ana", phone = "+5511999990001") {
  return messageBody.replaceAll("{{name}}", name).replaceAll("{{phone}}", phone);
}

function recipientPreview(recipient: CampaignRecipientDto) {
  const result = recipient.result as { messagePreview?: unknown };
  return typeof result.messagePreview === "string" ? result.messagePreview : "Preview nao gravado";
}

function statusLabel(status: CampaignDto["status"]) {
  const labels: Record<CampaignDto["status"], string> = {
    draft: "Rascunho",
    scheduled: "Agendada",
    sending: "Enviando",
    completed: "Concluida",
    failed: "Falhou"
  };

  return labels[status];
}

export function CampaignsPage() {
  const { getToken } = useAuth();
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [boards, setBoards] = useState<ContactBoardWithStagesDto[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [form, setForm] = useState<CampaignFormState>(emptyForm);
  const [audiencePreview, setAudiencePreview] = useState<CampaignAudienceContactDto[]>([]);
  const [recipients, setRecipients] = useState<CampaignRecipientDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRecipientsLoading, setIsRecipientsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadInitialData() {
      setIsLoading(true);
      setError(null);

      try {
        const [nextCampaigns, nextBoards] = await Promise.all([
          apiGetCampaigns(getToken),
          apiGetBoards(getToken)
        ]);

        if (!isMounted) return;

        setCampaigns(nextCampaigns);
        setBoards(nextBoards);
        setSelectedCampaignId((current) =>
          nextCampaigns.some((campaign) => campaign.id === current)
            ? current
            : nextCampaigns[0]?.id ?? null
        );
        setForm((current) => ({
          ...current,
          boardId: current.boardId || nextBoards[0]?.id || ""
        }));
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar disparos.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadInitialData();

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  const selectedCampaign = useMemo(
    () => campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? null,
    [campaigns, selectedCampaignId]
  );

  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === form.boardId) ?? null,
    [boards, form.boardId]
  );

  const hasUnsavedChanges = useMemo(() => {
    if (!selectedCampaign) {
      return false;
    }

    const savedForm = toFormState(selectedCampaign);

    return (
      form.name !== savedForm.name ||
      form.boardId !== savedForm.boardId ||
      form.stageId !== savedForm.stageId ||
      form.messageBody !== savedForm.messageBody ||
      form.scheduledAt !== savedForm.scheduledAt
    );
  }, [form, selectedCampaign]);

  const canUseSavedCampaign = Boolean(selectedCampaign) && !hasUnsavedChanges;

  useEffect(() => {
    if (selectedCampaign) {
      setForm(toFormState(selectedCampaign));
      setAudiencePreview([]);
    } else {
      setForm((current) => ({
        ...emptyForm,
        boardId: current.boardId || boards[0]?.id || ""
      }));
      setAudiencePreview([]);
      setRecipients([]);
    }
  }, [boards, selectedCampaign]);

  useEffect(() => {
    if (!selectedCampaignId) {
      setRecipients([]);
      return;
    }

    let isMounted = true;
    const campaignIdToLoad = selectedCampaignId;

    async function loadRecipients() {
      setIsRecipientsLoading(true);

      try {
        const nextRecipients = await apiGetCampaignRecipients(getToken, campaignIdToLoad);

        if (isMounted) {
          setRecipients(nextRecipients);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar resultados.");
        }
      } finally {
        if (isMounted) {
          setIsRecipientsLoading(false);
        }
      }
    }

    void loadRecipients();

    return () => {
      isMounted = false;
    };
  }, [getToken, selectedCampaignId]);

  const simulatedCount = campaigns.filter((campaign) => campaign.mode === "simulated").length;
  const scheduledCount = campaigns.filter((campaign) => campaign.status === "scheduled").length;
  const completedCount = campaigns.filter((campaign) => campaign.status === "completed").length;

  async function saveCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    const payload = {
      name: form.name,
      audience: {
        type: "board" as const,
        boardId: form.boardId,
        ...(form.stageId ? { stageId: form.stageId } : {})
      },
      messageBody: form.messageBody,
      scheduledAt: toApiDateTime(form.scheduledAt)
    };

    try {
      const savedCampaign = selectedCampaign
        ? await apiUpdateCampaign(getToken, selectedCampaign.id, payload)
        : await apiCreateCampaign(getToken, payload);

      setCampaigns((current) => mergeCampaign(current, savedCampaign));
      setSelectedCampaignId(savedCampaign.id);
      setNotice("Campanha salva em modo simulado.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel salvar campanha.");
    } finally {
      setIsSaving(false);
    }
  }

  function createDraft() {
    setSelectedCampaignId(null);
    setRecipients([]);
    setAudiencePreview([]);
    setNotice("Rascunho local pronto para edicao.");
  }

  async function resolveAudience() {
    if (!selectedCampaign) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const contacts = await apiResolveCampaignAudience(getToken, selectedCampaign.id);
      setAudiencePreview(contacts);
      setNotice(`${contacts.length} contatos encontrados na audiencia.`);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "Nao foi possivel resolver audiencia.");
    } finally {
      setIsSaving(false);
    }
  }

  async function sendSimulation() {
    if (!selectedCampaign) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const result = await apiSendCampaignSimulated(getToken, selectedCampaign.id);
      const [nextCampaigns, nextRecipients] = await Promise.all([
        apiGetCampaigns(getToken),
        apiGetCampaignRecipients(getToken, selectedCampaign.id)
      ]);

      setCampaigns(nextCampaigns);
      setRecipients(nextRecipients);
      setSelectedCampaignId(selectedCampaign.id);
      setNotice(`${result.recipientsCreated} envios simulados gravados como sent_simulated.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Nao foi possivel simular envio.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="module-page campaigns-page" aria-label="Disparos">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Disparos</h1>
        </div>
        <span className="status-pill status-pending">Envio simulado</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button" onClick={createDraft}>
          <Plus size={16} aria-hidden="true" />
          Novo disparo
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={sendSimulation}
          disabled={isSaving || !canUseSavedCampaign}
        >
          <Play size={16} aria-hidden="true" />
          {hasUnsavedChanges ? "Salve para simular" : "Simular envio"}
        </button>
      </div>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="list-note">{notice}</p> : null}
      {hasUnsavedChanges ? (
        <p className="list-note">Salve as alteracoes antes de resolver audiencia ou simular envio.</p>
      ) : null}

      <div className="metric-grid" aria-label="Resumo de disparos">
        <article className="metric-card"><span>Campanhas</span><strong>{campaigns.length}</strong><p>{simulatedCount} em modo simulado.</p></article>
        <article className="metric-card"><span>Agendadas</span><strong>{scheduledCount}</strong><p>Com horario salvo para teste.</p></article>
        <article className="metric-card"><span>Concluidas</span><strong>{completedCount}</strong><p>Com recipients simulados gravados.</p></article>
      </div>

      <div className="campaigns-grid">
        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Campanhas</h2>
            <span>{isLoading ? "Carregando" : `${campaigns.length} itens`}</span>
          </div>

          <div className="campaign-list">
            {campaigns.map((campaign) => (
              <button
                className={`campaign-card ${campaign.id === selectedCampaignId ? "is-selected" : ""}`}
                key={campaign.id}
                type="button"
                onClick={() => setSelectedCampaignId(campaign.id)}
              >
                <span className={`status-pill status-${campaign.status}`}>{statusLabel(campaign.status)}</span>
                <strong>{campaign.name}</strong>
                <small>{formatDateTime(campaign.scheduledAt)}</small>
                <em>{campaign.mode === "simulated" ? "Modo simulado" : "Modo real"}</em>
              </button>
            ))}

            {!isLoading && campaigns.length === 0 ? (
              <div className="channel-empty">
                <Send size={22} aria-hidden="true" />
                <strong>Nenhuma campanha criada</strong>
                <span>Crie um rascunho para testar disparos em modo simulado.</span>
              </div>
            ) : null}
          </div>
        </div>

        <form className="module-panel campaign-editor" onSubmit={saveCampaign}>
          <div className="panel-title-row">
            <h2>Rascunho</h2>
            <span>{selectedCampaign ? "Campanha salva" : "Novo disparo"}</span>
          </div>

          <label className="form-field">
            <span>Nome</span>
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              required
            />
          </label>

          <div className="campaign-audience-grid">
            <label className="form-field">
              <span>Board de audiencia</span>
              <select
                value={form.boardId}
                onChange={(event) => setForm((current) => ({ ...current, boardId: event.target.value, stageId: "" }))}
                required
              >
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>{board.name}</option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span>Etapa opcional</span>
              <select
                value={form.stageId}
                onChange={(event) => setForm((current) => ({ ...current, stageId: event.target.value }))}
              >
                <option value="">Todas</option>
                {selectedBoard?.stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>{stage.name}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="form-field">
            <span>Mensagem</span>
            <textarea
              value={form.messageBody}
              onChange={(event) => setForm((current) => ({ ...current, messageBody: event.target.value }))}
              required
              rows={6}
            />
          </label>

          <label className="form-field">
            <span>Agendamento</span>
            <input
              type="datetime-local"
              value={form.scheduledAt}
              onChange={(event) => setForm((current) => ({ ...current, scheduledAt: event.target.value }))}
            />
          </label>

          <div className="message-preview">
            <div>
              <Eye size={18} aria-hidden="true" />
              <strong>Preview</strong>
            </div>
            <p>{previewMessage(form.messageBody)}</p>
          </div>

          <div className="campaign-editor-footer">
            <button
              className="secondary-button"
              type="button"
              onClick={resolveAudience}
              disabled={isSaving || !canUseSavedCampaign}
            >
              <CalendarClock size={16} aria-hidden="true" />
              {hasUnsavedChanges ? "Salve para resolver" : "Resolver audiencia"}
            </button>
            <button className="primary-button" type="submit" disabled={isSaving || !form.boardId}>
              <Save size={16} aria-hidden="true" />
              Salvar
            </button>
          </div>
        </form>

        <aside className="module-panel campaign-results">
          <div className="panel-title-row">
            <h2>Resultados</h2>
            <span>{isRecipientsLoading ? "Carregando" : `${recipients.length} recipients`}</span>
          </div>

          <div className="local-runner-note">
            <FlaskConical size={18} aria-hidden="true" />
            <span>Modo simulado: nenhum WhatsApp real e enviado; recipients recebem sent_simulated.</span>
          </div>

          {audiencePreview.length > 0 ? (
            <div className="audience-preview">
              <strong>Audiencia resolvida</strong>
              <span>{audiencePreview.length} contatos</span>
              <p>{audiencePreview.slice(0, 3).map((contact) => contact.name ?? contact.phone).join(", ")}</p>
            </div>
          ) : null}

          <div className="recipient-table" role="table" aria-label="Resultados de recipients">
            <div className="recipient-table-row is-header" role="row">
              <span role="columnheader">Contato</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Preview</span>
            </div>
            {recipients.map((recipient) => (
              <div className="recipient-table-row" role="row" key={recipient.id}>
                <span role="cell">{recipient.contactName ?? recipient.contactPhone ?? recipient.contactId}</span>
                <span role="cell">{recipient.status}</span>
                <span role="cell">{recipientPreview(recipient)}</span>
              </div>
            ))}
          </div>

          {!isRecipientsLoading && recipients.length === 0 ? (
            <p className="list-note">Sem recipients simulados para esta campanha.</p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
