import type { LeadListDto, LeadSource } from "@prymeira-talk/shared";
import { Trash2 } from "lucide-react";
import { listProgressLabel } from "./lead-display";

interface LeadListSidebarProps {
  lists: LeadListDto[];
  selectedId: string | null;
  source: LeadSource;
  expanded: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onToggleExpanded: () => void;
  onLoadMore: () => void;
  onRequestDelete: (list: LeadListDto) => void;
}

export function LeadListSidebar({
  lists, selectedId, source, expanded, hasMore, loadingMore, busy,
  onSelect, onToggleExpanded, onLoadMore, onRequestDelete
}: LeadListSidebarProps) {
  const visibleLists = expanded ? lists : lists.slice(0, 3);
  const canExpand = lists.length > 3 || hasMore;

  return <aside className={`leads-lists${expanded ? " is-expanded" : ""}`} aria-label="Minhas listas">
    <div className="leads-section-heading"><span>Minhas listas</span><b aria-label={`${lists.length}${hasMore ? " ou mais" : ""} listas`}>{lists.length}{hasMore ? "+" : ""}</b></div>
    {lists.length === 0 && <p className="leads-muted">Suas buscas salvas aparecem aqui.</p>}
    <div className="leads-list-items">
      {visibleLists.map(list => <div className={`leads-list-row${selectedId === list.id ? " is-active" : ""}`} key={list.id}>
        <button type="button" className="leads-list-item" aria-current={selectedId === list.id ? "true" : undefined} onClick={() => onSelect(list.id)}>
          <span className="leads-list-title">{list.name}</span>
          <span className="leads-list-meta"><span>{list.source === "google_maps" ? "Google Maps" : "Receita Federal"}</span><span>{list.totalCount} resultados</span></span>
          <span className="leads-list-progress"><span className="leads-list-status">{listProgressLabel(list)}</span> · {list.processedCount} processados{list.failedCount > 0 ? ` · ${list.failedCount} falhas` : ""}</span>
        </button>
        <button type="button" className="leads-list-delete" aria-label={`Excluir lista ${list.name}`} title={`Excluir ${list.name}`} disabled={busy} onClick={() => onRequestDelete(list)}><Trash2 size={15} aria-hidden="true" /></button>
      </div>)}
    </div>
    {canExpand && <div className="leads-list-footer">
      <button type="button" className="leads-list-toggle" aria-expanded={expanded} onClick={onToggleExpanded}>{expanded ? "Mostrar menos" : "Ver todas"}</button>
      {expanded && hasMore && <button type="button" className="leads-list-more" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Carregando…" : "Carregar mais"}</button>}
    </div>}
    {source === "google_maps" && <p className="leads-hint">A busca percorre uma área limitada para preservar a qualidade dos resultados.</p>}
  </aside>;
}
