import { noul, type JevClient } from "../../core/jev.js";
import type { Judge } from "../../core/review.js";

/**
 * JEV as the follow-up judge: is this message worth sending now? It answers the question the old
 * follow-up never asked separately. Wire it with judgeFailClosed so a JEV outage sends nothing alone.
 */
export function createJuizDeFollowup(jev: JevClient, thresholds = { vale: 0.35, inventa: 0.6, assunto: 0.3 }): Judge {
  return async ({ texto, jogada, historico, fichaTexto }) => {
    const answers = await jev.ask(
      { ficha: fichaTexto, pendencia: jogada.instrucao, ultimasMensagens: historico.slice(-12), followupCandidato: texto },
      {
        vale: {
          type: "noul",
          instructions: "A conversa ficou parada. Lendo as últimas mensagens, faz sentido a empresa mandar o followupCandidato agora para o cliente?",
          criteria: {
            true: "Sim: o cliente ficou devendo algo real e a mensagem ajuda a retomar.",
            false: "Não: a conversa terminou, a vez é da empresa, o contato não é cliente, ou a mensagem incomoda sem motivo."
          }
        },
        assunto: {
          type: "noul",
          instructions: "O followupCandidato fala do assunto que está realmente em aberto no FINAL da conversa (e não de um assunto antigo já resolvido)?",
          criteria: { true: "Fala do assunto em aberto no final.", false: "Fala de um assunto antigo, resolvido ou que não aparece na conversa." }
        },
        inventa: {
          type: "noul",
          instructions: "O followupCandidato afirma preço, prazo, estoque, condição ou fato que não está nas últimas mensagens nem na ficha?",
          criteria: { true: "Afirma algo sem base.", false: "Tudo tem base na conversa ou na ficha." }
        }
      }
    );
    if (noul(answers.inventa) >= thresholds.inventa) return { ok: false, regra: "juiz_inventa", motivo: "O revisor achou uma afirmação sem base na conversa." };
    if (noul(answers.assunto) < thresholds.assunto) return { ok: false, regra: "juiz_assunto", motivo: "O revisor achou que a mensagem fala de um assunto que não é o que está em aberto." };
    if (noul(answers.vale) < thresholds.vale) return { ok: false, regra: "juiz_nao_vale", motivo: "O revisor achou que não vale mandar follow-up nesta conversa agora." };
    return { ok: true };
  };
}
