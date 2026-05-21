import { useAuth } from "@clerk/clerk-react";
import { FlaskConical, ListChecks, Play, Plus, Save, ToggleLeft, ToggleRight, Zap } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
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

function toFormState(automation: AutomationRuleDto): AutomationFormState {
  const firstAction = automation.actions[0];

  return {
    name: automation.name,
    trigger: automation.trigger,
    conditionSummary: conditionSummary(automation.conditions),
    actionType: firstAction?.type ?? "send_message",
    actionLabel: firstAction ? actionLabel(firstAction) : "Enviar saudacao em modo simulado"
  };
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function actionResultsCount(run: AutomationRunDto) {
  const result = run.result as { actionResults?: unknown };
  return Array.isArray(result.actionResults) ? result.actionResults.length : 0;
}

export function AutomationsPage() {
  const { getToken } = useAuth();
  const [automations, setAutomations] = useState<AutomationRuleDto[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRunDto[]>([]);
  const [form, setForm] = useState<AutomationFormState>(emptyForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunsLoading, setIsRunsLoading] = useState(false);
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
  }, [selectedAutomation]);

  useEffect(() => {
    if (!selectedAutomationId) {
      setRuns([]);
      return;
    }

    let isMounted = true;
    const automationIdToLoad = selectedAutomationId;

    async function loadRuns() {
      setIsRunsLoading(true);

      try {
        const nextRuns = await apiGetAutomationRuns(getToken, automationIdToLoad);

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
  }, [getToken, selectedAutomationId]);

  const enabledCount = automations.filter((automation) => automation.status === "enabled").length;

  async function saveAutomation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    const payload = {
      name: form.name,
      trigger: form.trigger,
      conditions: { summary: form.conditionSummary },
      actions: [{ type: form.actionType, label: form.actionLabel }]
    };

    try {
      const savedAutomation = selectedAutomation
        ? await apiUpdateAutomation(getToken, selectedAutomation.id, payload)
        : await apiCreateAutomation(getToken, {
            ...payload,
            status: "disabled"
          });

      setAutomations((current) => mergeAutomation(current, savedAutomation));
      setSelectedAutomationId(savedAutomation.id);
      setNotice("Automacao salva no runner local.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel salvar automacao.");
    } finally {
      setIsSaving(false);
    }
  }

  async function createDraft() {
    setSelectedAutomationId(null);
    setRuns([]);
    setForm(emptyForm);
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

  async function runLocalTest() {
    if (!selectedAutomation) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const run = await apiTestAutomation(getToken, selectedAutomation.id, {
        eventKey: `${selectedAutomation.trigger}:manual-preview`,
        input: {
          source: "web",
          preview: true
        }
      });

      setRuns((current) => [run, ...current.filter((existingRun) => existingRun.id !== run.id)]);
      setNotice("Teste local concluido. Mesmo evento reutiliza o mesmo run.");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Nao foi possivel executar teste local.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="module-page automations-page" aria-label="Automacoes">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Automacoes</h1>
        </div>
        <span className="status-pill status-pending">Runner local simulado</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button" onClick={createDraft}>
          <Plus size={16} aria-hidden="true" />
          Criar fluxo
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={runLocalTest}
          disabled={isSaving || !selectedAutomation}
        >
          <Play size={16} aria-hidden="true" />
          Testar local
        </button>
      </div>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="list-note">{notice}</p> : null}

      <div className="automation-grid">
        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Regras</h2>
            <span>{isLoading ? "Carregando" : `${enabledCount} ativas`}</span>
          </div>

          <div className="automation-rule-list">
            {automations.map((automation) => (
              <button
                className={`automation-rule-card ${automation.id === selectedAutomationId ? "is-selected" : ""}`}
                key={automation.id}
                type="button"
                onClick={() => setSelectedAutomationId(automation.id)}
              >
                <span className={`status-pill status-${automation.status}`}>
                  {automation.status === "enabled" ? "Ativa" : "Pausada"}
                </span>
                <strong>{automation.name}</strong>
                <small>{triggerOptions.find((option) => option.value === automation.trigger)?.label ?? automation.trigger}</small>
                <em>{conditionSummary(automation.conditions)}</em>
              </button>
            ))}

            {!isLoading && automations.length === 0 ? (
              <div className="channel-empty">
                <Zap size={22} aria-hidden="true" />
                <strong>Nenhuma regra criada</strong>
                <span>Crie um fluxo para testar a execucao simulada local.</span>
              </div>
            ) : null}
          </div>
        </div>

        <form className="module-panel automation-editor" onSubmit={saveAutomation}>
          <div className="panel-title-row">
            <h2>Editor</h2>
            <span>{selectedAutomation ? "Regra existente" : "Novo rascunho"}</span>
          </div>

          <label className="form-field">
            <span>Nome</span>
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              required
            />
          </label>

          <label className="form-field">
            <span>Trigger</span>
            <select
              value={form.trigger}
              onChange={(event) => setForm((current) => ({ ...current, trigger: event.target.value }))}
            >
              {triggerOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="form-field">
            <span>Resumo das condicoes</span>
            <input
              value={form.conditionSummary}
              onChange={(event) => setForm((current) => ({ ...current, conditionSummary: event.target.value }))}
              required
            />
          </label>

          <div className="automation-actions-editor">
            <div className="panel-title-row compact">
              <h2>Acoes</h2>
              <span>Simuladas</span>
            </div>
            <label className="form-field">
              <span>Tipo</span>
              <select
                value={form.actionType}
                onChange={(event) => setForm((current) => ({ ...current, actionType: event.target.value }))}
              >
                {actionOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>Descricao</span>
              <input
                value={form.actionLabel}
                onChange={(event) => setForm((current) => ({ ...current, actionLabel: event.target.value }))}
                required
              />
            </label>
          </div>

          <div className="automation-editor-footer">
            {selectedAutomation ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => toggleAutomation(selectedAutomation)}
                disabled={isSaving}
              >
                {selectedAutomation.status === "enabled" ? (
                  <ToggleRight size={16} aria-hidden="true" />
                ) : (
                  <ToggleLeft size={16} aria-hidden="true" />
                )}
                {selectedAutomation.status === "enabled" ? "Desabilitar" : "Habilitar"}
              </button>
            ) : null}
            <button className="primary-button" type="submit" disabled={isSaving}>
              <Save size={16} aria-hidden="true" />
              Salvar
            </button>
          </div>
        </form>

        <aside className="module-panel automation-history">
          <div className="panel-title-row">
            <h2>Historico</h2>
            <span>{isRunsLoading ? "Carregando" : `${runs.length} runs`}</span>
          </div>

          <div className="local-runner-note">
            <FlaskConical size={18} aria-hidden="true" />
            <span>Execucao local: acoes sao simuladas e gravadas como completed.</span>
          </div>

          <div className="automation-run-list">
            {runs.map((run) => (
              <article key={run.id}>
                <ListChecks size={18} aria-hidden="true" />
                <div>
                  <strong>{run.status}</strong>
                  <span>{run.eventKey}</span>
                  <em>{actionResultsCount(run)} acoes - {formatDateTime(run.createdAt)}</em>
                </div>
              </article>
            ))}

            {!isRunsLoading && runs.length === 0 ? (
              <p className="list-note">Sem execucoes para esta regra.</p>
            ) : null}
          </div>
        </aside>
      </div>
    </section>
  );
}
