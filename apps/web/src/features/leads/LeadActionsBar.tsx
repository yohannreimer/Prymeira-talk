import { CircleCheck, Send, UserPlus } from "lucide-react";

export function LeadActionsBar({ count, busy, onVerify, onImport, onCampaign }: { count: number; busy: boolean; onVerify: () => void; onImport: () => void; onCampaign: () => void }) {
  return <div className="leads-actions-bar" aria-live="polite"><strong>{count} selecionado{count === 1 ? "" : "s"}</strong><div>
    <button type="button" className="secondary-button" disabled={!count || busy || count > 250} onClick={onVerify}><CircleCheck size={16} /> Verificar WhatsApp</button>
    <button type="button" className="secondary-button" disabled={!count || busy} onClick={onImport}><UserPlus size={16} /> Cadastrar contatos</button>
    <button type="button" className="primary-button" disabled={!count || busy} onClick={onCampaign}><Send size={16} /> Criar lote de disparo</button>
  </div></div>;
}
