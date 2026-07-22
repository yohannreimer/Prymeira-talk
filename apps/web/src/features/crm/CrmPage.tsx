import type { ContactDto } from "@prymeira-talk/shared";
import { useTalkAuth } from "../../app/auth";
import {
  Activity,
  AlertTriangle,
  Bot,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  FlaskConical,
  Link2,
  Plus,
  RefreshCw,
  StickyNote,
  UserRoundCheck
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  apiCreateCrmLead,
  apiCreateCrmNote,
  apiGetContacts,
  apiGetConversationContext,
  apiGetCrmSyncActions,
  apiLinkCrmContact,
  type CrmSyncActionDto
} from "../../app/api";

function actionLabel(actionType: string) {
  const labels: Record<string, string> = {
    link_contact: "Contato vinculado",
    create_lead: "Oportunidade criada",
    create_note: "Nota da IA enviada"
  };
  return labels[actionType] ?? actionType;
}

function actionVerb(actionType: string) {
  const labels: Record<string, string> = {
    link_contact: "vinculou o contato",
    create_lead: "criou uma oportunidade",
    create_note: "enviou uma nota"
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
  return mode === "real" ? "Real" : "Local";
}

export function readCrmContactId(search: string) {
  return new URLSearchParams(search).get("contact")?.trim() || null;
}

function readCrmConversationId(search: string) {
  return new URLSearchParams(search).get("conversation")?.trim() || null;
}

function formatPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  const brazilian = digits.startsWith("55") ? digits.slice(2) : digits;
  if (brazilian.length !== 10 && brazilian.length !== 11) return value;
  const area = brazilian.slice(0, 2);
  const subscriber = brazilian.slice(2);
  const splitAt = subscriber.length - 4;
  return `+55 ${area} ${subscriber.slice(0, splitAt)}-${subscriber.slice(splitAt)}`;
}

export function crmContactOptionLabel(contact: Pick<ContactDto, "name" | "company" | "phone">) {
  return [contact.name ?? "Contato sem nome", contact.company, formatPhone(contact.phone)]
    .filter(Boolean)
    .join(" · ");
}

export function crmLeadTitle(contact: Pick<ContactDto, "name" | "company">) {
  return `Orçamento — ${contact.company ?? contact.name ?? "Novo contato"}`;
}

