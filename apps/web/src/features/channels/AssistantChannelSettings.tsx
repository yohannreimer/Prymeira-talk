import { useEffect, useState } from 'react';
import type { AiAgentDto, AssistantChannelSettings as Settings } from '@prymeira-talk/shared';
import { apiGetAgents, apiGetAssistantChannelSettings, apiGetCurrentTalkUser, apiSetAssistantChannelSettings } from '../../app/api';

export function AssistantChannelSettings({ channelId, getToken }: { channelId: string; getToken: () => Promise<string | null> }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [agents, setAgents] = useState<AiAgentDto[]>([]);
  const [manager, setManager] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([apiGetAssistantChannelSettings(channelId, getToken), apiGetCurrentTalkUser(getToken), apiGetAgents(getToken)]).then(([config, user, list]) => { if (active) { setSettings(config); setManager(user.role !== 'agent'); setAgents(list); } }).catch(e => { if (active) setNotice(e.message); });
    return () => { active = false; };
  }, [channelId, getToken]);
  if (!settings) return <p className="assistant-caption">{notice ?? 'Carregando configuração do apoio…'}</p>;
  return <form className="assistant-channel-settings" onSubmit={async e => { e.preventDefault(); setBusy(true); setNotice(null); try { setSettings(await apiSetAssistantChannelSettings(channelId, settings, getToken)); setNotice('Configuração salva. Nenhuma mensagem foi enviada.'); } catch (err) { setNotice(err instanceof Error ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); } }}>
    <div><h3>IA de apoio</h3><p>Prepara o texto. O vendedor revisa e envia.</p></div>
    <label>Modo<select aria-label="Modo" disabled={!manager || busy} value={settings.mode} onChange={e => setSettings({ ...settings, mode: e.target.value as Settings['mode'] })}><option value="disabled">Desativado</option><option value="automatic">Sugestão a cada mensagem recebida</option><option value="on_demand">Somente quando solicitado</option></select></label>
    <label>Agente<select aria-label="Agente" disabled={!manager || busy} value={settings.agentId ?? ''} onChange={e => setSettings({ ...settings, agentId: e.target.value || null })}><option value="">Escolha um agente</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
    <p className="assistant-caption">Humano no controle pausa as sugestões. Antes do piloto, confira também as campanhas e automações independentes deste canal.</p>
    {manager ? <button className="assistant-primary" type="submit" disabled={busy || (settings.mode !== 'disabled' && !settings.agentId)}>{busy ? 'Salvando…' : 'Salvar configuração'}</button> : <p>Somente gestores podem alterar esta configuração.</p>}
    {notice ? <p role="status">{notice}</p> : null}
  </form>;
}
