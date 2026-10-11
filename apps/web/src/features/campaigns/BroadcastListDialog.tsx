import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, ContactRound, ListPlus, Pencil, Plus, Search, Users, X } from 'lucide-react';
import type { ContactDto } from '@prymeira-talk/shared';
import {
  apiAddBroadcastListMembers, apiCreateBroadcastList, apiGetBroadcastList, apiGetBroadcastLists,
  apiGetContactsPage, apiRemoveBroadcastListMember, apiRenameBroadcastList, type BroadcastListDetailDto,
  type BroadcastListDto
} from '../../app/api';
import { ContactAvatar, ContactPhotoProvider } from '../inbox/ContactAvatar';
import { findOrCreateRecipient } from '../inbox/send-helpers';

const PAGE_SIZE = 50;

export function BroadcastListDialog({ initialListId, getToken, onClose, onSelected }: {
  initialListId: string | null;
  getToken: () => Promise<string | null>;
  onClose(): void;
  onSelected(list: BroadcastListDto): void;
}) {
  const [lists, setLists] = useState<BroadcastListDto[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(initialListId);
  const [detail, setDetail] = useState<BroadcastListDetailDto | null>(null);
  const [directory, setDirectory] = useState<ContactDto[]>([]);
  const [directoryCursor, setDirectoryCursor] = useState<string | null>(null);
  const [directoryTotal, setDirectoryTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [newListName, setNewListName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [creatingContact, setCreatingContact] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyContactId, setBusyContactId] = useState<string | null>(null);
  const [loadingDirectory, setLoadingDirectory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedIds = useMemo(() => new Set(detail?.contacts.map((contact) => contact.id) ?? []), [detail]);
  const selectedSummary = lists.find((list) => list.id === selectedListId) ?? null;

  useEffect(() => {
    let active = true;
    void apiGetBroadcastLists(getToken).then((items) => {
      if (!active) return;
      setLists(items);
      setSelectedListId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as listas.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [getToken]);

  useEffect(() => {
    if (!selectedListId) { setDetail(null); return; }
    let active = true;
    setDetail(null);
    void apiGetBroadcastList(getToken, selectedListId).then((next) => { if (active) setDetail(next); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar a lista.'); });
    return () => { active = false; };
  }, [getToken, selectedListId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    setLoadingDirectory(true);
    void apiGetContactsPage(getToken, { search: debouncedSearch, limit: PAGE_SIZE }).then((page) => {
      if (!active) return;
      setDirectory(page.items);
      setDirectoryCursor(page.nextCursor);
      setDirectoryTotal(page.total);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Não foi possível pesquisar contatos.'); })
      .finally(() => { if (active) setLoadingDirectory(false); });
    return () => { active = false; };
  }, [getToken, debouncedSearch]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy && !busyContactId) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, busyContactId, onClose]);

  async function refreshList(listId: string) {
    const [next, summaries] = await Promise.all([apiGetBroadcastList(getToken, listId), apiGetBroadcastLists(getToken)]);
    setDetail(next);
    setLists(summaries);
  }

  async function createList(event: FormEvent) {
    event.preventDefault();
    if (!newListName.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const created = await apiCreateBroadcastList(getToken, newListName.trim());
      setLists((current) => [created, ...current]);
      setSelectedListId(created.id);
      setNewListName('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível criar a lista.'); }
    finally { setBusy(false); }
  }

  async function renameList(event: FormEvent) {
    event.preventDefault();
    if (!selectedListId || !renameValue.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const renamed = await apiRenameBroadcastList(getToken, selectedListId, renameValue.trim());
      setLists((current) => current.map((item) => item.id === renamed.id ? renamed : item));
      setDetail((current) => current?.id === renamed.id ? { ...current, name: renamed.name } : current);
      setRenaming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível renomear a lista.'); }
    finally { setBusy(false); }
  }

  async function toggle(contactId: string) {
    if (!selectedListId || !detail || busyContactId) return;
    setBusyContactId(contactId); setError(null);
    try {
      if (selectedIds.has(contactId)) await apiRemoveBroadcastListMember(getToken, selectedListId, contactId);
      else await apiAddBroadcastListMembers(getToken, selectedListId, [contactId]);
      await refreshList(selectedListId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível alterar a lista.'); }
    finally { setBusyContactId(null); }
  }

  async function addVisibleContacts() {
    if (!selectedListId || !detail || busy) return;
    const ids = directory.filter((contact) => !selectedIds.has(contact.id)).map((contact) => contact.id);
    if (!ids.length) return;
    setBusy(true); setError(null);
    try { await apiAddBroadcastListMembers(getToken, selectedListId, ids); await refreshList(selectedListId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível adicionar os contatos.'); }
    finally { setBusy(false); }
  }

  async function createContact(event: FormEvent) {
    event.preventDefault();
    if (!selectedListId || !contactPhone.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const contact = await findOrCreateRecipient(getToken, contactPhone, contactName.trim() || undefined);
      await apiAddBroadcastListMembers(getToken, selectedListId, [contact.id]);
      await refreshList(selectedListId);
      setDirectory((current) => [contact, ...current.filter((item) => item.id !== contact.id)]);
      setCreatingContact(false); setContactName(''); setContactPhone('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível criar o contato.'); }
    finally { setBusy(false); }
  }

  async function loadMore() {
    if (!directoryCursor || loadingDirectory) return;
    setLoadingDirectory(true); setError(null);
    try {
      const page = await apiGetContactsPage(getToken, { search: debouncedSearch, cursor: directoryCursor, limit: PAGE_SIZE });
      setDirectory((current) => [...current, ...page.items.filter((item) => !current.some((contact) => contact.id === item.id))]);
      setDirectoryCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível carregar mais contatos.'); }
    finally { setLoadingDirectory(false); }
  }

  const dialog = <div className="broadcast-list-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy && !busyContactId) onClose(); }}>
    <div className="broadcast-list-dialog" role="dialog" aria-modal="true" aria-labelledby="broadcast-list-title">
      <header className="broadcast-list-header"><div className="broadcast-list-heading-icon"><Users size={24} /></div><div>
        <span className="broadcast-list-kicker">DISPAROS · DESTINATÁRIOS</span><h2 id="broadcast-list-title">Listas de transmissão</h2>
        <p>Organize seus contatos uma vez e use a lista em quantos disparos precisar.</p>
      </div><button type="button" aria-label="Fechar listas" className="broadcast-list-close" onClick={onClose} disabled={busy || !!busyContactId}><X size={22} /></button></header>
      {error ? <p role="alert" className="broadcast-list-error">{error}</p> : null}
      <div className="broadcast-list-columns">
        <aside className="broadcast-list-sidebar" aria-label="Listas salvas">
          <div className="broadcast-list-section-title"><span>SUAS LISTAS</span><b>{lists.length}</b></div>
          <div className="broadcast-list-saved">
            {loading ? <p className="broadcast-list-empty">Carregando listas...</p> : lists.length === 0 ? <p className="broadcast-list-empty">Crie uma lista para começar.</p> : lists.map((list) => <button type="button" key={list.id}
              className={`broadcast-list-saved-item ${list.id === selectedListId ? 'is-selected' : ''}`}
              onClick={() => { setSelectedListId(list.id); setRenaming(false); setError(null); }}>
              <span className="broadcast-list-saved-icon"><Users size={17} /></span><span><strong>{list.name}</strong><small>{list.memberCount} {list.memberCount === 1 ? 'contato' : 'contatos'}</small></span><ChevronRight size={17} />
            </button>)}
          </div>
          <form className="broadcast-list-create" onSubmit={(event) => void createList(event)}><label htmlFor="broadcast-list-new-name">Nova lista</label>
            <div><input id="broadcast-list-new-name" value={newListName} maxLength={120} placeholder="Ex.: Clientes da Villefer" onChange={(event) => setNewListName(event.target.value)} /><button type="submit" aria-label="Criar lista" disabled={!newListName.trim() || busy}><Plus size={18} /></button></div>
          </form>
        </aside>
        <main className="broadcast-list-directory">
          <div className="broadcast-list-directory-head"><div><span className="broadcast-list-kicker">CONTATOS</span><h3>{detail?.name ?? 'Escolha ou crie uma lista'}</h3><p>Pesquise e marque as pessoas que farão parte desta lista.</p></div>
            {detail ? <button type="button" className="broadcast-list-rename" aria-label="Renomear lista" onClick={() => { setRenameValue(detail.name); setRenaming(true); }}><Pencil size={17} /></button> : null}</div>
          {renaming ? <form className="broadcast-list-rename-form" onSubmit={(event) => void renameList(event)}><input aria-label="Novo nome da lista" value={renameValue} maxLength={120} onChange={(event) => setRenameValue(event.target.value)} /><button type="submit" disabled={busy || !renameValue.trim()}>Salvar nome</button><button type="button" onClick={() => setRenaming(false)}>Cancelar</button></form> : null}
          <div className="broadcast-list-search-row"><label className="broadcast-list-search"><Search size={19} /><input type="search" placeholder="Buscar por nome ou número" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <button type="button" className="broadcast-list-new-contact" disabled={!selectedListId} onClick={() => setCreatingContact((value) => !value)}><ListPlus size={18} /> Novo contato</button></div>
          {creatingContact ? <form className="broadcast-list-contact-form" onSubmit={(event) => void createContact(event)}><div><label>Nome<input autoFocus value={contactName} maxLength={200} placeholder="Nome do contato" onChange={(event) => setContactName(event.target.value)} /></label><label>Telefone com DDD<input type="tel" value={contactPhone} placeholder="55 79 99139-6920" onChange={(event) => setContactPhone(event.target.value)} /></label></div><button type="submit" disabled={busy || !contactPhone.trim()}>Salvar e adicionar</button></form> : null}
          <div className="broadcast-list-directory-caption"><strong>{directoryTotal} contatos no Talk</strong><span>{detail ? 'Marque para adicionar; desmarque para remover.' : 'Selecione uma lista à esquerda para editar.'}</span>
            {detail && directory.some((contact) => !selectedIds.has(contact.id)) ? <button type="button" disabled={busy || !!busyContactId} onClick={() => void addVisibleContacts()}>Adicionar contatos exibidos</button> : null}</div>
          <div className="broadcast-list-contact-scroll">
            {loadingDirectory ? <p className="broadcast-list-empty">Carregando contatos...</p> : directory.length === 0 ? <p className="broadcast-list-empty">Nenhum contato encontrado. Use “Novo contato” para cadastrar.</p> : directory.map((contact) => <label className={`broadcast-list-contact-row ${selectedIds.has(contact.id) ? 'is-included' : ''}`} key={contact.id}>
              <ContactAvatar contactId={contact.id} name={contact.name || contact.phone} className="broadcast-list-avatar" />
              <span className="broadcast-list-contact-identity"><strong>{contact.name?.trim() || contact.phone}</strong><small>{contact.phone}</small></span>
              <input type="checkbox" checked={selectedIds.has(contact.id)} disabled={!detail || !!busyContactId || busy}
                onChange={() => void toggle(contact.id)} aria-label={`${selectedIds.has(contact.id) ? 'Remover' : 'Adicionar'} ${contact.name?.trim() || contact.phone}`} />
            </label>)}
            {directoryCursor ? <button type="button" className="broadcast-list-load-more" disabled={loadingDirectory} onClick={() => void loadMore()}>Carregar mais contatos</button> : null}
          </div>
        </main>
        <aside className="broadcast-list-selected" aria-label="Contatos selecionados"><div className="broadcast-list-selected-head"><span className="broadcast-list-kicker">NESTA LISTA</span><strong>{detail?.memberCount ?? 0}</strong></div>
          <h3>Prontos para o próximo disparo</h3><p>Você pode mudar esta lista a qualquer momento. Envios iniciados guardam seus próprios destinatários.</p>
          <div className="broadcast-list-selected-scroll">{!detail?.contacts.length ? <div className="broadcast-list-selected-empty"><ContactRound size={27} /><span>Marque contatos para montar sua lista.</span></div> : detail.contacts.map((contact) => <div className="broadcast-list-selected-row" key={contact.id}><span className="broadcast-list-selected-initial">{(contact.name || contact.phone).slice(0, 1).toUpperCase()}</span><span><strong>{contact.name || contact.phone}</strong><small>{contact.phone}</small></span><button type="button" aria-label={`Remover ${contact.name || contact.phone} da lista`} disabled={!!busyContactId || busy} onClick={() => void toggle(contact.id)}><X size={16} /></button></div>)}</div>
        </aside>
      </div>
      <footer className="broadcast-list-footer"><span>{selectedSummary ? <><Check size={16} /> <strong>{selectedSummary.name}</strong> · {detail?.memberCount ?? selectedSummary.memberCount} contatos</> : 'Crie uma lista e adicione contatos para continuar.'}</span>
        <button type="button" className="primary-button" disabled={!detail || detail.memberCount === 0 || busy || !!busyContactId}
          onClick={() => { if (selectedSummary) onSelected({ ...selectedSummary, memberCount: detail!.memberCount }); }}>Usar esta lista <ChevronRight size={18} /></button></footer>
    </div>
  </div>;
  return createPortal(<ContactPhotoProvider getToken={getToken}>{dialog}</ContactPhotoProvider>, document.body);
}
