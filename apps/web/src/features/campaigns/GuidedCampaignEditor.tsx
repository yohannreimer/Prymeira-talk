import { useEffect, useRef, useState } from "react";
import type { ChannelDto } from "@prymeira-talk/shared";
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, ListPlus, Pause, Play, ShieldCheck, Upload, Users } from "lucide-react";
import {
  apiActivateCampaign, apiControlCampaign, apiCreateCampaign, apiGetCampaignProgress,
  apiGetBroadcastLists, apiGetCampaigns, apiGetCampaignRecipients, apiPreviewCampaignAudience,
  apiResolveUncertainCampaignRecipient, apiUpdateCampaign, apiGetSettings, apiGetAgents,
  apiGenerateMessageVariations,
  type AiAgentDto,
  type CampaignAudiencePreviewDto, type CampaignCadenceDto, type CampaignDto,
  type CampaignProgressDto, type CampaignRecipientDto, type ContactBoardWithStagesDto, type BroadcastListDto
} from "../../app/api";
import { CampaignReview } from "./CampaignReview";
import { MessageVariations } from "./MessageVariations";
import { buildTemplates, initialVariations, missingPlaceholders } from "./message-variations";
import { BroadcastListDialog } from './BroadcastListDialog';
import { CampaignRhythm } from "./CampaignRhythm";
import { CampaignTracking } from "./CampaignTracking";
import { isDaily, withDaily } from "./campaign-rhythm";
import "./campaigns-redesign.css";

type ImportedRow = { name?: string; phone: string; fields: Record<string, string> };
type Stage = 1 | 2 | 3;
export const SAFE_CADENCE: CampaignCadenceDto = {
  minDelaySeconds: 120, maxDelaySeconds: 300, batchSize: 20,
  pauseMinSeconds: 900, pauseMaxSeconds: 1200, windowStart: "09:00", windowEnd: "20:00"
};

function localDateTime(value: string | null, timeZone: string) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(value));
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function zonedDateTimeToIso(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Escolha uma data e hora válidas.");
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]));
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const displayed = localDateTime(new Date(guess).toISOString(), timeZone);
    const actual = Date.parse(`${displayed}:00Z`);
    const difference = target - actual;
    guess += difference;
    if (difference === 0) break;
  }
  const iso = new Date(guess).toISOString();
  if (localDateTime(iso, timeZone) !== value) {
    throw new Error("Esse horário não existe no fuso selecionado. Escolha outro horário.");
  }
  return iso;
}

