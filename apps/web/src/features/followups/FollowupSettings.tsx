import type { ChannelDto, ChannelFollowupConfig } from "@prymeira-talk/shared";
import { useEffect, useState } from "react";
import {
  apiGetChannelFollowupConfig,
  apiGetChannels,
  apiGetCurrentTalkUser,
  apiSetChannelFollowupConfig
} from "../../app/api";

type Unit = "minutes" | "hours" | "days";
type StepDraft = { value: string; unit: Unit };
const multiplier: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
const weekdays = [
  { value: 1, label: "Seg" }, { value: 2, label: "Ter" }, { value: 3, label: "Qua" },
  { value: 4, label: "Qui" }, { value: 5, label: "Sex" }, { value: 6, label: "Sáb" },
  { value: 0, label: "Dom" }
];

function toDraft(minutes: number): StepDraft {
  if (minutes % 1440 === 0) return { value: String(minutes / 1440), unit: "days" };
  if (minutes % 60 === 0) return { value: String(minutes / 60), unit: "hours" };
  return { value: String(minutes), unit: "minutes" };
}

export function FollowupSettings({ getToken }: { getToken: () => Promise<string | null> }) {
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [channelId, setChannelId] = useState("");
  const [config, setConfig] = useState<ChannelFollowupConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<ChannelFollowupConfig | null>(null);
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [customized, setCustomized] = useState(false);
  const [manager, setManager] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([apiGetChannels(getToken), apiGetCurrentTalkUser(getToken)]).then(([list, user]) => {
      if (!active) return;
      setChannels(list);
      setChannelId(list[0]?.id ?? "");
      setManager(user.role !== "agent");
      setLoading(false);
    }).catch((error) => {
      if (active) { setMessage(error instanceof Error ? error.message : "Falha ao carregar canais."); setLoading(false); }
    });
    return () => { active = false; };
  }, [getToken]);

  useEffect(() => {
    if (!channelId) return;
    let active = true;
    setLoading(true);
    setMessage(null);
    apiGetChannelFollowupConfig(getToken, channelId).then((result) => {
      if (!active) return;
      setConfig(result.config);
      setSavedConfig(result.config);
      setSteps(result.config.steps.map((step) => toDraft(step.afterMinutes)));
      setCustomized(result.customized);
      setLoading(false);
    }).catch((error) => {
      if (active) { setMessage(error instanceof Error ? error.message : "Falha ao carregar configuração."); setLoading(false); }
    });
    return () => { active = false; };
  }, [channelId, getToken]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !channelId) return;
    const minutes = steps.map((step) => Math.round(Number(step.value) * multiplier[step.unit]));
    if (minutes.some((value) => !Number.isInteger(value) || value < 1 || value > 43_200)) {
      setMessage("Use intervalos entre 1 minuto e 30 dias.");
      return;
    }
    const nextConfig = { ...config, steps: minutes.map((afterMinutes) => ({ afterMinutes })) };
    setSaving(true);
    setMessage(null);
    try {
      const result = await apiSetChannelFollowupConfig(getToken, channelId, nextConfig);
      setConfig(result.config);
      setSavedConfig(result.config);
      setSteps(result.config.steps.map((step) => toDraft(step.afterMinutes)));
      setCustomized(true);
      setMessage("Configuração salva para este número. Novas sequências usam os intervalos escolhidos.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    if (!savedConfig || !channelId || !manager) return;
    const enabled = !savedConfig.enabled;
    setSaving(true);
    setMessage(null);
    try {
      const result = await apiSetChannelFollowupConfig(getToken, channelId, { ...savedConfig, enabled });
      setSavedConfig(result.config);
      setConfig((current) => current ? { ...current, enabled: result.config.enabled } : result.config);
      setCustomized(true);
      setMessage(enabled
        ? "Follow-ups reativados neste número. Novas conversas poderão iniciar sequências."
        : "Follow-ups pausados neste número. Os pendentes foram cancelados; os intervalos foram preservados.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível alterar o status.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="followups-settings">
    <div className="followups-settings-heading">
      <h2>Configuração por número</h2>
      <p>Os intervalos começam após cada tentativa enviada. Se o horário cair fora do atendimento, a tentativa espera a próxima abertura.</p>
    </div>
    <label className="followups-settings-field">Número de WhatsApp
      <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
        {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.displayName ?? channel.phoneNumber ?? channel.providerKey} {channel.phoneNumber ? `· ${channel.phoneNumber}` : ""}</option>)}
      </select>
    </label>
    {!channels.length && !loading ? <p>Nenhum número disponível.</p> : null}
    {loading ? <p>Carregando configuração…</p> : null}
    {config && !loading ? <form onSubmit={(event) => void save(event)}>
      <div className="followups-settings-field">
        <strong>{savedConfig?.enabled ? "Follow-ups ativos" : "Follow-ups pausados"}</strong>
        <p className="followups-settings-caption">Ao pausar, os pendentes deste número são cancelados. Reativar mantém os intervalos e vale para novas conversas.</p>
        {manager ? <button className="followups-button" type="button" disabled={saving || !savedConfig} onClick={() => void toggleEnabled()}>{savedConfig?.enabled ? "Pausar neste número" : "Reativar neste número"}</button> : null}
      </div>
      <p className="followups-settings-caption">{customized ? "Cadência personalizada configurada neste número." : "Sugestão de seis etapas. Salve para ativá-la neste número."}</p>
      <h3>Intervalos entre tentativas</h3>
      <div className="followups-settings-steps">
        {steps.map((step, index) => <div className="followups-settings-step" key={index}>
          <strong>{index + 1}ª tentativa</strong>
          <input aria-label={`Intervalo da tentativa ${index + 1}`} type="number" min="1" step="any" value={step.value} disabled={!manager || saving}
            onChange={(event) => setSteps((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} />
          <select aria-label={`Unidade da tentativa ${index + 1}`} value={step.unit} disabled={!manager || saving}
            onChange={(event) => setSteps((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, unit: event.target.value as Unit } : item))}>
            <option value="minutes">minutos</option><option value="hours">horas</option><option value="days">dias</option>
          </select>
          {manager ? <button type="button" disabled={saving || steps.length === 1} onClick={() => setSteps((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remover</button> : null}
        </div>)}
      </div>
      {manager ? <button type="button" disabled={saving || steps.length >= 10} onClick={() => setSteps((current) => [...current, { value: "1", unit: "days" }])}>Adicionar tentativa</button> : null}
      <h3>Horário permitido</h3>
      <div className="followups-settings-days">
        {weekdays.map((day) => <label key={day.value}><input type="checkbox" checked={config.businessDays.includes(day.value)} disabled={!manager || saving}
          onChange={(event) => setConfig((current) => current ? { ...current, businessDays: event.target.checked ? [...current.businessDays, day.value].sort() : current.businessDays.filter((value) => value !== day.value) } : current)} />{day.label}</label>)}
      </div>
      <div className="followups-settings-hours">
        <label>A partir de <input type="time" value={config.businessHours.start} disabled={!manager || saving} onChange={(event) => setConfig((current) => current ? { ...current, businessHours: { ...current.businessHours, start: event.target.value } } : current)} /></label>
        <label>Até <input type="time" value={config.businessHours.end} disabled={!manager || saving} onChange={(event) => setConfig((current) => current ? { ...current, businessHours: { ...current.businessHours, end: event.target.value } } : current)} /></label>
      </div>
      <h3>Envio dos follow-ups deste número</h3>
      <label className="followups-settings-field">Modo de envio
        <select value={config.humanCommercialDelivery} disabled={!manager || saving} onChange={(event) => setConfig((current) => current ? { ...current, humanCommercialDelivery: event.target.value as ChannelFollowupConfig["humanCommercialDelivery"] } : current)}>
          <option value="review">Criar rascunho para aprovação antes de enviar</option>
          <option value="automatic">Permitir envio automático quando a análise considerar seguro</option>
        </select>
      </label>
      <p className="followups-settings-caption">O modo de envio vale para todos os follow-ups deste número, inclusive os de qualificação da IA. Sem autorização de envio automático, cada mensagem fica para revisão. Uma resposta do cliente interrompe a sequência. Recusas e conversas encerradas não recebem novos lembretes. A análise pode pedir revisão mesmo com envio automático liberado.</p>
      {manager ? <button className="followups-button followups-button-primary" type="submit" disabled={saving || config.businessDays.length === 0}>{saving ? "Salvando…" : "Salvar configuração"}</button> : <p>Somente gestores podem alterar esta configuração.</p>}
    </form> : null}
    {message ? <p role="status" className="followups-settings-message">{message}</p> : null}
  </div>;
}
