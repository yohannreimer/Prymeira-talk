import { useAuth } from "@clerk/clerk-react";
import { FlaskConical, Link2, Plus, RefreshCw, StickyNote } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  apiCreateCrmLead,
  apiCreateCrmNote,
  apiGetCrmSyncActions,
  apiLinkCrmContact,
  type CrmSyncActionDto
} from "../../app/api";

function actionLabel(actionType: string) {
  const labels: Record<string, string> = {
    link_contact: "Vincular contato",
    create_lead: "Criar lead",
    create_note: "Criar nota"
  };

  return labels[actionType] ?? actionType;
}

export function CrmPage() {
  const { getToken } = useAuth();
  const [actions, setActions] = useState<CrmSyncActionDto[]>([]);
  const [contactId, setContactId] = useState("");
  const [atomicCrmContactId, setAtomicCrmContactId] = useState("crm_demo_123");
  const [leadTitle, setLeadTitle] = useState("Novo lead Talk");
  const [noteBody, setNoteBody] = useState("Nota criada a partir do atendimento.");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadActions(nextContactId = contactId) {
    setIsLoading(true);
    setError(null);

    try {
      setActions(await apiGetCrmSyncActions(getToken, nextContactId || undefined));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar CRM.");
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
      setNotice(`${actionLabel(syncAction.actionType)} registrado em modo ${syncAction.mode}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel executar acao CRM.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="module-page" aria-label="Atomic CRM">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Atomic CRM</h1>
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
        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Acoes</h2>
            <span>Contato filtravel</span>
          </div>
          <form className="module-form" onSubmit={(event) => void runAction(event, "link")}>
            <label className="form-field">
              Contact ID
              <input value={contactId} onChange={(event) => setContactId(event.target.value)} placeholder="UUID do contato" required />
            </label>
            <label className="form-field">
              Atomic CRM Contact ID
              <input value={atomicCrmContactId} onChange={(event) => setAtomicCrmContactId(event.target.value)} />
            </label>
            <button className="primary-button" type="submit" disabled={isSaving}>
              <Link2 size={16} />
              Vincular contato
            </button>
          </form>
          <form className="module-form compact-form" onSubmit={(event) => void runAction(event, "lead")}>
            <label className="form-field">
              Titulo do lead
              <input value={leadTitle} onChange={(event) => setLeadTitle(event.target.value)} required />
            </label>
            <button className="secondary-button" type="submit" disabled={isSaving || !contactId}>
              <Plus size={16} />
              Criar lead
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
        </div>

        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Sync actions</h2>
            <button className="secondary-button" type="button" onClick={() => void loadActions(contactId)}>
              Filtrar contato
            </button>
          </div>
          <div className="ops-table crm-table" role="table">
            <div className="ops-table-row is-header" role="row">
              <span>Acao</span>
              <span>Status</span>
              <span>Contato</span>
            </div>
            {actions.length === 0 ? <p className="list-note">Nenhuma acao CRM registrada.</p> : null}
            {actions.map((action) => (
              <div key={action.id} className="ops-table-row" role="row">
                <span>
                  <strong>{actionLabel(action.actionType)}</strong>
                  <small>{action.mode}</small>
                </span>
                <span>{isLoading ? "Carregando" : action.status}</span>
                <span>{action.contactId ?? "Sem contato"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
