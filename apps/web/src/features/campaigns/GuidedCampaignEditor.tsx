import { useEffect, useState } from "react";
import type { ChannelDto } from "@prymeira-talk/shared";
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, Pause, Play, ShieldCheck, Upload } from "lucide-react";
import {
  apiActivateCampaign, apiControlCampaign, apiCreateCampaign, apiGetCampaignProgress,
  apiGetCampaigns, apiGetCampaignRecipients, apiPreviewCampaignAudience,
  apiResolveUncertainCampaignRecipient, apiUpdateCampaign,
  type CampaignAudiencePreviewDto, type CampaignCadenceDto, type CampaignDto,
  type CampaignProgressDto, type CampaignRecipientDto, type ContactBoardWithStagesDto
} from "../../app/api";
import { CampaignReview } from "./CampaignReview";

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
  const [current, setCurrent] = useState(props.campaign);
  const [stage, setStage] = useState<Stage>(1);
  const [name, setName] = useState(props.campaign?.name ?? "");
  const [source, setSource] = useState<"board" | "imported">(props.campaign?.audience.type ?? "board");
  const [boardId, setBoardId] = useState(props.campaign?.audience.boardId ?? props.boards[0]?.id ?? "");
  const [rows, setRows] = useState<ImportedRow[]>(props.campaign?.audience.rows?.map((row) =>
    ({ ...row, fields: row.fields ?? {} })) ?? []);
  const [audienceChanged, setAudienceChanged] = useState(false);
  const [channelId, setChannelId] = useState(props.channels[0]?.id ?? "");
  const [message, setMessage] = useState(props.campaign?.messageBody ?? "");
  const [startMode, setStartMode] = useState<"now" | "scheduled">(
    props.campaign?.scheduledAt ? "scheduled" : "now");
  const [scheduledAt, setScheduledAt] = useState(localDateTime(props.campaign?.scheduledAt ?? null,
    props.campaign?.timeZone ?? "America/Sao_Paulo"));
  const [cadence, setCadence] = useState<CampaignCadenceDto>(props.campaign
    ? props.campaign.cadence : SAFE_CADENCE);
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

  useEffect(() => {
    if (!current || current.status === "draft") return;
    let mounted = true;
    const load = async () => {
      try { const next = await apiGetCampaignProgress(props.getToken, current.id);
        const rows = next.uncertain > 0 ? await apiGetCampaignRecipients(props.getToken, current.id) : [];
        if (mounted) { setProgress(next); setUncertainRows(rows.filter((row) => row.status === "uncertain")); } }
      catch { if (mounted) setError("Não foi possível atualizar o andamento da fila."); }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, [current?.id, current?.status, props.getToken]);

  async function saveDraft() {
    if (!name.trim()) throw new Error("Dê um nome para este disparo.");
    if (!message.trim()) throw new Error("Escreva a mensagem antes de continuar.");
    const audience = source === "board"
      ? { type: "board" as const, boardId }
      : { type: "imported" as const, rows };
    if (source === "board" && !boardId) throw new Error("Escolha um board de contatos.");
    if (source === "imported" && rows.length === 0) throw new Error("Importe uma planilha com contatos.");
    const scheduled = startMode === "scheduled" && scheduledAt
      ? zonedDateTimeToIso(scheduledAt, timeZone) : null;
    const body = { name: name.trim(), messageBody: message.trim(),
      templates: [message.trim()], cadence, scheduledAt: scheduled, timeZone };
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
    if (stage === 1) { if (!channelId) { setError("Escolha o número que enviará as mensagens."); return; }
      setError(null); setStage(2); return; }
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
    {notice && <p role="status" className="campaign-toast">{notice}</p>}
    {isActive ? <div className="guided-campaign-panel">
      <div className="guided-campaign-panel-heading"><div><span className="guided-campaign-kicker">ACOMPANHAMENTO</span>
        <h2>{progress?.status === "paused" ? "Fila pausada" : progress?.status === "needs_attention"
          ? "Ação humana necessária" : progress?.status === "completed" ? "Envio concluído" :
          progress?.status === "canceled" ? "Envios restantes cancelados" : "Mensagens em andamento"}</h2></div>
        <ShieldCheck aria-hidden="true" size={26} /></div>
      {progress && <><div className="campaign-review-summary">
        <div><strong>{progress.total}</strong><span>na fila</span></div>
        <div className="is-ready"><strong>{progress.sent}</strong><span>enviadas</span></div>
        <div><strong>{progress.pending}</strong><span>pendentes</span></div>
        <div><strong>{progress.skipped + progress.failed + progress.uncertain}</strong><span>precisam atenção</span></div>
      </div><p className="campaign-guidance-note">{progress.nextScheduledAt ?
        `Próxima tentativa prevista: ${new Date(progress.nextScheduledAt).toLocaleString("pt-BR")}.` :
        "Não há próxima tentativa agendada."} {progress.uncertain > 0 &&
        `${progress.uncertain} envio com resultado incerto: confira no WhatsApp antes de qualquer nova ação.`}</p></>}
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
          : <div className="guided-campaign-source-choice"><label><input type="radio" checked={source === "board"}
              onChange={() => { setSource("board"); setAudienceChanged(true); }} /> Contatos do CRM</label>
            <label><input type="radio" checked={source === "imported"}
              onChange={() => { setSource("imported"); setAudienceChanged(true); }} /> Planilha Excel/CSV</label></div>}
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
        <label className="form-field"><span>Mensagem</span><textarea rows={7} value={message}
          onChange={(event) => { setMessage(event.target.value); setPreview(null); }} maxLength={2000}
          placeholder="Olá {{nome}}, tudo bem?" /></label>
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
          ] as Array<[keyof CampaignCadenceDto, string]>).map(([key, label]) => <label className="form-field" key={key}>
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
      </>}
      {stage === 3 && preview && <><div className="guided-campaign-panel-heading"><div><span className="guided-campaign-kicker">ETAPA 3 DE 3</span>
        <h2>Revise antes de confirmar</h2><p>Somente os números com WhatsApp confirmado entrarão na fila.</p></div></div>
        <CampaignReview preview={preview} message={message} channelName={selectedChannel?.displayName ||
          selectedChannel?.phoneNumber || "Canal selecionado"} startLabel={startLabel} cadence={cadence}
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
  </section>;
}
