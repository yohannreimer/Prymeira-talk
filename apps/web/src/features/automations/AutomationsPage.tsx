import { useTalkAuth } from "../../app/auth";
import { ArrowLeft, Maximize2, Minimize2, Plus, Save, ToggleLeft, ToggleRight, Zap } from "lucide-react";
import { type Dispatch, FormEvent, type SetStateAction, useCallback, useEffect, useMemo, useState } from "react";
import { automationFlowSchema, getAutomationBlock, type AutomationBlockType, type AutomationFlowDefinition } from "@prymeira-talk/shared";
import {
  apiCreateAutomation,
  apiGetAutomationRuns,
  apiGetAutomations,
  apiTestAutomation,
  apiUpdateAutomation,
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
  actionLabel: "Enviar saudacao em modo simulado"
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
    actionLabel: firstAction ? actionLabel(firstAction) : "Enviar saudacao em modo simulado"
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
  const [automations, setAutomations] = useState<AutomationRuleDto[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [form, setForm] = useState<AutomationFormState>(emptyForm);
  const [flowPayload, setFlowPayload] = useState<AutomationFlowDefinition | null>(null);
  const [runs, setRuns] = useState<AutomationRunDto[]>([]);
  const [isRunsLoading, setIsRunsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [runEventKey, setRunEventKey] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadAutomations() {
      setIsLoading(true);
      setError(null);

      try {
        const nextAutomations = await apiGetAutomations(getToken);

        if (!isMounted) return;

        setAutomations(nextAutomations);
        setSelectedAutomationId((current) =>
          nextAutomations.some((automation) => automation.id === current)
            ? current
            : nextAutomations[0]?.id ?? null
        );
        setViewMode("hub");
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar automacoes.");
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
    if (selectedAutomation) {
      setForm(toFormState(selectedAutomation));
    } else {
      setForm(emptyForm);
    }
    setFlowPayload(null);
  }, [selectedAutomation]);

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
          setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar historico.");
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
    setViewMode("editor");
  }

  function closeEditor() {
    setViewMode("hub");
  }

  function enterFocusMode() {
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
      setViewMode("editor");
      setNotice("Automacao salva no runner local.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel salvar automacao.");
    } finally {
      setIsSaving(false);
    }
  }

  async function createDraft() {
    setSelectedAutomationId(null);
    setForm(emptyForm);
    setFlowPayload(null);
    setDraftVersion((current) => current + 1);
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
          ? "Automacao habilitada para testes locais."
          : "Automacao pausada."
      );
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Nao foi possivel alterar status.");
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
      setError(testError instanceof Error ? testError.message : "Nao foi possivel testar automacao.");
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <AutomationsPageView
      automations={automations}
      canvasTriggerLabel={canvasTriggerLabel}
      draftVersion={draftVersion}
      enabledCount={enabledCount}
      error={error}
      form={form}
      isFocusMode={viewMode === "focus"}
      isLoading={isLoading}
      isRunsLoading={isRunsLoading}
      isSaving={isSaving}
      isTesting={isTesting}
      notice={notice}
      onBack={closeEditor}
      onCanvasChange={handleCanvasChange}
      onCreate={createDraft}
      onEnterFocusMode={enterFocusMode}
      onExitFocusMode={exitFocusMode}
      onFormChange={setForm}
      onOpen={openAutomation}
      onRunEventKeyChange={setRunEventKey}
      onSave={saveAutomation}
      onTest={testSelectedAutomation}
      onToggleAutomation={toggleAutomation}
      runEventKey={runEventKey}
      runs={runs}
      selectedAutomation={selectedAutomation}
      viewMode={viewMode}
    />
  );
}

interface AutomationsPageViewProps {
  automations: AutomationRuleDto[];
  canvasTriggerLabel: string;
  draftVersion: number;
  enabledCount: number;
  error: string | null;
  form: AutomationFormState;
  isFocusMode: boolean;
  isLoading: boolean;
  isRunsLoading: boolean;
  isSaving: boolean;
  isTesting: boolean;
  notice: string | null;
  onBack: () => void;
  onCanvasChange: (payload: AutomationFlowDefinition) => void;
  onCreate: () => void;
  onEnterFocusMode: () => void;
  onExitFocusMode: () => void;
  onFormChange: Dispatch<SetStateAction<AutomationFormState>>;
  onOpen: (automationId: string) => void;
  onRunEventKeyChange?: Dispatch<SetStateAction<string>>;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onTest: () => void;
  onToggleAutomation: (automation: AutomationRuleDto) => void;
  runEventKey: string;
  runs: AutomationRunDto[];
  selectedAutomation: AutomationRuleDto | null;
  viewMode: AutomationViewMode;
}

