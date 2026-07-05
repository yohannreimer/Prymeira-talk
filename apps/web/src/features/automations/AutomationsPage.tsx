import { useTalkAuth } from "../../app/auth";
import {
  ArrowLeft,
  CheckCircle2,
  History,
  Maximize2,
  Minimize2,
  Plus,
  Save,
  ToggleLeft,
  ToggleRight,
  Trash2,
  TriangleAlert,
  Zap
} from "lucide-react";
import { type Dispatch, FormEvent, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  automationFlowSchema,
  getAutomationBlock,
  type AutomationBlockType,
  type AutomationFlowDefinition,
  type ContactDto
} from "@prymeira-talk/shared";
import {
  apiCreateAutomation,
  apiDeleteAutomation,
  apiGetAgents,
  apiGetContacts,
  apiGetAutomationRuns,
  apiGetAutomations,
  apiTestAutomation,
  apiUpdateAutomation,
  type AiAgentDto,
  type AutomationActionDto,
  type AutomationRuleDto,
  type AutomationRunDto
} from "../../app/api";
import { AutomationCanvas } from "./AutomationCanvas";
import { createDefaultAutomationFlow } from "./automationFlow";

const triggerOptions = [
  { value: "message.received", label: "Mensagem recebida" },
  { value: "conversation.closed", label: "Conversa encerrada" },
  { value: "contact.created", label: "Contato criado" },
  { value: "board.stage.changed", label: "Etapa do board alterada" }
];

const actionOptions = [
  { value: "send_message", label: "Enviar mensagem" },
  { value: "assign_department", label: "Enviar para departamento" },
  { value: "add_tag", label: "Adicionar tag" },
  { value: "create_crm_note", label: "Criar nota no CRM" }
];

interface AutomationFormState {
  name: string;
  trigger: string;
  conditionSummary: string;
  actionType: string;
  actionLabel: string;
}

interface AutomationSavePayload {
  name: string;
  trigger: string;
  conditions: { summary: string };
  actions: AutomationRuleDto["actions"];
}

export type AutomationViewMode = "hub" | "editor" | "focus";

const triggerByBlockType: Partial<Record<AutomationBlockType, string>> = {
  trigger_message_received: "message.received",
  trigger_first_message: "message.received",
  trigger_reengagement: "message.received",
  trigger_keyword: "message.received",
  trigger_tag_added: "tag.added",
  trigger_board_stage_changed: "board.stage.changed",
  trigger_conversation_closed: "conversation.closed",
  trigger_schedule: "schedule.tick",
  trigger_webhook: "webhook.received"
};

const emptyForm: AutomationFormState = {
  name: "Boas-vindas local",
  trigger: "message.received",
  conditionSummary: "Quando uma mensagem inbound chegar",
  actionType: "send_message",
  actionLabel: "Enviar saudação em modo simulado"
};

function mergeAutomation(
  automations: AutomationRuleDto[],
  automation: AutomationRuleDto
) {
  const withoutAutomation = automations.filter((current) => current.id !== automation.id);
  return [automation, ...withoutAutomation];
}

export function defaultAutomationEventKey(trigger: string, automationId: string) {
  return `${trigger}:manual-test:${automationId}`;
}

export function mergeAutomationRun(
  runs: AutomationRunDto[],
  run: AutomationRunDto
) {
  return [run, ...runs.filter((current) => current.id !== run.id)];
}

function conditionSummary(conditions: unknown) {
  if (
    typeof conditions === "object" &&
    conditions !== null &&
    "summary" in conditions &&
    typeof conditions.summary === "string"
  ) {
    return conditions.summary;
  }

  return "Sem condicoes adicionais";
}

function actionLabel(action: AutomationActionDto) {
  return action.label ?? actionOptions.find((option) => option.value === action.type)?.label ?? action.type;
}

function formatAutomationRunDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function automationRunSummary(result: unknown) {
  if (!isRecord(result)) {
    return "Resultado ainda sem detalhes.";
  }

  if (result.skippedReason === "trigger_not_matched") {
    return "Gatilho avaliado, mas não correspondeu a este evento.";
  }

  const actionResults = Array.isArray(result.actionResults) ? result.actionResults : [];
  const failedAction = actionResults.find(
    (item): item is Record<string, unknown> => isRecord(item) && item.status === "failed"
  );

  if (failedAction) {
    if (typeof failedAction.error === "string") return failedAction.error;
    if (typeof failedAction.message === "string") return failedAction.message;
    return "Uma etapa falhou.";
  }

  const completedCount = actionResults.filter(
    (item) => isRecord(item) && item.status === "completed"
  ).length;

  if (completedCount > 0) {
    return `${completedCount} etapa${completedCount === 1 ? "" : "s"} executada${completedCount === 1 ? "" : "s"}.`;
  }

  return "Run registrado sem etapas executadas.";
}

