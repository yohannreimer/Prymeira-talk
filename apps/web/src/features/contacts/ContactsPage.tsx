import { useAuth } from "@clerk/clerk-react";
import type { ContactDto } from "@prymeira-talk/shared";
import { Columns3, Pencil, Plus, Save, Search, Users } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiCreateContact, apiGetContacts, apiUpdateContact } from "../../app/api";

type ViewMode = "list" | "board";

interface ContactFormState {
  name: string;
  phone: string;
  email: string;
  company: string;
}

const emptyForm: ContactFormState = {
  name: "",
  phone: "",
  email: "",
  company: ""
};

function mergeContact(contacts: ContactDto[], contact: ContactDto) {
  const withoutContact = contacts.filter((current) => current.id !== contact.id);
  return [contact, ...withoutContact];
}

function contactName(contact: ContactDto) {
  return contact.name ?? contact.phone;
}

function initials(contact: ContactDto) {
  const source = contact.name ?? contact.company ?? contact.phone;
  return source.slice(0, 2).toUpperCase();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short"
  }).format(new Date(value));
}

function toFormState(contact: ContactDto): ContactFormState {
  return {
    name: contact.name ?? "",
    phone: contact.phone,
    email: contact.email ?? "",
    company: contact.company ?? ""
  };
}

