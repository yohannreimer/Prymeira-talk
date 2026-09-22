import { useState, type FormEvent } from "react";
import type { LeadSearchFilters, LeadSource } from "@prymeira-talk/shared";
import { Search, Upload } from "lucide-react";

type Props = {
  source: LeadSource;
  busy: boolean;
  onGoogle: (value: { name: string; niche: string; city: string; state: string }) => void;
  onReceita: (name: string, filters: LeadSearchFilters) => void;
  onLookup: (query: { cnpj?: string; companyName?: string }) => void;
  onCsv: (file: File, name: string) => void;
};

export function LeadSearchPanel({ source, busy, onGoogle, onReceita, onLookup, onCsv }: Props) {
  const [name, setName] = useState("");
  const [activity, setActivity] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [company, setCompany] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [cnae, setCnae] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [capitalMin, setCapitalMin] = useState("");
  const [capitalMax, setCapitalMax] = useState("");
  const [openedFrom, setOpenedFrom] = useState("");
  const [openedTo, setOpenedTo] = useState("");
  const [hasPhone, setHasPhone] = useState(false);
  const [hasEmail, setHasEmail] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const listName = (name.trim() || [activity, city, state].filter(Boolean).join(" · ")).slice(0, 160);
    if (source === "google_maps") {
      onGoogle({ name: listName, niche: activity.trim(), city: city.trim(), state: state.trim().toUpperCase() });
      return;
    }
    const filters: LeadSearchFilters = {
      page: 1, pageSize: 25,
      ...(activity.trim() && { activity: activity.trim() }),
      ...(city.trim() && { city: city.trim() }),
      ...(state.trim() && { state: state.trim().toUpperCase() }),
      ...(cnae.trim() && { cnae: cnae.trim() }),
      ...(companySize.trim() && { companySize: companySize.trim() }),
      ...(capitalMin && { capitalMin: Number(capitalMin) }),
      ...(capitalMax && { capitalMax: Number(capitalMax) }),
      ...(openedFrom && { openedFrom }), ...(openedTo && { openedTo }),
      ...(hasPhone && { hasPhone: true }), ...(hasEmail && { hasEmail: true }), ...(activeOnly && { active: true })
    };
    onReceita(listName || "Busca Receita Federal", filters);
  }

  return <div className="leads-search-panel">
    <form onSubmit={submitSearch} className="leads-search-form">
      <div className="leads-form-head"><div><span className="leads-eyebrow">NOVA PESQUISA</span><h2>{source === "google_maps" ? "Encontre negócios na região" : "Explore empresas da Receita"}</h2></div><span className="leads-source-mark">{source === "google_maps" ? "MAPS" : "CNPJ"}</span></div>
      <div className="leads-form-grid">
        <label>Nome da lista <input className="text-input" value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Clínicas em Campinas" maxLength={160} /></label>
        <label>Atividade {source === "google_maps" ? "/ nicho" : ""}<input className="text-input" value={activity} onChange={e => setActivity(e.target.value)} placeholder={source === "google_maps" ? "Ex.: clínicas odontológicas" : "Ex.: comércio de roupas"} maxLength={160} required={source === "google_maps" || (source === "receita_federal" && !city.trim() && !cnae.trim())} /></label>
        <label>Cidade<input className="text-input" value={city} onChange={e => setCity(e.target.value)} placeholder="Ex.: Campinas" maxLength={120} required={source === "google_maps"} /></label>
        <label>UF<input className="text-input" value={state} onChange={e => setState(e.target.value.toUpperCase())} placeholder="SP" maxLength={2} pattern="[A-Z]{2}" required={source === "google_maps"} /></label>
      </div>
      {source === "receita_federal" && <details className="leads-advanced"><summary>Filtros avançados</summary><div className="leads-form-grid">
        <label>CNAE<input className="text-input" value={cnae} onChange={e => setCnae(e.target.value)} /></label>
        <label>Porte<input className="text-input" value={companySize} onChange={e => setCompanySize(e.target.value)} /></label>
        <label>Capital mínimo<input className="text-input" type="number" min="0" value={capitalMin} onChange={e => setCapitalMin(e.target.value)} /></label>
        <label>Capital máximo<input className="text-input" type="number" min="0" value={capitalMax} onChange={e => setCapitalMax(e.target.value)} /></label>
        <label>Abertura a partir de<input className="text-input" type="date" value={openedFrom} onChange={e => setOpenedFrom(e.target.value)} /></label>
        <label>Abertura até<input className="text-input" type="date" value={openedTo} onChange={e => setOpenedTo(e.target.value)} /></label>
      </div><div className="leads-checks"><label><input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} /> Apenas ativas</label><label><input type="checkbox" checked={hasPhone} onChange={e => setHasPhone(e.target.checked)} /> Com telefone</label><label><input type="checkbox" checked={hasEmail} onChange={e => setHasEmail(e.target.checked)} /> Com e-mail</label></div></details>}
      <div className="leads-form-foot"><p>{source === "google_maps" ? "Busca conservadora: até 10 minutos por região, com resultados parciais preservados." : "Os resultados são salvos em uma lista para seleção e acompanhamento."}</p><button className="primary-button" disabled={busy} type="submit"><Search size={16} /> Buscar empresas</button></div>
    </form>
    {source === "receita_federal" && <div className="leads-secondary-tools"><form onSubmit={event => { event.preventDefault(); onLookup(cnpj.trim() ? { cnpj: cnpj.trim() } : { companyName: company.trim() }); }}><h3>Consultar empresa</h3><div className="leads-inline-fields"><label>CNPJ<input className="text-input" value={cnpj} onChange={e => { setCnpj(e.target.value); if (e.target.value) setCompany(""); }} placeholder="00.000.000/0001-00" /></label><span>ou</span><label>Razão social<input className="text-input" value={company} onChange={e => { setCompany(e.target.value); if (e.target.value) setCnpj(""); }} placeholder="Nome da empresa" /></label><button className="secondary-button" disabled={busy || (!cnpj.trim() && !company.trim())} type="submit">Consultar</button></div></form>
      <form onSubmit={event => { event.preventDefault(); if (file) onCsv(file, name.trim() || file.name.replace(/\.csv$/i, "")); }}><h3>Importar CNPJs</h3><div className="leads-inline-fields"><label>Arquivo CSV<input type="file" accept=".csv,text/csv" onChange={e => setFile(e.target.files?.[0] ?? null)} required /></label><button className="secondary-button" disabled={busy || !file} type="submit"><Upload size={15} /> Importar CSV</button></div><small>CSV de até 5 MiB. Linhas inválidas ficam disponíveis para download.</small></form></div>}
  </div>;
}
