import type { LeadResultDto } from "@prymeira-talk/shared";
import { ExternalLink, Phone, Mail, Sparkles } from "lucide-react";
import { formatCnpj, whatsappLabels } from "./lead-display";

export function LeadResultsTable({ items, selected, onToggle, onSelectAll, onSimilar }: { items: LeadResultDto[]; selected: Set<string>; onToggle: (id: string) => void; onSelectAll: () => void; onSimilar: (lead: LeadResultDto) => void }) {
  return <div className="leads-results-scroll"><table className="leads-results-table">
    <thead><tr><th scope="col"><input type="checkbox" aria-label="Selecionar todos os resultados desta página" checked={items.length > 0 && items.every(item => selected.has(item.id))} onChange={onSelectAll} /></th><th scope="col">Empresa</th><th scope="col">Contato</th><th scope="col">Localização / atividade</th><th scope="col">WhatsApp</th><th scope="col">Origem</th><th scope="col">Ações</th></tr></thead>
    <tbody>{items.map(item => <tr key={item.id} className={selected.has(item.id) ? "is-selected" : ""}>
      <td><input type="checkbox" aria-label={`Selecionar ${item.tradeName || item.companyName || item.cnpj || "empresa"}`} checked={selected.has(item.id)} onChange={() => onToggle(item.id)} /></td>
      <td><strong>{item.tradeName || item.companyName || "Empresa sem nome"}</strong>{item.tradeName && item.companyName && <small>{item.companyName}</small>}<small>{formatCnpj(item.cnpj)}</small></td>
      <td>{item.phones.length > 0 ? <span><Phone size={13} aria-hidden="true" /> {item.phones[0]}{item.phones.length > 1 ? ` +${item.phones.length - 1}` : ""}</span> : <small>Sem telefone</small>}{item.email && <span><Mail size={13} aria-hidden="true" /> {item.email}</span>}</td>
      <td>{item.address && <span>{item.address}</span>}<small>{[item.city, item.state].filter(Boolean).join(" / ") || "Local não informado"} · {item.cnaePrimary || item.category || "Atividade não informada"}</small></td>
      <td><span className={`leads-chip whatsapp-${item.whatsappStatus}`}>{whatsappLabels[item.whatsappStatus]}</span></td>
      <td><span className="leads-chip">{item.source === "google_maps" ? "Maps" : "Receita"}</span></td>
      <td className="leads-row-actions">{item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`Abrir origem de ${item.tradeName || item.companyName}`}><ExternalLink size={15} /> Origem</a>}{item.source === "receita_federal" && item.cnpj && <button type="button" onClick={() => onSimilar(item)}><Sparkles size={15} /> Similares</button>}</td>
    </tr>)}</tbody>
  </table></div>;
}
