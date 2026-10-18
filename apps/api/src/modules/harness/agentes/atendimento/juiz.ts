import { choice, noul, type JevClient, type JevQuestion } from "../../core/jev.js";
import { CRITERIO_INVENTA, PERGUNTA_INVENTA, type Judge } from "../../core/review.js";
import type { FichaDoAtendimento } from "./tipos.js";

type Requisito = { id: string; exigencia: string; pergunta: JevQuestion & { type: "choice" }; falhas: Record<string, string> };

/** Review concrete obligations, never veto a reply with an unexplained overall adherence score. */
export function createJuizDeAtendimento(jev: JevClient): Judge {
  return async input => {
    const ficha = input.ficha as FichaDoAtendimento;
    const perguntas = (ficha.perguntas ?? []).filter(p => p.status === "respondida" || p.status === "sem_base");
    const requisitos: Requisito[] = [];
    const add = (id: string, exigencia: string, criteria: Record<string, string>, falhas: Record<string, string>) => {
      requisitos.push({ id, exigencia, falhas, pergunta: { type: "choice", instructions: `${exigencia} Escolha somente uma falha concreta presente na mensagem, não uma preferência de estilo. Paráfrases fiéis e unidades equivalentes valem. Oferta de catálogo/vendedor é opcional e sua ausência não é falha. Não exija copiar todos os trechos nem informações não perguntadas, salvo condições necessárias para não enganar.`, criteria } });
    };
    const fatos: Record<string, string> = { preco: "preço", prazo: "prazo", estoque: "estoque ou pronta entrega", medida: "medida ou formato", pedido_minimo: "pedido mínimo", produto_material: "produto ou material", outro_fato: "outro fato concreto" };
    add("afirmacao_sem_base", PERGUNTA_INVENTA + " Identifique a categoria de uma afirmação sem suporte. Leia todas as fontes; não confunda paráfrase ou condição verdadeira da base com invenção.",
      { nenhuma: "Toda afirmação está apoiada em uma fonte, é paráfrase fiel ou não há afirmação factual.", ...Object.fromEntries(Object.entries(fatos).map(([id, nome]) => [id, `A mensagem afirma ${nome} sem suporte em nenhuma fonte.`])) },
      Object.fromEntries(Object.entries(fatos).map(([id, nome]) => [id, `A mensagem afirma ${nome} sem suporte nas fontes. Retire ou corrija essa afirmação usando apenas as evidências disponíveis.`])));
    perguntas.forEach((p, i) => {
      const fontes = [p.resposta, ...(p.maisRespostas ?? [])].filter(c => c != null);
      const evidencia = fontes.map(c => `${c.trechoId}: "${c.citacao}"`).join("; ");
      const contexto = `${p.id}: "${p.texto}". Evidências: ${evidencia || "sem base"}.`;
      add(`resposta_${i + 1}`, `Atender à pergunta ${contexto} Quando a ficha vincula esta pergunta a um trecho específico, usar o nome do produto desse trecho em vez das palavras do cliente não constitui troca por si só. Para produto_diferente, identifique incompatibilidade concreta de material, família, acabamento ou medida entre o pedido e a resposta; diferença de nome, sinônimo ou ausência de repetição exata não basta. Se ela já foi respondida na conversa e não há nova dúvida, não exija repetição. Se está sem base, indicar o assunto específico que depende do vendedor, sem inventar.`,
        { atendida: "Responde ao que foi perguntado com a informação relevante, ou já estava respondido sem nova dúvida.", sem_resposta: "A pergunta ou parte essencial dela ficou sem resposta; só houve saudação, oferta, pergunta devolvida ou desvio.", produto_diferente: "Há incompatibilidade concreta entre produto/material pedido e respondido, não apenas o uso do nome que aparece na evidência vinculada à pergunta.", sem_encaminhamento: "Não existe base para responder e não indicou o assunto que o vendedor precisa confirmar." },
        { sem_resposta: `Faltou responder à pergunta ${contexto}`, produto_diferente: `A resposta troca o produto/material de ${contexto} Corrija a correspondência ou explique o que depende de confirmação.`, sem_encaminhamento: `Faltou indicar ao vendedor o assunto sem base de ${contexto}` });
      if (p.status === "respondida" && fontes.some(c => /sob encomenda/i.test(c.citacao))) {
        add(`encomenda_${i + 1}`, `Preservar a condição de fornecimento sob encomenda ao responder ${contexto}`,
          { preservada: "A mensagem informa sob encomenda, por encomenda ou equivalente.", nao_se_aplica: "Não confirma fornecimento (recusa ou encaminha uma dúvida), ou essa condição já foi dita sem nova dúvida.", omitida: "Confirma fornecimento sem informar a condição sob encomenda, que ainda não foi dita." },
          { omitida: `Em ${p.id}, faltou informar que o fornecimento é sob encomenda. Fonte: ${evidencia}.` });
      }
    });
    if (/deixar o pedido pronto para orçar/i.test(input.jogada.instrucao)) {
      for (const dado of ["medida", "quantidade", "cidade"]) {
        add(`dado_${dado}`, `Pedir ${dado} para preparar o orçamento SOMENTE se ainda falta na conversa. Não exigir nova pergunta se o dado já foi informado, não se aplica ao pedido, ou a mensagem oferece catálogo/vendedor como próximo passo permitido pela jogada.`,
          { cumprido: `A mensagem pede ${dado} que ainda faltava.`, nao_se_aplica: "O dado já existe, não é necessário, ou foi oferecido outro próximo passo permitido.", faltou: `O dado ${dado} falta para orçar e a mensagem não pede nem oferece outro próximo passo permitido.` },
          { faltou: `Faltou pedir ${dado}, que ainda não foi informado e é necessário para preparar o orçamento.` });
      }
    }
    if (!perguntas.length) add("resposta_atual", "Responder ou reconhecer o conteúdo novo da última mensagem. Se for só saudação, uma saudação basta.",
      { atendida: "Responde ou reconhece o que o contato disse.", sem_resposta: "Ignora a pergunta ou informação nova do contato." },
      { sem_resposta: `Faltou responder ou reconhecer a última mensagem: "${input.historico.at(-1)?.texto ?? ""}".` });
    const answers = await jev.ask({ pedido: input.pedidoTexto ?? "", ficha: input.fichaTexto, jogada: input.jogada.instrucao,
      outrasFontes: input.fontesExtras ?? "", perguntas, ultimasMensagens: input.historico.slice(-8), mensagemCandidata: input.texto },
      { inventa: { type: "noul", instructions: PERGUNTA_INVENTA, criteria: CRITERIO_INVENTA }, ...Object.fromEntries(requisitos.map(r => [r.id, r.pergunta])) });
    const verificacoes = requisitos.map(r => {
      const resultado = choice(answers[r.id]);
      if (!resultado || !Object.hasOwn(r.pergunta.criteria, resultado)) throw new Error(`JEV_REQUIREMENT_INVALID_${r.id}`);
      return { id: r.id, exigencia: r.exigencia, resultado, ok: !Object.hasOwn(r.falhas, resultado), motivo: r.falhas[resultado] ?? null };
    });
    const notas = { inventa: noul(answers.inventa) };
    const faltas = verificacoes.filter(v => !v.ok);
    return faltas.length
      ? { ok: false, regra: "juiz_requisito", motivo: faltas.map(v => `[${v.id}] ${v.motivo}`).join("\n"), notas, verificacoes }
      : { ok: true, notas, verificacoes };
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
