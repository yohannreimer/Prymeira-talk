import { useTalkAuth } from "../../app/auth";
import type { ChannelDto } from "@prymeira-talk/shared";
import { CalendarClock, Gauge, Play, Plus, RefreshCw, Save, Send, Upload, X, Zap } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { readSheet } from "read-excel-file/browser";
import {
  apiCreateCampaign,
  apiGetBoards,
  apiGetChannels,
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
type CampaignSendMode = "evolution" | "meta_cloud";
type MetaVariableMode = "field" | "fixed";

interface ImportedAudienceRow {
  name?: string;
  phone: string;
  fields: Record<string, string>;
}

interface MetaVariableMapping {
  index: number;
  mode: MetaVariableMode;
  fieldKey: string;
  fixedValue: string;
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
  name: "",
  audienceSource: "board",
  boardId: "",
  stageId: "",
  importedRows: [],
  templates: [""],
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

function parseCsvRows(text: string): unknown[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);

  return rows.filter((currentRow) => currentRow.some((value) => value.trim().length > 0));
}

function parseAudienceRows(rows: unknown[][]): ImportedAudienceRow[] {
  const [headerRow, ...dataRows] = rows;
  const headers = (headerRow ?? []).map(normalizeCell);
  const phoneColumn = findColumn(headers, [/telefone/, /phone/, /celular/, /whats/, /número/, /número/]);
  const nameColumn = findColumn(headers, [/^nome$/, /name/, /cliente/, /contato/]);

  if (!phoneColumn) return [];

  const phoneIndex = headers.indexOf(phoneColumn);
  const nameIndex = nameColumn ? headers.indexOf(nameColumn) : -1;

  return dataRows
    .map((row) => {
      const phone = normalizeCell(row[phoneIndex]);
      const name = nameIndex >= 0 ? normalizeCell(row[nameIndex]) : "";
      const fields = Object.fromEntries(
        headers.map((header, index) => [header, normalizeCell(row[index])])
      );

      return {
        ...(name ? { name } : {}),
        phone,
        fields
      };
    })
    .filter((row) => row.phone.length > 0);
}

async function parseAudienceFile(file: File): Promise<ImportedAudienceRow[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const rows = extension === "csv"
    ? parseCsvRows(await file.text())
    : await readSheet(file);

  return parseAudienceRows(rows);
}

function resultPreview(result: unknown) {
  if (typeof result !== "object" || result === null) return "";
  const payload = result as { messagePreview?: unknown };
  return typeof payload.messagePreview === "string" ? payload.messagePreview : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMetaComponentText(component: unknown) {
  if (!isRecord(component)) return "";

  return typeof component.text === "string" ? component.text : "";
}

function getMetaComponentType(component: unknown) {
  if (!isRecord(component)) return "";

  return typeof component.type === "string" ? component.type.toLowerCase() : "";
}

function getMetaBodyText(template: MetaTemplateOptionDto | null) {
  if (!template) return "";

  const bodyComponent = template.components.find((component) => getMetaComponentType(component) === "body");
  return getMetaComponentText(bodyComponent) || template.preview || "";
}

function extractMetaVariableIndexes(text: string) {
  return Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), (match) => Number(match[1]))
    .filter((index) => Number.isInteger(index) && index > 0)
    .filter((index, position, indexes) => indexes.indexOf(index) === position)
    .sort((first, second) => first - second);
}

function resolveSampleValue(
  mapping: MetaVariableMapping,
  sample: ImportedAudienceRow | CampaignAudienceContactDto | undefined,
  fallbackName: string
) {
  if (mapping.mode === "fixed") return mapping.fixedValue;

  const fieldKey = mapping.fieldKey.trim();
  if (!fieldKey) return "";

  const name = sample?.name?.trim() || fallbackName;
  const fields = "fields" in (sample ?? {}) ? (sample as ImportedAudienceRow | CampaignAudienceContactDto).fields : {};
  const variables: Record<string, string> = {
    ...fields,
    name,
    nome: name,
    phone: sample?.phone ?? "",
    telefone: sample?.phone ?? ""
  };

  return variables[fieldKey] ?? "";
}

