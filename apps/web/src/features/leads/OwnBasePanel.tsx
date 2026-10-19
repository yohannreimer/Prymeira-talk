import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Upload } from "lucide-react";
import type { OwnBaseFilter, OwnBaseLeadPage, OwnBaseOverview } from "@prymeira-talk/shared";
import { useTalkAuth } from "../../app/auth";
import {
  apiCreateLeadCampaignDraft, apiImportLeadContacts, apiOwnBaseLeads, apiOwnBaseOverview, apiOwnBaseSelection, type OwnBaseView
} from "../../app/api";
import { OwnBaseImport } from "./OwnBaseImport";
import { RegionsEditor } from "./RegionsEditor";
import "./own-base.css";

const FILTERS: Array<{ value: OwnBaseFilter; label: string }> = [
  { value: "never", label: "Não disparados" }, { value: "sent", label: "Já disparados" },
  { value: "replied", label: "Responderam" }, { value: "all", label: "Todos" }
];
const date = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
/** +5547999015903 → (47) 99901-5903 */
export function formatPhone(value: string | null) {
  const digits = (value ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  const match = /^(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : value ?? "";
}
type RegionKey = string | null | undefined; // undefined = every region, null = without a region

/**
 * Leads · Base própria: the workspace's own spreadsheets by region. Everyone sees every region; lists are created only
 * from the workspace's own region, and each company shows its last dispatch, whatever list it came from.
 */
export function OwnBasePanel({ onOpenCampaign, onBaseChanged }: { onOpenCampaign: (campaignId: string) => void; onBaseChanged?: () => void }) {
  const { getToken } = useTalkAuth();
  const [overview, setOverview] = useState<OwnBaseOverview | null>(null);
  const [region, setRegion] = useState<RegionKey>(undefined);
  const [filter, setFilter] = useState<OwnBaseFilter>("never");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OwnBaseLeadPage | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; campaignId?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [editingRegions, setEditingRegions] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const request = useRef(0);
  const listId = overview?.list?.id ?? null;

  const loadOverview = useCallback(async () => {
    const next = await apiOwnBaseOverview(getToken);
    setOverview(next);
    setRegion(current => current !== undefined && next.regions.some(item => item.region === current) ? current
      : next.regions.find(item => item.isMine)?.region ?? next.regions[0]?.region ?? undefined);
    return next;
  }, [getToken]);
  useEffect(() => { void loadOverview().catch(cause => setError(cause instanceof Error ? cause.message : "Não foi possível carregar a base.")); }, [loadOverview]);
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query), 300); return () => window.clearTimeout(timer); }, [query]);
  const view: OwnBaseView = useMemo(() => ({ region, filter, q: search }), [region, filter, search]);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [region, filter, search]);
  useEffect(() => {
    if (!listId) { setData(null); return; }
    const mine = ++request.current;
    void apiOwnBaseLeads(getToken, listId, view, page).then(next => { if (request.current === mine) setData(next); })
      .catch(cause => { if (request.current === mine) setError(cause instanceof Error ? cause.message : "Não foi possível carregar as empresas."); });
  }, [getToken, listId, view, page]);

  const current = overview?.regions.find(item => item.region === region);
  const selectable = data?.selectable ?? false;
  const pageIds = data?.items.map(item => item.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every(id => selected.has(id));
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  async function selectAll() {
    if (!listId) return;
    setBusy(true); setError(null);
    try { setSelected(new Set((await apiOwnBaseSelection(getToken, listId, view)).ids)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível selecionar."); }
    finally { setBusy(false); }
  }
  async function createList(name: string) {
    if (!listId || !selected.size) return;
    setBusy(true); setError(null);
    try {
      const ids = [...selected];
      const imported = await apiImportLeadContacts(getToken, listId, ids);
      const eligible = imported.contacts.filter(contact => contact.contactId && contact.provenanceId).map(contact => contact.leadId);
      if (!eligible.length) throw new Error("Nenhuma empresa selecionada tem telefone válido.");
      const result = await apiCreateLeadCampaignDraft(getToken, listId, eligible, undefined, ids, name);
      setNaming(null); setSelected(new Set());
      setNotice({ text: `Lista "${name}" criada em Disparos com ${result.contactCount} empresas. Escreva a mensagem e o ritmo lá; nada foi enviado.`, campaignId: result.campaignId });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar a lista."); }
    finally { setBusy(false); }
  }

  if (importing) return <OwnBaseImport listId={listId} onCancel={() => setImporting(false)}
    onDone={async message => { setImporting(false); setNotice({ text: message }); await loadOverview(); onBaseChanged?.(); }} />;

  if (overview && !overview.list) return <section className="own-base own-base-empty" aria-label="Base própria">
    <h2>Sua base de clientes, por região</h2>
    <p>Suba a planilha que vocês já têm: o Talk reconhece as colunas, separa por região e mostra quem já recebeu disparo.</p>
    <button type="button" className="own-base-go" onClick={() => setImporting(true)}><Upload size={15} aria-hidden="true" />Subir planilha</button>
  </section>;

  return <section className="own-base" aria-label="Base própria">
    {(error || notice) && <p className={`own-base-feedback${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
      {error || notice?.text}
      {!error && notice?.campaignId ? <button type="button" onClick={() => onOpenCampaign(notice.campaignId!)}>Abrir em Disparos</button> : null}
      <button type="button" className="own-base-dismiss" aria-label="Fechar aviso" onClick={() => { setError(null); setNotice(null); }}>×</button>
    </p>}
    <div className="own-base-pane">
      <aside className="own-base-regions">
        <div className="own-base-bar"><div><h2>Regiões</h2><span>{overview?.list?.name ?? "Carregando…"}</span></div></div>
        <ul role="radiogroup" aria-label="Regiões">
          {overview?.regions.map(item => <li key={item.region ?? "__none__"}>
            <button type="button" role="radio" aria-checked={item.region === region} className={item.region === region ? "is-on" : undefined} onClick={() => setRegion(item.region)}>
              <span className="own-base-region-name">{item.region ?? "Sem região"}</span>
              <span className="own-base-count">{item.total.toLocaleString("pt-BR")}</span>
              <span className="own-base-region-meta">{item.isMine ? "Sua região" : item.seller ?? (item.region ? "Sem vendedor" : "Cidade sem região")}{item.dispatched ? ` · ${item.dispatched.toLocaleString("pt-BR")} já disparados` : ""}</span>
            </button>
          </li>)}
        </ul>
        <div className="own-base-links">
          <button type="button" onClick={() => setEditingRegions(true)}>Editar regiões e cidades</button>
          <button type="button" onClick={() => setImporting(true)}>Subir planilha</button>
        </div>
      </aside>
      <div className="own-base-main">
        <div className="own-base-bar">
          <div className="own-base-filters" role="tablist" aria-label="Filtro">
            {FILTERS.map(option => <button key={option.value} type="button" role="tab" aria-selected={filter === option.value} className={filter === option.value ? "is-on" : undefined} onClick={() => setFilter(option.value)}>
              {option.label} <span>{data ? data.counts[option.value].toLocaleString("pt-BR") : ""}</span></button>)}
          </div>
          <label className="own-base-search"><Search size={14} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar empresa ou telefone" aria-label="Buscar empresa ou telefone" /></label>
        </div>
        <div className="own-base-table">
          <table className={selectable ? undefined : "is-locked"}>
            <thead><tr>
              <th className="own-base-check"><input type="checkbox" aria-label="Selecionar esta página" disabled={!selectable || !pageIds.length} checked={allOnPage}
                onChange={() => setSelected(current => { const next = new Set(current); for (const id of pageIds) { if (allOnPage) next.delete(id); else next.add(id); } return next; })} /></th>
              <th>Empresa</th><th>Telefone</th><th>Cidade</th><th>Último disparo</th>
            </tr></thead>
            <tbody>
              {data?.items.map(item => <tr key={item.id}>
                <td className="own-base-check"><input type="checkbox" aria-label={`Selecionar ${item.company}`} disabled={!selectable} checked={selected.has(item.id)} onChange={() => toggle(item.id)} /></td>
                <td>{item.company}</td>
                <td className="own-base-num">{item.phone ? formatPhone(item.phone) : <span className="own-base-faint">sem telefone válido</span>}{item.otherPhones ? <span className="own-base-faint"> +{item.otherPhones}</span> : null}</td>
                <td>{item.city ?? <span className="own-base-faint">—</span>}</td>
                <td>{item.repliedAt ? <span className="own-base-dot is-ok">Respondeu {date(item.repliedAt)}</span>
                  : item.lastDispatch ? <span className="own-base-dot is-sent">{date(item.lastDispatch.at)} · {item.lastDispatch.campaign}</span>
                  : <span className="own-base-faint">—</span>}</td>
              </tr>)}
            </tbody>
          </table>
          {data && !data.items.length ? <p className="own-base-none">{filter === "never" ? "Todas as empresas desta região já receberam disparo." : "Nenhuma empresa aqui."}</p> : null}
          {!data ? <p className="own-base-none">Carregando empresas…</p> : null}
        </div>
        {data && data.total > data.pageSize ? <div className="own-base-pages">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>{((page - 1) * data.pageSize + 1).toLocaleString("pt-BR")}–{Math.min(page * data.pageSize, data.total).toLocaleString("pt-BR")} de {data.total.toLocaleString("pt-BR")}</span>
          <button type="button" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Próxima</button>
        </div> : null}
        {!selectable && data ? <p className="own-base-lock">{current?.seller ? `Região de ${current.seller}. ` : "Região de outro vendedor. "}Você pode consultar, mas só cria listas na sua região.</p> : null}
        {selectable ? <div className="own-base-footbar">
          <span><b>{selected.size.toLocaleString("pt-BR")}</b> selecionadas{data && selected.size < data.total ? <> · <button type="button" className="own-base-link" disabled={busy} onClick={() => void selectAll()}>selecionar as {data.total.toLocaleString("pt-BR")} desta visão</button></> : null}</span>
          <span className="own-base-actions">
            {selected.size ? <button type="button" className="own-base-plain" onClick={() => setSelected(new Set())}>Limpar</button> : null}
            <button type="button" className="own-base-go" disabled={!selected.size || busy}
              onClick={() => setNaming(`${current?.region ?? "Base própria"} · ${new Date().toLocaleDateString("pt-BR", { month: "long" }).replace(/^./, char => char.toUpperCase())}`)}>Criar lista de disparo</button>
          </span>
        </div> : null}
      </div>
    </div>
    {naming !== null ? <div className="own-base-scrim" role="presentation" onClick={event => { if (event.target === event.currentTarget && !busy) setNaming(null); }}>
      <form className="own-base-dialog" role="dialog" aria-modal="true" aria-labelledby="own-base-name-title" onSubmit={event => { event.preventDefault(); if (naming.trim()) void createList(naming.trim()); }}>
        <h2 id="own-base-name-title">Criar lista de disparo</h2>
        <p>As {selected.size.toLocaleString("pt-BR")} empresas vão para uma lista em Disparos. Lá você escreve a mensagem, escolhe o ritmo e agenda.</p>
        <label>Nome da lista<input autoFocus value={naming} maxLength={160} onChange={event => setNaming(event.target.value)} /></label>
        <div className="own-base-actions"><button type="button" className="own-base-plain" disabled={busy} onClick={() => setNaming(null)}>Cancelar</button><button type="submit" className="own-base-go" disabled={busy || !naming.trim()}>{busy ? "Criando…" : "Criar lista"}</button></div>
      </form>
    </div> : null}
    {editingRegions ? <RegionsEditor onClose={() => setEditingRegions(false)} onSaved={async () => { setEditingRegions(false); await loadOverview(); }} /> : null}
  </section>;
}
