import { ArrowRight, ClipboardList, ShieldAlert } from "lucide-react";
import type { HandoffBrief as HandoffBriefData } from "./handoff-brief";

export function HandoffBrief({ brief, messagesLoading }: { brief: HandoffBriefData; messagesLoading: boolean }) {
  return (
    <section className="handoff-brief" aria-label="Resumo para ação humana">
      <div className="handoff-brief-intro">
        <span className="handoff-brief-kicker"><ShieldAlert size={15} aria-hidden="true" /> Humano necessário</span>
        <h3>Próxima ação</h3>
        <p>O agente passou esta conversa para sua equipe.</p>
      </div>

      <div className="handoff-brief-next">
        <span><ArrowRight size={16} aria-hidden="true" /> Faça agora</span>
        <p>{brief.nextStep}</p>
      </div>

      <div className="handoff-brief-facts">
        <div>
          <h4><ClipboardList size={14} aria-hidden="true" /> O cliente informou</h4>
          <p>{messagesLoading ? "Carregando histórico…" : brief.customerContext ?? "Confira o pedido no histórico da conversa."}</p>
        </div>
        <div>
          <h4>O que já foi dito</h4>
          <p>{messagesLoading ? "Carregando histórico…" : brief.lastReply ?? "Não há resposta automática registrada neste histórico."}</p>
        </div>
        <div>
          <h4>Motivo do repasse</h4>
          <p>{brief.reason}</p>
        </div>
      </div>
      <p className="handoff-brief-footnote">Resumo das últimas mensagens. Confira a conversa antes de responder.</p>
    </section>
  );
}