export function AutomationsPageView({
  automations,
  canvasTriggerLabel,
  draftVersion,
  enabledCount,
  error,
  form,
  isFocusMode,
  isLoading,
  isRunsLoading,
  isSaving,
  isTesting,
  notice,
  onBack,
  onCanvasChange,
  onCreate,
  onEnterFocusMode,
  onExitFocusMode,
  onFormChange,
  onOpen,
  onRunEventKeyChange,
  onSave,
  onTest,
  onToggleAutomation,
  runEventKey,
  runs,
  selectedAutomation,
  viewMode
}: AutomationsPageViewProps) {
  const shouldShowEditor = viewMode === "editor" || viewMode === "focus";

  return (
    <section className="module-page automations-page" aria-label="Automacoes">
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

      <div className="automation-page-messages">
        {error ? <p className="error-note">{error}</p> : null}
        {notice ? <p className="list-note">{notice}</p> : null}
      </div>

      {shouldShowEditor ? (
        <AutomationEditorView
          canvasTriggerLabel={canvasTriggerLabel}
          draftVersion={draftVersion}
          form={form}
          isFocusMode={isFocusMode}
          isRunsLoading={isRunsLoading}
          isSaving={isSaving}
          isTesting={isTesting}
          onBack={onBack}
          onCanvasChange={onCanvasChange}
          onEnterFocusMode={onEnterFocusMode}
          onExitFocusMode={onExitFocusMode}
          onFormChange={onFormChange}
          onRunEventKeyChange={onRunEventKeyChange}
          onSave={onSave}
          onTest={onTest}
          onToggleAutomation={onToggleAutomation}
          runEventKey={runEventKey}
          runs={runs}
          selectedAutomation={selectedAutomation}
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
        <p>Crie o primeiro fluxo para organizar boas-vindas, retornos e automacoes de atendimento.</p>
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
          <p>{isLoading ? "Carregando automacoes" : `${automations.length} fluxo${automations.length === 1 ? "" : "s"}`}</p>
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
  canvasTriggerLabel,
  draftVersion,
  form,
  isFocusMode,
  isRunsLoading,
  isSaving,
  isTesting,
  onBack,
  onCanvasChange,
  onEnterFocusMode,
  onExitFocusMode,
  onFormChange,
  onRunEventKeyChange,
  onSave,
  onTest,
  onToggleAutomation,
  runEventKey,
  runs,
  selectedAutomation
}: {
  canvasTriggerLabel: string;
  draftVersion: number;
  form: AutomationFormState;
  isFocusMode: boolean;
  isRunsLoading: boolean;
  isSaving: boolean;
  isTesting: boolean;
  onBack: () => void;
  onCanvasChange: (payload: AutomationFlowDefinition) => void;
  onEnterFocusMode: () => void;
  onExitFocusMode: () => void;
  onFormChange: Dispatch<SetStateAction<AutomationFormState>>;
  onRunEventKeyChange?: Dispatch<SetStateAction<string>>;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onTest: () => void;
  onToggleAutomation: (automation: AutomationRuleDto) => void;
  runEventKey: string;
  runs: AutomationRunDto[];
  selectedAutomation: AutomationRuleDto | null;
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
              className="secondary-button icon-button-label"
              disabled={!selectedAutomation || isTesting}
              onClick={() => void onTest()}
              type="button"
            >
              <Zap size={15} aria-hidden="true" />
              {isTesting ? "Testando" : "Testar agora"}
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
            key={selectedAutomation?.id ?? `new-automation-${draftVersion}`}
            onChange={onCanvasChange}
            value={selectedAutomation?.actions}
            variant={isFocusMode ? "focus" : "editor"}
          />
        </div>

        <aside className="module-panel automation-runs-panel">
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
                <small>{formatAutomationRunDate(run.updatedAt)}</small>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
