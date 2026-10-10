import { agentFollowupConfigSchema, type AgentFollowupConfig } from "@prymeira-talk/shared";
import { AgentFollowupConfigEditor, emptyAgentFollowupConfig, validateAgentFollowupConfig } from "./AgentFollowupConfigEditor";
import { useTalkAuth } from "../../app/auth";
import {
  apiCreateAgent,
  apiCreateAgentKnowledge,
  apiApproveAgentImprovement,
  apiDeleteAgent,
  apiDeleteAgentKnowledge,
  apiGetAgentKnowledge,
  apiGetAgentImprovements,
  apiGetAgents,
  apiGetTags,
  apiNormalizeAgentImprovement,
  apiSendAgentTestChatMessage,
  apiUpdateAgent,
  apiUpdateAgentImprovement,
  apiUpdateAgentKnowledge,
  apiUploadAgentKnowledge,
  ApiRequestError,
  type AgentTestChatMessageDto,
  type AiAgentAllowedAction,
  type AiAgentDto,
  type AiAgentImprovementDto,
  type AiKnowledgeSourceDto,
  type TagDto
} from "../../app/api";
import {
  BookOpen,
  Bot,
  Check,
  FileText,
  HelpCircle,
  Lightbulb,
  MessageSquare,
  PackageOpen,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  UserRound
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AgentPackagePanel } from "./AgentPackagePanel";
import { getTestUploadMime, validateTestUpload } from "./agent-test-upload";
import { AgentTestInspection } from "./AgentTestInspection";

const defaultAllowedActions: AiAgentAllowedAction[] = [
  "send_message",
  "add_tag",
  "create_internal_note",
  "request_handoff"
];

const allowedActionLabels: Array<{ value: AiAgentAllowedAction; label: string; description: string }> = [
  { value: "send_message", label: "Enviar mensagem", description: "Responde o cliente no WhatsApp." },
  { value: "send_attachment", label: "Enviar anexo", description: "Envia catálogo ou arquivo aprovado." },
  { value: "add_tag", label: "Adicionar tag", description: "Classifica a conversa com tags permitidas." },
  { value: "remove_tag", label: "Remover tag", description: "Remove uma tag da conversa." },
  { value: "change_priority", label: "Alterar prioridade", description: "Prioriza o atendimento." },
  { value: "create_internal_note", label: "Nota interna", description: "Registra contexto para o vendedor." },
  { value: "assign_user", label: "Atribuir a usuário", description: "Encaminha para um usuário do time." },
  { value: "assign_department", label: "Atribuir a departamento", description: "Encaminha para um departamento." },
  { value: "request_handoff", label: "Pedir handoff", description: "Passa a conversa para o vendedor." }
];

const defaultSystemPrompt =
  "Atue como um agente de atendimento da Prymeira Talk. Responda com clareza, use a base de conhecimento quando ela for relevante e solicite handoff quando faltar contexto.";

const defaultProspectingPrompt = "Atue como um agente de prospecção da Prymeira Talk. Acompanhe as respostas à abordagem inicial com clareza e respeito, use a base de conhecimento para explicar a oferta, qualifique o interesse e solicite handoff quando o critério de passagem para o humano for atingido.";

type AgentFormState = {
  type: "attendance" | "prospecting";
  prospectingGoal: string;
  followupConfig: AgentFollowupConfig;
  name: string;
  status: AiAgentDto["status"];
  systemPrompt: string;
  allowedActions: AiAgentAllowedAction[];
  allowedTagIds: string[];
  reasoningEffort: "none" | "low";
  onlyNewConversations: boolean;
};

type KnowledgeFormState = {
  type: "faq" | "text";
  title: string;
  content: string;
  fileUrl: string;
};

type KnowledgeUploadFormState = {
  title: string;
  category: string;
  file: File | null;
};

type KnowledgeInputMode = "file" | "text";
type AgentDetailTab = "profile" | "capabilities" | "knowledge" | "improvements" | "test";
type ImprovementFilter = AiAgentImprovementDto["status"] | "all";

type ImprovementFormState = {
  title: string;
  content: string;
};

type AgentTestDebugState = Record<string, unknown> | null;

const knowledgeUploadCategories: Array<{ value: string; label: string }> = [
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
    type: "attendance",
    prospectingGoal: "",
    followupConfig: emptyAgentFollowupConfig(),
    name: "Agente de atendimento",
    status: "inactive",
    systemPrompt: defaultSystemPrompt,
    reasoningEffort: "none",
    onlyNewConversations: false,
    allowedActions: defaultAllowedActions,
    allowedTagIds: []
  };
}

function agentFormFromAgent(agent: AiAgentDto): AgentFormState {
  return {
    type: agent.type ?? "attendance",
    prospectingGoal: typeof agent.handoffConfig.prospectingGoal === "string" ? agent.handoffConfig.prospectingGoal : "",
    followupConfig: agentFollowupConfigSchema.safeParse(agent.behaviorConfig.followup).success
      ? agentFollowupConfigSchema.parse(agent.behaviorConfig.followup) : emptyAgentFollowupConfig(),
    name: agent.name,
    status: agent.status,
    systemPrompt: agent.systemPrompt,
    reasoningEffort: agent.behaviorConfig.reasoningEffort === "low" ? "low" : "none",
    onlyNewConversations: agent.behaviorConfig.onlyNewConversations === true,
    allowedActions: agent.allowedActions,
    allowedTagIds: agent.allowedTags.map((tag) => tag.id)
  };
}

function emptyKnowledgeForm(): KnowledgeFormState {
  return {
    type: "faq",
    title: "",
    content: "",
    fileUrl: ""
  };
}

function emptyKnowledgeUploadForm(): KnowledgeUploadFormState {
  return {
    title: "",
    category: "precos",
    file: null
  };
}

function emptyImprovementForm(): ImprovementFormState {
  return { title: "", content: "" };
}

const allowedActionGroups: Array<{ title: string; actions: AiAgentAllowedAction[] }> = [
  { title: "Conversar com o cliente", actions: ["send_message", "send_attachment"] },
  { title: "Organizar a conversa", actions: ["add_tag", "remove_tag", "change_priority", "create_internal_note"] },
  { title: "Passar para o time", actions: ["assign_user", "assign_department", "request_handoff"] }
];

function agentInitials(name: string) {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "IA";
  return words.slice(0, 2).map((word) => word[0]!.toUpperCase()).join("");
}

function agentStatusLabel(status: AiAgentDto["status"]) {
  return status === "active" ? "Ativo" : "Inativo";
}

function knowledgeTypeLabel(type: AiKnowledgeSourceDto["type"]) {
  if (type === "faq") return "FAQ";
  if (type === "text") return "Texto";
  return "Arquivo";
}

function improvementKindLabel(kind: AiAgentImprovementDto["kind"]) {
  if (kind === "not_sold") return "Produto não comercializado";
  if (kind === "made_to_order") return "Sob encomenda";
  if (kind === "policy") return "Política";
  return "FAQ";
}

function improvementStatusLabel(status: AiAgentImprovementDto["status"]) {
  if (status === "accepted") return "Incluída na base";
  if (status === "rejected") return "Recusada";
  return "Pendente de revisão";
}

function improvementScopeLabel(scope: NonNullable<AiAgentImprovementDto["clarification"]["normalization"]>["scope"]) {
  if (scope === "requested_item_only") return "Apenas o item exatamente solicitado.";
  if (scope === "requested_item_variations") return "As variações confirmadas do item solicitado.";
  if (scope === "material_or_finish_family") return "A família de material ou acabamento confirmada.";
  return "O escopo amplo de catálogo confirmado pelo time.";
}

function readKnowledgeCategory(source: AiKnowledgeSourceDto) {
  const metadata = source.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return null;
  }

  const category = (metadata as Record<string, unknown>).category;
  return typeof category === "string" ? category : null;
}

function knowledgeCategoryLabel(value: string | null) {
  return knowledgeUploadCategories.find((category) => category.value === value)?.label ?? value;
}

