import { useTalkAuth } from "../../app/auth";
import {
  apiCreateAgent,
  apiCreateAgentKnowledge,
  apiGetAgentKnowledge,
  apiGetAgents,
  apiUpdateAgent,
  type AiAgentAllowedAction,
  type AiAgentDto,
  type AiKnowledgeSourceDto
} from "../../app/api";
import {
  Bot,
  FileText,
  HelpCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

const defaultAllowedActions: AiAgentAllowedAction[] = [
  "send_message",
  "add_tag",
  "create_internal_note",
  "request_handoff"
];

const defaultSystemPrompt =
  "Atue como um agente de atendimento da Prymeira Talk. Responda com clareza, use a base de conhecimento quando ela for relevante e solicite handoff quando faltar contexto.";

type AgentFormState = {
  name: string;
  systemPrompt: string;
};

type KnowledgeFormState = {
  type: "faq" | "text";
  title: string;
  content: string;
};

function emptyAgentForm(): AgentFormState {
  return {
    name: "Agente de atendimento",
    systemPrompt: defaultSystemPrompt
  };
}

function emptyKnowledgeForm(): KnowledgeFormState {
  return {
    type: "faq",
    title: "",
    content: ""
  };
}

function agentStatusLabel(status: AiAgentDto["status"]) {
  return status === "active" ? "Ativo" : "Inativo";
}

function knowledgeTypeLabel(type: AiKnowledgeSourceDto["type"]) {
  if (type === "faq") return "FAQ";
  if (type === "text") return "Texto";
  return "Arquivo";
}

export function AgentsPage() {
  const { getToken } = useTalkAuth();
  const [agents, setAgents] = useState<AiAgentDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentForm, setAgentForm] = useState<AgentFormState>(emptyAgentForm);
  const [knowledge, setKnowledge] = useState<AiKnowledgeSourceDto[]>([]);
  const [knowledgeForm, setKnowledgeForm] = useState<KnowledgeFormState>(emptyKnowledgeForm);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isLoadingKnowledge, setIsLoadingKnowledge] = useState(false);
  const [isSavingAgent, setIsSavingAgent] = useState(false);
  const [isSavingKnowledge, setIsSavingKnowledge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  async function loadAgents() {
    setIsLoadingAgents(true);
    setError(null);

    try {
      const loadedAgents = await apiGetAgents(getToken);
      setAgents(loadedAgents);

      if (selectedAgentId && loadedAgents.some((agent) => agent.id === selectedAgentId)) {
        return;
      }

      const firstAgent = loadedAgents[0] ?? null;
      setSelectedAgentId(firstAgent?.id ?? null);
      setAgentForm(firstAgent ? {
        name: firstAgent.name,
        systemPrompt: firstAgent.systemPrompt
      } : emptyAgentForm());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar agentes.");
    } finally {
      setIsLoadingAgents(false);
    }
  }

  async function loadKnowledge(agentId: string) {
    setIsLoadingKnowledge(true);
    setError(null);

    try {
      setKnowledge(await apiGetAgentKnowledge(getToken, agentId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar conhecimento.");
    } finally {
      setIsLoadingKnowledge(false);
    }
  }

  useEffect(() => {
    void loadAgents();
  }, [getToken]);

  useEffect(() => {
    if (!selectedAgentId) {
      setKnowledge([]);
      return;
    }

    void loadKnowledge(selectedAgentId);
  }, [getToken, selectedAgentId]);

  function startNewAgent() {
    setSelectedAgentId(null);
    setAgentForm(emptyAgentForm());
    setKnowledge([]);
    setNotice(null);
    setError(null);
  }

  function selectAgent(agent: AiAgentDto) {
    setSelectedAgentId(agent.id);
    setAgentForm({
      name: agent.name,
      systemPrompt: agent.systemPrompt
    });
    setNotice(null);
    setError(null);
  }

  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSavingAgent(true);
    setError(null);
    setNotice(null);

    try {
      if (selectedAgent) {
        const updatedAgent = await apiUpdateAgent(getToken, selectedAgent.id, {
          name: agentForm.name,
          systemPrompt: agentForm.systemPrompt
        });

        setAgents((current) => current.map((agent) => agent.id === updatedAgent.id ? updatedAgent : agent));
        setNotice("Agente atualizado.");
        return;
      }

      const createdAgent = await apiCreateAgent(getToken, {
        name: agentForm.name,
        systemPrompt: agentForm.systemPrompt,
        allowedActions: defaultAllowedActions
      });

      setAgents((current) => [createdAgent, ...current]);
      setSelectedAgentId(createdAgent.id);
      setAgentForm({
        name: createdAgent.name,
        systemPrompt: createdAgent.systemPrompt
      });
      setNotice("Agente criado.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel salvar o agente.");
    } finally {
      setIsSavingAgent(false);
    }
  }

  async function addKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedAgent) {
      setError("Crie ou selecione um agente antes de adicionar conhecimento.");
      return;
    }

    setIsSavingKnowledge(true);
    setError(null);
    setNotice(null);

    try {
      const createdSource = await apiCreateAgentKnowledge(getToken, selectedAgent.id, {
        type: knowledgeForm.type,
        title: knowledgeForm.title,
        content: knowledgeForm.content
      });

      setKnowledge((current) => [createdSource, ...current]);
      setKnowledgeForm(emptyKnowledgeForm());
      setNotice("Conhecimento adicionado.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel adicionar conhecimento.");
    } finally {
      setIsSavingKnowledge(false);
    }
  }

  return (
    <section className="module-page" aria-label="Agentes">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Agentes</h1>
        </div>
        <div className="module-header-actions">
          <span className={`status-badge status-badge--${isLoadingAgents ? "waiting" : "open"}`}>
            {isLoadingAgents ? "Carregando" : `${agents.length} agentes`}
          </span>
          <button className="secondary-button" type="button" onClick={() => void loadAgents()}>
            <RefreshCw size={14} />
            Atualizar
          </button>
          <button className="primary-button" type="button" onClick={startNewAgent}>
            <Plus size={14} />
            Novo agente
          </button>
        </div>
      </header>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <div className="ops-grid">
        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Agentes configurados</h2>
            <span>{isLoadingAgents ? "Sincronizando" : `${agents.length} total`}</span>
          </div>

          {agents.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Bot size={24} />
              </div>
              <h3>Nenhum agente</h3>
              <p>Crie o primeiro agente autonomo para usar em automacoes e atendimento.</p>
            </div>
          ) : null}

          <div className="assistant-log-list" aria-label="Lista de agentes">
            {agents.map((agent) => (
              <button
                className="assistant-log-card"
                key={agent.id}
                onClick={() => selectAgent(agent)}
                type="button"
                aria-pressed={agent.id === selectedAgentId}
              >
                <div className="assistant-log-header">
                  <span className={`status-badge status-badge--${agent.status === "active" ? "open" : "closed"}`}>
                    {agentStatusLabel(agent.status)}
                  </span>
                  <span className="status-badge status-badge--bot">{agent.model}</span>
                </div>
                <strong>{agent.name}</strong>
                <p className="assistant-log-result">{agent.systemPrompt}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="module-form">
          <form className="module-panel module-form" onSubmit={(event) => void saveAgent(event)}>
            <div className="panel-title-row">
              <h2>{selectedAgent ? "Editar agente" : "Novo agente"}</h2>
              <span className="status-badge status-badge--bot">
                <ShieldCheck size={12} />
                {defaultAllowedActions.length} acoes padrao
              </span>
            </div>
            <label className="form-field">
              Nome
              <input
                value={agentForm.name}
                onChange={(event) => setAgentForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Agente comercial"
                required
              />
            </label>
            <label className="form-field">
              Prompt do sistema
              <textarea
                value={agentForm.systemPrompt}
                onChange={(event) => setAgentForm((current) => ({ ...current, systemPrompt: event.target.value }))}
                required
                rows={7}
              />
            </label>
            <button className="primary-button" type="submit" disabled={isSavingAgent}>
              <Save size={15} />
              {isSavingAgent ? "Salvando" : selectedAgent ? "Salvar alteracoes" : "Criar agente"}
            </button>
          </form>

          <section className="module-panel" aria-label="Conhecimento">
            <div className="panel-title-row">
              <h2>Conhecimento</h2>
              <span>{selectedAgent ? `${knowledge.length} fontes` : "Selecione um agente"}</span>
            </div>

            <form className="module-form" onSubmit={(event) => void addKnowledge(event)}>
              <label className="form-field">
                Tipo
                <select
                  value={knowledgeForm.type}
                  onChange={(event) => setKnowledgeForm((current) => ({
                    ...current,
                    type: event.target.value as KnowledgeFormState["type"]
                  }))}
                  disabled={!selectedAgent}
                >
                  <option value="faq">FAQ</option>
                  <option value="text">Texto</option>
                </select>
              </label>
              <label className="form-field">
                Titulo
                <input
                  value={knowledgeForm.title}
                  onChange={(event) => setKnowledgeForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder={knowledgeForm.type === "faq" ? "Como remarcar um horario?" : "Politica de atendimento"}
                  disabled={!selectedAgent}
                  required
                />
              </label>
              <label className="form-field">
                Conteudo
                <textarea
                  value={knowledgeForm.content}
                  onChange={(event) => setKnowledgeForm((current) => ({ ...current, content: event.target.value }))}
                  placeholder="Resposta, instrucoes ou texto de referencia para o agente."
                  disabled={!selectedAgent}
                  required
                  rows={5}
                />
              </label>
              <button className="secondary-button" type="submit" disabled={!selectedAgent || isSavingKnowledge}>
                <Plus size={15} />
                {isSavingKnowledge ? "Adicionando" : "Adicionar conhecimento"}
              </button>
            </form>

            <div className="assistant-log-list" aria-label="Fontes de conhecimento">
              {isLoadingKnowledge ? <p className="list-note">Carregando conhecimento...</p> : null}
              {!isLoadingKnowledge && selectedAgent && knowledge.length === 0 ? (
                <p className="list-note">Nenhuma fonte cadastrada para este agente.</p>
              ) : null}
              {knowledge.map((source) => (
                <article className="assistant-log-card" key={source.id}>
                  <div className="assistant-log-header">
                    <span className="status-badge status-badge--bot">
                      {source.type === "faq" ? <HelpCircle size={12} /> : <FileText size={12} />}
                      {knowledgeTypeLabel(source.type)}
                    </span>
                    <span className={`status-badge status-badge--${source.status === "ready" ? "open" : "waiting"}`}>
                      {source.status}
                    </span>
                  </div>
                  <strong>{source.title}</strong>
                  {source.content ? <p className="assistant-log-result">{source.content}</p> : null}
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