export function GuidedCampaignEditor(props: {
  campaign: CampaignDto | null;
  boards: ContactBoardWithStagesDto[];
  channels: ChannelDto[];
  getToken: () => Promise<string | null>;
  parseFile: (file: File) => Promise<ImportedRow[]>;
  onSaved: (campaign: CampaignDto) => void;
  onBack: () => void;
  onMeta: () => void;
}) {
  const [prospectingEnabled, setProspectingEnabled] = useState(Boolean(props.campaign?.prospectingAgentId));
  const [prospectingAgentId, setProspectingAgentId] = useState(props.campaign?.prospectingAgentId ?? "");
  const [prospectingContext, setProspectingContext] = useState(props.campaign?.prospectingContext ?? "");
  const [agents, setAgents] = useState<AiAgentDto[]>([]);
  const [moduleEnabled, setModuleEnabled] = useState(false);
  const [prospectingLoading, setProspectingLoading] = useState(true);
  const [prospectingError, setProspectingError] = useState<string | null>(null);
  const [skippedRows, setSkippedRows] = useState<CampaignRecipientDto[]>([]);
  const [current, setCurrent] = useState(props.campaign);
  const [stage, setStage] = useState<Stage>(1);
  const [name, setName] = useState(props.campaign?.name ?? "");
  const [source, setSource] = useState<'list' | "board" | "imported">(props.campaign?.audience.type ?? 'list');
  const [listId, setListId] = useState(props.campaign?.audience.type === 'list' ? props.campaign.audience.listId ?? '' : '');
  const [selectedList, setSelectedList] = useState<BroadcastListDto | null>(null);
  const [listDialogOpen, setListDialogOpen] = useState(false);
  const [boardId, setBoardId] = useState(props.campaign?.audience.boardId ?? props.boards[0]?.id ?? "");
  const [rows, setRows] = useState<ImportedRow[]>(props.campaign?.audience.rows?.map((row) =>
    ({ ...row, fields: row.fields ?? {} })) ?? []);
  const [audienceChanged, setAudienceChanged] = useState(false);
  const [channelId, setChannelId] = useState(props.channels[0]?.id ?? "");
  const [message, setMessage] = useState(props.campaign?.messageBody ?? "");
  const messageField = useRef<HTMLTextAreaElement>(null);
  const latestMessage = useRef(message);
  const [variations, setVariations] = useState<string[]>(() => initialVariations(props.campaign));
  const [generatedVariations, setGeneratedVariations] = useState<string[]>(() => initialVariations(props.campaign));
  const [variationsSource, setVariationsSource] = useState((props.campaign?.messageBody ?? "").trim());
  const [variationsBusy, setVariationsBusy] = useState(false);
  const [variationsError, setVariationsError] = useState<string | null>(null);
  const [hideFromInboxUntilReply, setHideFromInboxUntilReply] = useState(props.campaign?.hideFromInboxUntilReply ?? false);
  const [startMode, setStartMode] = useState<"now" | "scheduled">(
    props.campaign?.scheduledAt ? "scheduled" : "now");
  const [scheduledAt, setScheduledAt] = useState(localDateTime(props.campaign?.scheduledAt ?? null,
    props.campaign?.timeZone ?? "America/Sao_Paulo"));
  // A list from Leads (Base própria, Google Maps…) starts spread over days: ~40 a day on weekdays.
  const [cadence, setCadence] = useState<CampaignCadenceDto>(() => !props.campaign ? SAFE_CADENCE
    : props.campaign.status === "draft" && props.campaign.audience.origin === "leads" && !isDaily(props.campaign.cadence)
      ? withDaily(SAFE_CADENCE) : props.campaign.cadence);
  const [customizing, setCustomizing] = useState(false);
  const [timeZone, setTimeZone] = useState(props.campaign?.timeZone ?? "America/Sao_Paulo");
  const [preview, setPreview] = useState<CampaignAudiencePreviewDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [progress, setProgress] = useState<CampaignProgressDto | null>(null);
  const [uncertainRows, setUncertainRows] = useState<CampaignRecipientDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activationKey] = useState(() => crypto.randomUUID());
  const selectedChannel = props.channels.find((channel) => channel.id === channelId);
  const isActive = current?.status !== undefined && current.status !== "draft";
  const isLeadDraft = current?.audience.origin === "leads";

  const prospectingAgents = agents.filter((agent) => agent.status === "active" && agent.type === "prospecting");
  const responsibleAgent = agents.find((agent) => agent.id === prospectingAgentId);

  useEffect(() => {
    let mounted = true;
    setProspectingLoading(true); setProspectingError(null);
    void Promise.all([apiGetSettings(props.getToken), apiGetAgents(props.getToken)])
      .then(([settings, agents]) => { if (mounted) { setModuleEnabled(settings.modules?.campaignProspecting === true); setAgents(agents); } })
      .catch(() => { if (mounted) setProspectingError("Não foi possível carregar a configuração de prospecção. Atualize a página para tentar novamente."); })
      .finally(() => { if (mounted) setProspectingLoading(false); });
    return () => { mounted = false; };
  }, [props.getToken]);

  function validateProspecting() {
    if (!prospectingEnabled) return;
    if (prospectingLoading) throw new Error("Aguarde o carregamento da configuração de prospecção.");
    if (prospectingError) throw new Error(prospectingError);
    if (!moduleEnabled) throw new Error("Ative o módulo de prospecção em Configurações para acompanhar respostas com IA.");
    if (!prospectingAgents.some((agent) => agent.id === prospectingAgentId))
      throw new Error("Escolha um agente ativo de Prospecção para acompanhar as respostas.");
    if (prospectingContext.trim().length > 6000) throw new Error("O contexto da oferta deve ter até 6000 caracteres.");
  }

  function closeListDialog() {
    setListDialogOpen(false);
    if (!listId) return;
    void apiGetBroadcastLists(props.getToken).then((lists) => {
      setSelectedList(lists.find((list) => list.id === listId) ?? null);
    }).catch(() => undefined);
  }

  useEffect(() => {
    if (!listId) return;
    let active = true;
    void apiGetBroadcastLists(props.getToken).then((lists) => {
      if (active) setSelectedList(lists.find((list) => list.id === listId) ?? null);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [listId, props.getToken]);

  useEffect(() => {
    if (!current || current.status === "draft") return;
    let mounted = true;
    const load = async () => {
      try { const next = await apiGetCampaignProgress(props.getToken, current.id);
        const rows = (next.uncertain > 0 || next.skipped > 0) ? await apiGetCampaignRecipients(props.getToken, current.id) : [];
        if (mounted) { setProgress(next); setUncertainRows(rows.filter((row) => row.status === "uncertain"));
          setSkippedRows(rows.filter((row) => row.status.startsWith("skipped"))); } }
      catch { if (mounted) setError("Não foi possível atualizar o andamento da fila."); }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, [current?.id, current?.status, props.getToken]);

  const variationsStale = variations.length > 0 && message.trim() !== variationsSource;

  function updateMessage(next: string) {
    latestMessage.current = next;
    setMessage(next);
    setPreview(null);
  }
  function insertName() {
    const field = messageField.current;
    const start = field?.selectionStart ?? message.length;
    const end = field?.selectionEnd ?? message.length;
    updateMessage(`${message.slice(0, start)}{{nome}}${message.slice(end)}`);
  }
  async function generateVariations() {
    const edited = variations.some((text) => !generatedVariations.includes(text));
    if (edited && !window.confirm("Regerar vai substituir as variações atuais, incluindo as suas edições. Continuar?")) return;
    const source = message.trim();
    setVariationsBusy(true); setVariationsError(null);
    try {
      const generated = await apiGenerateMessageVariations(props.getToken, source);
      if (latestMessage.current.trim() !== source) {
        setVariationsError("A mensagem mudou enquanto as variações eram geradas. Gere novamente.");
        return;
      }
      setVariations(generated); setGeneratedVariations(generated); setVariationsSource(source);
      setPreview(null);
    } catch (cause) {
      setVariationsError(cause instanceof Error ? cause.message : "Não foi possível gerar as variações.");
    } finally { setVariationsBusy(false); }
  }

  async function saveDraft() {
    validateProspecting();
    if (!name.trim()) throw new Error("Dê um nome para este disparo.");
    if (!message.trim()) throw new Error("Escreva a mensagem antes de continuar.");
    if (variationsStale) {
      throw new Error("As variações foram geradas a partir de outra versão da mensagem. Gere novamente ou remova as variações antes de continuar.");
    }
    if (variations.some((text) => text.trim() && missingPlaceholders(message, text).length > 0)) {
      throw new Error("Há variações sem um campo da mensagem original. Corrija ou remova antes de continuar.");
    }
    const audience = source === 'list' ? { type: 'list' as const, listId }
      : source === "board" ? { type: "board" as const, boardId }
      : { type: "imported" as const, rows };
    if (source === 'list' && !listId) throw new Error('Escolha uma lista de contatos.');
    if (source === "board" && !boardId) throw new Error("Escolha um board de contatos.");
    if (source === "imported" && rows.length === 0) throw new Error("Importe uma planilha com contatos.");
    const scheduled = startMode === "scheduled" && scheduledAt
      ? zonedDateTimeToIso(scheduledAt, timeZone) : null;
    const body = { name: name.trim(), messageBody: message.trim(),
      templates: buildTemplates(message, variations), cadence, scheduledAt: scheduled, timeZone, hideFromInboxUntilReply,
      prospectingAgentId: prospectingEnabled ? prospectingAgentId : null,
      prospectingContext: prospectingEnabled ? prospectingContext.trim() || null : null };
    const saved = current
      ? await apiUpdateCampaign(props.getToken, current.id, {
          ...body, ...(audienceChanged ? { audience } : {}) })
      : await apiCreateCampaign(props.getToken, { ...body, audience });
    setCurrent(saved); props.onSaved(saved); setAudienceChanged(false);
    return saved;
  }

  async function saveOnly() {
    setBusy(true); setError(null);
    try { await saveDraft(); setNotice("Rascunho salvo. Nenhuma mensagem foi enviada."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }

  async function continueStage() {
    if (stage === 1) { if (source === 'list' && !listId) { setError('Escolha ou crie uma lista de contatos.'); return; }
      if (!channelId) { setError("Escolha o número que enviará as mensagens."); return; }
      setError(null); setStage(2); return; }
    if (isDaily(cadence) && (cadence.dailyMin ?? 0) > (cadence.dailyMax ?? 0)) {
      setError("No ritmo por dia, o mínimo precisa ser menor ou igual ao máximo."); return;
    }
    setBusy(true); setError(null);
    try {
      if (startMode === "scheduled" && (!scheduledAt ||
        new Date(zonedDateTimeToIso(scheduledAt, timeZone)) <= new Date())) {
        throw new Error("Escolha uma data e hora futuras para o agendamento.");
      }
      try { new Intl.DateTimeFormat("pt-BR", { timeZone }).format(new Date()); }
      catch { throw new Error("Informe um fuso horário válido, como America/Sao_Paulo."); }
      const saved = await saveDraft();
      const next = await apiPreviewCampaignAudience(props.getToken, saved.id, channelId, {
        startMode, scheduledAt: startMode === "scheduled" ? zonedDateTimeToIso(scheduledAt, timeZone) : null,
        timeZone
      });
      setPreview(next); setConfirmed(false); setStage(3);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível verificar os destinatários."); }
    finally { setBusy(false); }
  }

  async function activate() {
    if (!current || !preview || !confirmed || !preview.eligible.length ||
      preview.excluded.some((row) => row.reason === "verification_error") ||
      preview.unresolvedVariables.length > 0) return;
    setBusy(true); setError(null);
    try {
      validateProspecting();
      await apiActivateCampaign(props.getToken, current.id, {
        idempotencyKey: activationKey, channelId, startMode,
        scheduledAt: startMode === "scheduled" ? zonedDateTimeToIso(scheduledAt, timeZone) : null,
        timeZone, confirmation: true,
        expectedAudienceHash: preview.audienceHash
      });
      const updated = (await apiGetCampaigns(props.getToken)).find((item) => item.id === current.id);
      if (updated) { setCurrent(updated); props.onSaved(updated); }
      setProgress(await apiGetCampaignProgress(props.getToken, current.id));
      setNotice(startMode === "scheduled" ? "Envio agendado. Nenhuma mensagem saiu agora." :
        "Fila iniciada. Acompanhe o andamento abaixo.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível iniciar a fila."); }
    finally { setBusy(false); }
  }

  async function control(action: "pause" | "resume" | "cancel-remaining") {
    if (!current) return;
    setBusy(true); setError(null);
    try {
      const next = await apiControlCampaign(props.getToken, current.id, action);
      setProgress(next);
      const updated = (await apiGetCampaigns(props.getToken)).find((item) => item.id === current.id);
      if (updated) { setCurrent(updated); props.onSaved(updated); }
      setNotice(action === "pause" ? "Fila pausada. Um envio já em andamento pode terminar." :
        action === "resume" ? "Fila retomada." : "Mensagens ainda pendentes canceladas.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar a fila."); }
    finally { setBusy(false); }
  }

  async function resolveUncertain(recipientId: string, outcome: "sent" | "not_sent") {
    if (!current) return;
    const confirmed = window.confirm(outcome === "sent"
      ? "Você conferiu no WhatsApp que esta mensagem foi enviada? Essa confirmação não reenviará nada."
      : "Você conferiu no WhatsApp que esta mensagem NÃO foi enviada? Ela não será reenviada automaticamente.");
    if (!confirmed) return;
    setBusy(true); setError(null);
    try {
      const next = await apiResolveUncertainCampaignRecipient(props.getToken,
        current.id, recipientId, outcome);
      setProgress(next);
      setUncertainRows((rows) => rows.filter((row) => row.id !== recipientId));
      const updated = (await apiGetCampaigns(props.getToken)).find((item) => item.id === current.id);
      if (updated) { setCurrent(updated); props.onSaved(updated); }
      setNotice("Revisão registrada. Nenhuma mensagem foi reenviada.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registrar a revisão."); }
    finally { setBusy(false); }
  }

  const audienceSize = isLeadDraft || source === "imported" ? rows.length || null
    : source === "list" ? selectedList?.memberCount ?? null : null;
  const startLabel = preview?.effectiveStartAt
    ? `${new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeStyle: "short", timeZone })
      .format(new Date(preview.effectiveStartAt))} (${timeZone})`
    : startMode === "now" ? `Assim que confirmar, dentro do horário permitido (${timeZone})` :
      scheduledAt ? `${scheduledAt.replace("T", " ")} (${timeZone})` : "Ainda não definido";
  const canActivate = stage === 3 && !!preview && preview.eligible.length > 0 && confirmed &&
    !busy && preview.unresolvedVariables.length === 0 &&
    !preview.excluded.some((row) => row.reason === "verification_error");

  return <section className="module-page campaigns-page guided-campaign" aria-label="Disparo guiado">
    <header className="module-header guided-campaign-header"><div>
      <button type="button" className="secondary-button" onClick={props.onBack}>Voltar para disparos</button>
      <p className="eyebrow">DISPARO PELO WHATSAPP</p>
      <h1>{isActive ? current?.name : "Preparar disparo"}</h1>
      <p>Confira cada etapa. Salvar um rascunho não envia mensagens.</p>
    </div>{!isActive && <button type="button" className="secondary-button" onClick={props.onMeta}>Usar Meta oficial</button>}</header>
    {error && <p role="alert" className="error-note campaign-inline-note">{error}</p>}
    {prospectingError && <p role="alert" className="error-note campaign-inline-note">{prospectingError}</p>}
    {notice && <p role="status" className="campaign-toast">{notice}</p>}
    {isActive ? <div className="guided-campaign-panel">
      <div className="guided-campaign-panel-heading"><div><span className="guided-campaign-kicker">ACOMPANHAMENTO</span>
        <h2>{progress?.status === "paused" ? "Fila pausada" : progress?.status === "needs_attention"
          ? "Ação humana necessária" : progress?.status === "completed" ? "Envio concluído" :
          progress?.status === "canceled" ? "Envios restantes cancelados" : "Mensagens em andamento"}</h2></div>
        <ShieldCheck aria-hidden="true" size={26} /></div>
      {current?.prospectingAgentId && <dl className="campaign-review-details">
        <div><dt>Agente responsável</dt><dd>{responsibleAgent?.name ?? "Agente associado"}</dd></div>
        {current.prospectingContext && <div><dt>Contexto da oferta</dt><dd>{current.prospectingContext}</dd></div>}
      </dl>}
      <p className="campaign-guidance-note">Pausar, cancelar os envios restantes ou concluir este disparo não encerra as conversas em andamento.</p>
      {progress && <><div className="campaign-review-summary">
        <div><strong>{progress.total}</strong><span>na fila</span></div>
        <div className="is-ready"><strong>{progress.sent}</strong><span>enviadas</span></div>
        <div><strong>{progress.pending}</strong><span>pendentes</span></div>
        <div><strong>{progress.skipped + progress.failed + progress.uncertain}</strong><span>precisam atenção</span></div>
      </div><p className="campaign-guidance-note">{progress.nextScheduledAt ?
        `Próxima tentativa prevista: ${new Date(progress.nextScheduledAt).toLocaleString("pt-BR")}.` :
        "Não há próxima tentativa agendada."} {progress.uncertain > 0 &&
        `${progress.uncertain} envio com resultado incerto: confira no WhatsApp antes de qualquer nova ação.`}</p>
        <CampaignTracking progress={progress} /></>}
      {skippedRows.length > 0 && <div className="guided-campaign-uncertain"><h3>Contatos ignorados</h3>
        {skippedRows.map((row) => <div className="guided-campaign-uncertain-row" key={row.id}>
          <strong>{row.contactName || "Contato"}</strong><span>{row.contactPhone}</span>
          <p>{row.status === "skipped_in_service" ? "Contato já está em atendimento. " : ""}{row.skipReason || row.errorMessage || "Contato indisponível para este envio."}</p>
        </div>)}
      </div>}
      {uncertainRows.length > 0 && <div className="guided-campaign-uncertain"><h3>Confira no WhatsApp antes de continuar</h3>
        <p>O sistema não recebeu confirmação destes envios. Não vamos tentar de novo automaticamente.</p>
        {uncertainRows.map((row) => <div className="guided-campaign-uncertain-row" key={row.id}>
          <strong>{row.contactName || (typeof row.contactSnapshot === "object" && row.contactSnapshot !== null &&
            "name" in row.contactSnapshot ? String(row.contactSnapshot.name || "Contato") : "Contato")}</strong>
          <span>{row.contactPhone || (typeof row.contactSnapshot === "object" && row.contactSnapshot !== null &&
            "phone" in row.contactSnapshot ? String(row.contactSnapshot.phone || "") : "")}</span>
          <div><button type="button" className="secondary-button" disabled={busy}
            onClick={() => void resolveUncertain(row.id, "sent")}>Confirmei: foi enviada</button>
            <button type="button" className="secondary-button" disabled={busy}
              onClick={() => void resolveUncertain(row.id, "not_sent")}>Confirmei: não foi enviada</button></div>
        </div>)}
      </div>}
      <div className="guided-campaign-actions">
        {(progress?.status === "scheduled" || progress?.status === "sending") &&
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void control("pause")}><Pause size={16} /> Pausar fila</button>}
        {progress?.status === "paused" && <button type="button" className="primary-button" disabled={busy}
          onClick={() => void control("resume")}><Play size={16} /> Retomar fila</button>}
        {progress && ["scheduled", "sending", "paused", "needs_attention"].includes(progress.status) &&
          <button type="button" className="secondary-button" disabled={busy}
            onClick={() => void control("cancel-remaining")}>Cancelar mensagens pendentes</button>}
      </div></div> : <>
      <nav className="guided-campaign-steps" aria-label="Etapas do disparo">{([
        [1, "Destinatários"], [2, "Mensagem e horário"], [3, "Revisar e enviar"]
      ] as Array<[Stage, string]>).map(([number, title]) => <span key={number} className={stage === number ? "is-current" :
        stage > number ? "is-done" : ""}><b>{stage > number ? "✓" : number}</b>{title}</span>)}</nav>
      <div className="guided-campaign-panel">
      {stage === 1 && <><div className="guided-campaign-panel-heading"><div><span className="guided-campaign-kicker">ETAPA 1 DE 3</span>
        <h2>Quem vai receber?</h2><p>Escolha a lista e o número que fará o envio.</p></div></div>
        <label className="form-field"><span>Nome do disparo</span><input value={name}
          onChange={(event) => setName(event.target.value)} placeholder="Ex.: Academias de Joinville" /></label>
        {isLeadDraft ? <div className="guided-campaign-source"><CheckCircle2 size={20} />
          <div><strong>Lista vinda de Leads</strong><span>{current?.audience.selectedCount ?? rows.length} selecionados originalmente · {rows.length} importados para o rascunho</span></div></div>
          : source === 'list' ? <div className="guided-campaign-list-choice"><div className="guided-campaign-list-icon"><Users size={22} /></div><div><span>CONTATOS</span><strong>{selectedList?.name || 'Sua lista de transmissão'}</strong><small>{selectedList ? `${selectedList.memberCount} ${selectedList.memberCount === 1 ? 'contato salvo' : 'contatos salvos'} · reutilize em outros disparos` : 'Crie ou escolha uma lista para este disparo'}</small></div><button type="button" className="secondary-button" onClick={() => setListDialogOpen(true)}><ListPlus size={17} /> {selectedList ? 'Ver e editar lista' : 'Escolher contatos'}</button></div>
          : <><div className="guided-campaign-source-choice"><label><input type="radio" checked={source === "board"}
              onChange={() => { setSource("board"); setAudienceChanged(true); }} /> Contatos do CRM</label>
            <label><input type="radio" checked={source === "imported"}
              onChange={() => { setSource("imported"); setAudienceChanged(true); }} /> Planilha Excel/CSV</label></div><button type="button" className="guided-campaign-switch-list" onClick={() => { setSource('list'); setAudienceChanged(true); setListDialogOpen(true); }}>Usar uma lista de contatos reutilizável</button></>}
        {!isLeadDraft && source === "board" && <label className="form-field"><span>Board de contatos</span>
          <select value={boardId} onChange={(event) => { setBoardId(event.target.value); setAudienceChanged(true); }}>
            <option value="">Selecione</option>{props.boards.map((board) => <option value={board.id} key={board.id}>{board.name}</option>)}
          </select></label>}
        {!isLeadDraft && source === "imported" && <label className="guided-campaign-upload"><Upload size={20} />
          <span>{rows.length ? `${rows.length} contatos na planilha` : "Escolher planilha Excel/CSV"}</span>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={async (event) => {
            const file = event.target.files?.[0]; if (!file) return;
            try { setRows(await props.parseFile(file)); setAudienceChanged(true); }
            catch { setError("Não foi possível ler a planilha."); }
          }} /></label>}
        <label className="form-field"><span>Número que enviará as mensagens</span>
          <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
            <option value="">Selecione um número conectado</option>{props.channels.map((channel) =>
              <option value={channel.id} key={channel.id}>{channel.displayName || channel.phoneNumber || channel.providerKey}</option>)}</select></label>
        <p className="campaign-guidance-note">Na próxima etapa, vamos verificar novamente quais números têm WhatsApp. Nenhuma mensagem será enviada agora.</p>
      </>}
      {stage === 2 && <><div className="guided-campaign-panel-heading"><div><span className="guided-campaign-kicker">ETAPA 2 DE 3</span>
        <h2>O que enviar e quando?</h2><p>Escreva a mensagem e escolha o início.</p></div><Clock3 size={26} /></div>
        <label className="form-field"><span>Mensagem</span><textarea rows={7} value={message} ref={messageField}
          onChange={(event) => updateMessage(event.target.value)} maxLength={2000}
          placeholder="Olá {{nome}}, tudo bem?" /></label>
        <div className="message-name-helper">
          <button type="button" className="secondary-button" onClick={insertName}>Inserir nome</button>
          <small>O nome só é usado quando o contato é uma pessoa. Empresas ficam sem nome (ex.: "Olá, tudo bem?").</small>
        </div>
        <MessageVariations message={message} variations={variations} busy={variationsBusy}
          error={variationsError} stale={variationsStale} onGenerate={() => void generateVariations()}
          onChange={(index, value) => { setVariations(variations.map((text, i) => i === index ? value : text)); setPreview(null); }}
          onRemove={(index) => { setVariations(variations.filter((_, i) => i !== index)); setPreview(null); }} />
        <div className="module-form">
          <label className="guided-campaign-hidden-option"><input type="checkbox" checked={prospectingEnabled}
            disabled={prospectingLoading || !!prospectingError || (!moduleEnabled && !prospectingEnabled)}
            onChange={(event) => { setProspectingEnabled(event.target.checked); setPreview(null); }} />
            <span><strong>Acompanhar respostas com IA</strong>
              <small>Após o contato responder, o agente de Prospecção acompanha a conversa e passa para o time conforme o critério configurado.</small></span></label>
          {prospectingLoading && <p role="status" className="campaign-guidance-note">Carregando agentes e módulos...</p>}
          {!prospectingLoading && !prospectingError && !moduleEnabled && <p className="campaign-guidance-note">O módulo está desativado. <a href="?module=ajustes#settings-modules">Ativar em Configurações</a>.</p>}
          {prospectingEnabled && <>
            <label className="form-field"><span>Agente de Prospecção</span><select required value={prospectingAgentId}
              disabled={prospectingLoading || !moduleEnabled || !!prospectingError}
              onChange={(event) => { setProspectingAgentId(event.target.value); setPreview(null); }}>
              <option value="">Escolha um agente ativo</option>
              {prospectingAgentId && !prospectingAgents.some((agent) => agent.id === prospectingAgentId) &&
                <option value={prospectingAgentId}>{responsibleAgent?.name ?? "Agente salvo"} (indisponível)</option>}
              {prospectingAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
            </select><small>Prepare agentes em <a href="?module=ia">Agentes</a>. Somente agentes ativos do tipo Prospecção podem acompanhar respostas.</small></label>
            <label className="form-field"><span>Contexto da oferta (opcional)</span><textarea rows={4} maxLength={6000}
              value={prospectingContext} onChange={(event) => { setProspectingContext(event.target.value); setPreview(null); }}
              placeholder="Descreva a oferta deste disparo para orientar o agente." /></label>
          </>}
        </div>
        <label className="guided-campaign-hidden-option"><input type="checkbox" checked={hideFromInboxUntilReply}
          onChange={(event) => setHideFromInboxUntilReply(event.target.checked)} /><span><strong>Não mover conversas por causa deste disparo</strong>
          <small>Conversas já visíveis ficam na mesma posição, com a nova mensagem no card. Contatos novos aparecem na busca e entram na caixa quando responderem.</small></span></label>
        <div className="guided-campaign-source-choice"><label><input type="radio" checked={startMode === "now"}
          onChange={() => setStartMode("now")} /> Iniciar após minha confirmação</label>
          <label><input type="radio" checked={startMode === "scheduled"}
            onChange={() => setStartMode("scheduled")} /> Agendar para outro horário</label></div>
        {startMode === "scheduled" && <label className="form-field"><span>Data e hora de início</span>
          <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /></label>}
        <label className="form-field"><span>Fuso horário dos envios</span>
          <input list="campaign-time-zones" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} />
          <datalist id="campaign-time-zones"><option value="America/Sao_Paulo" /><option value="America/Manaus" />
            <option value="America/Recife" /><option value="America/Cuiaba" /><option value="America/Rio_Branco" /></datalist></label>
        <CampaignRhythm cadence={cadence} onChange={(next) => { setCadence(next); setPreview(null); }}
          audienceSize={audienceSize} start={startMode === "scheduled" && scheduledAt ? new Date(scheduledAt) : new Date()}
          sameDay={<>
        <div className="guided-campaign-safety"><ShieldCheck size={22} /><div><strong>Ritmo padrão moderado</strong>
          <span>Intervalos variados de 2 a 5 minutos; pausa variada de 15 a 20 minutos a cada 20 tentativas; envios apenas das 9h às 20h. Isso reduz o volume, mas não garante proteção contra bloqueios.</span></div></div>
        <div className="guided-campaign-cadence-actions"><button type="button" className="secondary-button"
          onClick={() => { setCadence(SAFE_CADENCE); setCustomizing(false); }}>Usar padrão moderado</button>
          <button type="button" className="secondary-button" onClick={() => setCustomizing((value) => !value)}>
            {customizing ? "Ocultar personalização" : "Personalizar ritmo"}</button></div>
        {customizing && <div className="guided-campaign-custom-cadence">
          {([
            ["minDelaySeconds", "Intervalo mínimo (segundos)"],
            ["maxDelaySeconds", "Intervalo máximo (segundos)"],
            ["batchSize", "Pausar após quantas tentativas"],
            ["pauseMinSeconds", "Pausa mínima (segundos)"],
            ["pauseMaxSeconds", "Pausa máxima (segundos)"]
          ] as Array<["minDelaySeconds" | "maxDelaySeconds" | "batchSize" | "pauseMinSeconds" | "pauseMaxSeconds", string]>).map(([key, label]) => <label className="form-field" key={key}>
            <span>{label}</span><input type="number" min={0} step={1} value={cadence[key] ?? 0}
              onChange={(event) => setCadence((value) => ({ ...value, [key]: Number(event.target.value) }))} />
          </label>)}
          <label className="form-field"><span>Janela: início</span><input type="time" value={cadence.windowStart ?? "09:00"}
            onChange={(event) => setCadence((value) => ({ ...value, windowStart: event.target.value }))} /></label>
          <label className="form-field"><span>Janela: fim</span><input type="time" value={cadence.windowEnd ?? "20:00"}
            onChange={(event) => setCadence((value) => ({ ...value, windowEnd: event.target.value }))} /></label>
        </div>}
        {(cadence.minDelaySeconds !== 120 || cadence.maxDelaySeconds !== 300 || cadence.batchSize !== 20 ||
          cadence.pauseMinSeconds !== 900 || cadence.pauseMaxSeconds !== 1200 ||
          cadence.windowEnd !== "20:00") && !customizing && <p className="campaign-guidance-note">Este rascunho usa ritmo personalizado. Revise os valores ou escolha o padrão moderado.</p>}
          </>} />
      </>}
      {stage === 3 && preview && <><div className="guided-campaign-panel-heading"><div><span className="guided-campaign-kicker">ETAPA 3 DE 3</span>
        <h2>Revise antes de confirmar</h2><p>Somente os números com WhatsApp confirmado entrarão na fila.</p></div></div>
        {hideFromInboxUntilReply ? <p className="campaign-guidance-note">Modo discreto: conversas atuais não mudam de posição; conversas novas entram na caixa após uma resposta.</p> : null}
        <CampaignReview preview={preview} message={message} channelName={selectedChannel?.displayName ||
          selectedChannel?.phoneNumber || "Canal selecionado"} startLabel={startLabel} cadence={cadence}
          prospectingAgentName={prospectingEnabled ? responsibleAgent?.name : undefined}
          prospectingContext={prospectingEnabled ? prospectingContext : undefined}
          confirmed={confirmed} onConfirmedChange={setConfirmed} />
        {preview.excluded.some((row) => row.reason === "verification_error") && <p role="alert" className="error-note">
          A verificação falhou para alguns números. Verifique novamente antes de ativar.</p>}
        {preview.unresolvedVariables.length > 0 && <p role="alert" className="error-note">
          Estas variáveis não têm valor para todos os destinatários: {preview.unresolvedVariables.join(", ")}. Corrija a mensagem antes de ativar.</p>}
      </>}
      <div className="guided-campaign-actions">
        {stage > 1 && <button type="button" className="secondary-button" onClick={() => setStage((stage - 1) as Stage)}><ArrowLeft size={16} /> Voltar</button>}
        {stage < 3 && <button type="button" className="primary-button" disabled={busy} onClick={() => void continueStage()}>
          {stage === 1 ? "Continuar para mensagem" : "Verificar destinatários"} <ArrowRight size={16} /></button>}
        {stage === 3 && <><button type="button" className="secondary-button" disabled={busy}
          onClick={() => void continueStage()}>Verificar novamente</button>
          <button type="button" className="primary-button" disabled={!canActivate} onClick={() => void activate()}>
            {startMode === "scheduled" ? `Agendar ${preview?.eligible.length ?? 0} mensagens` :
              `Iniciar envio para ${preview?.eligible.length ?? 0} contatos`}</button></>}
        {(stage > 1 || message.trim()) && <button type="button" className="secondary-button"
          disabled={busy} onClick={() => void saveOnly()}>Salvar rascunho</button>}
      </div></div></>}
    {listDialogOpen ? <BroadcastListDialog initialListId={listId || null} getToken={props.getToken} onClose={closeListDialog} onSelected={(list) => { setListId(list.id); setSelectedList(list); setSource('list'); setAudienceChanged(true); setPreview(null); setListDialogOpen(false); }} /> : null}
  </section>;
}
