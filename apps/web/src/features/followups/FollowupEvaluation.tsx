import type { AiAgentDto } from "@prymeira-talk/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiDecideEvaluationProposal,
  apiGetAgents,
  apiListAgentEvaluations,
  apiRemoveEvaluationRule,
  apiRunAgentEvaluation,
  type AgentEvaluation,
  type AgentEvaluationCase,
  type AgentEvaluationProposal
} from "../../app/api";

const RUNNING_REFRESH_MS = 15_000;

const rotuloLabel: Record<AgentEvaluationCase["rotulo"], string> = {
  aprovado: "Aprovado sem mudança",
  editado: "Editado pelo vendedor",
  descartado: "Descartado pelo vendedor",
  respondeu: "Cliente respondeu",
  sem_resposta: "Sem resposta"
};
const erroLabel: Record<NonNullable<AgentEvaluationCase["erro"]>["tipo"], string> = {
  nao_devia: "Não era caso de follow-up",
  assunto: "Assunto errado",
  texto: "Texto ruim",
  nenhum: "Sem erro do agente"
};
const autorLabel: Record<string, string> = { contato: "Cliente", agente: "Agente", humano: "Vendedor" };

/** Agents with the new attendance agent on: the only ones the weekly evaluation covers. */
function harnessAgents(agents: AiAgentDto[]) {
  return agents.filter((agent) => {
    const harness = (agent.behaviorConfig as Record<string, unknown>).harness as { agente?: unknown; canais?: unknown } | undefined;
    return harness?.agente === "atendimento" && Array.isArray(harness.canais) && harness.canais.length > 0;
  });
}

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const day = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const period = (evaluation: AgentEvaluation) => `${day(evaluation.periodStart)} a ${day(new Date(new Date(evaluation.periodEnd).getTime() - 1).toISOString())}`;

function validationText(proposal: AgentEvaluationProposal) {
  const v = proposal.validacao;
  if (!v) return "Não foi possível testar esta regra.";
  const corrige = v.erradosTestados
    ? `Corrigiu ${v.corrige} de ${v.erradosTestados} ${v.erradosTestados === 1 ? "caso errado" : "casos errados"}`
    : "Nenhum caso errado para testar (sem a regra o agente já não mandaria)";
  const quebra = v.bonsTestados
    ? `cancelou ${v.quebra} de ${v.bonsTestados} follow-ups bons`
    : "sem follow-ups bons para comparar";
  return `${corrige}; ${quebra}.`;
}