function automationRunLog(run: AutomationRunDto) {
  return JSON.stringify(
    {
      id: run.id,
      status: run.status,
      eventKey: run.eventKey,
      input: run.input,
      result: run.result
    },
    null,
    2
  );
}

export function automationActionsToTrigger(
  actions: AutomationRuleDto["actions"] | AutomationFlowDefinition | undefined,
  fallback: string
) {
  const parsedFlow = automationFlowSchema.safeParse(actions);

  if (!parsedFlow.success) {
    return fallback;
  }

  const triggerNode = parsedFlow.data.nodes.find(
    (node) => getAutomationBlock(node.type)?.category === "trigger"
  );

  if (!triggerNode) {
    return fallback;
  }

  return triggerByBlockType[triggerNode.type] ?? fallback;
}

function graphActionsOrDefault(actions: AutomationRuleDto["actions"] | undefined) {
  const parsedFlow = automationFlowSchema.safeParse(actions);
  return parsedFlow.success ? parsedFlow.data : createDefaultAutomationFlow();
}

function toFormState(automation: AutomationRuleDto): AutomationFormState {
  const actions = Array.isArray(automation.actions) ? automation.actions : [];
  const firstAction = actions[0];

  return {
    name: automation.name,
    trigger: automation.trigger,
    conditionSummary: conditionSummary(automation.conditions),
    actionType: firstAction?.type ?? "send_message",
    actionLabel: firstAction ? actionLabel(firstAction) : "Enviar saudação em modo simulado"
  };
}

export function buildAutomationSavePayload(
  form: AutomationFormState,
  selectedAutomation?: AutomationRuleDto | null,
  canvasActions?: AutomationFlowDefinition
): AutomationSavePayload {
  const actions = canvasActions ?? (Array.isArray(selectedAutomation?.actions)
    ? [{ type: form.actionType, label: form.actionLabel }]
    : selectedAutomation?.actions ?? [{ type: form.actionType, label: form.actionLabel }]);

  return {
    name: form.name,
    trigger: automationActionsToTrigger(actions, form.trigger),
    conditions: { summary: form.conditionSummary },
    actions
  };
}

