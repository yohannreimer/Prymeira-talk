import { useTalkAuth } from "../../app/auth";
import {
  Activity,
  AlertTriangle,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  FlaskConical,
  Link2,
  Plus,
  RefreshCw,
  StickyNote
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  apiCreateCrmLead,
  apiCreateCrmNote,
  apiGetCrmSyncActions,
  apiLinkCrmContact,
  type CrmSyncActionDto
} from "../../app/api";

function actionLabel(actionType: string) {
  const labels: Record<string, string> = {
    link_contact: "Contato vinculado",
    create_lead: "Lead enviado",
    create_note: "Nota criada"
  };

  return labels[actionType] ?? actionType;
}

function actionVerb(actionType: string) {
  const labels: Record<string, string> = {
    link_contact: "vinculou",
    create_lead: "enviou lead",
    create_note: "criou nota"
  };

  return labels[actionType] ?? actionType;
}

function resultObject(action: CrmSyncActionDto) {
  return action.result && typeof action.result === "object" && !Array.isArray(action.result)
    ? (action.result as Record<string, unknown>)
    : {};
}

function payloadObject(action: CrmSyncActionDto) {
  return action.payload && typeof action.payload === "object" && !Array.isArray(action.payload)
    ? (action.payload as Record<string, unknown>)
    : {};
}