export function FollowupEvaluation({ getToken }: { getToken: () => Promise<string | null> }) {
  const [agents, setAgents] = useState<AiAgentDto[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [evaluations, setEvaluations] = useState<AgentEvaluation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGetAgents(getToken).then((list) => {
      if (!active) return;
      const available = harnessAgents(list);
      setAgents(available);
      setAgentId(available[0]?.id ?? "");
      if (!available.length) setLoading(false);
    }).catch((error) => {
      if (active) { setMessage(error instanceof Error ? error.message : "Falha ao carregar os agentes."); setAgents([]); setLoading(false); }
    });
    return () => { active = false; };
  }, [getToken]);

  const load = useCallback(async () => {
    if (!agentId) return;
    try {
      const list = await apiListAgentEvaluations(getToken, agentId);
      setEvaluations(list);
      setSelectedId((current) => current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao carregar a avaliação.");
    } finally {
      setLoading(false);
    }
  }, [agentId, getToken]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  const running = evaluations.some((item) => item.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), RUNNING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const selected = useMemo(() => evaluations.find((item) => item.id === selectedId) ?? null, [evaluations, selectedId]);
  const rules = selected?.rules ?? evaluations[0]?.rules ?? [];

  async function runNow() {
    setBusy("run");
    setMessage(null);
    try {
      await apiRunAgentEvaluation(getToken, agentId);
      setMessage("Avaliação dos últimos 7 dias iniciada. Ela leva alguns minutos; esta tela atualiza sozinha.");
      setTimeout(() => void load(), 1500);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível iniciar a avaliação.");
    } finally {
      setBusy(null);
    }
  }

  async function decide(proposal: AgentEvaluationProposal, decision: "approve" | "reject") {
    if (!selected) return;
    setBusy(proposal.id);
    setMessage(null);
    try {
      const updated = await apiDecideEvaluationProposal(getToken, agentId, selected.id, proposal.id, decision);
      setEvaluations((current) => current.map((item) => item.id === updated.id ? updated : { ...item, rules: updated.rules }));
      setMessage(decision === "approve" ? "Regra aprovada. Ela vale a partir do próximo follow-up." : "Regra recusada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível decidir a regra.");
    } finally {
      setBusy(null);
    }
  }

  async function removeRule(rule: string) {
    setBusy(`rule:${rule}`);
    setMessage(null);
    try {
      const result = await apiRemoveEvaluationRule(getToken, agentId, rule);
      setEvaluations((current) => current.map((item) => ({ ...item, rules: result.rules })));
      setMessage("Regra removida do agente.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível remover a regra.");
    } finally {
      setBusy(null);
    }
  }

  if (agents && !agents.length) {
    return <div className="followups-settings followups-evaluation">
      <h2>Avaliação semanal</h2>
      <p className="followups-settings-caption">A avaliação semanal acompanha o agente novo de atendimento. Ele ainda não está ligado em nenhum número.</p>
      {message ? <p role="status" className="followups-settings-message">{message}</p> : null}
    </div>;
  }

  return <div className="followups-settings followups-evaluation">
    <div className="followups-settings-heading">
      <h2>Avaliação semanal</h2>
      <p>Todo sábado de manhã o sistema revê os follow-ups da semana: o que o vendedor aprovou, editou ou descartou e se o cliente respondeu. Dos erros saem propostas de regra, já testadas nos casos da semana. Nada muda no agente sem a sua aprovação.</p>
    </div>

    <div className="followups-evaluation-toolbar">
      {agents && agents.length > 1 ? <label className="followups-settings-field">Agente
        <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </label> : null}
      {evaluations.length ? <label className="followups-settings-field">Semana
        <select value={selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
          {evaluations.map((item) => <option key={item.id} value={item.id}>{period(item)}{item.status === "running" ? " (rodando)" : item.status === "failed" ? " (falhou)" : ""}</option>)}
        </select>
      </label> : null}
      <button className="followups-button" type="button" disabled={!agentId || busy !== null || running} onClick={() => void runNow()}>
        {running ? "Avaliando…" : "Avaliar os últimos 7 dias agora"}
      </button>
    </div>

    {message ? <p role="status" className="followups-settings-message">{message}</p> : null}
    {loading ? <p>Carregando avaliação…</p> : null}
    {!loading && !evaluations.length ? <p className="followups-settings-caption">Ainda não há avaliação. A primeira sai no próximo sábado, ou agora pelo botão acima.</p> : null}

    {selected?.status === "running" ? <p className="followups-settings-caption">Esta avaliação ainda está rodando.</p> : null}
    {selected?.status === "failed" ? <p className="followups-evaluation-error" role="alert">A avaliação falhou: {selected.error ?? "erro desconhecido"}. Ela tenta de novo sozinha em algumas horas.</p> : null}

    {selected?.status === "ready" && selected.summary ? <>
      <div className="followups-evaluation-stats">
        <div><strong>{percent(selected.summary.aprovacao)}</strong><span>dos rascunhos aprovados sem mudança</span></div>
        <div><strong>{percent(selected.summary.resposta)}</strong><span>dos envios automáticos com resposta do cliente</span></div>
        <div><strong>{selected.summary.decisoes.mensagem}</strong><span>follow-ups escritos na semana</span></div>
        <div><strong>{selected.summary.erros.nao_devia + selected.summary.erros.assunto + selected.summary.erros.texto}</strong><span>erros do agente encontrados</span></div>
      </div>

      <h3>Regras propostas</h3>
      {!selected.proposals.length ? <p className="followups-settings-caption">Nenhuma regra nova nesta semana.</p> : null}
      <div className="followups-evaluation-proposals">
        {selected.proposals.map((proposal) => <article key={proposal.id} className="followups-evaluation-proposal">
          <p className="followups-evaluation-rule">{proposal.regra}</p>
          {proposal.porque ? <p className="followups-settings-caption">{proposal.porque}</p> : null}
          <p className="followups-evaluation-validation">{validationText(proposal)}</p>
          {proposal.status === "pendente"
            ? <div className="followups-evaluation-actions">
                <button className="followups-button followups-button-primary" type="button" disabled={busy !== null} onClick={() => void decide(proposal, "approve")}>Aprovar</button>
                <button className="followups-button" type="button" disabled={busy !== null} onClick={() => void decide(proposal, "reject")}>Recusar</button>
              </div>
            : <span className={`followups-evaluation-chip is-${proposal.status}`}>{proposal.status === "aprovada" ? "Aprovada" : "Recusada"}</span>}
        </article>)}
      </div>
    </> : null}

    <h3>Regras em uso no agente</h3>
    {!rules.length ? <p className="followups-settings-caption">Nenhuma regra aprovada ainda.</p> : null}
    <ul className="followups-evaluation-rules">
      {rules.map((rule) => <li key={rule}>
        <span>{rule}</span>
        <button className="followups-button followups-button-quiet" type="button" disabled={busy !== null} onClick={() => void removeRule(rule)}>Remover</button>
      </li>)}
    </ul>

    {selected?.status === "ready" && selected.cases.length ? <>
      <h3>Casos da semana</h3>
      <div className="followups-evaluation-cases">
        {[...selected.cases].sort((a, b) => Number(Boolean(b.erro && b.erro.tipo !== "nenhum")) - Number(Boolean(a.erro && a.erro.tipo !== "nenhum"))).map((caso) => <details key={caso.followupId} className="followups-evaluation-case">
          <summary>
            <span className={`followups-evaluation-chip is-${caso.rotulo}`}>{rotuloLabel[caso.rotulo]}</span>
            {caso.erro && caso.erro.tipo !== "nenhum" ? <span className="followups-evaluation-chip is-erro">{erroLabel[caso.erro.tipo]}</span> : null}
            <span className="followups-evaluation-date">{day(caso.decididoEm)}</span>
            <span className="followups-evaluation-preview">{caso.rascunho}</span>
          </summary>
          {caso.erro ? <p className="followups-settings-caption">{caso.erro.explicacao}</p> : null}
          <ol className="followups-evaluation-chat">
            {caso.ultimas.map((mensagem, index) => <li key={index} className={`is-${mensagem.autor}`}><b>{autorLabel[mensagem.autor] ?? mensagem.autor}:</b> {mensagem.texto}</li>)}
          </ol>
          <p><b>Agente escreveu:</b> {caso.rascunho}</p>
          {caso.rotulo === "editado" ? <p><b>Vendedor enviou:</b> {caso.enviado}</p> : null}
          {caso.resposta ? <p><b>Cliente respondeu:</b> {caso.resposta}</p> : null}
        </details>)}
      </div>
    </> : null}
  </div>;
}