export function AutomationsPage() {
  const { getToken } = useTalkAuth();
  const [viewMode, setViewMode] = useState<AutomationViewMode>("hub");
  const [agents, setAgents] = useState<AiAgentDto[]>([]);
  const [automations, setAutomations] = useState<AutomationRuleDto[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [form, setForm] = useState<AutomationFormState>(emptyForm);
  const [flowPayload, setFlowPayload] = useState<AutomationFlowDefinition | null>(null);
  const [runs, setRuns] = useState<AutomationRunDto[]>([]);
  const [isRunsLoading, setIsRunsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isRealSimulating, setIsRealSimulating] = useState(false);
  const [runEventKey, setRunEventKey] = useState("");
  const [simulationContacts, setSimulationContacts] = useState<ContactDto[]>([]);
  const [simulationContactId, setSimulationContactId] = useState("");
  const [simulationMessageBody, setSimulationMessageBody] = useState("Mensagem de simulação da automação.");
  const [isSimulationContactsLoading, setIsSimulationContactsLoading] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const previousEditorAutomationId = useRef<string | null>(null);

  useEffect(() => {
    const feedback = error ?? notice;
    if (!feedback) return;

    const timeout = setTimeout(() => {
      if (error) {
        setError((current) => (current === feedback ? null : current));
      } else {
        setNotice((current) => (current === feedback ? null : current));
      }
    }, 4200);

    return () => clearTimeout(timeout);
  }, [error, notice]);

  useEffect(() => {
    let isMounted = true;

    async function loadAutomations() {
      setIsLoading(true);
      setError(null);

      try {
        const [nextAutomations, nextAgents] = await Promise.all([
          apiGetAutomations(getToken),
          apiGetAgents(getToken).catch(() => [])
        ]);

        if (!isMounted) return;

        setAutomations(nextAutomations);
        setAgents(nextAgents);
        setSelectedAutomationId((current) =>
          nextAutomations.some((automation) => automation.id === current)
            ? current
            : nextAutomations[0]?.id ?? null
        );
        setViewMode("hub");
        setIsHistoryOpen(false);
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar automações.");
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadAutomations();

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  const selectedAutomation = useMemo(
    () => automations.find((automation) => automation.id === selectedAutomationId) ?? null,
    [automations, selectedAutomationId]
  );

  useEffect(() => {
    if (previousEditorAutomationId.current === selectedAutomationId) {
      return;
    }

    previousEditorAutomationId.current = selectedAutomationId;

    if (selectedAutomation) {
      setForm(toFormState(selectedAutomation));
    } else {
      setForm(emptyForm);
    }
    setFlowPayload(null);
  }, [selectedAutomation, selectedAutomationId]);

  useEffect(() => {
    if (!selectedAutomation) {
      setRuns([]);
      setRunEventKey("");
      return;
    }

    let isMounted = true;
    setRunEventKey(defaultAutomationEventKey(selectedAutomation.trigger, selectedAutomation.id));

    async function loadRuns() {
      if (!selectedAutomation) return;

      setIsRunsLoading(true);

      try {
        const nextRuns = await apiGetAutomationRuns(getToken, selectedAutomation.id);

        if (isMounted) {
          setRuns(nextRuns);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar histórico.");
        }
      } finally {
        if (isMounted) {
          setIsRunsLoading(false);
        }
      }
    }

    void loadRuns();

    return () => {
      isMounted = false;
    };
  }, [getToken, selectedAutomation]);

  useEffect(() => {
    if (!isHistoryOpen) {
      return;
    }

    let isMounted = true;
    setIsSimulationContactsLoading(true);

    apiGetContacts(getToken)
      .then((contacts) => {
        if (!isMounted) return;
        setSimulationContacts(contacts);
        setSimulationContactId((current) =>
          current && contacts.some((contact) => contact.id === current)
            ? current
            : contacts[0]?.id ?? ""
        );
      })
      .catch((contactsError) => {
        if (isMounted) {
          setError(contactsError instanceof Error ? contactsError.message : "Não foi possível carregar contatos.");
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsSimulationContactsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [getToken, isHistoryOpen]);

  const enabledCount = automations.filter((automation) => automation.status === "enabled").length;
  const canvasTrigger = automationActionsToTrigger(
    flowPayload ?? selectedAutomation?.actions,
    form.trigger
  );
  const canvasTriggerLabel =
    triggerOptions.find((option) => option.value === canvasTrigger)?.label ?? canvasTrigger;
  const handleCanvasChange = useCallback((payload: AutomationFlowDefinition) => {
    setFlowPayload(payload);
  }, []);

  function openAutomation(automationId: string) {
    setSelectedAutomationId(automationId);
    setIsHistoryOpen(false);
    setViewMode("editor");
  }

  function closeEditor() {
    setIsHistoryOpen(false);
    setViewMode("hub");
  }

  function enterFocusMode() {
    setIsHistoryOpen(false);
    setViewMode("focus");
  }

  function exitFocusMode() {
    setViewMode("editor");
  }

  async function saveAutomation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    const payload = buildAutomationSavePayload(
      form,
      selectedAutomation,
      flowPayload ?? graphActionsOrDefault(selectedAutomation?.actions)
    );

    try {
      const savedAutomation = selectedAutomation
        ? await apiUpdateAutomation(getToken, selectedAutomation.id, payload)
        : await apiCreateAutomation(getToken, {
            ...payload,
            status: "disabled"
          });

      setAutomations((current) => mergeAutomation(current, savedAutomation));
      setSelectedAutomationId(savedAutomation.id);
      setIsHistoryOpen(false);
      setViewMode("editor");
      setNotice("Automação salva no runner local.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar automação.");
    } finally {
      setIsSaving(false);
    }
  }

  async function createDraft() {
    setSelectedAutomationId(null);
    setForm(emptyForm);
    setFlowPayload(null);
    setDraftVersion((current) => current + 1);
    setIsHistoryOpen(false);
    setViewMode("editor");
    setNotice("Rascunho local pronto para edicao.");
  }

  async function toggleAutomation(automation: AutomationRuleDto) {
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const updatedAutomation = await apiUpdateAutomation(getToken, automation.id, {
        status: automation.status === "enabled" ? "disabled" : "enabled"
      });

      setAutomations((current) => mergeAutomation(current, updatedAutomation));
      setSelectedAutomationId(updatedAutomation.id);
      setNotice(
        updatedAutomation.status === "enabled"
          ? "Automação habilitada para testes locais."
          : "Automação pausada."
      );
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Não foi possível alterar status.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteSelectedAutomation() {
    if (!selectedAutomation) return;

    const shouldDelete =
      typeof window === "undefined"
        ? true
        : window.confirm(`Apagar o fluxo "${selectedAutomation.name}"? Essa ação não pode ser desfeita.`);

    if (!shouldDelete) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await apiDeleteAutomation(getToken, selectedAutomation.id);
      setAutomations((current) => current.filter((automation) => automation.id !== selectedAutomation.id));
      setSelectedAutomationId(null);
      setFlowPayload(null);
      setRuns([]);
      setIsHistoryOpen(false);
      setViewMode("hub");
      setNotice("Automação apagada.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Não foi possível apagar automação.");
    } finally {
      setIsSaving(false);
    }
  }

  async function testSelectedAutomation() {
    if (!selectedAutomation) return;

    setIsTesting(true);
    setError(null);
    setNotice(null);

    try {
      const run = await apiTestAutomation(getToken, selectedAutomation.id, {
        eventKey:
          runEventKey || defaultAutomationEventKey(selectedAutomation.trigger, selectedAutomation.id),
        input: {
          source: "manual_test",
          trigger: selectedAutomation.trigger
        }
      });

      setRuns((current) => mergeAutomationRun(current, run));
      setNotice("Teste local concluido pelo runner.");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Não foi possível testar automação.");
    } finally {
      setIsTesting(false);
    }
  }

  async function simulateSelectedAutomationWithContact() {
    if (!selectedAutomation || !simulationContactId) return;

    setIsRealSimulating(true);
    setError(null);
    setNotice(null);

    try {
      const run = await apiTestAutomation(getToken, selectedAutomation.id, {
        contactId: simulationContactId,
        messageBody: simulationMessageBody.trim() || "Mensagem de simulação da automação."
      });

      setRuns((current) => mergeAutomationRun(current, run));
      setNotice("Simulação real enviada para o contato selecionado.");
    } catch (simulationError) {
      setError(simulationError instanceof Error ? simulationError.message : "Não foi possível simular automação.");
    } finally {
      setIsRealSimulating(false);
    }
  }

  return (
    <AutomationsPageView
      agents={agents}
      automations={automations}
      canvasTriggerLabel={canvasTriggerLabel}
      draftVersion={draftVersion}
      enabledCount={enabledCount}
      error={error}
      form={form}
      isFocusMode={viewMode === "focus"}
      isHistoryOpen={isHistoryOpen}
      isLoading={isLoading}
      isRunsLoading={isRunsLoading}
      isRealSimulating={isRealSimulating}
      isSaving={isSaving}
      isSimulationContactsLoading={isSimulationContactsLoading}
      isTesting={isTesting}
      notice={notice}
      onBack={closeEditor}
      onCanvasChange={handleCanvasChange}
      onCreate={createDraft}
      onEnterFocusMode={enterFocusMode}
      onExitFocusMode={exitFocusMode}
      onFormChange={setForm}
      onHistoryToggle={() => setIsHistoryOpen((current) => !current)}
      onOpen={openAutomation}
      onDeleteAutomation={deleteSelectedAutomation}
      onRunEventKeyChange={setRunEventKey}
      onSimulationContactChange={setSimulationContactId}
      onSimulationMessageBodyChange={setSimulationMessageBody}
      onSave={saveAutomation}
      onTest={testSelectedAutomation}
      onRealSimulation={simulateSelectedAutomationWithContact}
      onToggleAutomation={toggleAutomation}
      runEventKey={runEventKey}
      runs={runs}
      selectedAutomation={selectedAutomation}
      simulationContactId={simulationContactId}
      simulationContacts={simulationContacts}
      simulationMessageBody={simulationMessageBody}
      viewMode={viewMode}
    />
  );
}

interface AutomationsPageViewProps {
  agents: AiAgentDto[];
  automations: AutomationRuleDto[];
  canvasTriggerLabel: string;
  draftVersion: number;
  enabledCount: number;
  error: string | null;
  form: AutomationFormState;
  isFocusMode: boolean;
  isHistoryOpen: boolean;
  isLoading: boolean;
  isRunsLoading: boolean;
  isRealSimulating: boolean;
  isSaving: boolean;
  isSimulationContactsLoading: boolean;
  isTesting: boolean;
  notice: string | null;
  onBack: () => void;
  onCanvasChange: (payload: AutomationFlowDefinition) => void;
  onCreate: () => void;
  onEnterFocusMode: () => void;
  onExitFocusMode: () => void;
  onFormChange: Dispatch<SetStateAction<AutomationFormState>>;
  onHistoryToggle: () => void;
  onOpen: (automationId: string) => void;
  onDeleteAutomation: () => void;
  onRealSimulation: () => void;
  onRunEventKeyChange?: Dispatch<SetStateAction<string>>;
  onSimulationContactChange: Dispatch<SetStateAction<string>>;
  onSimulationMessageBodyChange: Dispatch<SetStateAction<string>>;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onTest: () => void;
  onToggleAutomation: (automation: AutomationRuleDto) => void;
  runEventKey: string;
  runs: AutomationRunDto[];
  selectedAutomation: AutomationRuleDto | null;
  simulationContactId: string;
  simulationContacts: ContactDto[];
  simulationMessageBody: string;
  viewMode: AutomationViewMode;
}

export function AutomationsPageView({
  agents,
  automations,
  canvasTriggerLabel,
  draftVersion,
  enabledCount,
  error,
  form,
  isFocusMode,
  isHistoryOpen,
  isLoading,
  isRunsLoading,
  isRealSimulating,
  isSaving,
  isSimulationContactsLoading,
  isTesting,
  notice,
  onBack,
  onCanvasChange,
  onCreate,
  onEnterFocusMode,
  onExitFocusMode,
  onFormChange,
  onHistoryToggle,
  onOpen,
  onDeleteAutomation,
  onRealSimulation,
  onRunEventKeyChange,
  onSimulationContactChange,
  onSimulationMessageBodyChange,
  onSave,
  onTest,
  onToggleAutomation,
  runEventKey,
  runs,
  selectedAutomation,
  simulationContactId,
  simulationContacts,
  simulationMessageBody,
  viewMode
}: AutomationsPageViewProps) {
  const shouldShowEditor = viewMode === "editor" || viewMode === "focus";

  return (
    <section className="module-page automations-page" aria-label="Automações">
      <header className="module-header">
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div>
            <p className="eyebrow">Prymeira Talk</p>
            <h1>Automações</h1>
          </div>
          {automations.length > 0 ? (
            <span className="status-badge status-badge--open">
              {enabledCount} ativa{enabledCount !== 1 ? "s" : ""}
            </span>
          ) : null}
        </div>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Plus size={16} aria-hidden="true" />
          Criar fluxo
        </button>
      </header>

      <AutomationToast message={error ?? notice} tone={error ? "error" : "success"} />

      {shouldShowEditor ? (
        <AutomationEditorView
          agents={agents}
          canvasTriggerLabel={canvasTriggerLabel}
          draftVersion={draftVersion}
          form={form}
          isFocusMode={isFocusMode}
          isHistoryOpen={isHistoryOpen}
          isRunsLoading={isRunsLoading}
          isRealSimulating={isRealSimulating}
          isSaving={isSaving}
          isSimulationContactsLoading={isSimulationContactsLoading}
          isTesting={isTesting}
          onBack={onBack}
          onCanvasChange={onCanvasChange}
          onEnterFocusMode={onEnterFocusMode}
          onExitFocusMode={onExitFocusMode}
          onFormChange={onFormChange}
          onHistoryToggle={onHistoryToggle}
          onDeleteAutomation={onDeleteAutomation}
          onRealSimulation={onRealSimulation}
          onRunEventKeyChange={onRunEventKeyChange}
          onSimulationContactChange={onSimulationContactChange}
          onSimulationMessageBodyChange={onSimulationMessageBodyChange}
          onSave={onSave}
          onTest={onTest}
          onToggleAutomation={onToggleAutomation}
          runEventKey={runEventKey}
          runs={runs}
          selectedAutomation={selectedAutomation}
          simulationContactId={simulationContactId}
          simulationContacts={simulationContacts}
          simulationMessageBody={simulationMessageBody}
        />
      ) : (
        <AutomationHubView
          automations={automations}
          isLoading={isLoading}
          onCreate={onCreate}
          onOpen={onOpen}
        />
      )}
    </section>
  );
}

function AutomationToast({
  message,
  tone
}: {
  message: string | null;
  tone: "success" | "error";
}) {
  if (!message) return null;

  const Icon = tone === "error" ? TriangleAlert : CheckCircle2;

  return (
    <div
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={`automation-toast automation-toast--${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon size={18} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function automationStatusLabel(status: AutomationRuleDto["status"]) {
  return status === "enabled" ? "Ativo" : "Pausado";
}

function automationEditorStatusLabel(automation: AutomationRuleDto | null) {
  if (!automation) {
    return "Rascunho";
  }

  return automation.status === "enabled" ? "Fluxo ativo" : "Fluxo pausado";
}

function automationEditorStatusActionLabel(automation: AutomationRuleDto) {
  return automation.status === "enabled" ? "Pausar fluxo" : "Ativar fluxo";
}

export function AutomationHubView({
  automations,
  isLoading,
  onCreate,
  onOpen
}: {
  automations: AutomationRuleDto[];
  isLoading: boolean;
  onCreate: () => void;
  onOpen: (automationId: string) => void;
}) {
  if (!isLoading && automations.length === 0) {
    return (
      <div className="automation-hub-empty">
        <div className="empty-state-icon">
          <Zap size={28} aria-hidden="true" />
        </div>
        <h2>Nenhum fluxo criado</h2>
        <p>Crie o primeiro fluxo para organizar boas-vindas, retornos e automações de atendimento.</p>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Plus size={16} aria-hidden="true" />
          Criar fluxo
        </button>
      </div>
    );
  }

  return (
    <div className="automation-hub">
      <div className="automation-hub-toolbar">
        <div>
          <h2>Fluxos</h2>
          <p>{isLoading ? "Carregando automações" : `${automations.length} fluxo${automations.length === 1 ? "" : "s"}`}</p>
        </div>
      </div>

      <div className="automation-flow-grid">
        {automations.map((automation) => (
          <button
            className="automation-flow-card"
            key={automation.id}
            onClick={() => onOpen(automation.id)}
            type="button"
          >
            <span className={`status-badge status-badge--${automation.status === "enabled" ? "open" : "closed"}`}>
              {automationStatusLabel(automation.status)}
            </span>
            <strong>{automation.name}</strong>
            <small>{triggerOptions.find((option) => option.value === automation.trigger)?.label ?? automation.trigger}</small>
            <em>Abrir editor</em>
          </button>
        ))}
      </div>
    </div>
  );
}

export function AutomationEditorView({
  agents,
  canvasTriggerLabel,
  draftVersion,
  form,
  isFocusMode,
  isHistoryOpen,
  isRunsLoading,
  isRealSimulating,
  isSaving,
  isSimulationContactsLoading,
  isTesting,
  onBack,
  onCanvasChange,
  onEnterFocusMode,
  onExitFocusMode,
  onFormChange,
  onHistoryToggle,
  onDeleteAutomation,
  onRealSimulation,
  onRunEventKeyChange,
  onSimulationContactChange,
  onSimulationMessageBodyChange,
  onSave,
  onTest,
  onToggleAutomation,
  runEventKey,
  runs,
  selectedAutomation,
  simulationContactId,
  simulationContacts,
  simulationMessageBody
}: {
  agents: AiAgentDto[];
  canvasTriggerLabel: string;
  draftVersion: number;
  form: AutomationFormState;
  isFocusMode: boolean;
  isHistoryOpen: boolean;
  isRunsLoading: boolean;
  isRealSimulating: boolean;
  isSaving: boolean;
  isSimulationContactsLoading: boolean;
  isTesting: boolean;
  onBack: () => void;
  onCanvasChange: (payload: AutomationFlowDefinition) => void;
  onEnterFocusMode: () => void;
  onExitFocusMode: () => void;
  onFormChange: Dispatch<SetStateAction<AutomationFormState>>;
  onHistoryToggle: () => void;
  onDeleteAutomation: () => void;
  onRealSimulation: () => void;
  onRunEventKeyChange?: Dispatch<SetStateAction<string>>;
  onSimulationContactChange: Dispatch<SetStateAction<string>>;
  onSimulationMessageBodyChange: Dispatch<SetStateAction<string>>;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onTest: () => void;
  onToggleAutomation: (automation: AutomationRuleDto) => void;
  runEventKey: string;
  runs: AutomationRunDto[];
  selectedAutomation: AutomationRuleDto | null;
  simulationContactId: string;
  simulationContacts: ContactDto[];
  simulationMessageBody: string;
}) {
  const editorStatusLabel = automationEditorStatusLabel(selectedAutomation);
  const editorStatusClass = selectedAutomation
    ? selectedAutomation.status === "enabled"
      ? "open"
      : "closed"
    : "waiting";

  return (
    <div className={`automation-editor-shell ${isFocusMode ? "is-focus-mode" : ""}`}>
      <form className="automation-editor-main-form" onSubmit={onSave}>
        <div className="automation-editor-topbar">
          <button className="secondary-button icon-button-label" type="button" onClick={onBack}>
            <ArrowLeft size={15} aria-hidden="true" />
            Voltar para automações
          </button>

          <div className="automation-editor-title">
            <h2>{selectedAutomation ? "Editar fluxo" : "Novo fluxo"}</h2>
            <input
              aria-label="Nome do fluxo"
              className="automation-title-field"
              onChange={(event) => onFormChange((current) => ({ ...current, name: event.target.value }))}
              required
              value={form.name}
            />
          </div>

          <div className="automation-editor-actions">
            {selectedAutomation ? (
              <button
                aria-label={automationEditorStatusActionLabel(selectedAutomation)}
                aria-pressed={selectedAutomation.status === "enabled"}
                className={`secondary-button automation-status-control status-badge status-badge--${editorStatusClass}`}
                type="button"
                onClick={() => void onToggleAutomation(selectedAutomation)}
                disabled={isSaving}
              >
                {selectedAutomation.status === "enabled" ? (
                  <ToggleRight size={15} aria-hidden="true" />
                ) : (
                  <ToggleLeft size={15} aria-hidden="true" />
                )}
                {editorStatusLabel}
              </button>
            ) : (
              <span className={`status-badge status-badge--${editorStatusClass}`}>{editorStatusLabel}</span>
            )}

            <button
              aria-expanded={isHistoryOpen}
              className="secondary-button icon-button-label"
              onClick={onHistoryToggle}
              type="button"
            >
              <Zap size={15} aria-hidden="true" />
              Testar fluxo
            </button>

            <button
              aria-expanded={isHistoryOpen}
              className="secondary-button icon-button-label"
              onClick={onHistoryToggle}
              type="button"
            >
              <History size={15} aria-hidden="true" />
              Histórico
            </button>

            <button
              className="secondary-button icon-button-label"
              onClick={isFocusMode ? onExitFocusMode : onEnterFocusMode}
              type="button"
            >
              {isFocusMode ? (
                <Minimize2 size={15} aria-hidden="true" />
              ) : (
                <Maximize2 size={15} aria-hidden="true" />
              )}
              {isFocusMode ? "Sair do foco" : "Modo foco"}
            </button>

            {selectedAutomation ? (
              <button
                className="secondary-button danger-button icon-button-label"
                disabled={isSaving}
                onClick={onDeleteAutomation}
                type="button"
              >
                <Trash2 size={15} aria-hidden="true" />
                Apagar
              </button>
            ) : null}

            <button className="primary-button" disabled={isSaving} type="submit">
              <Save size={15} aria-hidden="true" />
              Salvar
            </button>
          </div>
        </div>

        <div className="automation-editor-meta">
          <label className="form-field automation-condition-field">
            <span>Resumo das condições</span>
            <input
              onChange={(event) => onFormChange((current) => ({ ...current, conditionSummary: event.target.value }))}
              required
              value={form.conditionSummary}
            />
          </label>

          <div className="automation-flow-summary" aria-label="Resumo do fluxo">
            <span>Gatilho do canvas</span>
            <strong>{canvasTriggerLabel}</strong>
          </div>
        </div>
      </form>

      <div className="automation-editor-body">
        <div className="automation-editor-canvas-area">
          <AutomationCanvas
            agents={agents}
            key={selectedAutomation?.id ?? `new-automation-${draftVersion}`}
            onChange={onCanvasChange}
            value={selectedAutomation?.actions}
            variant={isFocusMode ? "focus" : "editor"}
          />
        </div>
      </div>

      {isHistoryOpen ? (
        <AutomationHistoryDrawer
          isRunsLoading={isRunsLoading}
          isRealSimulating={isRealSimulating}
          isSimulationContactsLoading={isSimulationContactsLoading}
          isTesting={isTesting}
          onRealSimulation={onRealSimulation}
          onRunEventKeyChange={onRunEventKeyChange}
          onSimulationContactChange={onSimulationContactChange}
          onSimulationMessageBodyChange={onSimulationMessageBodyChange}
          onTest={onTest}
          runEventKey={runEventKey}
          runs={runs}
          selectedAutomation={selectedAutomation}
          simulationContactId={simulationContactId}
          simulationContacts={simulationContacts}
          simulationMessageBody={simulationMessageBody}
        />
      ) : null}
    </div>
  );
}

function AutomationHistoryDrawer({
  isRunsLoading,
  isRealSimulating,
  isSimulationContactsLoading,
  isTesting,
  onRealSimulation,
  onRunEventKeyChange,
  onSimulationContactChange,
  onSimulationMessageBodyChange,
  onTest,
  runEventKey,
  runs,
  selectedAutomation,
  simulationContactId,
  simulationContacts,
  simulationMessageBody
}: {
  isRunsLoading: boolean;
  isRealSimulating: boolean;
  isSimulationContactsLoading: boolean;
  isTesting: boolean;
  onRealSimulation: () => void;
  onRunEventKeyChange?: Dispatch<SetStateAction<string>>;
  onSimulationContactChange: Dispatch<SetStateAction<string>>;
  onSimulationMessageBodyChange: Dispatch<SetStateAction<string>>;
  onTest: () => void;
  runEventKey: string;
  runs: AutomationRunDto[];
  selectedAutomation: AutomationRuleDto | null;
  simulationContactId: string;
  simulationContacts: ContactDto[];
  simulationMessageBody: string;
}) {
  return (
    <aside className="automation-history-drawer" aria-label="Teste & histórico">
      <div className="panel-title-row">
        <h2>Teste & histórico</h2>
        <span>{isRunsLoading ? "Carregando" : `${runs.length} runs`}</span>
      </div>

      <label className="form-field">
        <span>Event key</span>
        <input
          disabled={!selectedAutomation || isTesting}
          onChange={(event) => onRunEventKeyChange?.(event.target.value)}
          value={runEventKey}
        />
      </label>

      <button
        className="secondary-button icon-button-label"
        disabled={!selectedAutomation || isTesting}
        onClick={() => void onTest()}
        type="button"
      >
        <Zap size={15} aria-hidden="true" />
        {isTesting ? "Testando" : "Teste seco"}
      </button>

      <div className="automation-real-simulation">
        <div className="automation-real-simulation-heading">
          <strong>Simulação real</strong>
          <small>Envia WhatsApp de verdade quando o fluxo tiver envio.</small>
        </div>
        <label className="form-field">
          <span>Contato salvo</span>
          <select
            disabled={!selectedAutomation || isSimulationContactsLoading || isRealSimulating}
            onChange={(event) => onSimulationContactChange(event.target.value)}
            value={simulationContactId}
          >
            {simulationContacts.length === 0 ? (
              <option value="">{isSimulationContactsLoading ? "Carregando contatos..." : "Nenhum contato encontrado"}</option>
            ) : null}
            {simulationContacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name || contact.phone} {contact.phone ? `- ${contact.phone}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Mensagem inbound simulada</span>
          <textarea
            disabled={!selectedAutomation || isRealSimulating}
            onChange={(event) => onSimulationMessageBodyChange(event.target.value)}
            rows={3}
            value={simulationMessageBody}
          />
        </label>
        <button
          className="primary-button icon-button-label"
          disabled={!selectedAutomation || !simulationContactId || isRealSimulating}
          onClick={() => void onRealSimulation()}
          type="button"
        >
          <Zap size={15} aria-hidden="true" />
          {isRealSimulating ? "Simulando" : "Simular real"}
        </button>
      </div>

      <div className="automation-run-list">
        {runs.length === 0 && !isRunsLoading ? (
          <p className="list-note">Nenhum teste executado.</p>
        ) : null}
        {runs.map((run) => (
          <article className="automation-run-card" key={run.id}>
            <span className={`status-badge status-badge--${run.status === "completed" ? "open" : "waiting"}`}>
              {run.status}
            </span>
            <strong>{run.eventKey}</strong>
            <p>{automationRunSummary(run.result)}</p>
            <small>{formatAutomationRunDate(run.updatedAt)}</small>
            <details className="automation-run-log">
              <summary>Ver log</summary>
              <pre>{automationRunLog(run)}</pre>
            </details>
          </article>
        ))}
      </div>
    </aside>
  );
}
