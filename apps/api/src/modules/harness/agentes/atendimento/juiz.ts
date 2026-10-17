import { noul, type JevClient } from "../../core/jev.js";
import { createJevJudge, CRITERIO_INVENTA, PERGUNTA_INVENTA, type Judge } from "../../core/review.js";
import type { FichaDoAtendimento } from "./tipos.js";

/** Live attendance has to answer every question, not merely acknowledge a greeting. */
export function createJuizDeAtendimento(jev: JevClient): Judge {
  const geral = createJevJudge(jev, { inventa: 0.6, segue: 0.6, responde: 0.65 });
  return async input => {
    const veredito = await geral(input);
    if (!veredito.ok) return veredito;
    const ficha = input.ficha as FichaDoAtendimento;
    const perguntas = (ficha.perguntas ?? []).filter(p => p.status === "respondida" || p.status === "sem_base");
    if (!perguntas.length) return veredito;
    const questions = Object.fromEntries(perguntas.map((p, i) => [`resposta_${i + 1}`, {
      type: "noul" as const,
      instructions: `A mensagemCandidata responde de fato à pergunta ${p.id}, com as informações relevantes das evidências, sem trocar a resposta por saudação, oferta de catálogo/vendedor ou apenas repetir a pergunta? Uma paráfrase fiel vale. Confira se as evidências se referem ao mesmo produto e material perguntados; condições de outro produto não atendem à pergunta. Não exija dados não perguntados nem repita informações já respondidas na conversa. Se a pergunta está sem base, a resposta deve indicar especificamente o assunto que depende do vendedor.`,
      criteria: { true: "A pergunta foi atendida e as condições essenciais foram preservadas, ou já foi respondida antes e não há nova dúvida sobre ela.", false: "A pergunta ou parte essencial dela ficou sem resposta; só há saudação, oferta, pergunta devolvida ou afirmação genérica sem a condição necessária." }
    }]));
    const answers = await jev.ask({
      perguntas: perguntas.map(p => ({ id: p.id, pergunta: p.texto, status: p.status, evidencias: [p.resposta, ...(p.maisRespostas ?? [])].filter(Boolean) })),
      ultimasMensagens: input.historico.slice(-8), mensagemCandidata: input.texto
    }, questions);
    const notas = { ...veredito.notas, ...Object.fromEntries(perguntas.map((p, i) => [`cobertura_${p.id}`, noul(answers[`resposta_${i + 1}`])])) };
    const faltou = perguntas.filter(p => notas[`cobertura_${p.id}`] < 0.65);
    return faltou.length
      ? { ok: false, regra: "juiz_resposta_incompleta", motivo: `Faltou responder com as evidências da ficha: ${faltou.map(p => `${p.id}: ${p.texto}`).join("; ")}. Responda essas perguntas antes da oferta de catálogo ou vendedor.`, notas }
      : { ok: true, notas };
  };
}

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