function readField(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function modeLabel(mode: CrmSyncActionDto["mode"]) {
  return mode === "real" ? "Real" : "Simulado";
}

export function CrmPage() {
  const { getToken } = useTalkAuth();
  const [actions, setActions] = useState<CrmSyncActionDto[]>([]);
  const [contactId, setContactId] = useState("");
  const [atomicCrmContactId, setAtomicCrmContactId] = useState("");
  const [leadTitle, setLeadTitle] = useState("Novo lead Talk");
  const [noteBody, setNoteBody] = useState("Nota criada a partir do atendimento.");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const metrics = useMemo(() => {
    const leads = actions.filter((action) => action.actionType === "create_lead").length;
    const notes = actions.filter((action) => action.actionType === "create_note").length;
    const real = actions.filter((action) => action.mode === "real").length;
    const needsAttention = actions.filter((action) => action.status !== "completed").length;

    return { leads, notes, real, needsAttention };
  }, [actions]);

  async function loadActions(nextContactId = contactId) {
    setIsLoading(true);
    setError(null);

    try {
      setActions(await apiGetCrmSyncActions(getToken, nextContactId || undefined));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar CRM.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadActions("");
  }, [getToken]);

  async function runAction(event: FormEvent<HTMLFormElement>, action: "link" | "lead" | "note") {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const syncAction =
        action === "link"
          ? await apiLinkCrmContact(getToken, { contactId, atomicCrmContactId })
          : action === "lead"
            ? await apiCreateCrmLead(getToken, { contactId, title: leadTitle })
            : await apiCreateCrmNote(getToken, { contactId, body: noteBody });

      setActions((current) => [syncAction, ...current]);
      setNotice(`${actionLabel(syncAction.actionType)} em modo ${modeLabel(syncAction.mode).toLowerCase()}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível executar ação CRM.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="module-page crm-page" aria-label="Vincula CRM">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Vincula CRM</h1>
        </div>
        <div className="module-header-actions">
          <span className="status-pill status-pending">
            <FlaskConical size={14} />
            {metrics.real > 0 ? "Conexao real" : "Modo simulado"}
          </span>
          <button className="secondary-button" type="button" onClick={() => void loadActions()} disabled={isLoading}>
            <RefreshCw size={16} />
            Atualizar
          </button>
        </div>
      </header>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <section className="crm-summary-grid" aria-label="Resumo Vincula CRM">
        <article className="crm-summary-item">
          <span>Leads enviados</span>
          <strong>{metrics.leads}</strong>
          <small>Cliques no botão Lead do atendimento</small>
        </article>
        <article className="crm-summary-item">
          <span>Notas criadas</span>
          <strong>{metrics.notes}</strong>
          <small>Registros enviados ou preparados para o CRM</small>
        </article>
        <article className="crm-summary-item">
          <span>Sincronizações reais</span>
          <strong>{metrics.real}</strong>
          <small>Chamadas confirmadas pelo Vincula</small>
        </article>
        <article className={`crm-summary-item ${metrics.needsAttention ? "is-warning" : ""}`}>
          <span>Atencao</span>
          <strong>{metrics.needsAttention}</strong>
          <small>{metrics.needsAttention ? "Itens que não finalizaram" : "Nenhuma pendência registrada"}</small>
        </article>
      </section>

      <div className="crm-dashboard-grid">
        <section className="module-panel crm-activity-panel" aria-label="Ultimas sincronizações">
          <div className="panel-title-row">
            <div>
              <h2>Ultimas sincronizações</h2>
              <p>Histórico do que o Talk enviou para o Vincula.</p>
            </div>
            <form
              className="crm-filter-form"
              onSubmit={(event) => {
                event.preventDefault();
                void loadActions(contactId);
              }}
            >
              <input
                value={contactId}
                onChange={(event) => setContactId(event.target.value)}
                placeholder="Filtrar por UUID do contato"
              />
              <button className="secondary-button" type="submit" disabled={isLoading}>
                Filtrar
              </button>
            </form>
          </div>

          <div className="crm-activity-list">
            {actions.length === 0 ? (
              <div className="crm-empty-state">
                <BriefcaseBusiness size={28} />
                <strong>Nenhuma sincronização ainda</strong>
                <p>Quando você clicar em Lead no atendimento, o resultado aparece aqui.</p>
              </div>
            ) : null}

            {actions.map((action) => {
              const result = resultObject(action);
              const payload = payloadObject(action);
              const vinculaContactId = readField(result, "vinculaContactId");
              const vinculaLeadId = readField(result, "vinculaLeadId");
              const vinculaCompanyId = readField(result, "vinculaCompanyId");

              return (
                <article key={action.id} className="crm-activity-row">
                  <div className={`crm-activity-icon crm-activity-icon--${action.status === "completed" ? "ok" : "warn"}`}>
                    {action.status === "completed" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
                  </div>
                  <div className="crm-activity-main">
                    <div className="crm-activity-title">
                      <strong>{actionLabel(action.actionType)}</strong>
                      <span>{modeLabel(action.mode)}</span>
                    </div>
                    <p>
                      Talk {actionVerb(action.actionType)}
                      {readField(payload, "title") ? `: ${readField(payload, "title")}` : ""}.
                    </p>
                    <div className="crm-id-row">
                      <span>Contato Talk: {action.contactId ?? "--"}</span>
                      {vinculaContactId ? <span>Contato Vincula: {vinculaContactId}</span> : null}
                      {vinculaLeadId ? <span>Lead: {vinculaLeadId}</span> : null}
                      {vinculaCompanyId ? <span>Empresa: {vinculaCompanyId}</span> : null}
                    </div>
                  </div>
                  <time>{formatDate(action.createdAt)}</time>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="module-panel crm-guide-panel" aria-label="Como usar a integração">
          <div className="panel-title-row">
            <h2>Como usar</h2>
            <Activity size={18} />
          </div>
          <ol className="crm-guide-list">
            <li>
              <strong>Atenda pelo WhatsApp</strong>
              <span>A conversa segue normal no modulo Atendimento.</span>
            </li>
            <li>
              <strong>Clique em Lead</strong>
              <span>O Talk cria ou atualiza contato, empresa e lead no Vincula.</span>
            </li>
            <li>
              <strong>Acompanhe aqui</strong>
              <span>Use este painel para conferir IDs, modo real e histórico.</span>
            </li>
          </ol>

          <details className="crm-advanced-panel">
            <summary>Acoes tecnicas</summary>
            <form className="module-form" onSubmit={(event) => void runAction(event, "link")}>
              <label className="form-field">
                Contact ID
                <input value={contactId} onChange={(event) => setContactId(event.target.value)} placeholder="UUID do contato" required />
              </label>
              <label className="form-field">
                ID do contato no Vincula
                <input value={atomicCrmContactId} onChange={(event) => setAtomicCrmContactId(event.target.value)} placeholder="Ex: 42" />
              </label>
              <button className="secondary-button" type="submit" disabled={isSaving || !contactId || !atomicCrmContactId}>
                <Link2 size={16} />
                Vincular contato
              </button>
            </form>
            <form className="module-form compact-form" onSubmit={(event) => void runAction(event, "lead")}>
              <label className="form-field">
                Título do lead
                <input value={leadTitle} onChange={(event) => setLeadTitle(event.target.value)} required />
              </label>
              <button className="secondary-button" type="submit" disabled={isSaving || !contactId}>
                <Plus size={16} />
                Enviar lead
              </button>
            </form>
            <form className="module-form compact-form" onSubmit={(event) => void runAction(event, "note")}>
              <label className="form-field">
                Nota
                <textarea value={noteBody} onChange={(event) => setNoteBody(event.target.value)} required />
              </label>
              <button className="secondary-button" type="submit" disabled={isSaving || !contactId}>
                <StickyNote size={16} />
                Criar nota
              </button>
            </form>
          </details>

          <div className="crm-health-box">
            <Building2 size={18} />
            <div>
              <strong>Empresa no Vincula</strong>
              <p>Quando o contato tem empresa no Talk, a integração tenta reutilizar ou criar a empresa e ligar o contato nela.</p>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
