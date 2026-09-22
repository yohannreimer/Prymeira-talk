import type { LeadListDto, LeadSource } from "@prymeira-talk/shared";
import { listProgressLabel } from "./lead-display";

export function LeadListSidebar({ lists, selectedId, onSelect, source }: { lists: LeadListDto[]; selectedId: string | null; onSelect: (id: string) => void; source: LeadSource }) {
  return <aside className="leads-lists" aria-label="Minhas listas">
    <div className="leads-section-heading"><span>Minhas listas</span><b>{lists.length}</b></div>
    {lists.length === 0 && <p className="leads-muted">Suas buscas salvas aparecem aqui.</p>}
    {lists.map(list => <button type="button" key={list.id} className={`leads-list-item${selectedId === list.id ? " is-active" : ""}`} onClick={() => onSelect(list.id)}>
      <span className="leads-list-title">{list.name}</span>
      <span className="leads-list-meta"><span>{list.source === "google_maps" ? "Google Maps" : "Receita Federal"}</span><span>{list.totalCount} resultados</span></span>
      <span className="leads-list-progress"><span className="leads-list-status">{listProgressLabel(list)}</span> · {list.processedCount} processados{list.failedCount > 0 ? ` · ${list.failedCount} falhas` : ""}</span>
    </button>)}
    {source === "google_maps" && <p className="leads-hint">A busca percorre uma área limitada para preservar a qualidade dos resultados.</p>}
  </aside>;
}
