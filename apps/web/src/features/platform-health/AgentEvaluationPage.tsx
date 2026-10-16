import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { useTalkAuth } from "../../app/auth";
import {
  apiClientEvaluations,
  apiDecideClientProposal,
  apiEvaluationClients,
  apiRemoveClientRule,
  apiRunClientEvaluation,
  SupervisionApiError,
  type AgentEvaluation,
  type AgentEvaluationCase,
  type AgentEvaluationProposal,
  type EvaluationClient
} from "../../app/supervision-api";
import { OwnerNav } from "./OwnerNav";
import "./platform-health.css";
import "./agent-evaluation.css";

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

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const day = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const period = (evaluation: AgentEvaluation) => `${day(evaluation.periodStart)} a ${day(new Date(new Date(evaluation.periodEnd).getTime() - 1).toISOString())}`;
const workspaceLabel = (agent: EvaluationClient["agents"][number]) => agent.workspaceName ?? agent.workspaceId.slice(0, 8);

export function validationText(proposal: AgentEvaluationProposal) {
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

/**
 * The product owner's weekly evaluation of each customer's new attendance agent. A customer may run the
 * same agent in several workspaces (Villefer: Vendas 02, 03, 05 and 06): their follow-ups are evaluated
 * together and an approved rule goes to all of them.
 */
export function AgentEvaluationPage() {
  const { getToken } = useTalkAuth();
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const token = useCallback(() => tokenRef.current(), []);
  const [clients, setClients] = useState<EvaluationClient[] | null>(null);
  const [clientKey, setClientKey] = useState("");
  const [evaluations, setEvaluations] = useState<AgentEvaluation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const failed = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof SupervisionApiError && (cause.status === 401 || cause.status === 403)) {
      setDenied(cause.status === 401 ? "Sua sessão expirou. Entre novamente pelo Hub." : "Esta tela é só para administradores do Hub.");
    } else setMessage(cause instanceof Error ? cause.message : fallback);
  }, []);

  const loadClients = useCallback(async () => {
    try {
      const list = await apiEvaluationClients(token);
      setClients(list);
      setClientKey((current) => current && list.some((client) => client.key === current) ? current : list[0]?.key ?? "");
      if (!list.length) setLoading(false);
    } catch (cause) {
      failed(cause, "Não foi possível carregar os clientes.");
      setClients([]);
      setLoading(false);
    }
  }, [failed, token]);
  useEffect(() => { void loadClients(); }, [loadClients]);

  const load = useCallback(async () => {
    if (!clientKey) return;
    try {
      const list = await apiClientEvaluations(clientKey, token);
      setEvaluations(list);
      setSelectedId((current) => current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null);
    } catch (cause) {
      failed(cause, "Não foi possível carregar a avaliação.");
    } finally {
      setLoading(false);
    }
  }, [clientKey, failed, token]);
  useEffect(() => { setLoading(true); setEvaluations([]); setSelectedId(null); setMessage(null); void load(); }, [load]);

  const running = evaluations.some((item) => item.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), RUNNING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const client = clients?.find((item) => item.key === clientKey) ?? null;
  const selected = useMemo(() => evaluations.find((item) => item.id === selectedId) ?? null, [evaluations, selectedId]);
  const rules = selected?.rules ?? evaluations[0]?.rules ?? client?.rules ?? [];
  const workspaceNames = useMemo(() => new Map((client?.agents ?? []).map((agent) => [agent.workspaceId, workspaceLabel(agent)])), [client]);
  const severalWorkspaces = (client?.agents.length ?? 0) > 1;

  async function act(key: string, action: () => Promise<void>, fallback: string) {
    setBusy(key);
    setMessage(null);
    try { await action(); } catch (cause) { failed(cause, fallback); } finally { setBusy(null); }
  }
  const runNow = () => act("run", async () => {
    await apiRunClientEvaluation(clientKey, token);
    setMessage("Avaliação dos últimos 7 dias iniciada. Ela leva alguns minutos; esta tela atualiza sozinha.");
    window.setTimeout(() => void load(), 1500);
  }, "Não foi possível iniciar a avaliação.");
  const decide = (proposal: AgentEvaluationProposal, decision: "approve" | "reject") => act(proposal.id, async () => {
    if (!selected) return;
    const updated = await apiDecideClientProposal(clientKey, selected.id, proposal.id, decision, token);
    setEvaluations((current) => current.map((item) => item.id === updated.id ? updated : { ...item, rules: updated.rules }));
    if (decision === "approve") setClients((current) => current?.map((item) => item.key === clientKey ? { ...item, rules: updated.rules } : item) ?? null);
    setMessage(decision === "approve"
      ? `Regra aprovada${severalWorkspaces ? ` nos ${client!.agents.length} workspaces` : ""}. Ela vale a partir do próximo follow-up.`
      : "Regra recusada.");
    void loadClients();
  }, "Não foi possível decidir a regra.");
  const removeRule = (rule: string) => act(`rule:${rule}`, async () => {
    const result = await apiRemoveClientRule(clientKey, rule, token);
    setEvaluations((current) => current.map((item) => ({ ...item, rules: result.rules })));
    setClients((current) => current?.map((item) => item.key === clientKey ? { ...item, rules: result.rules } : item) ?? null);
    setMessage("Regra removida do agente.");
  }, "Não foi possível remover a regra.");

  return <div className="health-page">
    <header className="health-header">
      <div className="health-brand"><span className="health-brand-mark"><ClipboardCheck size={20} aria-hidden="true" /></span><strong>Avaliação dos agentes</strong><span>Prymeira Talk · todos os clientes</span></div>
      <OwnerNav current="avaliacao" />
      <div className="health-refresh">
        <button type="button" onClick={() => { void loadClients(); void load(); }} disabled={loading}><RefreshCw size={15} aria-hidden="true" className={loading ? "is-refreshing" : ""} />Atualizar</button>
      </div>
    </header>
    {denied ? <section className="health-denied" role="alert"><ShieldCheck size={32} aria-hidden="true" /><h2>Acesso restrito</h2><p>{denied}</p></section> : <main className="health-content evaluation-layout">
      <aside className="evaluation-clients" aria-label="Clientes">
        {clients === null ? <p className="health-empty">Carregando clientes…</p> : null}
        {clients && !clients.length ? <p className="health-empty">Nenhum cliente com o agente novo ligado.</p> : null}
        {clients?.map((item) => <button key={item.key} type="button" className="evaluation-client" aria-pressed={item.key === clientKey} onClick={() => setClientKey(item.key)}>
          <strong>{item.name}</strong>
          <small>{item.agents.length === 1 ? workspaceLabel(item.agents[0]!) : `${item.agents.length} workspaces`} · {item.rules.length} {item.rules.length === 1 ? "regra" : "regras"}</small>
          {item.pendingProposals ? <span className="evaluation-badge">{item.pendingProposals} para decidir</span> : null}
        </button>)}
      </aside>

      {client ? <section className="evaluation-detail" aria-label={`Avaliação de ${client.name}`}>
        <div className="evaluation-heading">
          <div>
            <h1>{client.name}</h1>
            <p className="evaluation-caption">Todo sábado de manhã o sistema revê os follow-ups da semana{severalWorkspaces ? " de todos os workspaces do cliente" : ""}: o que o vendedor aprovou, editou ou descartou e se o cliente respondeu. Dos erros saem propostas de regra, já testadas nos casos da semana. Nada muda no agente sem a sua aprovação{severalWorkspaces ? ", e a regra aprovada vale para todos os workspaces" : ""}.</p>
          </div>
          <ul className="evaluation-workspaces" aria-label="Workspaces do cliente">
            {client.agents.map((agent) => <li key={agent.agentId}>{workspaceLabel(agent)}<small>{agent.channels} {agent.channels === 1 ? "número" : "números"}</small></li>)}
          </ul>
        </div>

        <div className="evaluation-toolbar">
          {evaluations.length ? <label>Semana
            <select value={selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
              {evaluations.map((item) => <option key={item.id} value={item.id}>{period(item)}{item.status === "running" ? " (rodando)" : item.status === "failed" ? " (falhou)" : ""}</option>)}
            </select>
          </label> : null}
          <button className="evaluation-button" type="button" disabled={busy !== null || running} onClick={() => void runNow()}>
            {running ? "Avaliando…" : "Avaliar os últimos 7 dias agora"}
          </button>
        </div>

        {message ? <p role="status" className="evaluation-message">{message}</p> : null}
        {loading ? <p className="evaluation-caption">Carregando avaliação…</p> : null}
        {!loading && !evaluations.length ? <p className="evaluation-caption">Ainda não há avaliação. A primeira sai no próximo sábado, ou agora pelo botão acima.</p> : null}
        {selected?.status === "running" ? <p className="evaluation-caption">Esta avaliação ainda está rodando.</p> : null}
        {selected?.status === "failed" ? <p className="evaluation-error" role="alert">A avaliação falhou: {selected.error ?? "erro desconhecido"}. Ela tenta de novo sozinha em algumas horas.</p> : null}

        {selected?.status === "ready" && selected.summary ? <>
          <div className="evaluation-stats">
            <div><strong>{percent(selected.summary.aprovacao)}</strong><span>dos rascunhos aprovados sem mudança</span></div>
            <div><strong>{percent(selected.summary.resposta)}</strong><span>dos envios automáticos com resposta do cliente</span></div>
            <div><strong>{selected.summary.decisoes.mensagem}</strong><span>follow-ups escritos na semana</span></div>
            <div><strong>{selected.summary.erros.nao_devia + selected.summary.erros.assunto + selected.summary.erros.texto}</strong><span>erros do agente encontrados</span></div>
          </div>

          <h2>Regras propostas</h2>
          {!selected.proposals.length ? <p className="evaluation-caption">Nenhuma regra nova nesta semana.</p> : null}
          <div className="evaluation-proposals">
            {selected.proposals.map((proposal) => <article key={proposal.id} className="evaluation-proposal">
              <p className="evaluation-rule">{proposal.regra}</p>
              {proposal.porque ? <p className="evaluation-caption">{proposal.porque}</p> : null}
              <p className="evaluation-validation">{validationText(proposal)}</p>
              {proposal.status === "pendente"
                ? <div className="evaluation-actions">
                    <button className="evaluation-button is-primary" type="button" disabled={busy !== null} onClick={() => void decide(proposal, "approve")}>Aprovar</button>
                    <button className="evaluation-button" type="button" disabled={busy !== null} onClick={() => void decide(proposal, "reject")}>Recusar</button>
                  </div>
                : <span className={`evaluation-chip is-${proposal.status}`}>{proposal.status === "aprovada" ? "Aprovada" : "Recusada"}</span>}
            </article>)}
          </div>
        </> : null}

        <h2>Regras em uso no agente</h2>
        {!rules.length ? <p className="evaluation-caption">Nenhuma regra aprovada ainda.</p> : null}
        <ul className="evaluation-rules">
          {rules.map((rule) => <li key={rule}>
            <span>{rule}</span>
            <button className="evaluation-button is-quiet" type="button" disabled={busy !== null} onClick={() => void removeRule(rule)}>Remover</button>
          </li>)}
        </ul>

        {selected?.status === "ready" && selected.cases.length ? <>
          <h2>Casos da semana</h2>
          <div className="evaluation-cases">
            {[...selected.cases].sort((a, b) => Number(Boolean(b.erro && b.erro.tipo !== "nenhum")) - Number(Boolean(a.erro && a.erro.tipo !== "nenhum"))).map((caso) => <details key={caso.followupId} className="evaluation-case">
              <summary>
                <span className={`evaluation-chip is-${caso.rotulo}`}>{rotuloLabel[caso.rotulo]}</span>
                {caso.erro && caso.erro.tipo !== "nenhum" ? <span className="evaluation-chip is-erro">{erroLabel[caso.erro.tipo]}</span> : null}
                {severalWorkspaces && caso.workspaceId ? <span className="evaluation-chip">{workspaceNames.get(caso.workspaceId) ?? caso.workspaceId.slice(0, 8)}</span> : null}
                <span className="evaluation-date">{day(caso.decididoEm)}</span>
                <span className="evaluation-preview">{caso.rascunho}</span>
              </summary>
              {caso.erro ? <p className="evaluation-caption">{caso.erro.explicacao}</p> : null}
              <ol className="evaluation-chat">
                {caso.ultimas.map((mensagem, index) => <li key={index}><b>{autorLabel[mensagem.autor] ?? mensagem.autor}:</b> {mensagem.texto}</li>)}
              </ol>
              <p><b>Agente escreveu:</b> {caso.rascunho}</p>
              {caso.rotulo === "editado" ? <p><b>Vendedor enviou:</b> {caso.enviado}</p> : null}
              {caso.resposta ? <p><b>Cliente respondeu:</b> {caso.resposta}</p> : null}
            </details>)}
          </div>
        </> : null}
      </section> : null}
    </main>}
  </div>;
}
