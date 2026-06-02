import { useTalkAuth } from "../../app/auth";
import { CalendarClock, Gauge, Play, Plus, RefreshCw, Save, Send, Upload, Zap } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { read, utils } from "xlsx";
import {
  apiCreateCampaign,
  apiGetBoards,
  apiGetCampaignRecipients,
  apiGetCampaigns,
  apiGetSettings,
  apiListMetaEvolutionTemplates,
  apiResolveCampaignAudience,
  apiSendCampaignReal,
  apiSendCampaignMetaTemplate,
  apiSendCampaignSimulated,
  apiUpdateCampaign,
  type CampaignAudienceContactDto,
  type CampaignCadenceDto,
  type CampaignDto,
  type CampaignRecipientDto,
  type ContactBoardWithStagesDto,
  type IntegrationConfigDto,
  type MetaTemplateDto,
  type MetaTemplateOptionDto
} from "../../app/api";

type AudienceSource = "board" | "imported";
type CampaignViewMode = "hub" | "editor";
type MetaConnectionMode = "direct" | "evolution_official";

interface ImportedAudienceRow {
  name?: string;
  phone: string;
  fields: Record<string, string>;
}

interface CampaignFormState {
  name: string;
  audienceSource: AudienceSource;
  boardId: string;
  stageId: string;
  importedRows: ImportedAudienceRow[];
  templates: string[];
  fallbackName: string;
  cadence: CampaignCadenceDto;
  scheduledAt: string;
}

const defaultCadence: CampaignCadenceDto = {
  minDelaySeconds: 30,
  maxDelaySeconds: 90,
  batchSize: 25,
  pauseMinSeconds: 300,
  pauseMaxSeconds: 900,
  windowStart: "09:00",
  windowEnd: "18:00"
};

const emptyForm: CampaignFormState = {
  name: "Reativacao VIP",
  audienceSource: "board",
  boardId: "",
  stageId: "",
  importedRows: [],
  templates: [
    "Oi {{name}}, temos uma novidade para voce.",
    "{{name}}, passando rapidinho para falar contigo.",
    "Ola {{name}}, posso te mostrar uma novidade?"
  ],
  fallbackName: "cliente",
  cadence: defaultCadence,
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
    audienceSource: campaign.audience.type === "imported" ? "imported" : "board",
    boardId: campaign.audience.boardId ?? "",
    stageId: campaign.audience.stageId ?? "",
    importedRows: (campaign.audience.rows ?? []).map((row) => ({
      ...row,
      fields: row.fields ?? {}
    })),
    templates: campaign.templates.length > 0 ? campaign.templates : [campaign.messageBody],
    fallbackName: campaign.fallbackName || "cliente",
    cadence: campaign.cadence,
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

function renderPreview(template: string, fallbackName: string, sample?: ImportedAudienceRow | CampaignAudienceContactDto) {
  const name = sample?.name?.trim() || fallbackName;
  const fields = "fields" in (sample ?? {}) ? (sample as ImportedAudienceRow | CampaignAudienceContactDto).fields : {};
  const variables: Record<string, string> = {
    ...fields,
    name,
    nome: name,
    phone: sample?.phone ?? "+5511999990001",
    telefone: sample?.phone ?? "+5511999990001"
  };

  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) =>
    variables[key as keyof typeof variables] ?? ""
  );
}