export function CrmPage() {
  const { getToken } = useTalkAuth();
  const [actions, setActions] = useState<CrmSyncActionDto[]>([]);
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [contactId, setContactId] = useState("");
  const [atomicCrmContactId, setAtomicCrmContactId] = useState("");
  const [leadTitle, setLeadTitle] = useState("Novo orçamento Talk");
  const [noteBody, setNoteBody] = useState("Resumo comercial criado a partir do atendimento.");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.id === contactId) ?? null,
    [contactId, contacts]
  );

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
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar o CRM.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let isMounted = true;

    async function loadCrmPage() {
      setIsLoading(true);
      setError(null);
      try {
        const requestedContactId = readCrmContactId(window.location.search);
        const requestedConversationId = readCrmConversationId(window.location.search);
        const [loadedContacts, conversationContext] = await Promise.all([
          apiGetContacts(getToken),
          requestedConversationId
            ? apiGetConversationContext(requestedConversationId, getToken)
            : Promise.resolve(null)
        ]);
        if (!isMounted) return;

        const nextContact =
          loadedContacts.find((contact) => contact.id === requestedContactId) ??
          loadedContacts[0] ??
          null;
        setContacts(loadedContacts);
        setContactId(nextContact?.id ?? "");
        if (nextContact) setLeadTitle(crmLeadTitle(nextContact));

        const aiNote = conversationContext?.notes.find((note) => note.body.startsWith("Resumo da IA:"));
        if (aiNote) setNoteBody(aiNote.body);

        const loadedActions = await apiGetCrmSyncActions(getToken, nextContact?.id);
        if (isMounted) setActions(loadedActions);
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar o CRM.");
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void loadCrmPage();
    return () => {
      isMounted = false;
    };
  }, [getToken]);

  function selectContact(nextContactId: string) {
    const nextContact = contacts.find((contact) => contact.id === nextContactId) ?? null;
    setContactId(nextContactId);
    setLeadTitle(nextContact ? crmLeadTitle(nextContact) : "Novo orçamento Talk");
    setNoteBody("Resumo comercial criado a partir do atendimento.");
    setNotice(null);

    const url = new URL(window.location.href);
    if (nextContactId) url.searchParams.set("contact", nextContactId);
    else url.searchParams.delete("contact");
    url.searchParams.delete("conversation");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    void loadActions(nextContactId);
  }

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
      setNotice(`${actionLabel(syncAction.actionType)} em ambiente ${modeLabel(syncAction.mode).toLowerCase()}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível executar a ação no CRM.");
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
          <span className={`status-pill ${metrics.real > 0 ? "status-active" : "status-pending"}`}>
            <FlaskConical size={14} />
            {metrics.real > 0 ? "Conexão real" : "Ambiente local"}
          </span>
          <button className="secondary-button" type="button" onClick={() => void loadActions()} disabled={isLoading}>
            <RefreshCw size={16} /> Atualizar
          </button>
        </div>
      </header>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <section className="crm-summary-grid" aria-label="Resumo Vincula CRM">
        <article className="crm-summary-item"><span>Oportunidades</span><strong>{metrics.leads}</strong><small>Criadas para o contato selecionado</small></article>
        <article className="crm-summary-item"><span>Notas enviadas</span><strong>{metrics.notes}</strong><small>Contexto comercial registrado no CRM</small></article>
        <article className="crm-summary-item"><span>Sincronizações reais</span><strong>{metrics.real}</strong><small>Chamadas confirmadas pelo Vincula</small></article>
        <article className={`crm-summary-item ${metrics.needsAttention ? "is-warning" : ""}`}><span>Atenção</span><strong>{metrics.needsAttention}</strong><small>{metrics.needsAttention ? "Itens que não finalizaram" : "Nenhuma pendência"}</small></article>
      </section>

      <div className="crm-dashboard-grid">
        <section className="module-panel crm-activity-panel" aria-label="Últimas sincronizações">
          <div className="panel-title-row crm-activity-heading">
            <div><h2>Histórico de sincronização</h2><p>O que o Talk enviou ao Vincula para este contato.</p></div>
            <label className="crm-contact-picker">
              <span>Contato ativo</span>
              <select value={contactId} onChange={(event) => selectContact(event.target.value)}>
                <option value="">Selecione um contato</option>
                {contacts.map((contact) => <option key={contact.id} value={contact.id}>{crmContactOptionLabel(contact)}</option>)}
              </select>
            </label>
          </div>

          <div className="crm-activity-list">
            {!isLoading && actions.length === 0 ? (
              <div className="crm-empty-state"><BriefcaseBusiness size={28} /><strong>Contato pronto para sincronizar</strong><p>Crie a oportunidade ou envie a nota da IA no painel ao lado.</p></div>
            ) : null}
            {actions.map((action) => {
              const result = resultObject(action);
              const payload = payloadObject(action);
              const vinculaContactId = readField(result, "vinculaContactId") ?? readField(result, "atomicCrmContactId");
              const vinculaLeadId = readField(result, "vinculaLeadId") ?? readField(result, "atomicCrmLeadId");
              const vinculaCompanyId = readField(result, "vinculaCompanyId");
              return (
                <article key={action.id} className="crm-activity-row">
                  <div className={`crm-activity-icon crm-activity-icon--${action.status === "completed" ? "ok" : "warn"}`}>
                    {action.status === "completed" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
                  </div>
                  <div className="crm-activity-main">
                    <div className="crm-activity-title"><strong>{actionLabel(action.actionType)}</strong><span>{modeLabel(action.mode)}</span></div>
                    <p>Talk {actionVerb(action.actionType)}{readField(payload, "title") ? `: ${readField(payload, "title")}` : ""}.</p>
                    <div className="crm-id-row">
                      {vinculaContactId ? <span>Contato: {vinculaContactId}</span> : null}
                      {vinculaLeadId ? <span>Oportunidade: {vinculaLeadId}</span> : null}
                      {vinculaCompanyId ? <span>Empresa: {vinculaCompanyId}</span> : null}
                    </div>
                  </div>
                  <time>{formatDate(action.createdAt)}</time>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="module-panel crm-guide-panel" aria-label="Sincronizar contato com Vincula">
          <section className="crm-ready-panel">
            <p className="eyebrow">Pronto para o CRM</p>
            <div className="crm-ready-contact">
              <span><UserRoundCheck size={18} /></span>
              <div><h3>{selectedContact?.name ?? "Selecione um contato"}</h3><p>{selectedContact?.company ?? selectedContact?.phone ?? ""}</p></div>
            </div>
            <form className="crm-action-form" onSubmit={(event) => void runAction(event, "lead")}>
              <label>Título da oportunidade<input value={leadTitle} onChange={(event) => setLeadTitle(event.target.value)} required /></label>
              <button className="primary-button" type="submit" disabled={isSaving || !contactId}><Plus size={16} /> Criar oportunidade</button>
            </form>
            <form className="crm-action-form" onSubmit={(event) => void runAction(event, "note")}>
              <label><span className="crm-note-label"><Bot size={13} /> Nota preparada pela IA</span><textarea rows={4} value={noteBody} onChange={(event) => setNoteBody(event.target.value)} required /></label>
              <button className="secondary-button" type="submit" disabled={isSaving || !contactId}><StickyNote size={16} /> Enviar nota da IA</button>
            </form>
          </section>

          <details className="crm-advanced-panel">
            <summary>Ações técnicas</summary>
            <form className="module-form" onSubmit={(event) => void runAction(event, "link")}>
              <label className="form-field">Contato Talk<input value={contactId} readOnly /></label>
              <label className="form-field">ID do contato no Vincula<input value={atomicCrmContactId} onChange={(event) => setAtomicCrmContactId(event.target.value)} placeholder="Ex: 42" /></label>
              <button className="secondary-button" type="submit" disabled={isSaving || !contactId || !atomicCrmContactId}><Link2 size={16} /> Vincular contato</button>
            </form>
          </details>

          <div className="crm-health-box"><Building2 size={18} /><div><strong>Empresa vinculada</strong><p>O Vincula reutiliza ou cria a empresa e conecta contato, oportunidade e notas.</p></div></div>
          <div className="crm-guide-inline"><Activity size={15} /><span>Em modo local, o mesmo contrato gera IDs simulados e histórico persistente.</span></div>
        </aside>
      </div>
    </section>
  );
}