function normalizeKnowledgeCategoryInput(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function guessMimeType(file: File) {
  if (file.type) {
    return file.type;
  }

  const lowerName = file.name.toLocaleLowerCase("pt-BR");
  if (lowerName.endsWith(".txt")) return "text/plain";
  if (lowerName.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
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

function formatAgentTestDebug(debug: AgentTestDebugState) {
  if (!debug) {
    return JSON.stringify({
      status: "Nenhum teste executado nesta sessão."
    }, null, 2);
  }

  return JSON.stringify(debug, null, 2);
}

export function AgentsPage() {
  const { getToken } = useTalkAuth();
  const [agents, setAgents] = useState<AiAgentDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentForm, setAgentForm] = useState<AgentFormState>(emptyAgentForm);
  const [knowledge, setKnowledge] = useState<AiKnowledgeSourceDto[]>([]);
  const [knowledgeForm, setKnowledgeForm] = useState<KnowledgeFormState>(emptyKnowledgeForm);
  const [knowledgeUploadForm, setKnowledgeUploadForm] =
    useState<KnowledgeUploadFormState>(emptyKnowledgeUploadForm);
  const [knowledgeInputMode, setKnowledgeInputMode] = useState<KnowledgeInputMode>("file");
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null);
  const [agentDetailTab, setAgentDetailTab] = useState<AgentDetailTab>("profile");
  const [improvements, setImprovements] = useState<AiAgentImprovementDto[]>([]);
  const [improvementFilter, setImprovementFilter] = useState<ImprovementFilter>("pending");
  const [editingImprovementId, setEditingImprovementId] = useState<string | null>(null);
  const [improvementForm, setImprovementForm] = useState<ImprovementFormState>(emptyImprovementForm);
  const [clarificationDrafts, setClarificationDrafts] = useState<Record<string, Record<string, string>>>({});
  const [testMessages, setTestMessages] = useState<AgentTestChatMessageDto[]>([]);
  const [testMessageBody, setTestMessageBody] = useState("");
  const [testDebug, setTestDebug] = useState<AgentTestDebugState>(null);
  const testRequestGeneration = useRef(0);
  const [testFile, setTestFile] = useState<File | null>(null);
  const [testFileKey, setTestFileKey] = useState(0);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isLoadingKnowledge, setIsLoadingKnowledge] = useState(false);
  const [isSavingAgent, setIsSavingAgent] = useState(false);
  const [isDeletingAgent, setIsDeletingAgent] = useState(false);
  const [isSavingKnowledge, setIsSavingKnowledge] = useState(false);
  const [deletingKnowledgeId, setDeletingKnowledgeId] = useState<string | null>(null);
  const [isLoadingImprovements, setIsLoadingImprovements] = useState(false);
  const [improvementActionId, setImprovementActionId] = useState<string | null>(null);
  const [isUploadingKnowledge, setIsUploadingKnowledge] = useState(false);
  const [isSendingTestMessage, setIsSendingTestMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPackagePanelOpen, setIsPackagePanelOpen] = useState(false);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  const editingKnowledgeSource = useMemo(
    () => knowledge.find((source) => source.id === editingKnowledgeId) ?? null,
    [editingKnowledgeId, knowledge]
  );

  const pendingImprovementCount = useMemo(
    () => improvements.filter((improvement) => improvement.status === "pending").length,
    [improvements]
  );

  const visibleImprovements = useMemo(
    () =>
      improvementFilter === "all"
        ? improvements
        : improvements.filter((improvement) => improvement.status === improvementFilter),
    [improvementFilter, improvements]
  );

  async function loadAgents() {
    setIsLoadingAgents(true);
    setError(null);

    try {
      const [loadedAgents, loadedTags] = await Promise.all([
        apiGetAgents(getToken),
        apiGetTags(getToken)
      ]);
      setAgents(loadedAgents);
      setTags(loadedTags.filter((tag) => tag.isActive));

      const refreshedSelectedAgent = selectedAgentId
        ? loadedAgents.find((agent) => agent.id === selectedAgentId) ?? null
        : null;

      if (refreshedSelectedAgent) {
        setAgentForm(agentFormFromAgent(refreshedSelectedAgent));
        return;
      }

      const firstAgent = loadedAgents[0] ?? null;
      setSelectedAgentId(firstAgent?.id ?? null);
      setAgentForm(firstAgent ? agentFormFromAgent(firstAgent) : emptyAgentForm());
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

  async function loadImprovements(agentId: string) {
    setIsLoadingImprovements(true);

    try {
      setImprovements(await apiGetAgentImprovements(getToken, agentId, "all"));
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Não foi possível carregar os aprimoramentos do agente."
      );
    } finally {
      setIsLoadingImprovements(false);
    }
  }

  useEffect(() => {
    void loadAgents();
  }, [getToken]);

  useEffect(() => {
    if (!selectedAgentId) {
      setKnowledge([]);
      setImprovements([]);
      setClarificationDrafts({});
      return;
    }

    void loadKnowledge(selectedAgentId);
    void loadImprovements(selectedAgentId);
  }, [getToken, selectedAgentId]);

  function changeAgentType(type: AgentFormState["type"]) {
    setAgentForm((current) => ({ ...current, type,
      ...(!selectedAgent ? {
        name: ["Agente de atendimento", "Agente de prospecção"].includes(current.name)
          ? type === "prospecting" ? "Agente de prospecção" : "Agente de atendimento" : current.name,
        systemPrompt: [defaultSystemPrompt, defaultProspectingPrompt].includes(current.systemPrompt)
          ? type === "prospecting" ? defaultProspectingPrompt : defaultSystemPrompt : current.systemPrompt
      } : {}) }));
  }

  function startNewAgent() {
    if (isSendingTestMessage) return;
    testRequestGeneration.current += 1;
    setTestFile(null);
    setTestFileKey((value) => value + 1);
    setSelectedAgentId(null);
    setAgentForm(emptyAgentForm());
    setKnowledge([]);
    setEditingKnowledgeId(null);
    setKnowledgeForm(emptyKnowledgeForm());
    setAgentDetailTab("profile");
    setImprovements([]);
    setEditingImprovementId(null);
    setImprovementForm(emptyImprovementForm());
    setClarificationDrafts({});
    setTestMessages([]);
    setTestMessageBody("");
    setTestDebug(null);
    setNotice(null);
    setError(null);
  }

  function selectAgent(agent: AiAgentDto) {
    if (isSendingTestMessage) return;
    testRequestGeneration.current += 1;
    setTestFile(null);
    setTestFileKey((value) => value + 1);
    setSelectedAgentId(agent.id);
    setAgentForm(agentFormFromAgent(agent));
    setEditingKnowledgeId(null);
    setKnowledgeForm(emptyKnowledgeForm());
    setAgentDetailTab("profile");
    // Re-clicking the selected agent must not wipe its suggestions: the loader only re-runs when the id changes.
    if (agent.id !== selectedAgentId) setImprovements([]);
    setEditingImprovementId(null);
    setImprovementForm(emptyImprovementForm());
    setClarificationDrafts({});
    setTestMessages([]);
    setTestMessageBody("");
    setTestDebug(null);
    setNotice(null);
    setError(null);
  }

  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSavingAgent(true);
    setError(null);
    setNotice(null);

    try {
      if (!agentForm.name.trim() || !agentForm.systemPrompt.trim()) {
        setAgentDetailTab("profile");
        throw new Error(!agentForm.name.trim() ? "Dê um nome para este agente." : "Escreva as instruções do agente.");
      }
      if (agentForm.type === "prospecting") {
        if (!agentForm.prospectingGoal.trim()) throw new Error("Preencha Quando passar para o humano.");
        if (agentForm.prospectingGoal.trim().length > 2000) throw new Error("Quando passar para o humano deve ter até 2000 caracteres.");
        const followupError = validateAgentFollowupConfig(agentForm.followupConfig);
        if (followupError) throw new Error(followupError);
      }
      const prospectingFields = { type: agentForm.type,
        ...(agentForm.type === "prospecting" ? { prospectingGoal: agentForm.prospectingGoal.trim(), followupConfig: agentForm.followupConfig } : {}) };
      if (selectedAgent) {
        const updatedAgent = await apiUpdateAgent(getToken, selectedAgent.id, {
          ...prospectingFields,
          name: agentForm.name,
          status: agentForm.status,
          systemPrompt: agentForm.systemPrompt,
          reasoningEffort: agentForm.reasoningEffort,
          onlyNewConversations: agentForm.onlyNewConversations,
          allowedActions: agentForm.allowedActions,
          allowedTagIds: agentForm.allowedTagIds
        });

        setAgents((current) => current.map((agent) => agent.id === updatedAgent.id ? updatedAgent : agent));
        setAgentForm(agentFormFromAgent(updatedAgent));
        setNotice("Agente atualizado.");
        return;
      }

      const createdAgent = await apiCreateAgent(getToken, {
        ...prospectingFields,
        name: agentForm.name,
        status: agentForm.status,
        systemPrompt: agentForm.systemPrompt,
        reasoningEffort: agentForm.reasoningEffort,
        onlyNewConversations: agentForm.onlyNewConversations,
        allowedActions: agentForm.allowedActions,
        allowedTagIds: agentForm.allowedTagIds
      });

      setAgents((current) => [createdAgent, ...current]);
      setSelectedAgentId(createdAgent.id);
      setAgentForm(agentFormFromAgent(createdAgent));
      setNotice("Agente criado.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar o agente.");
    } finally {
      setIsSavingAgent(false);
    }
  }

  async function deleteAgent() {
    if (!selectedAgent || isDeletingAgent || selectedAgent.status !== "inactive") {
      return;
    }

    const confirmed = window.confirm(
      `Excluir o agente “${selectedAgent.name}”? Esta ação apaga a base de conhecimento, sessões, sugestões e follow-ups ligados a ele. Antes de continuar, altere automações ou canais que ainda usam este agente.`
    );

    if (!confirmed) {
      return;
    }

    setIsDeletingAgent(true);
    setError(null);
    setNotice(null);

    try {
      await apiDeleteAgent(getToken, selectedAgent.id);
      const remainingAgents = agents.filter((agent) => agent.id !== selectedAgent.id);
      const nextAgent = remainingAgents[0] ?? null;

      testRequestGeneration.current += 1;
      setAgents(remainingAgents);
      setSelectedAgentId(nextAgent?.id ?? null);
      setAgentForm(nextAgent ? agentFormFromAgent(nextAgent) : emptyAgentForm());
      setKnowledge([]);
      setImprovements([]);
      setClarificationDrafts({});
      setKnowledgeForm(emptyKnowledgeForm());
      setKnowledgeUploadForm(emptyKnowledgeUploadForm());
      setEditingKnowledgeId(null);
      setTestFile(null);
      setTestFileKey((value) => value + 1);
      setTestMessages([]);
      setTestMessageBody("");
      setTestDebug(null);
      setNotice(`Agente “${selectedAgent.name}” excluído.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Não foi possível excluir o agente.");
    } finally {
      setIsDeletingAgent(false);
    }
  }

  function startEditingKnowledge(source: AiKnowledgeSourceDto) {
    setEditingKnowledgeId(source.id);
    setKnowledgeForm({
      type: source.type === "faq" ? "faq" : "text",
      title: source.title,
      content: source.content ?? "",
      fileUrl: source.fileUrl ?? ""
    });
    setKnowledgeInputMode("text");
    setError(null);
    setNotice(null);
  }

  function cancelKnowledgeEditing() {
    setEditingKnowledgeId(null);
    setKnowledgeForm(emptyKnowledgeForm());
    setError(null);
  }

  async function saveKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedAgent) {
      setError("Crie ou selecione um agente antes de adicionar conhecimento.");
      return;
    }

    setIsSavingKnowledge(true);
    setError(null);
    setNotice(null);

    try {
      if (editingKnowledgeSource) {
        const updatedSource = await apiUpdateAgentKnowledge(
          getToken,
          selectedAgent.id,
          editingKnowledgeSource.id,
          {
            title: knowledgeForm.title,
            content: knowledgeForm.content,
            fileUrl: knowledgeForm.fileUrl.trim() || null
          }
        );

        setKnowledge((current) =>
          current.map((source) => source.id === updatedSource.id ? updatedSource : source)
        );
        setEditingKnowledgeId(null);
        setKnowledgeForm(emptyKnowledgeForm());
        setNotice("Conhecimento atualizado.");
        return;
      }

      const createdSource = await apiCreateAgentKnowledge(getToken, selectedAgent.id, {
        type: knowledgeForm.type,
        title: knowledgeForm.title,
        content: knowledgeForm.content,
        fileUrl: knowledgeForm.fileUrl.trim() || null
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

  async function deleteKnowledgeSource(source: AiKnowledgeSourceDto) {
    if (!selectedAgent || deletingKnowledgeId) {
      return;
    }

    const confirmed = window.confirm(
      `Excluir a fonte “${source.title}”? O agente deixará de usar esse conteúdo e a ação não poderá ser desfeita.`
    );

    if (!confirmed) {
      return;
    }

    setDeletingKnowledgeId(source.id);
    setError(null);
    setNotice(null);

    try {
      await apiDeleteAgentKnowledge(getToken, selectedAgent.id, source.id);
      setKnowledge((current) => current.filter((item) => item.id !== source.id));
      if (editingKnowledgeId === source.id) {
        setEditingKnowledgeId(null);
        setKnowledgeForm(emptyKnowledgeForm());
      }
      setNotice("Fonte de conhecimento excluída.");
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Não foi possível excluir a fonte de conhecimento."
      );
    } finally {
      setDeletingKnowledgeId(null);
    }
  }

  function startEditingImprovement(improvement: AiAgentImprovementDto) {
    setEditingImprovementId(improvement.id);
    setImprovementForm({
      title: improvement.title,
      content: improvement.content
    });
    setError(null);
    setNotice(null);
  }

  function cancelImprovementEditing() {
    setEditingImprovementId(null);
    setImprovementForm(emptyImprovementForm());
  }

  function clarificationAnswersFor(improvement: AiAgentImprovementDto) {
    return clarificationDrafts[improvement.id] ?? improvement.clarification.answers;
  }

  function clarificationIsComplete(improvement: AiAgentImprovementDto) {
    const answers = clarificationAnswersFor(improvement);
    return improvement.clarification.questions.every((question) => Boolean(answers[question.id]?.trim()));
  }

  function clarificationIsSaved(improvement: AiAgentImprovementDto) {
    const answers = clarificationAnswersFor(improvement);
    return improvement.clarification.questions.every(
      (question) => answers[question.id]?.trim() === improvement.clarification.answers[question.id]?.trim()
    );
  }

  function setClarificationAnswer(improvement: AiAgentImprovementDto, questionId: string, answer: string) {
    setClarificationDrafts((current) => ({
      ...current,
      [improvement.id]: {
        ...(current[improvement.id] ?? improvement.clarification.answers),
        [questionId]: answer
      }
    }));
  }

  async function saveClarification(improvement: AiAgentImprovementDto) {
    if (!selectedAgent || improvementActionId) {
      return;
    }

    if (!clarificationIsComplete(improvement)) {
      setError("Responda todas as perguntas de escopo. Quando não houver exceção, escreva “Nenhuma”.");
      return;
    }

    setImprovementActionId(improvement.id);
    setError(null);
    setNotice(null);

    try {
      const updated = await apiUpdateAgentImprovement(
        getToken,
        selectedAgent.id,
        improvement.id,
        { clarificationAnswers: clarificationAnswersFor(improvement) }
      );
      setImprovements((current) =>
        current.map((item) => item.id === updated.id ? updated : item)
      );
      setClarificationDrafts((current) => ({
        ...current,
        [updated.id]: updated.clarification.answers
      }));
      setNotice("Escopo salvo e incorporado ao conhecimento proposto.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Não foi possível salvar as respostas de escopo."
      );
    } finally {
      setImprovementActionId(null);
    }
  }

  async function normalizeImprovement(improvement: AiAgentImprovementDto) {
    if (!selectedAgent || improvementActionId) {
      return;
    }

    if (!clarificationIsComplete(improvement) || !clarificationIsSaved(improvement)) {
      setError("Complete e salve as respostas de escopo antes de pedir a interpretação do JEV.");
      return;
    }

    setImprovementActionId(improvement.id);
    setError(null);
    setNotice(null);

    try {
      const updated = await apiNormalizeAgentImprovement(getToken, selectedAgent.id, improvement.id);
      setImprovements((current) =>
        current.map((item) => item.id === updated.id ? updated : item)
      );
      setClarificationDrafts((current) => ({
        ...current,
        [updated.id]: updated.clarification.answers
      }));
      setNotice("A regra foi preparada e teve o escopo validado pelo JEV. Revise o texto antes de aprovar.");
    } catch (normalizationError) {
      setError(
        normalizationError instanceof Error
          ? normalizationError.message
          : "Não foi possível preparar a regra para revisão."
      );
    } finally {
      setImprovementActionId(null);
    }
  }

  async function saveImprovement(improvement: AiAgentImprovementDto) {
    if (!selectedAgent || improvementActionId) {
      return;
    }

    setImprovementActionId(improvement.id);
    setError(null);
    setNotice(null);

    try {
      const updated = await apiUpdateAgentImprovement(
        getToken,
        selectedAgent.id,
        improvement.id,
        improvementForm
      );
      setImprovements((current) =>
        current.map((item) => item.id === updated.id ? updated : item)
      );
      setEditingImprovementId(null);
      setImprovementForm(emptyImprovementForm());
      setNotice("Sugestão de aprimoramento atualizada.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Não foi possível atualizar a sugestão de aprimoramento."
      );
    } finally {
      setImprovementActionId(null);
    }
  }

  async function approveImprovement(improvement: AiAgentImprovementDto) {
    if (!selectedAgent || improvementActionId) {
      return;
    }

    const isEditing = editingImprovementId === improvement.id;
    if (!clarificationIsComplete(improvement)) {
      setError("Complete e salve as perguntas de escopo antes de incluir este aprimoramento na base.");
      return;
    }
    if (!clarificationIsSaved(improvement)) {
      setError("Salve as respostas de escopo antes de incluir este aprimoramento na base.");
      return;
    }
    if (!improvement.clarification.normalization) {
      setError("Peça para o JEV interpretar o escopo antes de incluir este aprimoramento na base.");
      return;
    }
    const confirmed = window.confirm(
      "Aprovar esta sugestão e incluí-la na base de conhecimento do agente? O conteúdo aprovado poderá ser usado nas próximas conversas equivalentes."
    );
    if (!confirmed) {
      return;
    }

    setImprovementActionId(improvement.id);
    setError(null);
    setNotice(null);

    try {
      const updated = await apiApproveAgentImprovement(
        getToken,
        selectedAgent.id,
        improvement.id,
        isEditing ? improvementForm : {}
      );
      setImprovements((current) =>
        current.map((item) => item.id === updated.id ? updated : item)
      );
      setEditingImprovementId(null);
      setImprovementForm(emptyImprovementForm());
      await loadKnowledge(selectedAgent.id);
      setNotice("Sugestão aprovada e adicionada à base de conhecimento.");
    } catch (approveError) {
      setError(
        approveError instanceof Error
          ? approveError.message
          : "Não foi possível aprovar a sugestão de aprimoramento."
      );
    } finally {
      setImprovementActionId(null);
    }
  }

  async function rejectImprovement(improvement: AiAgentImprovementDto) {
    if (!selectedAgent || improvementActionId) {
      return;
    }

    const confirmed = window.confirm(
      `Recusar a sugestão “${improvement.title}”? Ela não será adicionada à base de conhecimento.`
    );
    if (!confirmed) {
      return;
    }

    setImprovementActionId(improvement.id);
    setError(null);
    setNotice(null);

    try {
      const updated = await apiUpdateAgentImprovement(
        getToken,
        selectedAgent.id,
        improvement.id,
        { reject: true }
      );
      setImprovements((current) =>
        current.map((item) => item.id === updated.id ? updated : item)
      );
      if (editingImprovementId === improvement.id) {
        cancelImprovementEditing();
      }
      setNotice("Sugestão de aprimoramento recusada.");
    } catch (rejectError) {
      setError(
        rejectError instanceof Error
          ? rejectError.message
          : "Não foi possível recusar a sugestão de aprimoramento."
      );
    } finally {
      setImprovementActionId(null);
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
        category: normalizeKnowledgeCategoryInput(knowledgeUploadForm.category) || "outro",
        fileName: file.name,
        mimeType: guessMimeType(file),
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
    if (isSendingTestMessage) return;

    if (!selectedAgent) {
      setError("Salve ou selecione um agente antes de testar.");
      return;
    }

    const content = testMessageBody.trim() || (testFile ? `Arquivo enviado: ${testFile.name}` : "");
    if (!content) {
      return;
    }
    if (testFile && content.length > 3000) {
      setError("Com anexo, escreva uma mensagem de até 3.000 caracteres. Os dados do arquivo serão lidos separadamente.");
      return;
    }

    const nextMessages: AgentTestChatMessageDto[] = [
      ...testMessages,
      { role: "user", content }
    ];
    const requestGeneration = ++testRequestGeneration.current;
    setTestMessages(nextMessages);
    setTestMessageBody("");
    setIsSendingTestMessage(true);
    setError(null);
    setNotice(null);

    try {
      if (testFile) validateTestUpload(testFile);
      const attachment = testFile ? { fileName: testFile.name, mimeType: getTestUploadMime(testFile), base64Content: await fileToBase64(testFile) } : undefined;
      const result = await apiSendAgentTestChatMessage(getToken, selectedAgent.id, {
        messages: nextMessages,
        ...(attachment ? { attachment } : {})
      });
      if (requestGeneration !== testRequestGeneration.current) return;

      const retainedMessages = result.processedMessage
        ? [...nextMessages.slice(0,-1), result.processedMessage] : nextMessages;
      setTestMessages([...retainedMessages, result.message]);
      setTestFile(null);
      setTestFileKey((value) => value + 1);
      setTestDebug({ ...result.debug,
        knowledgeMatches: result.knowledgeMatches,
        output: result.output
      });
    } catch (testError) {
      if (requestGeneration !== testRequestGeneration.current) return;
      setTestMessages(testMessages);
      setTestMessageBody(content);
      setTestDebug(testError instanceof ApiRequestError && testError.debug
        ? testError.debug
        : {
          error: testError instanceof Error ? testError.message : "Erro desconhecido no teste."
        });
      setError(testError instanceof Error ? testError.message : "Não foi possível testar o agente.");
    } finally {
      if (requestGeneration === testRequestGeneration.current) setIsSendingTestMessage(false);
    }
  }

  function resetTestChat() {
    if (isSendingTestMessage) return;
    testRequestGeneration.current += 1;
    setTestFile(null);
    setTestFileKey((value) => value + 1);
    setTestMessages([]);
    setTestMessageBody("");
    setTestDebug(null);
    setError(null);
    setNotice(null);
  }

  function toggleAllowedTag(tagId: string) {
    setAgentForm((current) => ({
      ...current,
      allowedTagIds: current.allowedTagIds.includes(tagId)
        ? current.allowedTagIds.filter((currentTagId) => currentTagId !== tagId)
        : [...current.allowedTagIds, tagId]
    }));
  }

  function toggleAllowedAction(action: AiAgentAllowedAction) {
    setAgentForm((current) => ({
      ...current,
      allowedActions: current.allowedActions.includes(action)
        ? current.allowedActions.filter((currentAction) => currentAction !== action)
        : [...current.allowedActions, action]
    }));
  }

  function acceptImportedAgent(agent: AiAgentDto) {
    testRequestGeneration.current += 1;
    setIsSendingTestMessage(false);
    setError(null);
    setTestFile(null);
    setTestFileKey((value) => value + 1);
    setTestMessageBody("");
    setAgents((current) => [agent, ...current.filter((item) => item.id !== agent.id)]);
    setSelectedAgentId(agent.id);
    setAgentForm(agentFormFromAgent(agent));
    setKnowledge([]);
    setImprovements([]);
    setClarificationDrafts({});
    setTestMessages([]);
    setTestDebug(null);
  }

  const isFormTab = agentDetailTab === "profile" || agentDetailTab === "capabilities";
  const workspaceTabs: Array<{ id: AgentDetailTab; label: string; icon: typeof Bot; needsAgent: boolean; count?: number }> = [
    { id: "profile", label: "Quem é o agente", icon: UserRound, needsAgent: false },
    { id: "capabilities", label: "O que ele pode fazer", icon: ShieldCheck, needsAgent: false },
    { id: "knowledge", label: "Conhecimento", icon: BookOpen, needsAgent: true, count: selectedAgent ? knowledge.length : undefined },
    { id: "improvements", label: "Aprimoramentos", icon: Lightbulb, needsAgent: true, count: pendingImprovementCount || undefined },
    { id: "test", label: "Testar", icon: MessageSquare, needsAgent: true }
  ];

  return (
    <section className="module-page agents-page" aria-label="Agentes">
      <header className="agents-page__header">
        <div>
          <h1>Agentes</h1>
          <p>Quem atende seus clientes no WhatsApp, o que cada um sabe e o que pode fazer sozinho.</p>
        </div>
        <div className="module-header-actions">
          <button className="secondary-button" type="button" onClick={() => void loadAgents()}>
            <RefreshCw size={14} />
            Atualizar
          </button>
          <button
            className={`secondary-button${isPackagePanelOpen ? " is-active" : ""}`}
            type="button"
            aria-expanded={isPackagePanelOpen}
            onClick={() => setIsPackagePanelOpen((current) => !current)}
          >
            <PackageOpen size={14} />
            Importar ou exportar
          </button>
          <button className="primary-button" type="button" onClick={startNewAgent}>
            <Plus size={14} />
            Novo agente
          </button>
        </div>
      </header>

      {error ? <p className="error-note agents-page__note">{error}</p> : null}
      {notice ? <p className="success-note agents-page__note">{notice}</p> : null}

      {isPackagePanelOpen ? (
        <AgentPackagePanel
          getToken={getToken}
          selectedAgent={selectedAgent}
          onImported={acceptImportedAgent}
        />
      ) : null}

      <div className="agents-layout">
        <aside className="agents-roster" aria-label="Agentes configurados">
          <div className="agents-roster__title">
            <h2>Seus agentes</h2>
            <span>{isLoadingAgents ? "Carregando" : agents.length === 1 ? "1 agente" : `${agents.length} agentes`}</span>
          </div>

          {!isLoadingAgents && agents.length === 0 ? (
            <div className="agents-roster__empty">
              <span className="agents-avatar agents-avatar--empty"><Bot size={18} /></span>
              <strong>Nenhum agente ainda</strong>
              <p>Crie o primeiro agente para responder seus clientes e usar em automações.</p>
            </div>
          ) : null}

          <div className="agents-roster__list" aria-label="Lista de agentes">
            {agents.map((agent) => (
              <button
                className={`agents-roster__item${agent.id === selectedAgentId ? " is-selected" : ""}`}
                key={agent.id}
                onClick={() => selectAgent(agent)}
                type="button"
                aria-pressed={agent.id === selectedAgentId}
              >
                <span className="agents-avatar" aria-hidden="true">{agentInitials(agent.name)}</span>
                <span className="agents-roster__body">
                  <strong title={agent.name}>{agent.name}</strong>
                  <span>
                    <i className={`agents-dot agents-dot--${agent.status === "active" ? "on" : "off"}`} aria-hidden="true" />
                    {agentStatusLabel(agent.status)} · {agent.type === "prospecting" ? "Prospecção" : "Atendimento"}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <button className="agents-roster__new" type="button" onClick={startNewAgent} aria-pressed={!selectedAgentId}>
            <Plus size={15} />
            Criar outro agente
          </button>
        </aside>

        <div className="agents-workspace">
          <div className="agents-hero">
            <span className="agents-avatar agents-avatar--large" aria-hidden="true">
              {selectedAgent ? agentInitials(agentForm.name || selectedAgent.name) : <Sparkles size={20} />}
            </span>
            <div className="agents-hero__body">
              <div className="agents-hero__title">
                <h2>{selectedAgent ? agentForm.name || selectedAgent.name : "Novo agente"}</h2>
                <span className={`agents-state agents-state--${agentForm.status === "active" ? "on" : "off"}`}>
                  {agentStatusLabel(agentForm.status)}
                </span>
              </div>
              <p>
                {agentForm.type === "prospecting" ? "Prospecção" : "Atendimento"}
                {selectedAgent ? ` · ${selectedAgent.model}` : " · ainda não salvo"}
              </p>
            </div>
            <dl className="agents-hero__stats">
              <div><dt>Ações ligadas</dt><dd>{agentForm.allowedActions.length} de {allowedActionLabels.length}</dd></div>
              <div><dt>Tags</dt><dd>{agentForm.allowedTagIds.length}</dd></div>
              <div><dt>Fontes</dt><dd>{selectedAgent ? knowledge.length : "—"}</dd></div>
            </dl>
          </div>

          <nav className="agents-tabs" aria-label="Conteúdo do agente" role="tablist">
            {workspaceTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  className={agentDetailTab === tab.id ? "is-active" : ""}
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={agentDetailTab === tab.id}
                  onClick={() => setAgentDetailTab(tab.id)}
                  disabled={tab.needsAgent && !selectedAgent}
                  title={tab.needsAgent && !selectedAgent ? "Salve o agente para liberar" : undefined}
                >
                  <Icon size={15} />
                  {tab.label}
                  {tab.count ? <span>{tab.count}</span> : null}
                </button>
              );
            })}
          </nav>

          {isFormTab ? (
            <form className="agents-form" onSubmit={(event) => void saveAgent(event)}>
              {agentDetailTab === "profile" ? (
                <div className="agents-columns">
                  <div className="agents-column">
                    <section className="agents-card">
                      <header className="agents-card__header">
                        <h3>Quem é este agente</h3>
                        <p>O nome aparece para o time. O tipo define em quais conversas ele entra.</p>
                      </header>
                      <label className="form-field">
                        Nome
                        <input
                          value={agentForm.name}
                          onChange={(event) => setAgentForm((current) => ({ ...current, name: event.target.value }))}
                          placeholder="Agente comercial"
                          required
                        />
                      </label>
                      <div className="form-field">
                        Tipo de agente
                        <div className="agents-choice" role="radiogroup" aria-label="Tipo de agente">
                          {([
                            ["attendance", "Atendimento", "Responde as conversas que chegam no WhatsApp."],
                            ["prospecting", "Prospecção", "Acompanha as respostas dos disparos ligados a ele."]
                          ] as const).map(([value, label, description]) => (
                            <button
                              className={`agents-choice__option${agentForm.type === value ? " is-selected" : ""}`}
                              key={value}
                              type="button"
                              role="radio"
                              aria-checked={agentForm.type === value}
                              onClick={() => changeAgentType(value)}
                            >
                              <strong>{label}</strong>
                              <span>{description}</span>
                            </button>
                          ))}
                        </div>
                        {agentForm.type === "prospecting" ? (
                          <small>Você pode prepará-lo mesmo com o módulo de prospecção desativado.</small>
                        ) : null}
                      </div>
                      <div className="form-field">
                        Status do agente
                        <div className="agents-choice" role="radiogroup" aria-label="Status do agente">
                          {([
                            ["active", "Ativo", "Atende de verdade, conforme as regras abaixo."],
                            ["inactive", "Inativo", "Fica parado. Use para revisar com calma."]
                          ] as const).map(([value, label, description]) => (
                            <button
                              className={`agents-choice__option${agentForm.status === value ? " is-selected" : ""}`}
                              key={value}
                              type="button"
                              role="radio"
                              aria-checked={agentForm.status === value}
                              onClick={() => setAgentForm((current) => ({ ...current, status: value }))}
                            >
                              <strong>{label}</strong>
                              <span>{description}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </section>

                    <section className="agents-card">
                      <header className="agents-card__header">
                        <h3>Como ele responde</h3>
                        <p>Velocidade da resposta e em quais conversas ele pode entrar.</p>
                      </header>
                      <label className="form-field">
                        Modo de resposta
                        <select aria-label="Modo de resposta" value={agentForm.reasoningEffort} onChange={(event) => setAgentForm((current) => ({ ...current, reasoningEffort: event.target.value === "low" ? "low" : "none" }))}>
                          <option value="none">Rápido</option>
                          <option value="low">Mais cuidadoso</option>
                        </select>
                        <small>Nos modelos GPT-5.6 e GPT-6, o modo cuidadoso usa raciocínio curto antes de responder. Pode aumentar o tempo e o consumo de tokens; não garante acerto.</small>
                      </label>
                      <label className="agents-switch-row">
                        <input
                          type="checkbox"
                          role="switch"
                          checked={agentForm.onlyNewConversations}
                          onChange={(event) => setAgentForm((current) => ({ ...current, onlyNewConversations: event.target.checked }))}
                        />
                        <span className="agents-switch-row__body">
                          <strong>Responder só conversas novas</strong>
                          <span>Ligado: a IA só inicia em conversas sem histórico anterior no WhatsApp. Conversas antigas ficam como "Humano necessário" para o time atender.</span>
                        </span>
                      </label>
                    </section>

                    {selectedAgent ? (
                      <section className="agent-danger-zone" aria-label="Excluir agente">
                        <div>
                          <h3>Excluir agente</h3>
                          <p>
                            A exclusão remove a base de conhecimento e o histórico operacional deste agente.
                            {selectedAgent.status === "active"
                              ? " Inative e salve o agente antes de excluí-lo."
                              : " Confira antes se automações ou canais ainda dependem dele."}
                          </p>
                        </div>
                        <button
                          className="secondary-button danger-button"
                          type="button"
                          onClick={() => void deleteAgent()}
                          disabled={
                            isDeletingAgent ||
                            isSavingAgent ||
                            isSendingTestMessage ||
                            selectedAgent.status !== "inactive"
                          }
                        >
                          <Trash2 size={15} />
                          {isDeletingAgent ? "Excluindo" : "Excluir agente"}
                        </button>
                      </section>
                    ) : null}
                  </div>

                  <div className="agents-column">
                    <section className="agents-card">
                      <header className="agents-card__header agents-card__header--split">
                        <div>
                          <h3>As instruções dele</h3>
                          <p>Escreva como você explicaria o trabalho para um atendente novo.</p>
                        </div>
                        <span>{agentForm.systemPrompt.length} caracteres</span>
                      </header>
                      <label className="form-field">
                        Prompt do sistema
                        <textarea
                          className="agents-prompt"
                          value={agentForm.systemPrompt}
                          onChange={(event) => setAgentForm((current) => ({ ...current, systemPrompt: event.target.value }))}
                          required
                          rows={14}
                        />
                      </label>
                    </section>

                    {agentForm.type === "prospecting" ? (
                      <section className="agents-card">
                        <header className="agents-card__header">
                          <h3>Passar para uma pessoa</h3>
                          <p>Defina o resultado esperado e em quais situações o time deve assumir a conversa.</p>
                        </header>
                        <label className="form-field">Quando passar para o humano
                          <textarea required rows={4} maxLength={2000} value={agentForm.prospectingGoal}
                            placeholder="Ex.: Quando o contato pedir uma proposta ou confirmar interesse em agendar uma conversa."
                            onChange={(event) => setAgentForm((current) => ({ ...current, prospectingGoal: event.target.value }))} />
                        </label>
                        <AgentFollowupConfigEditor value={agentForm.followupConfig}
                          onChange={(followupConfig) => setAgentForm((current) => ({ ...current, followupConfig }))} />
                      </section>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="agents-columns">
                  <div className="agents-column">
                    <section className="agents-card" aria-label="Ações permitidas">
                      <header className="agents-card__header agents-card__header--split">
                        <div>
                          <h3>Ações permitidas</h3>
                          <p>Ligue só o que ele pode fazer sozinho. O que estiver desligado ele não faz, nem se o cliente pedir.</p>
                        </div>
                        <span>{agentForm.allowedActions.length} de {allowedActionLabels.length} ligadas</span>
                      </header>
                      {allowedActionGroups.map((group) => {
                        const groupActions = allowedActionLabels.filter((action) => group.actions.includes(action.value));
                        const enabledCount = groupActions.filter((action) => agentForm.allowedActions.includes(action.value)).length;

                        return (
                          <div className="agents-group" key={group.title}>
                            <div className="agents-group__title">
                              <strong>{group.title}</strong>
                              <span>{enabledCount} de {groupActions.length}</span>
                            </div>
                            {groupActions.map((action) => (
                              <label className="agents-switch-row" key={action.value}>
                                <input
                                  type="checkbox"
                                  role="switch"
                                  checked={agentForm.allowedActions.includes(action.value)}
                                  onChange={() => toggleAllowedAction(action.value)}
                                />
                                <span className="agents-switch-row__body">
                                  <strong>{action.label}</strong>
                                  <span>{action.description}</span>
                                </span>
                              </label>
                            ))}
                          </div>
                        );
                      })}
                    </section>
                  </div>

                  <div className="agents-column">
                    <section className="agents-card" aria-label="Tags permitidas">
                      <header className="agents-card__header agents-card__header--split">
                        <div>
                          <h3>Tags permitidas</h3>
                          <p>Selecione as tags que este agente pode aplicar.</p>
                        </div>
                        <span>{agentForm.allowedTagIds.length} selecionadas</span>
                      </header>

                      {tags.length === 0 ? (
                        <p className="list-note">Crie tags em Ajustes antes de selecionar.</p>
                      ) : (
                        <div className="agents-tag-list">
                          {tags.map((tag) => {
                            const isSelected = agentForm.allowedTagIds.includes(tag.id);

                            return (
                              <label
                                className={`agents-tag-option${isSelected ? " is-selected" : ""}`}
                                key={tag.id}
                                style={isSelected ? { borderColor: tag.color } : undefined}
                              >
                                <input
                                  checked={isSelected}
                                  onChange={() => toggleAllowedTag(tag.id)}
                                  type="checkbox"
                                />
                                <span
                                  className="settings-tag-swatch"
                                  style={{ backgroundColor: tag.color }}
                                  aria-hidden="true"
                                />
                                <span className="agents-tag-option__body">
                                  <strong>{tag.name}</strong>
                                  {tag.useGuide ? <span>{tag.useGuide}</span> : null}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  </div>
                </div>
              )}

              <div className="agents-savebar">
                <span>
                  {selectedAgent
                    ? "As mudanças só valem depois de salvar."
                    : "O agente só aparece na lista depois de criado."}
                </span>
                <button className="primary-button" type="submit" disabled={isSavingAgent}>
                  <Save size={15} />
                  {isSavingAgent ? "Salvando" : selectedAgent ? "Salvar alterações" : "Criar agente"}
                </button>
              </div>
            </form>
          ) : null}

          {agentDetailTab === "knowledge" ? (
            <div className="agents-columns" aria-label="Conhecimento">
              <section className="agents-card">
                <header className="agents-card__header agents-card__header--split">
                  <div>
                    <h3>O que ele já sabe</h3>
                    <p>Documentos e respostas que o agente consulta antes de responder.</p>
                  </div>
                  <span>{knowledge.length === 1 ? "1 fonte" : `${knowledge.length} fontes`}</span>
                </header>
            <div className="knowledge-source-list" aria-label="Fontes de conhecimento salvas">
              {isLoadingKnowledge ? <p className="list-note">Carregando conhecimento...</p> : null}
              {!isLoadingKnowledge && selectedAgent && knowledge.length === 0 ? (
                <p className="list-note">Nenhuma fonte cadastrada para este agente.</p>
              ) : null}
              {knowledge.map((source) => {
                const category = readKnowledgeCategory(source);
                const categoryLabel = knowledgeCategoryLabel(category);

                return (
                  <article className="knowledge-source-card" key={source.id}>
                    <div className="knowledge-source-card__header">
                      <div className="assistant-log-header">
                        <span className="status-badge status-badge--bot">
                          {source.type === "faq" ? <HelpCircle size={12} /> : <FileText size={12} />}
                          {knowledgeTypeLabel(source.type)}
                        </span>
                        {categoryLabel ? (
                          <span className="status-badge status-badge--bot">{categoryLabel}</span>
                        ) : null}
                        <span className={`status-badge status-badge--${source.status === "ready" ? "open" : "waiting"}`}>
                          {source.status === "ready" ? "Pronto" : source.status === "processing" ? "Processando" : "Falhou"}
                        </span>
                      </div>
                      <div className="knowledge-source-card__actions">
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => startEditingKnowledge(source)}
                          disabled={!selectedAgent || Boolean(deletingKnowledgeId)}
                          aria-label={`Editar conhecimento ${source.title}`}
                        >
                          <Pencil size={14} />
                          Editar
                        </button>
                        <button
                          className="secondary-button danger-button"
                          type="button"
                          onClick={() => void deleteKnowledgeSource(source)}
                          disabled={!selectedAgent || Boolean(deletingKnowledgeId)}
                          aria-label={`Excluir conhecimento ${source.title}`}
                        >
                          <Trash2 size={14} />
                          {deletingKnowledgeId === source.id ? "Excluindo" : "Excluir"}
                        </button>
                      </div>
                    </div>
                    <strong>{source.title}</strong>
                    {source.content ? <p className="assistant-log-result">{source.content}</p> : null}
                    {source.fileName ? <small>{source.fileName}</small> : null}
                    {source.fileUrl ? (
                      <a href={source.fileUrl} target="_blank" rel="noreferrer">
                        {source.fileUrl}
                      </a>
                    ) : null}
                  </article>
                );
              })}
            </div>
              </section>

              <section className="agents-card">
            <div className="knowledge-composer">
              <div className="panel-title-row compact">
                <h3>{editingKnowledgeSource ? "Editar conhecimento" : "Adicionar conhecimento"}</h3>
                {editingKnowledgeSource ? (
                  <button className="secondary-button" onClick={cancelKnowledgeEditing} type="button">
                    Cancelar
                  </button>
                ) : (
                  <div className="segmented-control" role="tablist" aria-label="Tipo de conhecimento">
                    <button
                      className={knowledgeInputMode === "file" ? "is-active" : ""}
                      onClick={() => setKnowledgeInputMode("file")}
                      type="button"
                    >
                      <UploadCloud size={14} />
                      Arquivo
                    </button>
                    <button
                      className={knowledgeInputMode === "text" ? "is-active" : ""}
                      onClick={() => setKnowledgeInputMode("text")}
                      type="button"
                    >
                      <MessageSquare size={14} />
                      Texto
                    </button>
                  </div>
                )}
              </div>

              {!editingKnowledgeSource && knowledgeInputMode === "file" ? (
                <form className="module-form" onSubmit={(event) => void uploadKnowledge(event)}>
                  <div className="knowledge-form-grid">
                    <label className="form-field">
                      Categoria
                      <input
                        list="knowledge-category-suggestions"
                        value={knowledgeUploadForm.category}
                        onChange={(event) => setKnowledgeUploadForm((current) => ({
                          ...current,
                          category: event.target.value
                        }))}
                        onBlur={() => setKnowledgeUploadForm((current) => ({
                          ...current,
                          category: normalizeKnowledgeCategoryInput(current.category) || "outro"
                        }))}
                        placeholder="Ex.: medidas_e_tolerancias"
                        disabled={!selectedAgent}
                        required
                      />
                      <datalist id="knowledge-category-suggestions">
                        {knowledgeUploadCategories.map((category) => (
                          <option key={category.value} value={category.value}>
                            {category.label}
                          </option>
                        ))}
                      </datalist>
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
                  </div>
                  <label className="form-field">
                    Arquivo PDF ou TXT
                    <input
                      accept="application/pdf,text/plain,.txt,.pdf"
                      disabled={!selectedAgent}
                      key={knowledgeUploadForm.file ? "selected-file" : "empty-file"}
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        setKnowledgeUploadForm((current) => ({
                          ...current,
                          file,
                          title: current.title.trim() || file?.name.replace(/\.[^.]+$/, "") || ""
                        }));
                      }}
                      type="file"
                    />
                  </label>
                  {knowledgeUploadForm.file ? (
                    <p className="list-note">
                      Selecionado: {knowledgeUploadForm.file.name}
                    </p>
                  ) : null}
                  <button
                    className="secondary-button"
                    type="submit"
                    disabled={!selectedAgent || !knowledgeUploadForm.file || isUploadingKnowledge}
                  >
                    <Plus size={15} />
                    {isUploadingKnowledge ? "Subindo" : "Subir documento"}
                  </button>
                </form>
              ) : (
                <form className="module-form" onSubmit={(event) => void saveKnowledge(event)}>
                  <div className="knowledge-form-grid">
                    {editingKnowledgeSource ? (
                      <div className="form-field form-field--read-only">
                        Tipo da fonte
                        <strong>{knowledgeTypeLabel(editingKnowledgeSource.type)}</strong>
                      </div>
                    ) : (
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
                    )}
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
                  </div>
                  <label className="form-field">
                    {editingKnowledgeSource?.type === "file" ? "Conteúdo extraído" : "Conteúdo"}
                    <textarea
                      value={knowledgeForm.content}
                      onChange={(event) => setKnowledgeForm((current) => ({ ...current, content: event.target.value }))}
                      placeholder="Resposta, instruções ou texto de referência para o agente."
                      disabled={!selectedAgent}
                      required={editingKnowledgeSource?.type !== "file"}
                      rows={5}
                    />
                  </label>
                  <label className="form-field">
                    URL do anexo (opcional)
                    <input
                      value={knowledgeForm.fileUrl}
                      onChange={(event) => setKnowledgeForm((current) => ({ ...current, fileUrl: event.target.value }))}
                      placeholder="https://exemplo.com/catalogo.pdf"
                      disabled={!selectedAgent}
                      type="url"
                    />
                  </label>
                  <button className="secondary-button" type="submit" disabled={!selectedAgent || isSavingKnowledge}>
                    {editingKnowledgeSource ? <Save size={15} /> : <Plus size={15} />}
                    {isSavingKnowledge
                      ? editingKnowledgeSource ? "Salvando" : "Adicionando"
                      : editingKnowledgeSource ? "Salvar conhecimento" : "Adicionar texto"}
                  </button>
                </form>
              )}
            </div>
              </section>
            </div>
          ) : null}

          {agentDetailTab === "improvements" ? (
            <section className="agents-card agent-improvements-panel" aria-label="Aprimoramentos do agente">
              <div className="panel-title-row">
                <div>
                  <h2>Aprimoramentos</h2>
                  <p className="agent-improvements-panel__intro">
                    O JEV identifica decisões explícitas do time depois de um repasse. Nada entra na
                    base automaticamente: revise, edite, aprove ou recuse cada sugestão.
                  </p>
                </div>
                <span className={`status-badge status-badge--${pendingImprovementCount > 0 ? "waiting" : "open"}`}>
                  {pendingImprovementCount} pendentes
                </span>
              </div>

              <div className="segmented-control" role="tablist" aria-label="Filtro de aprimoramentos">
                {([
                  ["pending", "Pendentes"],
                  ["accepted", "Incluídas"],
                  ["rejected", "Recusadas"],
                  ["all", "Todas"]
                ] as Array<[ImprovementFilter, string]>).map(([filter, label]) => (
                  <button
                    className={improvementFilter === filter ? "is-active" : ""}
                    key={filter}
                    onClick={() => setImprovementFilter(filter)}
                    role="tab"
                    aria-selected={improvementFilter === filter}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="agent-improvement-list" aria-label="Sugestões de aprimoramento">
                {isLoadingImprovements ? <p className="list-note">Carregando aprimoramentos...</p> : null}
                {!isLoadingImprovements && !selectedAgent ? (
                  <p className="list-note">Selecione um agente para revisar seus aprimoramentos.</p>
                ) : null}
                {!isLoadingImprovements && selectedAgent && visibleImprovements.length === 0 ? (
                  <div className="agent-improvements-empty">
                    <Lightbulb size={20} aria-hidden="true" />
                    <div>
                      <strong>Nenhuma sugestão nesta lista</strong>
                      <p>
                        Novas sugestões aparecem quando o humano resolve um repasse com uma orientação
                        comercial clara e reutilizável.
                      </p>
                    </div>
                  </div>
                ) : null}
                {visibleImprovements.map((improvement) => {
                  const isEditing = editingImprovementId === improvement.id;
                  const isWorking = improvementActionId === improvement.id;
                  const clarificationComplete = clarificationIsComplete(improvement);
                  const clarificationSaved = clarificationIsSaved(improvement);
                  const clarificationAnswers = clarificationAnswersFor(improvement);
                  const normalization = improvement.clarification.normalization;

                  return (
                    <article className="agent-improvement-card" key={improvement.id}>
                      <div className="agent-improvement-card__header">
                        <div className="assistant-log-header">
                          <span className="status-badge status-badge--bot">
                            <Lightbulb size={12} />
                            {improvementKindLabel(improvement.kind)}
                          </span>
                          <span className={`status-badge status-badge--${
                            improvement.status === "pending"
                              ? "waiting"
                              : improvement.status === "accepted" ? "open" : "closed"
                          }`}>
                            {improvementStatusLabel(improvement.status)}
                          </span>
                        </div>
                      </div>

                      {isEditing ? (
                        <form
                          className="module-form agent-improvement-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveImprovement(improvement);
                          }}
                        >
                          <label className="form-field">
                            Título da regra
                            <input
                              value={improvementForm.title}
                              onChange={(event) =>
                                setImprovementForm((current) => ({ ...current, title: event.target.value }))
                              }
                              required
                            />
                          </label>
                          <label className="form-field">
                            Conteúdo que será usado pelo agente
                            <textarea
                              value={improvementForm.content}
                              onChange={(event) =>
                                setImprovementForm((current) => ({ ...current, content: event.target.value }))
                              }
                              rows={7}
                              required
                            />
                          </label>
                          <div className="agent-improvement-card__actions">
                            <button className="secondary-button" type="button" onClick={cancelImprovementEditing}>
                              Cancelar
                            </button>
                            <button className="secondary-button" type="submit" disabled={isWorking}>
                              <Save size={15} />
                              {isWorking ? "Salvando" : "Salvar edição"}
                            </button>
                            <button
                              className="primary-button"
                              type="button"
                              disabled={
                                isWorking ||
                                !clarificationComplete ||
                                !clarificationSaved ||
                                !normalization
                              }
                              onClick={() => void approveImprovement(improvement)}
                            >
                              <Check size={15} />
                              Aprovar e incluir
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <h3>{improvement.title}</h3>
                          {improvement.rationale ? (
                            <p className="agent-improvement-card__rationale">{improvement.rationale}</p>
                          ) : null}
                          <div className="agent-improvement-evidence">
                            <div>
                              <span>Pedido que originou a sugestão</span>
                              <p>{improvement.sourceCustomerMessage}</p>
                            </div>
                            <div>
                              <span>Resposta confirmada pelo humano</span>
                              <p>{improvement.sourceHumanReply}</p>
                            </div>
                          </div>
                          <div className="agent-improvement-proposal">
                            <span>Conhecimento proposto</span>
                            <p>{improvement.content}</p>
                          </div>
                          {improvement.status === "pending" ? (
                            <>
                              <section className="agent-improvement-clarification" aria-label="Completar escopo">
                                <div className="agent-improvement-clarification__header">
                                  <HelpCircle size={17} aria-hidden="true" />
                                  <div>
                                    <h4>Complete o escopo antes de incluir</h4>
                                    <p>
                                      Essas respostas tornam a regra específica. Se não houver exceção,
                                      responda “Nenhuma”.
                                    </p>
                                  </div>
                                </div>
                                <div className="agent-improvement-clarification__questions">
                                  {improvement.clarification.questions.map((question) => (
                                    <label className="form-field" key={question.id}>
                                      {question.question}
                                      <textarea
                                        rows={3}
                                        value={clarificationAnswers[question.id] ?? ""}
                                        onChange={(event) =>
                                          setClarificationAnswer(improvement, question.id, event.target.value)
                                        }
                                        disabled={isWorking}
                                        required
                                      />
                                      <small>{question.help}</small>
                                    </label>
                                  ))}
                                </div>
                                <div className="agent-improvement-card__actions">
                                  <p className="agent-improvement-clarification__status">
                                    {clarificationComplete
                                      ? clarificationSaved
                                        ? normalization
                                          ? "Regra preparada e escopo validado. Revise o texto e inclua quando estiver correto."
                                          : "Escopo salvo. Prepare a proposta para revisão antes de incluir."
                                        : "Respostas prontas. Salve o escopo para atualizar a regra proposta."
                                      : "Responda as duas perguntas para liberar a aprovação."}
                                  </p>
                                  <button
                                    className="secondary-button"
                                    type="button"
                                    onClick={() => void saveClarification(improvement)}
                                    disabled={isWorking || !clarificationComplete || clarificationSaved}
                                  >
                                    <Save size={15} />
                                    {isWorking ? "Salvando" : "Salvar escopo"}
                                  </button>
                                  <button
                                    className="primary-button"
                                    type="button"
                                    onClick={() => void normalizeImprovement(improvement)}
                                    disabled={isWorking || !clarificationComplete || !clarificationSaved}
                                  >
                                    <Sparkles size={15} />
                                    {isWorking ? "Preparando" : "Preparar regra com IA"}
                                  </button>
                                </div>
                              </section>
                              {normalization ? (
                                <div className="agent-improvement-normalization" aria-live="polite">
                                  <ShieldCheck size={17} aria-hidden="true" />
                                  <div>
                                    <strong>Regra interpretada pelo JEV</strong>
                                    <p>
                                      {improvementScopeLabel(normalization.scope)} {normalization.requiresHandoffOutsideScope
                                        ? "Qualquer caso fora desse escopo seguirá para o comercial."
                                        : "O escopo amplo foi confirmado pelo time."}
                                    </p>
                                  </div>
                                </div>
                              ) : null}
                              <div className="agent-improvement-card__actions">
                                <button
                                  className="secondary-button"
                                  type="button"
                                  onClick={() => startEditingImprovement(improvement)}
                                  disabled={isWorking}
                                >
                                  <Pencil size={15} />
                                  Editar
                                </button>
                                <button
                                  className="secondary-button danger-button"
                                  type="button"
                                  onClick={() => void rejectImprovement(improvement)}
                                  disabled={isWorking}
                                >
                                  <Trash2 size={15} />
                                  {isWorking ? "Processando" : "Recusar"}
                                </button>
                                <button
                                  className="primary-button"
                                  type="button"
                                  onClick={() => void approveImprovement(improvement)}
                                  disabled={
                                    isWorking ||
                                    !clarificationComplete ||
                                    !clarificationSaved ||
                                    !normalization
                                  }
                                >
                                  <Check size={15} />
                                  {isWorking ? "Processando" : "Aprovar e incluir"}
                                </button>
                              </div>
                            </>
                          ) : null}
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}

          {agentDetailTab === "test" ? (
            <div className="agents-columns agents-columns--test" aria-label="Teste do agente">
              <section className="agents-card agent-test-panel">
                <header className="agents-card__header agents-card__header--split">
                  <div>
                    <h3>Teste do agente</h3>
                    <p>Converse como se fosse um cliente para ver como ele usa as instruções e o conhecimento.</p>
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={resetTestChat}
                    disabled={isSendingTestMessage || (testMessages.length === 0 && !testMessageBody && !testFile)}
                  >
                    <RotateCcw size={14} />
                    Resetar teste
                  </button>
                </header>

                <div className="agent-test-chat" aria-label="Chat de teste do agente">
                  {testMessages.length === 0 ? (
                    <div className="agent-test-empty">
                      <BookOpen size={18} />
                      <span>Envie uma pergunta para validar como o agente usa o conhecimento.</span>
                    </div>
                  ) : null}
                  {testMessages.map((message, index) => (
                    <article
                      className={`agent-test-message agent-test-message--${message.role}`}
                      key={`${message.role}-${index}-${message.content.slice(0, 12)}`}
                    >
                      <span className="agent-test-message__author">{message.role === "user" ? "Você" : "Agente"}</span>
                      <p>{message.content}</p>
                    </article>
                  ))}
                </div>

                <form className="agents-test-composer" onSubmit={(event) => void sendTestMessage(event)}>
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
                  <div className="agents-test-composer__row">
                    <label className="form-field agents-test-composer__file">
                      Anexo de teste — PDF, imagem ou áudio (até 8 MB)
                      <input key={testFileKey} type="file" aria-label="Anexo de teste"
                        accept=".pdf,.png,.jpg,.jpeg,.webp,.mp3,.m4a,.wav,.ogg,.opus,.webm"
                        disabled={!selectedAgent || isSendingTestMessage}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0] ?? null;
                          try {
                            if (file) validateTestUpload(file);
                            setTestFile(file); setError(null);
                          } catch (error) {
                            setTestFile(null); event.currentTarget.value = "";
                            setError(error instanceof Error ? error.message : "Anexo inválido.");
                          }
                        }} />
                    </label>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={!selectedAgent || (!testMessageBody.trim() && !testFile) || isSendingTestMessage}
                    >
                      <Send size={15} />
                      {isSendingTestMessage ? "Enviando" : "Enviar teste"}
                    </button>
                  </div>
                  {testFile ? <div className="muted">{testFile.name} · <button type="button" disabled={isSendingTestMessage} onClick={() => { setTestFile(null); setTestFileKey((value) => value + 1); }}>Remover anexo</button></div> : null}
                </form>
              </section>

              <section className="agents-card">
                <header className="agents-card__header">
                  <h3>O que conferir</h3>
                  <p>Simulação: não envia mensagens ao WhatsApp nem executa o repasse. Confira abaixo os dados lidos e o resumo proposto.</p>
                </header>
                {testDebug ? null : <p className="list-note">Depois do primeiro teste, aparecem aqui o que ele leu nos anexos e o repasse que faria.</p>}
                <AgentTestInspection debug={testDebug} />
                <details className="agent-test-debug">
                  <summary>Logs do teste</summary>
                  <pre>{formatAgentTestDebug(testDebug)}</pre>
                </details>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