function estimateDuration(rowCount: number, cadence: CampaignCadenceDto) {
  if (rowCount <= 1) return "imediato";

  const delaySeconds = Math.round((cadence.minDelaySeconds + cadence.maxDelaySeconds) / 2);
  const pauses = cadence.batchSize > 0 ? Math.floor((rowCount - 1) / cadence.batchSize) : 0;
  const totalSeconds = (rowCount - 1) * delaySeconds + pauses * cadence.pauseMinSeconds;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.ceil((totalSeconds % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

function normalizeCell(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function findColumn(headers: string[], patterns: RegExp[]) {
  return headers.find((header) => patterns.some((pattern) => pattern.test(header.toLowerCase())));
}

async function parseAudienceFile(file: File): Promise<ImportedAudienceRow[]> {
  const buffer = await file.arrayBuffer();
  const workbook = read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  if (!sheet) return [];

  const rows = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const phoneColumn = findColumn(headers, [/telefone/, /phone/, /celular/, /whats/, /numero/, /número/]);
  const nameColumn = findColumn(headers, [/^nome$/, /name/, /cliente/, /contato/]);

  if (!phoneColumn) return [];

  return rows
    .map((row) => {
      const phone = normalizeCell(row[phoneColumn]);
      const name = nameColumn ? normalizeCell(row[nameColumn]) : "";
      const fields = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, normalizeCell(value)])
      );

      return {
        ...(name ? { name } : {}),
        phone,
        fields
      };
    })
    .filter((row) => row.phone.length > 0);
}

function resultPreview(result: unknown) {
  if (typeof result !== "object" || result === null) return "";
  const payload = result as { messagePreview?: unknown };
  return typeof payload.messagePreview === "string" ? payload.messagePreview : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMetaCloudStatus(integrations: IntegrationConfigDto[]): {
  active: boolean;
  connectionMode: MetaConnectionMode;
} {
  const integration = integrations.find((current) => current.provider === "meta_cloud");
  const settings = isRecord(integration?.settings) ? integration.settings : {};
  const connectionMode: MetaConnectionMode = settings.connectionMode === "evolution_official"
    ? "evolution_official"
    : "direct";
  const directActive = (
    integration?.mode === "real" &&
    settings.enabled === true &&
    typeof settings.wabaId === "string" &&
    settings.wabaId.trim().length > 0 &&
    typeof settings.phoneNumberId === "string" &&
    settings.phoneNumberId.trim().length > 0 &&
    typeof settings.accessToken === "string" &&
    settings.accessToken.trim().length > 0
  );
  const evolutionOfficialActive = (
    integration?.mode === "real" &&
    settings.enabled === true &&
    typeof settings.evolutionBaseUrl === "string" &&
    settings.evolutionBaseUrl.trim().length > 0 &&
    typeof settings.evolutionApiKey === "string" &&
    settings.evolutionApiKey.trim().length > 0 &&
    typeof settings.evolutionInstanceName === "string" &&
    settings.evolutionInstanceName.trim().length > 0
  );

  return {
    active: connectionMode === "evolution_official" ? evolutionOfficialActive : directActive,
    connectionMode
  };
}

export function CampaignsPage() {
  const { getToken } = useTalkAuth();
  const [viewMode, setViewMode] = useState<CampaignViewMode>("hub");
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [boards, setBoards] = useState<ContactBoardWithStagesDto[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [form, setForm] = useState<CampaignFormState>(emptyForm);
  const [audiencePreview, setAudiencePreview] = useState<CampaignAudienceContactDto[]>([]);
  const [recipients, setRecipients] = useState<CampaignRecipientDto[]>([]);
  const [isMetaActive, setIsMetaActive] = useState(false);
  const [metaConnectionMode, setMetaConnectionMode] = useState<MetaConnectionMode>("direct");
  const [metaTemplate, setMetaTemplate] = useState<MetaTemplateDto>({
    name: "",
    language: "pt_BR"
  });
  const [metaTemplateOptions, setMetaTemplateOptions] = useState<MetaTemplateOptionDto[]>([]);
  const [isMetaTemplatesLoading, setIsMetaTemplatesLoading] = useState(false);
  const [metaTemplatesLoaded, setMetaTemplatesLoaded] = useState(false);
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
        setForm((current) => ({
          ...current,
          boardId: current.boardId || nextBoards[0]?.id || ""
        }));

        const settings = await apiGetSettings(getToken).catch(() => null);
        if (!isMounted) return;

        const metaStatus = settings ? getMetaCloudStatus(settings.integrations) : {
          active: false,
          connectionMode: "direct" as const
        };
        setIsMetaActive(metaStatus.active);
        setMetaConnectionMode(metaStatus.connectionMode);
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

  const audienceCount = form.audienceSource === "imported" ? form.importedRows.length : audiencePreview.length;
  const previewSample = form.audienceSource === "imported" ? form.importedRows[0] : audiencePreview[0];
  const scheduledCount = campaigns.filter((campaign) => campaign.status === "scheduled").length;
  const completedCount = campaigns.filter((campaign) => campaign.status === "completed").length;
  const sendingCount = campaigns.filter((campaign) => campaign.status === "sending").length;

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

  function openCampaign(campaign: CampaignDto) {
    setSelectedCampaignId(campaign.id);
    setForm(toFormState(campaign));
    setAudiencePreview([]);
    setViewMode("editor");
    setError(null);
    setNotice(null);
  }

  function createDraft() {
    setSelectedCampaignId(null);
    setRecipients([]);
    setAudiencePreview([]);
    setForm((current) => ({
      ...emptyForm,
      boardId: current.boardId || boards[0]?.id || ""
    }));
    setViewMode("editor");
    setNotice(null);
    setError(null);
  }

  async function saveCampaign(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    const cleanTemplates = form.templates.map((template) => template.trim()).filter(Boolean);
    const payload = {
      name: form.name,
      audience: form.audienceSource === "imported"
        ? {
            type: "imported" as const,
            rows: form.importedRows
          }
        : {
            type: "board" as const,
            boardId: form.boardId,
            ...(form.stageId ? { stageId: form.stageId } : {})
          },
      messageBody: cleanTemplates[0] ?? "",
      templates: cleanTemplates,
      fallbackName: form.fallbackName.trim() || "cliente",
      cadence: form.cadence,
      scheduledAt: toApiDateTime(form.scheduledAt)
    };

    try {
      const savedCampaign = selectedCampaign
        ? await apiUpdateCampaign(getToken, selectedCampaign.id, payload)
        : await apiCreateCampaign(getToken, payload);

      setCampaigns((current) => mergeCampaign(current, savedCampaign));
      setSelectedCampaignId(savedCampaign.id);
      setForm(toFormState(savedCampaign));
      setNotice("Disparo salvo.");
      return savedCampaign;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel salvar disparo.");
      return null;
    } finally {
      setIsSaving(false);
    }
  }

  async function resolveAudience() {
    let campaign = selectedCampaign;

    if (!campaign) {
      campaign = await saveCampaign();
    }

    if (!campaign) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const contacts = await apiResolveCampaignAudience(getToken, campaign.id);
      setAudiencePreview(contacts);
      setNotice(`${contacts.length} contatos prontos para o disparo.`);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "Nao foi possivel resolver audiencia.");
    } finally {
      setIsSaving(false);
    }
  }

  async function sendSimulation() {
    let campaign = selectedCampaign;

    if (!campaign) {
      campaign = await saveCampaign();
    }

    if (!campaign) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const result = await apiSendCampaignSimulated(getToken, campaign.id);
      const [nextCampaigns, nextRecipients] = await Promise.all([
        apiGetCampaigns(getToken),
        apiGetCampaignRecipients(getToken, campaign.id)
      ]);

      setCampaigns(nextCampaigns);
      setRecipients(nextRecipients);
      setNotice(`${result.recipientsCreated} mensagens colocadas na fila simulada.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Nao foi possivel simular envio.");
    } finally {
      setIsSaving(false);
    }
  }

  async function sendReal() {
    let campaign = selectedCampaign;

    if (!campaign) {
      campaign = await saveCampaign();
    }

    if (!campaign) return;

    const shouldSend = window.confirm("Enviar mensagens reais pelo WhatsApp para esta audiencia?");
    if (!shouldSend) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const result = await apiSendCampaignReal(getToken, campaign.id);
      const [nextCampaigns, nextRecipients] = await Promise.all([
        apiGetCampaigns(getToken),
        apiGetCampaignRecipients(getToken, campaign.id)
      ]);

      setCampaigns(nextCampaigns);
      setRecipients(nextRecipients);
      setNotice(`${result.recipientsSent ?? 0} mensagens reais enviadas. ${result.recipientsFailed ?? 0} falharam.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Nao foi possivel enviar campanha real.");
    } finally {
      setIsSaving(false);
    }
  }

  async function sendMetaTemplate() {
    let campaign = selectedCampaign;
    const template = {
      name: metaTemplate.name.trim(),
      language: metaTemplate.language.trim()
    };

    if (!template.name || !template.language) {
      setError("Informe o nome e o idioma do template Meta aprovado.");
      return;
    }

    if (!campaign) {
      campaign = await saveCampaign();
    }

    if (!campaign) return;

    const shouldSend = window.confirm("Enviar template aprovado da Meta para esta audiencia?");
    if (!shouldSend) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const result = await apiSendCampaignMetaTemplate(getToken, campaign.id, template);
      const [nextCampaigns, nextRecipients] = await Promise.all([
        apiGetCampaigns(getToken),
        apiGetCampaignRecipients(getToken, campaign.id)
      ]);

      setCampaigns(nextCampaigns);
      setRecipients(nextRecipients);
      setNotice(`${result.recipientsSent ?? 0} templates Meta enviados. ${result.recipientsFailed ?? 0} falharam.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Nao foi possivel enviar template Meta.");
    } finally {
      setIsSaving(false);
    }
  }

  async function loadMetaEvolutionTemplates() {
    setIsMetaTemplatesLoading(true);
    setError(null);
    setNotice(null);

    try {
      const templates = await apiListMetaEvolutionTemplates(getToken);
      setMetaTemplateOptions(templates);
      setMetaTemplatesLoaded(true);
      setNotice(
        templates.length > 0
          ? `${templates.length} templates Meta encontrados na Evolution.`
          : "A Evolution nao retornou templates para esta instancia."
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar templates da Evolution.");
    } finally {
      setIsMetaTemplatesLoading(false);
    }
  }

  function useMetaTemplateOption(template: MetaTemplateOptionDto) {
    setMetaTemplate({
      name: template.name,
      language: template.language || "pt_BR"
    });
    setNotice(`Template ${template.name} selecionado.`);
  }

  async function handleAudienceFile(file: File | null) {
    if (!file) return;

    setError(null);
    const rows = await parseAudienceFile(file);

    if (rows.length === 0) {
      setError("Nao encontrei uma coluna de telefone/WhatsApp na planilha.");
      return;
    }

    setForm((current) => ({
      ...current,
      audienceSource: "imported",
      importedRows: rows
    }));
    setAudiencePreview([]);
    setNotice(`${rows.length} contatos importados da planilha.`);
  }

  function updateTemplate(index: number, value: string) {
    setForm((current) => ({
      ...current,
      templates: current.templates.map((template, templateIndex) =>
        templateIndex === index ? value : template
      )
    }));
  }

  if (viewMode === "hub") {
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
            <strong>{sendingCount}</strong>
            <span>Enviando</span>
          </span>
          <span className="contacts-stat">
            <strong>{completedCount}</strong>
            <span>Concluidas</span>
          </span>
        </div>

        {error ? <p className="error-note campaign-inline-note">{error}</p> : null}

        <div className="campaign-hub-grid">
          <button className="campaign-create-card" type="button" onClick={createDraft}>
            <span className="campaign-create-icon">
              <Send size={26} aria-hidden="true" />
            </span>
            <strong>Criar novo disparo</strong>
            <span>Importe uma lista, escreva templates e configure o ritmo antes de enviar.</span>
          </button>

          {isLoading ? (
            <div className="module-panel campaign-empty-panel">Carregando campanhas...</div>
          ) : campaigns.length === 0 ? (
            <div className="module-panel campaign-empty-panel">
              <strong>Nenhum disparo criado</strong>
              <span>Comece por um rascunho e valide tudo em simulação.</span>
            </div>
          ) : (
            campaigns.map((campaign) => (
              <button
                className="campaign-hub-card"
                key={campaign.id}
                onClick={() => openCampaign(campaign)}
                type="button"
              >
                <span className={`status-badge status-badge--${
                  campaign.status === "completed" ? "open" :
                  campaign.status === "scheduled" || campaign.status === "sending" ? "waiting" : "closed"
                }`}>
                  {statusLabel(campaign.status)}
                </span>
                <strong>{campaign.name}</strong>
                <span>{campaign.audience.type === "imported" ? "Lista importada" : "Board do CRM"}</span>
                <small>{formatDateTime(campaign.scheduledAt)}</small>
              </button>
            ))
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="module-page campaigns-page" aria-label="Disparos">
      <header className="module-header campaign-editor-header">
        <div>
          <button className="secondary-button" type="button" onClick={() => setViewMode("hub")}>
            Voltar para disparos
          </button>
          <p className="eyebrow">Editar disparo</p>
          <h1>{selectedCampaign ? form.name : "Novo disparo"}</h1>
        </div>
        <div className="campaign-header-actions">
          <button className="secondary-button" disabled={isSaving} onClick={sendSimulation} type="button">
            <Play size={14} aria-hidden="true" />
            Simular fila
          </button>
          <button className="secondary-button" disabled={isSaving} onClick={sendReal} type="button">
            <Zap size={14} aria-hidden="true" />
            Enviar real
          </button>
          <button className="primary-button" disabled={isSaving} onClick={() => void saveCampaign()} type="button">
            <Save size={14} aria-hidden="true" />
            Salvar
          </button>
        </div>
      </header>

      {error ? <p className="error-note campaign-inline-note">{error}</p> : null}
      {notice ? <p className="list-note campaign-inline-note">{notice}</p> : null}

      <div className="campaign-builder-layout">
        <form className="module-panel campaign-builder-main" onSubmit={saveCampaign}>
          <section className="campaign-builder-section">
            <div className="panel-title-row">
              <h2>Base</h2>
              <span>{selectedCampaign ? statusLabel(selectedCampaign.status) : "Rascunho"}</span>
            </div>
            <label className="form-field">
              <span>Nome</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                required
                value={form.name}
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
          </section>

          <section className="campaign-builder-section">
            <div className="panel-title-row">
              <h2>Audiencia</h2>
              <span>{form.audienceSource === "imported" ? `${form.importedRows.length} importados` : "CRM"}</span>
            </div>
            <div className="segmented-control">
              <button
                className={form.audienceSource === "board" ? "is-active" : ""}
                onClick={() => setForm((current) => ({ ...current, audienceSource: "board" }))}
                type="button"
              >
                Board
              </button>
              <button
                className={form.audienceSource === "imported" ? "is-active" : ""}
                onClick={() => setForm((current) => ({ ...current, audienceSource: "imported" }))}
                type="button"
              >
                Excel/CSV
              </button>
            </div>

            {form.audienceSource === "board" ? (
              <div className="campaign-audience-grid">
                <label className="form-field">
                  <span>Board de audiencia</span>
                  <select
                    onChange={(event) => setForm((current) => ({ ...current, boardId: event.target.value, stageId: "" }))}
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
            ) : (
              <div className="campaign-import-box">
                <label className="secondary-button">
                  <Upload size={14} aria-hidden="true" />
                  Importar Excel/CSV
                  <input
                    accept=".csv,.xlsx,.xls"
                    className="visually-hidden"
                    onChange={(event) => void handleAudienceFile(event.target.files?.[0] ?? null)}
                    type="file"
                  />
                </label>
                <span>Reconheco colunas como nome, telefone, phone, celular ou WhatsApp.</span>
                {form.importedRows.length > 0 ? (
                  <div className="campaign-import-preview" aria-label="Previa da lista importada">
                    <div className="campaign-import-preview-row is-header">
                      <span>Nome</span>
                      <span>Telefone</span>
                    </div>
                    {form.importedRows.slice(0, 5).map((row, index) => (
                      <div className="campaign-import-preview-row" key={`${row.phone}-${index}`}>
                        <strong>{row.name?.trim() || form.fallbackName || "cliente"}</strong>
                        <span>{row.phone}</span>
                      </div>
                    ))}
                    {form.importedRows.length > 5 ? (
                      <small>+{form.importedRows.length - 5} contatos na fila importada</small>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section className="campaign-builder-section">
            <div className="panel-title-row">
              <h2>Mensagens</h2>
              <span>{form.templates.filter((template) => template.trim()).length} templates</span>
            </div>
            <label className="form-field">
              <span>Nome padrao quando vier vazio</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, fallbackName: event.target.value }))}
                value={form.fallbackName}
              />
            </label>
            {form.templates.map((template, index) => (
              <label className="form-field" key={index}>
                <span>Template {index + 1}</span>
                <textarea
                  onChange={(event) => updateTemplate(index, event.target.value)}
                  required={index === 0}
                  rows={4}
                  value={template}
                />
              </label>
            ))}
            <button
              className="secondary-button"
              disabled={form.templates.length >= 6}
              onClick={() => setForm((current) => ({ ...current, templates: [...current.templates, ""] }))}
              type="button"
            >
              <Plus size={14} aria-hidden="true" />
              Adicionar template
            </button>
          </section>

          {isMetaActive ? (
            <section className="campaign-builder-section">
              <div className="panel-title-row">
                <h2>Meta Cloud</h2>
                <span>{metaConnectionMode === "evolution_official" ? "Via Evolution" : "Template aprovado"}</span>
              </div>
              {metaConnectionMode === "evolution_official" ? (
                <div className="meta-template-picker">
                  <div className="meta-template-picker-header">
                    <div>
                      <strong>Templates da Evolution</strong>
                      <span>Use a lista da instancia oficial ou preencha manualmente abaixo.</span>
                    </div>
                    <button
                      className="secondary-button"
                      disabled={isMetaTemplatesLoading}
                      onClick={() => void loadMetaEvolutionTemplates()}
                      type="button"
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                      {isMetaTemplatesLoading ? "Carregando" : "Carregar templates"}
                    </button>
                  </div>
                  {metaTemplateOptions.length > 0 ? (
                    <div className="meta-template-list" aria-label="Templates Meta da Evolution">
                      {metaTemplateOptions.map((template) => (
                        <article className="meta-template-option" key={template.id}>
                          <div>
                            <strong>{template.name}</strong>
                            <span>{template.language} · {template.status}</span>
                            {template.preview ? <p>{template.preview}</p> : null}
                          </div>
                          <button
                            className="secondary-button"
                            onClick={() => useMetaTemplateOption(template)}
                            type="button"
                          >
                            Usar
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : metaTemplatesLoaded ? (
                    <p className="list-note">Nenhum template voltou da Evolution para esta instancia.</p>
                  ) : null}
                </div>
              ) : null}
              <div className="campaign-audience-grid">
                <label className="form-field">
                  <span>Nome do template</span>
                  <input
                    onChange={(event) => setMetaTemplate((current) => ({
                      ...current,
                      name: event.target.value
                    }))}
                    placeholder="reactivation_vip"
                    value={metaTemplate.name}
                  />
                </label>
                <label className="form-field">
                  <span>Idioma</span>
                  <input
                    onChange={(event) => setMetaTemplate((current) => ({
                      ...current,
                      language: event.target.value
                    }))}
                    placeholder="pt_BR"
                    value={metaTemplate.language}
                  />
                </label>
              </div>
              <button
                className="secondary-button"
                disabled={isSaving || !metaTemplate.name.trim() || !metaTemplate.language.trim()}
                onClick={sendMetaTemplate}
                type="button"
              >
                <Send size={14} aria-hidden="true" />
                Enviar template Meta
              </button>
            </section>
          ) : null}

          <section className="campaign-builder-section">
            <div className="panel-title-row">
              <h2>Ritmo</h2>
              <span>{estimateDuration(Math.max(audienceCount, form.importedRows.length, 1), form.cadence)}</span>
            </div>
            <div className="campaign-cadence-grid">
              <label className="form-field">
                <span>Delay minimo (s)</span>
                <input
                  min={0}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    cadence: { ...current.cadence, minDelaySeconds: Number(event.target.value) }
                  }))}
                  type="number"
                  value={form.cadence.minDelaySeconds}
                />
              </label>
              <label className="form-field">
                <span>Delay maximo (s)</span>
                <input
                  min={0}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    cadence: { ...current.cadence, maxDelaySeconds: Number(event.target.value) }
                  }))}
                  type="number"
                  value={form.cadence.maxDelaySeconds}
                />
              </label>
              <label className="form-field">
                <span>Pausa a cada</span>
                <input
                  min={0}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    cadence: { ...current.cadence, batchSize: Number(event.target.value) }
                  }))}
                  type="number"
                  value={form.cadence.batchSize}
                />
              </label>
              <label className="form-field">
                <span>Pausa minima (s)</span>
                <input
                  min={0}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    cadence: { ...current.cadence, pauseMinSeconds: Number(event.target.value) }
                  }))}
                  type="number"
                  value={form.cadence.pauseMinSeconds}
                />
              </label>
              <label className="form-field">
                <span>Inicio da janela</span>
                <input
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    cadence: { ...current.cadence, windowStart: event.target.value }
                  }))}
                  type="time"
                  value={form.cadence.windowStart ?? ""}
                />
              </label>
              <label className="form-field">
                <span>Fim da janela</span>
                <input
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    cadence: { ...current.cadence, windowEnd: event.target.value }
                  }))}
                  type="time"
                  value={form.cadence.windowEnd ?? ""}
                />
              </label>
            </div>
          </section>
        </form>

        <aside className="campaign-builder-side">
          <section className="module-panel campaign-preview-panel">
            <div className="panel-title-row">
              <h2>Preview</h2>
              <Gauge size={16} aria-hidden="true" />
            </div>
            <div className="campaign-preview-bubble">
              {renderPreview(form.templates.find((template) => template.trim()) ?? "", form.fallbackName, previewSample)}
            </div>
            <dl className="campaign-summary-list">
              <div>
                <dt>Audiencia</dt>
                <dd>{form.audienceSource === "imported" ? `${form.importedRows.length} importados` : `${audiencePreview.length || "Resolver"} contatos`}</dd>
              </div>
              <div>
                <dt>Templates</dt>
                <dd>{form.templates.filter((template) => template.trim()).length}</dd>
              </div>
              <div>
                <dt>Duração estimada</dt>
                <dd>{estimateDuration(Math.max(audienceCount, form.importedRows.length, 1), form.cadence)}</dd>
              </div>
            </dl>
            <button className="secondary-button" disabled={isSaving} onClick={resolveAudience} type="button">
              <CalendarClock size={14} aria-hidden="true" />
              Resolver audiencia
            </button>
          </section>

          <section className="module-panel campaign-results">
            <div className="panel-title-row">
              <h2>Fila e resultados</h2>
              <span>{isRecipientsLoading ? "Carregando" : `${recipients.length} linhas`}</span>
            </div>
            {recipients.length > 0 ? (
              <div className="recipient-table" role="table" aria-label="Resultados de recipients">
                <div className="recipient-table-row is-header" role="row">
                  <span role="columnheader">Contato</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Quando</span>
                </div>
                {recipients.map((recipient) => (
                  <div className="recipient-table-row" role="row" key={recipient.id}>
                    <span role="cell">{recipient.contactName ?? recipient.contactPhone ?? recipient.audienceKey}</span>
                    <span role="cell">{recipient.status}</span>
                    <span role="cell">{formatDateTime(recipient.scheduledAt)}</span>
                    <small>{resultPreview(recipient.result)}</small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="list-note">Simule ou envie para gerar a fila de destinatarios.</p>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
