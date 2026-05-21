import { useTalkAuth } from "../../app/auth";
import { Plus, Save, ToggleLeft, ToggleRight, Zap } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  apiCreateAutomation,
  apiGetAutomations,
  apiUpdateAutomation,
  type AutomationActionDto,
  type AutomationRuleDto
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

export function AutomationsPage() {
  const { getToken } = useTalkAuth();
  const [automations, setAutomations] = useState<AutomationRuleDto[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [form, setForm] = useState<AutomationFormState>(emptyForm);
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

  return (
    <section className="module-page automations-page" aria-label="Automacoes">
      <header className="module-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div>
            <p className="eyebrow">Prymeira Talk</p>
            <h1>Automações</h1>
          </div>
          {automations.length > 0 ? (
            <span className="status-badge status-badge--open">
              {enabledCount} ativa{enabledCount !== 1 ? 's' : ''}
            </span>
          ) : null}
        </div>
        <button className="primary-button" type="button" onClick={createDraft}>
          <Plus size={16} aria-hidden="true" />
          Criar fluxo
        </button>
      </header>

      {error ? <p className="error-note" style={{ margin: '0 16px' }}>{error}</p> : null}
      {notice ? <p className="list-note" style={{ margin: '0 16px' }}>{notice}</p> : null}

      <div className="automations-layout">
        <div className="module-panel automations-list-panel">
          <div className="panel-title-row">
            <h2>Regras</h2>
            <span>{isLoading ? 'Carregando' : `${automations.length} regras`}</span>
          </div>

          {!isLoading && automations.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Zap size={28} aria-hidden="true" />
              </div>
              <h3>Nenhuma regra criada</h3>
              <p>Crie um fluxo para automatizar ações na plataforma.</p>
            </div>
          ) : null}

          <div className="automation-rule-list">
            {automations.map((automation) => (
              <button
                className={`automation-rule-card ${automation.id === selectedAutomationId ? 'is-selected' : ''}`}
                key={automation.id}
                onClick={() => setSelectedAutomationId(automation.id)}
                type="button"
              >
                <span className={`status-badge status-badge--${automation.status === 'enabled' ? 'open' : 'closed'}`}>
                  {automation.status === 'enabled' ? 'Ativa' : 'Pausada'}
                </span>
                <span className="automation-rule-info">
                  <strong>{automation.name}</strong>
                  <small>{triggerOptions.find((option) => option.value === automation.trigger)?.label ?? automation.trigger}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <form className="module-panel automation-editor" onSubmit={saveAutomation}>
          <div className="panel-title-row">
            <h2>{selectedAutomation ? 'Editar regra' : 'Novo fluxo'}</h2>
            {selectedAutomation ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void toggleAutomation(selectedAutomation)}
                disabled={isSaving}
              >
                {selectedAutomation.status === 'enabled' ? (
                  <ToggleRight size={15} aria-hidden="true" />
                ) : (
                  <ToggleLeft size={15} aria-hidden="true" />
                )}
                {selectedAutomation.status === 'enabled' ? 'Desabilitar' : 'Habilitar'}
              </button>
            ) : null}
          </div>

          <label className="form-field">
            <span>Nome</span>
            <input
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              required
              value={form.name}
            />
          </label>

          <label className="form-field">
            <span>Trigger</span>
            <select
              onChange={(event) => setForm((current) => ({ ...current, trigger: event.target.value }))}
              value={form.trigger}
            >
              {triggerOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="form-field">
            <span>Resumo das condições</span>
            <input
              onChange={(event) => setForm((current) => ({ ...current, conditionSummary: event.target.value }))}
              required
              value={form.conditionSummary}
            />
          </label>

          <div className="automation-actions-editor">
            <div className="panel-title-row compact">
              <h3 style={{ fontSize: '12px', fontWeight: 700, margin: 0 }}>Ação</h3>
            </div>
            <label className="form-field">
              <span>Tipo</span>
              <select
                onChange={(event) => setForm((current) => ({ ...current, actionType: event.target.value }))}
                value={form.actionType}
              >
                {actionOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>Descrição</span>
              <input
                onChange={(event) => setForm((current) => ({ ...current, actionLabel: event.target.value }))}
                required
                value={form.actionLabel}
              />
            </label>
          </div>

          <div className="automation-editor-footer">
            <button className="primary-button" disabled={isSaving} type="submit">
              <Save size={15} aria-hidden="true" />
              Salvar
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
