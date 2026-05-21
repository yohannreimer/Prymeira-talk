import { useAuth } from "@clerk/clerk-react";
import { CalendarClock, Eye, Play, Plus, Save, Send } from "lucide-react";
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
        <button className="primary-button" type="button" onClick={createDraft}>
          <Plus size={16} aria-hidden="true" />
          Novo disparo
        </button>
      </header>

      <div className="contacts-stats-row" aria-label="Resumo de disparos">
        <span className="contacts-stat">
          <strong>{campaigns.length}</strong>
          <span>Campanhas</span>
        </span>
        <span className="contacts-stat">
          <strong>{scheduledCount}</strong>
          <span>Agendadas</span>
        </span>
        <span className="contacts-stat">
          <strong>{completedCount}</strong>
          <span>Concluídas</span>
        </span>
      </div>

      {error ? <p className="error-note" style={{ margin: '0 8px' }}>{error}</p> : null}
      {notice ? <p className="list-note" style={{ margin: '0 8px' }}>{notice}</p> : null}
      {hasUnsavedChanges ? (
        <p className="list-note" style={{ margin: '0 8px' }}>Salve as alterações antes de resolver audiência ou simular envio.</p>
      ) : null}

      <div className="campaigns-layout">
        {/* Left — campaign list */}
        <div className="module-panel campaigns-list-panel">
          <div className="panel-title-row">
            <h2>Campanhas</h2>
            <span>{isLoading ? 'Carregando' : `${campaigns.length} itens`}</span>
          </div>

          {!isLoading && campaigns.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Send size={28} aria-hidden="true" />
              </div>
              <h3>Nenhum disparo criado</h3>
              <p>Crie um rascunho para testar disparos em modo simulado.</p>
            </div>
          ) : null}

          <div className="campaign-list">
            {campaigns.map((campaign) => (
              <button
                className={`campaign-card ${campaign.id === selectedCampaignId ? 'is-selected' : ''}`}
                key={campaign.id}
                onClick={() => setSelectedCampaignId(campaign.id)}
                type="button"
              >
                <span className={`status-badge status-badge--${
                  campaign.status === 'completed' ? 'open' :
                  campaign.status === 'scheduled' || campaign.status === 'sending' ? 'waiting' : 'closed'
                }`}>
                  {statusLabel(campaign.status)}
                </span>
                <span className="campaign-card-info">
                  <strong>{campaign.name}</strong>
                  <small>{formatDateTime(campaign.scheduledAt)}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Right — editor + results */}
        <div className="campaigns-editor-col">
          <form className="module-panel campaign-editor" onSubmit={saveCampaign}>
            <div className="panel-title-row">
              <h2>{selectedCampaign ? 'Editar disparo' : 'Novo rascunho'}</h2>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="secondary-button"
                  disabled={isSaving || !canUseSavedCampaign}
                  onClick={sendSimulation}
                  type="button"
                >
                  <Play size={14} aria-hidden="true" />
                  {hasUnsavedChanges ? 'Salve para simular' : 'Simular envio'}
                </button>
                <button className="primary-button" disabled={isSaving || !form.boardId} type="submit">
                  <Save size={14} aria-hidden="true" />
                  Salvar
                </button>
              </div>
            </div>

            <label className="form-field">
              <span>Nome</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                required
                value={form.name}
              />
            </label>

            <div className="campaign-audience-grid">
              <label className="form-field">
                <span>Board de audiência</span>
                <select
                  onChange={(event) => setForm((current) => ({ ...current, boardId: event.target.value, stageId: '' }))}
                  required
                  value={form.boardId}
                >
                  {boards.map((board) => (
                    <option key={board.id} value={board.id}>{board.name}</option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Etapa opcional</span>
                <select
                  onChange={(event) => setForm((current) => ({ ...current, stageId: event.target.value }))}
                  value={form.stageId}
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
                onChange={(event) => setForm((current) => ({ ...current, messageBody: event.target.value }))}
                required
                rows={5}
                value={form.messageBody}
              />
            </label>

            <label className="form-field">
              <span>Agendamento</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, scheduledAt: event.target.value }))}
                type="datetime-local"
                value={form.scheduledAt}
              />
            </label>

            <div className="message-preview">
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <Eye size={14} aria-hidden="true" />
                <strong style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Preview</strong>
              </div>
              <p style={{ fontSize: '13px', color: 'var(--color-text-primary)', margin: 0 }}>{previewMessage(form.messageBody)}</p>
            </div>

            <div className="campaign-editor-footer">
              <button
                className="secondary-button"
                disabled={isSaving || !canUseSavedCampaign}
                onClick={resolveAudience}
                type="button"
              >
                <CalendarClock size={14} aria-hidden="true" />
                {hasUnsavedChanges ? 'Salve para resolver' : 'Resolver audiência'}
              </button>
            </div>
          </form>

          {/* Results section */}
          {(audiencePreview.length > 0 || recipients.length > 0 || isRecipientsLoading) ? (
            <div className="module-panel campaign-results">
              <div className="panel-title-row">
                <h2>Resultados</h2>
                <span>{isRecipientsLoading ? 'Carregando' : `${recipients.length} recipients`}</span>
              </div>

              {audiencePreview.length > 0 ? (
                <div className="audience-preview">
                  <strong>Audiência resolvida</strong>
                  <span>{audiencePreview.length} contatos</span>
                  <p>{audiencePreview.slice(0, 3).map((contact) => contact.name ?? contact.phone).join(', ')}</p>
                </div>
              ) : null}

              {recipients.length > 0 ? (
                <div className="recipient-table" role="table" aria-label="Resultados de recipients">
                  <div className="recipient-table-row is-header" role="row">
                    <span role="columnheader">Contato</span>
                    <span role="columnheader">Status</span>
                  </div>
                  {recipients.map((recipient) => (
                    <div className="recipient-table-row" role="row" key={recipient.id}>
                      <span role="cell">{recipient.contactName ?? recipient.contactPhone ?? recipient.contactId}</span>
                      <span role="cell">{recipient.status}</span>
                    </div>
                  ))}
                </div>
              ) : (
                !isRecipientsLoading ? <p className="list-note">Sem recipients para esta campanha.</p> : null
              )}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
