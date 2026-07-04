import { useTalkAuth } from "../../app/auth";
import { Bot, FlaskConical, Play, RefreshCw } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  apiCreateAssistantAction,
  apiGetAssistantActions,
  type AssistantActionDto,
  type AssistantActionType
} from "../../app/api";

function actionLabel(actionType: string) {
  return actionType === "suggested_reply" ? "Sugestão de resposta" : "Resumo";
}

function resultPreview(action: AssistantActionDto) {
  const result = action.result as { summary?: unknown; suggestedReply?: unknown };
  return String(result.summary ?? result.suggestedReply ?? "Resultado simulado registrado.");
}

export function AssistantPage() {
  const { getToken } = useTalkAuth();
  const [actions, setActions] = useState<AssistantActionDto[]>([]);
  const [actionType, setActionType] = useState<AssistantActionType>("summary");
  const [conversationId, setConversationId] = useState("");
  const [contactId, setContactId] = useState("");
  const [prompt, setPrompt] = useState("Cliente quer saber preço e prazo de implantação.");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadActions() {
    setIsLoading(true);
    setError(null);

    try {
      setActions(await apiGetAssistantActions(getToken));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar ações de IA.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadActions();
  }, [getToken]);

  async function createAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const action = await apiCreateAssistantAction(getToken, {
        actionType,
        conversationId: conversationId || null,
        contactId: contactId || null,
        input: {
          transcript: prompt,
          lastMessage: prompt
        }
      });
      setActions((current) => [action, ...current]);
      setNotice(`${actionLabel(action.actionType)} criada em modo ${action.mode}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível criar ação de IA.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="module-page" aria-label="IA">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>IA</h1>
        </div>
        <div className="module-header-actions">
          <span className="status-badge status-badge--bot">
            <FlaskConical size={12} />
            Modo simulado
          </span>
          <button className="secondary-button" type="button" onClick={() => void loadActions()}>
            <RefreshCw size={14} />
            Atualizar
          </button>
        </div>
      </header>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <div className="ops-grid">
        <form className="module-panel module-form" onSubmit={(event) => void createAction(event)}>
          <div className="panel-title-row">
            <h2>Nova ação</h2>
            <span className="status-badge status-badge--bot">Simulada</span>
          </div>
          <label className="form-field">
            Tipo
            <select value={actionType} onChange={(event) => setActionType(event.target.value as AssistantActionType)}>
              <option value="summary">Resumo</option>
              <option value="suggested_reply">Sugestão de resposta</option>
            </select>
          </label>
          <label className="form-field">
            Conversation ID
            <input value={conversationId} onChange={(event) => setConversationId(event.target.value)} placeholder="UUID opcional" />
          </label>
          <label className="form-field">
            Contact ID
            <input value={contactId} onChange={(event) => setContactId(event.target.value)} placeholder="UUID opcional" />
          </label>
          <label className="form-field">
            Contexto
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} required />
          </label>
          <button className="primary-button" type="submit" disabled={isSaving}>
            <Play size={16} />
            Executar
          </button>
        </form>

        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Logs de IA</h2>
            <span>{isLoading ? "Carregando" : `${actions.length} ações`}</span>
          </div>
          {actions.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Bot size={24} />
              </div>
              <h3>Nenhum log</h3>
              <p>Execute uma ação para gravar o primeiro resultado simulado.</p>
            </div>
          ) : null}
          <div className="assistant-log-list">
            {actions.map((action) => (
              <article key={action.id} className="assistant-log-card">
                <div className="assistant-log-header">
                  <span className="status-badge status-badge--bot">{actionLabel(action.actionType)}</span>
                  <span className="status-badge status-badge--closed">{action.mode}</span>
                </div>
                <p className="assistant-log-result">{resultPreview(action)}</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
