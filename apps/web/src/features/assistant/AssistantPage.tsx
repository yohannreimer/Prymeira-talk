import { useAuth } from "@clerk/clerk-react";
import { Bot, FlaskConical, Play, RefreshCw } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  apiCreateAssistantAction,
  apiGetAssistantActions,
  type AssistantActionDto,
  type AssistantActionType
} from "../../app/api";

function actionLabel(actionType: string) {
  return actionType === "suggested_reply" ? "Sugestao de resposta" : "Resumo";
}

function resultPreview(action: AssistantActionDto) {
  const result = action.result as { summary?: unknown; suggestedReply?: unknown };
  return String(result.summary ?? result.suggestedReply ?? "Resultado simulado registrado.");
}

export function AssistantPage() {
  const { getToken } = useAuth();
  const [actions, setActions] = useState<AssistantActionDto[]>([]);
  const [actionType, setActionType] = useState<AssistantActionType>("summary");
  const [conversationId, setConversationId] = useState("");
  const [contactId, setContactId] = useState("");
  const [prompt, setPrompt] = useState("Cliente quer saber preco e prazo de implantacao.");
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
      setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar acoes de IA.");
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
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel criar acao de IA.");
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
        <span className="status-pill status-pending">
          <FlaskConical size={14} />
          Modo simulado
        </span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button" onClick={() => void loadActions()}>
          <RefreshCw size={16} />
          Atualizar
        </button>
      </div>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <div className="ops-grid">
        <form className="module-panel module-form" onSubmit={(event) => void createAction(event)}>
          <div className="panel-title-row">
            <h2>Nova acao</h2>
            <span>Simulada</span>
          </div>
          <label className="form-field">
            Tipo
            <select value={actionType} onChange={(event) => setActionType(event.target.value as AssistantActionType)}>
              <option value="summary">Resumo</option>
              <option value="suggested_reply">Sugestao de resposta</option>
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
            <span>{isLoading ? "Carregando" : `${actions.length} acoes`}</span>
          </div>
          <div className="data-list">
            {actions.length === 0 ? (
              <div className="empty-panel">
                <Bot size={28} />
                <h3>Nenhum log</h3>
                <p>Execute uma acao para gravar o primeiro resultado simulado.</p>
              </div>
            ) : null}
            {actions.map((action) => (
              <div key={action.id}>
                <strong>{actionLabel(action.actionType)}</strong>
                <span>{action.mode}</span>
                <em>{resultPreview(action)}</em>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