export function ContactsPage() {
  const { getToken } = useAuth();
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [createForm, setCreateForm] = useState<ContactFormState>(emptyForm);
  const [editForm, setEditForm] = useState<ContactFormState>(emptyForm);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadContacts() {
      setIsLoading(true);
      setError(null);

      try {
        const nextContacts = await apiGetContacts(getToken, search);

        if (!isMounted) return;

        setContacts(nextContacts);
        setSelectedContactId((current) =>
          nextContacts.some((contact) => contact.id === current)
            ? current
            : nextContacts[0]?.id ?? null
        );
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar contatos.");
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadContacts();

    return () => {
      isMounted = false;
    };
  }, [getToken, search]);

  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.id === selectedContactId) ?? null,
    [contacts, selectedContactId]
  );

  useEffect(() => {
    if (selectedContact) {
      setEditForm(toFormState(selectedContact));
    } else {
      setEditForm(emptyForm);
    }
  }, [selectedContact]);

  const contactsWithEmail = contacts.filter((contact) => contact.email).length;
  const contactsWithCompany = contacts.filter((contact) => contact.company).length;
  const recentlyUpdated = contacts.filter((contact) => {
    const updatedAt = new Date(contact.updatedAt).getTime();
    return Date.now() - updatedAt < 7 * 24 * 60 * 60 * 1000;
  }).length;

  async function handleCreateContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setSaveMessage(null);

    try {
      const contact = await apiCreateContact(getToken, createForm);
      setContacts((current) => mergeContact(current, contact));
      setSelectedContactId(contact.id);
      setCreateForm(emptyForm);
      setSaveMessage("Contato criado.");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Nao foi possivel criar o contato.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleUpdateContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedContact) return;

    setIsSaving(true);
    setError(null);
    setSaveMessage(null);

    try {
      const contact = await apiUpdateContact(getToken, selectedContact.id, editForm);
      setContacts((current) => mergeContact(current, contact));
      setSelectedContactId(contact.id);
      setSaveMessage("Contato atualizado.");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Nao foi possivel atualizar o contato.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="module-page contacts-page" aria-label="Contatos">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Contatos</h1>
        </div>
        <span className="status-pill status-open">Base unificada</span>
      </header>

      <div className="contacts-toolbar">
        <label className="search-field">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Buscar contatos"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nome, telefone, email ou empresa"
            type="search"
            value={search}
          />
        </label>
        <div className="segmented-control" aria-label="Visualizacao de contatos">
          <button
            className={viewMode === "list" ? "is-active" : ""}
            onClick={() => setViewMode("list")}
            type="button"
          >
            <Users size={16} aria-hidden="true" />
            Lista
          </button>
          <button
            className={viewMode === "board" ? "is-active" : ""}
            onClick={() => setViewMode("board")}
            type="button"
          >
            <Columns3 size={16} aria-hidden="true" />
            Board
          </button>
        </div>
      </div>

      <div className="metric-grid" aria-label="Resumo de contatos">
        <article className="metric-card">
          <span>Total</span>
          <strong>{contacts.length}</strong>
          <p>Contatos locais carregados para este workspace.</p>
        </article>
        <article className="metric-card">
          <span>Com email</span>
          <strong>{contactsWithEmail}</strong>
          <p>Prontos para segmentacao multicanal.</p>
        </article>
        <article className="metric-card">
          <span>Atualizados</span>
          <strong>{recentlyUpdated}</strong>
          <p>Registros alterados nos ultimos 7 dias.</p>
        </article>
      </div>

      <div className="contacts-layout">
        <div className="contacts-main">
          <section className="module-panel">
            <div className="panel-title-row">
              <h2>{viewMode === "list" ? "Lista de contatos" : "Board de contatos"}</h2>
              <span>{contactsWithCompany} com empresa</span>
            </div>

            {isLoading ? <p className="list-note">Carregando contatos...</p> : null}
            {error ? <p className="error-note">{error}</p> : null}
            {saveMessage ? <p className="success-note">{saveMessage}</p> : null}

            {!isLoading && contacts.length === 0 ? (
              <div className="empty-panel">
                <Users size={28} aria-hidden="true" />
                <h3>Nenhum contato encontrado</h3>
                <p>Crie um contato local para iniciar sua base do Talk.</p>
              </div>
            ) : null}

            {viewMode === "list" && contacts.length > 0 ? (
              <div className="contacts-table" role="table" aria-label="Contatos locais">
                <div className="contacts-table-head" role="row">
                  <span role="columnheader">Contato</span>
                  <span role="columnheader">Telefone</span>
                  <span role="columnheader">Empresa</span>
                  <span role="columnheader">Atualizado</span>
                  <span role="columnheader">Acao</span>
                </div>
                {contacts.map((contact) => (
                  <button
                    className={
                      contact.id === selectedContactId
                        ? "contacts-row is-selected"
                        : "contacts-row"
                    }
                    key={contact.id}
                    onClick={() => setSelectedContactId(contact.id)}
                    role="row"
                    type="button"
                  >
                    <span className="contacts-person" role="cell">
                      <span className="contact-avatar" aria-hidden="true">{initials(contact)}</span>
                      <span>
                        <strong>{contactName(contact)}</strong>
                        <small>{contact.email ?? "Sem email"}</small>
                      </span>
                    </span>
                    <span role="cell">{contact.phone}</span>
                    <span role="cell">{contact.company ?? "Sem empresa"}</span>
                    <span role="cell">{formatDate(contact.updatedAt)}</span>
                    <span role="cell" className="row-action">
                      <Pencil size={15} aria-hidden="true" />
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            {viewMode === "board" && contacts.length > 0 ? (
              <div className="contacts-board" aria-label="Previa do board de contatos">
                {["Novos", "Em conversa", "Relacionamento"].map((stage, index) => (
                  <section className="board-column" key={stage}>
                    <header>
                      <strong>{stage}</strong>
                      <span>{contacts.slice(index, index + 3).length}</span>
                    </header>
                    {contacts.slice(index, index + 3).map((contact) => (
                      <button
                        className="board-contact"
                        key={`${stage}-${contact.id}`}
                        onClick={() => setSelectedContactId(contact.id)}
                        type="button"
                      >
                        <strong>{contactName(contact)}</strong>
                        <span>{contact.company ?? contact.phone}</span>
                      </button>
                    ))}
                  </section>
                ))}
              </div>
            ) : null}
          </section>
        </div>

        <aside className="contacts-side">
          <form className="contact-form" onSubmit={handleCreateContact}>
            <div className="panel-title-row">
              <h2>Novo contato</h2>
              <Plus size={18} aria-hidden="true" />
            </div>
            <label>
              Nome
              <input
                onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nome do contato"
                type="text"
                value={createForm.name}
              />
            </label>
            <label>
              Telefone
              <input
                onChange={(event) => setCreateForm((current) => ({ ...current, phone: event.target.value }))}
                placeholder="+5511999990000"
                required
                type="tel"
                value={createForm.phone}
              />
            </label>
            <label>
              Email
              <input
                onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="nome@empresa.com"
                type="email"
                value={createForm.email}
              />
            </label>
            <label>
              Empresa
              <input
                onChange={(event) => setCreateForm((current) => ({ ...current, company: event.target.value }))}
                placeholder="Empresa"
                type="text"
                value={createForm.company}
              />
            </label>
            <button className="primary-button icon-button-label" disabled={isSaving} type="submit">
              <Plus size={16} aria-hidden="true" />
              Criar contato
            </button>
          </form>

          <form className="contact-form" onSubmit={handleUpdateContact}>
            <div className="panel-title-row">
              <h2>Editar contato</h2>
              <Save size={18} aria-hidden="true" />
            </div>
            <label>
              Nome
              <input
                disabled={!selectedContact}
                onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))}
                type="text"
                value={editForm.name}
              />
            </label>
            <label>
              Telefone
              <input
                disabled={!selectedContact}
                onChange={(event) => setEditForm((current) => ({ ...current, phone: event.target.value }))}
                required
                type="tel"
                value={editForm.phone}
              />
            </label>
            <label>
              Email
              <input
                disabled={!selectedContact}
                onChange={(event) => setEditForm((current) => ({ ...current, email: event.target.value }))}
                type="email"
                value={editForm.email}
              />
            </label>
            <label>
              Empresa
              <input
                disabled={!selectedContact}
                onChange={(event) => setEditForm((current) => ({ ...current, company: event.target.value }))}
                type="text"
                value={editForm.company}
              />
            </label>
            <button
              className="secondary-button icon-button-label"
              disabled={!selectedContact || isSaving}
              type="submit"
            >
              <Save size={16} aria-hidden="true" />
              Salvar edicao
            </button>
          </form>
        </aside>
      </div>
    </section>
  );
}
