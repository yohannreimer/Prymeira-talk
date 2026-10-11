import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { LeadRegionDto } from "@prymeira-talk/shared";
import { useTalkAuth } from "../../app/auth";
import { apiGetLeadRegions, apiSaveLeadRegions } from "../../app/api";

type Draft = { name: string; cities: string; seller: string; isMine: boolean };

/** The regions of the workspace: a name, its cities, whose it is and which one is "Sua região". */
export function RegionsEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void | Promise<void> }) {
  const { getToken } = useTalkAuth();
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiGetLeadRegions(getToken).then(regions => setRows(regions.map(region => ({ name: region.name, cities: region.cities.join(", "), seller: region.seller ?? "", isMine: region.isMine }))))
      .catch(cause => setError(cause instanceof Error ? cause.message : "Não foi possível carregar as regiões."));
  }, [getToken]);
  const update = (index: number, patch: Partial<Draft>) => setRows(current => current?.map((row, at) => at === index ? { ...row, ...patch }
    : patch.isMine ? { ...row, isMine: false } : row) ?? null);

  async function save() {
    if (!rows) return;
    const regions: LeadRegionDto[] = rows.filter(row => row.name.trim()).map(row => ({ name: row.name.trim(),
      cities: row.cities.split(/[,;\n]+/).map(city => city.trim()).filter(Boolean), seller: row.seller.trim() || null, isMine: row.isMine }));
    if (new Set(regions.map(region => region.name.toLowerCase())).size !== regions.length) { setError("Duas regiões com o mesmo nome."); return; }
    setSaving(true); setError(null);
    try { await apiSaveLeadRegions(getToken, regions); await onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar."); setSaving(false); }
  }

  return <div className="own-base-scrim" role="presentation" onClick={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div className="own-base-dialog own-base-regions-editor" role="dialog" aria-modal="true" aria-labelledby="regions-title">
      <h2 id="regions-title">Regiões e cidades</h2>
      <p>As empresas vão para a região da cidade delas. "Sua região" é a única em que este workspace cria listas de disparo.</p>
      {!rows ? <p className="own-base-faint">{error ?? "Carregando…"}</p> : <div className="own-base-region-rows">
        {rows.map((row, index) => <fieldset key={index}>
          <legend className="own-base-sr">Região {index + 1}</legend>
          <div className="own-base-region-line">
            <input aria-label="Nome da região" value={row.name} placeholder="Nome da região" onChange={event => update(index, { name: event.target.value })} />
            <input aria-label="Vendedor" value={row.seller} placeholder="Vendedor" onChange={event => update(index, { seller: event.target.value })} />
            <label className="own-base-mine"><input type="radio" name="mine" checked={row.isMine} onChange={() => update(index, { isMine: true })} />Sua região</label>
            <button type="button" className="own-base-icon" aria-label={`Remover ${row.name || "região"}`} onClick={() => setRows(current => current?.filter((_, at) => at !== index) ?? null)}><Trash2 size={15} /></button>
          </div>
          <textarea aria-label="Cidades" rows={2} value={row.cities} placeholder="Cidades separadas por vírgula" onChange={event => update(index, { cities: event.target.value })} />
        </fieldset>)}
        <button type="button" className="own-base-link" onClick={() => setRows(current => [...(current ?? []), { name: "", cities: "", seller: "", isMine: false }])}><Plus size={14} aria-hidden="true" /> Adicionar região</button>
        {rows.some(row => row.isMine) ? <button type="button" className="own-base-link" onClick={() => setRows(current => current?.map(row => ({ ...row, isMine: false })) ?? null)}>Nenhuma é "Sua região" (todas liberadas)</button> : null}
      </div>}
      {error && rows ? <p className="own-base-error" role="alert">{error}</p> : null}
      <div className="own-base-actions"><button type="button" className="own-base-plain" disabled={saving} onClick={onClose}>Cancelar</button><button type="button" className="own-base-go" disabled={saving || !rows} onClick={() => void save()}>{saving ? "Salvando…" : "Salvar"}</button></div>
    </div>
  </div>;
}
