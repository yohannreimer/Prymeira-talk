import { noul, type JevClient } from "../../core/jev.js";
import { CRITERIO_INVENTA, PERGUNTA_INVENTA, type Judge } from "../../core/review.js";

/**
 * JEV as the follow-up judge: is this message worth sending now? It answers the question the old
 * follow-up never asked separately. Wire it with judgeFailClosed so a JEV outage sends nothing alone.
 */
export function createJuizDeFollowup(jev: JevClient, thresholds = { vale: 0.35, inventa: 0.6, assunto: 0.3 }): Judge {
  return async ({ texto, jogada, historico, fichaTexto, pedidoTexto, fontesExtras }) => {
    const answers = await jev.ask(
      {
        pedido: pedidoTexto ?? "",
        ficha: fichaTexto,
        jogada: jogada.instrucao,
        ...(fontesExtras ? { outrasFontes: fontesExtras } : {}),
        ultimasMensagens: historico.slice(-12),
        mensagemCandidata: texto
      },
      {
        vale: {
          type: "noul",
          instructions: "A conversa ficou parada. Lendo as últimas mensagens, faz sentido a empresa mandar a mensagemCandidata agora para o cliente?",
          criteria: {
            true: "Sim: o cliente ficou devendo algo real e a mensagem ajuda a retomar.",
            false: "Não: a conversa terminou, a vez é da empresa, o contato não é cliente, ou a mensagem incomoda sem motivo."
          }
        },
        assunto: {
          type: "noul",
          instructions: "A mensagemCandidata fala do assunto que está realmente em aberto no FINAL da conversa (e não de um assunto antigo já resolvido)?",
          criteria: { true: "Fala do assunto em aberto no final.", false: "Fala de um assunto antigo, resolvido ou que não aparece na conversa." }
        },
        inventa: { type: "noul", instructions: PERGUNTA_INVENTA, criteria: CRITERIO_INVENTA }
      }
    );
    const notas = { vale: noul(answers.vale), assunto: noul(answers.assunto), inventa: noul(answers.inventa) };
    if (notas.inventa >= thresholds.inventa) return { ok: false, regra: "juiz_inventa", motivo: "O revisor achou uma afirmação sem base na conversa.", notas };
    if (notas.assunto < thresholds.assunto) return { ok: false, regra: "juiz_assunto", motivo: "O revisor achou que a mensagem fala de um assunto que não é o que está em aberto.", notas };
    if (notas.vale < thresholds.vale) return { ok: false, regra: "juiz_nao_vale", motivo: "O revisor achou que não vale mandar follow-up nesta conversa agora.", notas };
    return { ok: true, notas };
  };
}
