import { useTalkAuth } from "../../app/auth";
import {
  apiCreateAgent,
  apiCreateAgentKnowledge,
  apiGetAgentKnowledge,
  apiGetAgents,
  apiSendAgentTestChatMessage,
  apiUpdateAgent,
  apiUploadAgentKnowledge,
  type AgentTestChatMessageDto,
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
  RotateCcw,
  Save,
  Send,
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

type KnowledgeUploadCategory =
  | "precos"
  | "produto"
  | "faq"
  | "politicas"
  | "onboarding"
  | "comercial"
  | "suporte"
  | "outro";

type KnowledgeUploadFormState = {
  title: string;
  category: KnowledgeUploadCategory;
  file: File | null;
};

const knowledgeUploadCategories: Array<{ value: KnowledgeUploadCategory; label: string }> = [
  { value: "precos", label: "Preços" },
  { value: "produto", label: "Produto" },
  { value: "faq", label: "FAQ" },
  { value: "politicas", label: "Políticas" },
  { value: "onboarding", label: "Onboarding" },
  { value: "comercial", label: "Comercial" },
  { value: "suporte", label: "Suporte" },
  { value: "outro", label: "Outro" }
];

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

function emptyKnowledgeUploadForm(): KnowledgeUploadFormState {
  return {
    title: "",
    category: "precos",
    file: null
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

function readKnowledgeCategory(source: AiKnowledgeSourceDto) {
  const metadata = source.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return null;
  }

  const category = (metadata as Record<string, unknown>).category;
  return typeof category === "string" ? category : null;
}

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

export function AgentsPage() {
  const { getToken } = useTalkAuth();
  const [agents, setAgents] = useState<AiAgentDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentForm, setAgentForm] = useState<AgentFormState>(emptyAgentForm);
  const [knowledge, setKnowledge] = useState<AiKnowledgeSourceDto[]>([]);
  const [knowledgeForm, setKnowledgeForm] = useState<KnowledgeFormState>(emptyKnowledgeForm);
  const [knowledgeUploadForm, setKnowledgeUploadForm] =
    useState<KnowledgeUploadFormState>(emptyKnowledgeUploadForm);
  const [testMessages, setTestMessages] = useState<AgentTestChatMessageDto[]>([]);
  const [testMessageBody, setTestMessageBody] = useState("");
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isLoadingKnowledge, setIsLoadingKnowledge] = useState(false);
  const [isSavingAgent, setIsSavingAgent] = useState(false);
  const [isSavingKnowledge, setIsSavingKnowledge] = useState(false);
  const [isUploadingKnowledge, setIsUploadingKnowledge] = useState(false);
  const [isSendingTestMessage, setIsSendingTestMessage] = useState(false);
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
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar agentes.");
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
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar conhecimento.");
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
    setTestMessages([]);
    setTestMessageBody("");
    setNotice(null);
    setError(null);
  }

  function selectAgent(agent: AiAgentDto) {
    setSelectedAgentId(agent.id);
    setAgentForm({
      name: agent.name,
      systemPrompt: agent.systemPrompt
    });
    setTestMessages([]);
    setTestMessageBody("");
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
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar o agente.");
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
      setError(saveError instanceof Error ? saveError.message : "Não foi possível adicionar conhecimento.");
    } finally {
      setIsSavingKnowledge(false);
    }
  }

  async function uploadKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedAgent || !knowledgeUploadForm.file) {
      setError("Selecione um agente e um arquivo.");
      return;
    }

    setIsUploadingKnowledge(true);
    setError(null);
    setNotice(null);

    try {
      const file = knowledgeUploadForm.file;
      const createdSource = await apiUploadAgentKnowledge(getToken, selectedAgent.id, {
        title: knowledgeUploadForm.title.trim() || file.name,
        category: knowledgeUploadForm.category,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        base64Content: await fileToBase64(file)
      });

      setKnowledge((current) => [createdSource, ...current]);
      setKnowledgeUploadForm(emptyKnowledgeUploadForm());
      setNotice("Documento adicionado ao agente.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Não foi possível enviar o documento.");
    } finally {
      setIsUploadingKnowledge(false);
    }
  }

  async function sendTestMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedAgent) {
      setError("Salve ou selecione um agente antes de testar.");
      return;
    }

    const content = testMessageBody.trim();
    if (!content) {
      return;
    }

    const nextMessages: AgentTestChatMessageDto[] = [
      ...testMessages,
      { role: "user", content }
    ];
    setTestMessages(nextMessages);
    setTestMessageBody("");
    setIsSendingTestMessage(true);
    setError(null);
    setNotice(null);

    try {
      const result = await apiSendAgentTestChatMessage(getToken, selectedAgent.id, {
        messages: nextMessages
      });

      setTestMessages((current) => [...current, result.message]);
    } catch (testError) {
      setTestMessages(testMessages);
      setTestMessageBody(content);
      setError(testError instanceof Error ? testError.message : "Não foi possível testar o agente.");
    } finally {
      setIsSendingTestMessage(false);
    }
  }

  function resetTestChat() {
    setTestMessages([]);
    setTestMessageBody("");
    setError(null);
    setNotice(null);
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
              <p>Crie o primeiro agente autônomo para usar em automações e atendimento.</p>
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
                {defaultAllowedActions.length} ações padrão
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
              {isSavingAgent ? "Salvando" : selectedAgent ? "Salvar alterações" : "Criar agente"}
            </button>
          </form>

          <section className="module-panel" aria-label="Teste do agente">
            <div className="panel-title-row">
              <h2>Teste do agente</h2>
              <button
                className="secondary-button"
                type="button"
                onClick={resetTestChat}
                disabled={testMessages.length === 0 && !testMessageBody}
              >
                <RotateCcw size={14} />
                Resetar teste
              </button>
            </div>

            <div className="assistant-log-list" aria-label="Chat de teste do agente">
              {testMessages.length === 0 ? (
                <p className="list-note">Nenhuma mensagem neste teste.</p>
              ) : null}
              {testMessages.map((message, index) => (
                <article
                  className="assistant-log-card"
                  key={`${message.role}-${index}-${message.content.slice(0, 12)}`}
                >
                  <div className="assistant-log-header">
                    <span className={`status-badge status-badge--${message.role === "user" ? "open" : "bot"}`}>
                      {message.role === "user" ? "Você" : "Agente"}
                    </span>
                  </div>
                  <p className="assistant-log-result">{message.content}</p>
                </article>
              ))}
            </div>

            <form className="module-form" onSubmit={(event) => void sendTestMessage(event)}>
              <label className="form-field">
                Mensagem de teste
                <textarea
                  value={testMessageBody}
                  onChange={(event) => setTestMessageBody(event.target.value)}
                  placeholder="Oi, tudo bem?"
                  disabled={!selectedAgent || isSendingTestMessage}
                  rows={3}
                />
              </label>
              <button
                className="secondary-button"
                type="submit"
                disabled={!selectedAgent || !testMessageBody.trim() || isSendingTestMessage}
              >
                <Send size={15} />
                {isSendingTestMessage ? "Enviando" : "Enviar teste"}
              </button>
            </form>
          </section>

          <section className="module-panel" aria-label="Conhecimento">
            <div className="panel-title-row">
              <h2>Conhecimento</h2>
              <span>{selectedAgent ? `${knowledge.length} fontes` : "Selecione um agente"}</span>
            </div>

            <form className="module-form" onSubmit={(event) => void uploadKnowledge(event)}>
              <label className="form-field">
                Categoria
                <select
                  value={knowledgeUploadForm.category}
                  onChange={(event) => setKnowledgeUploadForm((current) => ({
                    ...current,
                    category: event.target.value as KnowledgeUploadCategory
                  }))}
                  disabled={!selectedAgent}
                >
                  {knowledgeUploadCategories.map((category) => (
                    <option key={category.value} value={category.value}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                Título do documento
                <input
                  value={knowledgeUploadForm.title}
                  onChange={(event) => setKnowledgeUploadForm((current) => ({
                    ...current,
                    title: event.target.value
                  }))}
                  placeholder="Tabela de preços"
                  disabled={!selectedAgent}
                />
              </label>
              <label className="form-field">
                Arquivo PDF ou texto
                <input
                  accept="application/pdf,text/plain,.txt"
                  disabled={!selectedAgent}
                  key={knowledgeUploadForm.file ? "selected-file" : "empty-file"}
                  onChange={(event) => setKnowledgeUploadForm((current) => ({
                    ...current,
                    file: event.target.files?.[0] ?? null
                  }))}
                  type="file"
                />
              </label>
              <button
                className="secondary-button"
                type="submit"
                disabled={!selectedAgent || !knowledgeUploadForm.file || isUploadingKnowledge}
              >
                <Plus size={15} />
                {isUploadingKnowledge ? "Enviando" : "Adicionar documento"}
              </button>
            </form>

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
                Título
                <input
                  value={knowledgeForm.title}
                  onChange={(event) => setKnowledgeForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder={knowledgeForm.type === "faq" ? "Como remarcar um horário?" : "Política de atendimento"}
                  disabled={!selectedAgent}
                  required
                />
              </label>
              <label className="form-field">
                Conteúdo
                <textarea
                  value={knowledgeForm.content}
                  onChange={(event) => setKnowledgeForm((current) => ({ ...current, content: event.target.value }))}
                  placeholder="Resposta, instruções ou texto de referência para o agente."
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
              {knowledge.map((source) => {
                const category = readKnowledgeCategory(source);

                return (
                  <article className="assistant-log-card" key={source.id}>
                    <div className="assistant-log-header">
                      <span className="status-badge status-badge--bot">
                        {source.type === "faq" ? <HelpCircle size={12} /> : <FileText size={12} />}
                        {knowledgeTypeLabel(source.type)}
                      </span>
                      {category ? (
                        <span className="status-badge status-badge--bot">{category}</span>
                      ) : null}
                      <span className={`status-badge status-badge--${source.status === "ready" ? "open" : "waiting"}`}>
                        {source.status}
                      </span>
                    </div>
                    <strong>{source.title}</strong>
                    {source.content ? <p className="assistant-log-result">{source.content}</p> : null}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
