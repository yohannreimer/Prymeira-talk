import { ArrowRight, Check, ClipboardList, ShieldAlert } from "lucide-react";
import type { HandoffBriefDto } from "../../../../../packages/shared/src/assistant";

export function HandoffBrief({ brief, busy, onComplete }: { brief: HandoffBriefDto; busy: boolean; onComplete: () => void }) {
  const hasContent = Boolean(brief.nextAction && brief.summary);
  return (
    <section className="handoff-brief" aria-label="Apoio para ação humana" aria-live="polite">
      <div className="handoff-brief-intro">
        <span className="handoff-brief-kicker"><ShieldAlert size={15} aria-hidden="true" /> Humano necessário</span>
        <h3>Próximo passo</h3>
        {brief.status === "stale" ? <p className="handoff-brief-update">Atualizando com as novas mensagens…</p> : null}
      </div>
      {hasContent ? <>
        <div className="handoff-brief-next">
          <span><ArrowRight size={16} aria-hidden="true" /> Faça agora</span>
          <p>{brief.nextAction}</p>
        </div>
        <div className="handoff-brief-summary">
          <h4><ClipboardList size={14} aria-hidden="true" /> Resumo</h4>
          <p>{brief.summary}</p>
        </div>
      </> : brief.status === "failed" ? <p className="handoff-brief-message" role="alert">{brief.error ?? "Apoio indisponível. Confira a conversa."}</p>
        : <p className="handoff-brief-message" role="status">Preparando próximo passo…</p>}
      {brief.status === "stale" && hasContent ? <p className="handoff-brief-footnote">Resumo anterior; confira as novas mensagens antes de agir.</p> : null}
      <div className="handoff-brief-actions">
        <button className="assistant-primary" type="button" disabled={busy} onClick={onComplete}><Check size={15} aria-hidden="true" /> {busy ? "Concluindo…" : "Marcar como concluído"}</button>
        <p>Remove da lista Próxima ação. O atendimento continua com o humano.</p>
      </div>
    </section>
  );
}