function renderMetaTemplatePreview(input: {
  text: string;
  mappings: MetaVariableMapping[];
  sample?: ImportedAudienceRow | CampaignAudienceContactDto;
  fallbackName: string;
}) {
  return input.text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, rawIndex: string) => {
    const index = Number(rawIndex);
    const mapping = input.mappings.find((current) => current.index === index);
    if (!mapping) return `{{${rawIndex}}}`;

    return resolveSampleValue(mapping, input.sample, input.fallbackName) || `{{${rawIndex}}}`;
  });
}

function buildMetaTemplateComponents(input: {
  template: MetaTemplateOptionDto | null;
  mappings: MetaVariableMapping[];
}) {
  if (!input.template) return undefined;

  const bodyText = getMetaBodyText(input.template);
  const indexes = extractMetaVariableIndexes(bodyText);
  if (indexes.length === 0) return undefined;

  return [
    {
      type: "body" as const,
      parameters: indexes.map((index) => {
        const mapping = input.mappings.find((current) => current.index === index);

        return {
          type: "text" as const,
          text: mapping?.mode === "fixed"
            ? mapping.fixedValue
            : `{{${mapping?.fieldKey || "name"}}}`
        };
      })
    }
  ];
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
    settings.evolutionApiKey.trim().length > 0
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
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [form, setForm] = useState<CampaignFormState>(emptyForm);
  const [audiencePreview, setAudiencePreview] = useState<CampaignAudienceContactDto[]>([]);
  const [recipients, setRecipients] = useState<CampaignRecipientDto[]>([]);
  const [isMetaActive, setIsMetaActive] = useState(false);
  const [metaConnectionMode, setMetaConnectionMode] = useState<MetaConnectionMode>("direct");
  const [sendMode, setSendMode] = useState<CampaignSendMode>("evolution");
  const [selectedEvolutionChannelIds, setSelectedEvolutionChannelIds] = useState<string[]>([]);
  const [selectedMetaChannelIds, setSelectedMetaChannelIds] = useState<string[]>([]);
  const [metaTemplate, setMetaTemplate] = useState<MetaTemplateDto>({
    name: "",
    language: "pt_BR"
  });
  const [selectedMetaChannelId, setSelectedMetaChannelId] = useState("");
  const [metaTemplateOptions, setMetaTemplateOptions] = useState<MetaTemplateOptionDto[]>([]);
  const [selectedMetaTemplate, setSelectedMetaTemplate] = useState<MetaTemplateOptionDto | null>(null);
  const [metaVariableMappings, setMetaVariableMappings] = useState<MetaVariableMapping[]>([]);
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
        const [nextCampaigns, nextBoards, nextChannels] = await Promise.all([
          apiGetCampaigns(getToken),
          apiGetBoards(getToken),
          apiGetChannels(getToken)
        ]);

        if (!isMounted) return;

        setCampaigns(nextCampaigns);
        setBoards(nextBoards);
        setChannels(nextChannels);
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
        const firstMetaChannel = nextChannels.find((channel) =>
          channel.provider === "meta_cloud" && channel.status === "connected"
        );
        const firstEvolutionChannel = nextChannels.find((channel) =>
          channel.provider === "evolution" && channel.status === "connected"
        );
        setSelectedMetaChannelId((current) => current || firstMetaChannel?.id || "");
        setSelectedMetaChannelIds((current) =>
          current.length > 0 ? current : firstMetaChannel ? [firstMetaChannel.id] : []
        );
        setSelectedEvolutionChannelIds((current) =>
          current.length > 0 ? current : firstEvolutionChannel ? [firstEvolutionChannel.id] : []
        );
        if (!firstEvolutionChannel && firstMetaChannel) {
          setSendMode("meta_cloud");
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar disparos.");
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
  const evolutionChannels = useMemo(
    () => channels.filter((channel) => channel.provider === "evolution" && channel.status === "connected"),
    [channels]
  );
  const metaChannels = useMemo(
    () => channels.filter((channel) => channel.provider === "meta_cloud" && channel.status === "connected"),
    [channels]
  );

  const audienceCount = form.audienceSource === "imported" ? form.importedRows.length : audiencePreview.length;
  const previewSample = form.audienceSource === "imported" ? form.importedRows[0] : audiencePreview[0];
  const selectedMetaTemplateText = useMemo(() => getMetaBodyText(selectedMetaTemplate), [selectedMetaTemplate]);
  const selectedMetaVariableIndexes = useMemo(
    () => extractMetaVariableIndexes(selectedMetaTemplateText),
    [selectedMetaTemplateText]
  );
  const audienceFieldOptions = useMemo(() => {
    const keys = new Set(["name", "nome", "phone", "telefone"]);
    const rows = form.audienceSource === "imported" ? form.importedRows : audiencePreview;

    rows.slice(0, 20).forEach((row) => {
      Object.keys(row.fields ?? {}).forEach((key) => {
        if (key.trim()) keys.add(key.trim());
      });
    });

    return Array.from(keys);
  }, [audiencePreview, form.audienceSource, form.importedRows]);
  const metaPreviewText = useMemo(() => (
    renderMetaTemplatePreview({
      text: selectedMetaTemplateText,
      mappings: metaVariableMappings,
      sample: previewSample,
      fallbackName: form.fallbackName
    })
  ), [form.fallbackName, metaVariableMappings, previewSample, selectedMetaTemplateText]);
  const scheduledCount = campaigns.filter((campaign) => campaign.status === "scheduled").length;
  const completedCount = campaigns.filter((campaign) => campaign.status === "completed").length;
  const sendingCount = campaigns.filter((campaign) => campaign.status === "sending").length;

  useEffect(() => {
    if (!notice) return;

    const timeout = window.setTimeout(() => setNotice(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (selectedMetaChannelIds.length === 0) {
      setSelectedMetaChannelId("");
      return;
    }

    setSelectedMetaChannelId((current) =>
      current && selectedMetaChannelIds.includes(current)
        ? current
        : selectedMetaChannelIds[0] ?? ""
    );
  }, [selectedMetaChannelIds]);

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
          setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar resultados.");
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

  function toggleSelectedChannel(channelId: string, selectedIds: string[], setSelectedIds: (value: string[]) => void) {
    setSelectedIds(
      selectedIds.includes(channelId)
        ? selectedIds.filter((current) => current !== channelId)
        : [...selectedIds, channelId]
    );
  }

  function channelLabel(channel: ChannelDto) {
    return channel.displayName || channel.phoneNumber || channel.providerKey;
  }

  function updateMetaVariableMapping(index: number, partial: Partial<MetaVariableMapping>) {
    setMetaVariableMappings((current) => current.map((mapping) =>
      mapping.index === index ? { ...mapping, ...partial } : mapping
    ));
  }

  function getIncompleteMetaVariables() {
    return metaVariableMappings.filter((mapping) =>
      mapping.mode === "fixed"
        ? !mapping.fixedValue.trim()
        : !mapping.fieldKey.trim()
    );
  }

  async function saveCampaign(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    const cleanTemplates = form.templates.map((template) => template.trim()).filter(Boolean);
    const campaignName = form.name.trim();
    if (!campaignName) {
      setError("Informe o nome do disparo.");
      setIsSaving(false);
      return null;
    }
    if (sendMode === "evolution" && cleanTemplates.length === 0) {
      setError("Escreva pelo menos uma mensagem para enviar por número não oficial.");
      setIsSaving(false);
      return null;
    }
    const metaMessageBody = metaTemplate.name.trim()
      ? `Template Meta ${metaTemplate.name.trim()}`
      : "Template Meta oficial";
    const payload = {
      name: campaignName,
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
      messageBody: sendMode === "meta_cloud" ? metaMessageBody : cleanTemplates[0] ?? "",
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
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar disparo.");
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
      setError(resolveError instanceof Error ? resolveError.message : "Não foi possível resolver audiência.");
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
      setError(sendError instanceof Error ? sendError.message : "Não foi possível simular envio.");
    } finally {
      setIsSaving(false);
    }
  }

  async function sendReal() {
    if (selectedEvolutionChannelIds.length === 0) {
      setError("Escolha pelo menos um número não oficial para enviar.");
      return;
    }

    let campaign = selectedCampaign;

    if (!campaign) {
      campaign = await saveCampaign();
    }

    if (!campaign) return;

    const shouldSend = window.confirm("Enviar mensagens reais pelo WhatsApp para esta audiência?");
    if (!shouldSend) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const result = await apiSendCampaignReal(getToken, campaign.id, selectedEvolutionChannelIds);
      const [nextCampaigns, nextRecipients] = await Promise.all([
        apiGetCampaigns(getToken),
        apiGetCampaignRecipients(getToken, campaign.id)
      ]);

      setCampaigns(nextCampaigns);
      setRecipients(nextRecipients);
      setNotice(`${result.recipientsSent ?? 0} mensagens reais enviadas. ${result.recipientsFailed ?? 0} falharam.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Não foi possível enviar campanha real.");
    } finally {
      setIsSaving(false);
    }
  }

  async function sendMetaTemplate() {
    let campaign = selectedCampaign;
    const template = {
      name: metaTemplate.name.trim(),
      language: metaTemplate.language.trim(),
      components: buildMetaTemplateComponents({
        template: selectedMetaTemplate,
        mappings: metaVariableMappings
      })
    };

    if (!selectedMetaTemplate || !template.name || !template.language) {
      setError("Escolha um template Meta aprovado da lista.");
      return;
    }

    const incompleteVariables = getIncompleteMetaVariables();
    if (incompleteVariables.length > 0) {
      setError(`Mapeie a variavel {{${incompleteVariables[0]!.index}}} antes de enviar.`);
      return;
    }

    if (selectedMetaChannelIds.length === 0) {
      setError("Escolha pelo menos um número oficial Meta para enviar.");
      return;
    }

    if (!campaign) {
      campaign = await saveCampaign();
    }

    if (!campaign) return;

    const shouldSend = window.confirm("Enviar template aprovado da Meta para esta audiência?");
    if (!shouldSend) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const result = await apiSendCampaignMetaTemplate(
        getToken,
        campaign.id,
        template,
        selectedMetaChannelIds
      );
      const [nextCampaigns, nextRecipients] = await Promise.all([
        apiGetCampaigns(getToken),
        apiGetCampaignRecipients(getToken, campaign.id)
      ]);

      setCampaigns(nextCampaigns);
      setRecipients(nextRecipients);
      setNotice(`${result.recipientsSent ?? 0} templates Meta enviados. ${result.recipientsFailed ?? 0} falharam.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Não foi possível enviar template Meta.");
    } finally {
      setIsSaving(false);
    }
  }

  async function loadMetaEvolutionTemplates() {
    if (!selectedMetaChannelId) {
      setError("Escolha um canal Meta oficial para carregar os templates.");
      return;
    }

    setIsMetaTemplatesLoading(true);
    setError(null);
    setNotice(null);

    try {
      const templates = await apiListMetaEvolutionTemplates(getToken, selectedMetaChannelId);
      setMetaTemplateOptions(templates);
      setMetaTemplatesLoaded(true);
      setSelectedMetaTemplate(null);
      setMetaVariableMappings([]);
      setNotice(
        templates.length > 0
          ? `${templates.length} templates Meta encontrados na Evolution.`
          : "A Evolution não retornou templates para esta instancia."
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar templates da Evolution.");
    } finally {
      setIsMetaTemplatesLoading(false);
    }
  }

  function useMetaTemplateOption(template: MetaTemplateOptionDto) {
    setMetaTemplate({
      name: template.name,
      language: template.language || "pt_BR"
    });
    setSelectedMetaTemplate(template);
    setMetaVariableMappings(
      extractMetaVariableIndexes(getMetaBodyText(template)).map((index) => ({
        index,
        mode: index === 1 ? "field" : "fixed",
        fieldKey: index === 1 ? "name" : "",
        fixedValue: ""
      }))
    );
    setNotice(`Template ${template.name} selecionado.`);
  }

  async function handleAudienceFile(file: File | null) {
    if (!file) return;

    setError(null);
    const rows = await parseAudienceFile(file);

    if (rows.length === 0) {
      setError("Não encontrei uma coluna de telefone/WhatsApp na planilha.");
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
          <button
            className="secondary-button"
            disabled={isSaving}
            onClick={sendMode === "meta_cloud" ? sendMetaTemplate : sendReal}
            type="button"
          >
            <Zap size={14} aria-hidden="true" />
            {sendMode === "meta_cloud" ? "Enviar Meta" : "Enviar real"}
          </button>
          <button className="primary-button" disabled={isSaving} onClick={() => void saveCampaign()} type="button">
            <Save size={14} aria-hidden="true" />
            Salvar
          </button>
        </div>
      </header>

      {error ? <p className="error-note campaign-inline-note">{error}</p> : null}
      {notice ? (
        <div className="campaign-toast" role="status" aria-live="polite">
          {notice}
        </div>
      ) : null}

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
                  <span>Board de audiência</span>
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
                    <div className="campaign-import-preview-actions">
                      <strong>{form.importedRows.length} contatos importados</strong>
                      <button
                        className="icon-button"
                        onClick={() => {
                          setForm((current) => ({ ...current, importedRows: [] }));
                          setAudiencePreview([]);
                          setNotice("Lista importada removida.");
                        }}
                        type="button"
                        aria-label="Remover lista importada"
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
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
              <h2>Números de envio</h2>
              <span>
                {sendMode === "meta_cloud"
                  ? `${selectedMetaChannelIds.length} oficiais`
                  : `${selectedEvolutionChannelIds.length} não oficiais`}
              </span>
            </div>
            <div className="segmented-control">
              <button
                className={sendMode === "evolution" ? "is-active" : ""}
                onClick={() => setSendMode("evolution")}
                type="button"
              >
                Não oficial
              </button>
              <button
                className={sendMode === "meta_cloud" ? "is-active" : ""}
                disabled={!isMetaActive}
                onClick={() => setSendMode("meta_cloud")}
                type="button"
              >
                Meta oficial
              </button>
            </div>

            {sendMode === "evolution" ? (
              evolutionChannels.length > 0 ? (
                <div className="campaign-channel-picker" aria-label="Números não oficiais">
                  {evolutionChannels.map((channel) => (
                    <label className="campaign-channel-option" key={channel.id}>
                      <input
                        checked={selectedEvolutionChannelIds.includes(channel.id)}
                        onChange={() => toggleSelectedChannel(
                          channel.id,
                          selectedEvolutionChannelIds,
                          setSelectedEvolutionChannelIds
                        )}
                        type="checkbox"
                      />
                      <span>
                        <strong>{channelLabel(channel)}</strong>
                        <small>{channel.phoneNumber ?? "Número ainda não identificado"}</small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="list-note">Conecte um canal Evolution API para enviar mensagem livre.</p>
              )
            ) : metaChannels.length > 0 ? (
              <div className="campaign-channel-picker" aria-label="Números oficiais Meta">
                {metaChannels.map((channel) => (
                  <label className="campaign-channel-option" key={channel.id}>
                    <input
                      checked={selectedMetaChannelIds.includes(channel.id)}
                      onChange={() => {
                        toggleSelectedChannel(channel.id, selectedMetaChannelIds, setSelectedMetaChannelIds);
                        setMetaTemplateOptions([]);
                        setMetaTemplatesLoaded(false);
                        setSelectedMetaTemplate(null);
                        setMetaVariableMappings([]);
                      }}
                      type="checkbox"
                    />
                    <span>
                      <strong>{channelLabel(channel)}</strong>
                      <small>{channel.phoneNumber ?? channel.providerKey}</small>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="list-note">Crie um canal Meta oficial conectado antes de enviar templates.</p>
            )}
          </section>

          {sendMode === "evolution" ? (
            <section className="campaign-builder-section">
            <div className="panel-title-row">
              <h2>Mensagens</h2>
              <span>{form.templates.filter((template) => template.trim()).length} templates</span>
            </div>
            <label className="form-field">
              <span>Nome padrão quando vier vazio</span>
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
          ) : null}

          {sendMode === "meta_cloud" && isMetaActive ? (
            <section className="campaign-builder-section">
              <div className="panel-title-row">
                <h2>Meta Cloud</h2>
                <span>{metaConnectionMode === "evolution_official" ? "Via Evolution" : "Template aprovado"}</span>
              </div>
              {metaChannels.length > 0 ? (
                <label className="form-field">
                  <span>Canal para carregar templates</span>
                  <select
                    onChange={(event) => {
                      setSelectedMetaChannelId(event.target.value);
                      setMetaTemplateOptions([]);
                      setMetaTemplatesLoaded(false);
                      setSelectedMetaTemplate(null);
                      setMetaVariableMappings([]);
                    }}
                    value={selectedMetaChannelId}
                  >
                    {metaChannels
                      .filter((channel) => selectedMetaChannelIds.includes(channel.id))
                      .map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channelLabel(channel)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="list-note">Crie um canal Meta oficial conectado antes de enviar templates.</p>
              )}
              {metaConnectionMode === "evolution_official" ? (
                <div className="meta-template-picker">
                  <div className="meta-template-picker-header">
                    <div>
                      <strong>Templates da Evolution</strong>
                      <span>Escolha um template aprovado e mapeie as variáveis antes de enviar.</span>
                    </div>
                    <button
                      className="secondary-button"
                      disabled={isMetaTemplatesLoading || selectedMetaChannelIds.length === 0}
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
                            className={selectedMetaTemplate?.id === template.id ? "primary-button" : "secondary-button"}
                            onClick={() => useMetaTemplateOption(template)}
                            type="button"
                          >
                            {selectedMetaTemplate?.id === template.id ? "Selecionado" : "Usar"}
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : metaTemplatesLoaded ? (
                    <p className="list-note">Nenhum template voltou da Evolution para esta instancia.</p>
                  ) : null}
                </div>
              ) : null}
              {selectedMetaTemplate ? (
                <div className="meta-variable-panel">
                  <div className="meta-variable-title">
                    <div>
                      <strong>{selectedMetaTemplate.name}</strong>
                      <span>{selectedMetaTemplate.language} · {selectedMetaTemplate.status}</span>
                    </div>
                    <span>{selectedMetaVariableIndexes.length} variavel{selectedMetaVariableIndexes.length !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="meta-test-message">
                    {metaPreviewText || selectedMetaTemplate.preview || "Template sem corpo de mensagem."}
                  </div>
                  {selectedMetaVariableIndexes.length > 0 ? (
                    <div className="meta-variable-list" aria-label="Mapeamento das variáveis Meta">
                      {metaVariableMappings.map((mapping) => (
                        <div className="meta-variable-row" key={mapping.index}>
                          <span className="status-badge status-badge--closed">{`{{${mapping.index}}}`}</span>
                          <select
                            onChange={(event) => updateMetaVariableMapping(mapping.index, {
                              mode: event.target.value as MetaVariableMode
                            })}
                            value={mapping.mode}
                          >
                            <option value="field">Coluna da audiência</option>
                            <option value="fixed">Valor fixo</option>
                          </select>
                          {mapping.mode === "field" ? (
                            <select
                              onChange={(event) => updateMetaVariableMapping(mapping.index, {
                                fieldKey: event.target.value
                              })}
                              value={mapping.fieldKey}
                            >
                              <option value="">Escolha uma coluna</option>
                              {audienceFieldOptions.map((fieldKey) => (
                                <option key={fieldKey} value={fieldKey}>{fieldKey}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              onChange={(event) => updateMetaVariableMapping(mapping.index, {
                                fixedValue: event.target.value
                              })}
                              placeholder="Valor enviado igual para todos"
                              value={mapping.fixedValue}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="list-note">Este template não possui variáveis numericas no corpo.</p>
                  )}
                </div>
              ) : (
                <p className="list-note">Selecione um template aprovado para liberar o envio.</p>
              )}
              <button
                className="secondary-button"
                disabled={
                  isSaving ||
                  !selectedMetaTemplate ||
                  getIncompleteMetaVariables().length > 0 ||
                  selectedMetaChannelIds.length === 0
                }
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
              {sendMode === "meta_cloud"
                ? selectedMetaTemplate
                  ? metaPreviewText || selectedMetaTemplate.preview || `Template Meta ${selectedMetaTemplate.name}`
                  : "Escolha um template Meta aprovado."
                : renderPreview(form.templates.find((template) => template.trim()) ?? "", form.fallbackName, previewSample)}
            </div>
            <dl className="campaign-summary-list">
              <div>
                <dt>Audiencia</dt>
                <dd>{form.audienceSource === "imported" ? `${form.importedRows.length} importados` : `${audiencePreview.length || "Resolver"} contatos`}</dd>
              </div>
              <div>
                <dt>Envio</dt>
                <dd>
                  {sendMode === "meta_cloud"
                    ? `${selectedMetaChannelIds.length} oficiais`
                    : `${selectedEvolutionChannelIds.length} não oficiais`}
                </dd>
              </div>
              <div>
                <dt>Duração estimada</dt>
                <dd>{estimateDuration(Math.max(audienceCount, form.importedRows.length, 1), form.cadence)}</dd>
              </div>
            </dl>
            <button className="secondary-button" disabled={isSaving} onClick={resolveAudience} type="button">
              <CalendarClock size={14} aria-hidden="true" />
              Resolver audiência
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
