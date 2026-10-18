import type { HarnessEvent, Jogada, TriageResult } from "../../core/types.js";
import { pendenciasAbertas } from "./ficha.js";
import { soSaudacaoOuOferta } from "./cobertura.js";
import type { ContextoDoAtendimento, FichaDoAtendimento, Pendencia } from "./tipos.js";

const NAO_CLIENTE = new Set(["colega", "pessoal", "fornecedor", "transportadora"]);

/**
 * The follow-up process, in code. The analyst made the record true; this decides what to do with it:
 * chase the customer about one open item, remind the seller, or stay quiet. Live replies still run on
 * the current attendance engine, so any other event is a silent move here.
 */
export function decidirJogada(input: {
  ficha: FichaDoAtendimento;
  pedido: ContextoDoAtendimento;
  triagem: TriageResult | null;
  evento: HarnessEvent;
}): Jogada {
  const { ficha, pedido, evento } = input;
  if (evento.tipo === "abertura") return { tipo: "sem_abertura", silencio: true, instrucao: "O atendimento responde; não abre conversa." };
  if (evento.tipo === "mensagem") return jogadaDaMensagem(ficha, input.triagem, pedido);
  if (NAO_CLIENTE.has(ficha.contato.tipo)) {
    return { tipo: "contato_nao_cliente", silencio: true, instrucao: `Contato ${ficha.contato.tipo}: sem follow-up.` };
  }

  const abertas = pendenciasAbertas(ficha);
  const ultima = (items: Pendencia[]) => items.reduce<Pendencia | null>((best, item) => !best || item.prova.mensagem >= best.prova.mensagem ? item : best, null);
  const ultimaAberta = Math.max(-1, ...abertas.map((item) => item.prova.mensagem));

  // A closing or a pickup under way counts only if nothing was opened after it.
  if (ficha.encerrada && ficha.encerrada.prova.mensagem >= ultimaAberta) {
    return { tipo: "encerrada", silencio: true, instrucao: `Encerrada: ${ficha.encerrada.motivo}.` };
  }
  if (ficha.emAndamento && ficha.emAndamento.prova.mensagem >= ultimaAberta) {
    return { tipo: "em_andamento", silencio: true, instrucao: `Em andamento: ${ficha.emAndamento.motivo}.` };
  }

  // The company owes something: the customer is not chased, the seller is reminded.
  const daEmpresa = ultima(abertas.filter((item) => item.dono === "empresa"));
  if (daEmpresa) {
    return {
      tipo: "lembrete_vendedor",
      humano: `Lembrete: ${daEmpresa.descricao} (${daEmpresa.doContato ? `o cliente pediu na mensagem [${daEmpresa.doContato.mensagem}]: "${daEmpresa.doContato.trecho}"` : `mensagem [${daEmpresa.prova.mensagem}]: "${daEmpresa.prova.trecho}"`})`,
      instrucao: "A vez é da empresa.",
      dados: { pendenciaId: daEmpresa.id }
    };
  }
  if (ficha.indicado && ficha.indicado.prova.mensagem >= ultimaAberta) {
    const telefone = ficha.indicado.telefone ? ` (${ficha.indicado.telefone})` : "";
    return {
      tipo: "lembrete_vendedor",
      humano: `Lembrete: falar com ${ficha.indicado.nome}${telefone}, indicado pelo contato (mensagem [${ficha.indicado.prova.mensagem}]: "${ficha.indicado.prova.trecho}")`,
      instrucao: "A vez é da empresa."
    };
  }

  const doCliente = ultima(abertas.filter((item) => item.dono === "cliente"));
  if (!doCliente) return { tipo: "nada_aberto", silencio: true, instrucao: "Nada em aberto: sem follow-up." };

  const anteriores = ficha.followups.filter((item) => item.pendenciaId === doCliente.id);
  if (anteriores.length >= pedido.maxFollowups) {
    return { tipo: "limite_de_tentativas", silencio: true, instrucao: `Já foram ${anteriores.length} follow-ups sobre ${doCliente.id}.` };
  }
  const tentativa = anteriores.length + 1;
  const etapa = tentativa === 1 ? "primeira tentativa" : tentativa >= pedido.maxFollowups ? "última tentativa" : `tentativa ${tentativa}`;
  return {
    tipo: "cobrar_pendencia",
    instrucao: [
      `Retome a conversa parada sobre esta pendência do cliente: ${doCliente.descricao}.`,
      `Ela vem da mensagem [${doCliente.prova.mensagem}]: "${doCliente.prova.trecho}".`,
      `É a ${etapa} de ${pedido.maxFollowups}.`,
      ...(anteriores.length ? [`Já enviado antes (não repita): ${anteriores.map((item) => `"${item.texto}"`).join(" | ")}`] : [])
    ].join(" "),
    skills: ["followup"],
    dados: { pendenciaId: doCliente.id, tentativa, limiteDeCaracteres: 350 }
  };
}

/**
 * A live reply. The order is the point: the reader registered each question and searched the base;
 * code answers with what has a quoted passage and hands over only what the base does not cover.
 */
function jogadaDaMensagem(ficha: FichaDoAtendimento, triagem: TriageResult | null, pedido: ContextoDoAtendimento): Jogada {
  if (triagem?.kind === "robo") return { tipo: "aguardar_pessoa", silencio: true, instrucao: "Atendimento automático do outro lado." };
  if (triagem?.kind === "recusa" || triagem?.kind === "despedida") {
    return { tipo: "encerrar", instrucao: "O contato encerrou ou recusou. Agradeça em uma frase, sem insistir e sem perguntar nada." };
  }
  const jogada = jogadaDasPerguntas(ficha);
  // Weights computed by code go to the writer even when the reader did not cite them, apart from the minimum.
  const pesos = (ficha.pesosDaVez ?? []).map((id) => ficha.trechosVistos[id]).filter(Boolean);
  const anexos = (ficha.anexosDaVez ?? []).map((id) => pedido.anexos?.find((anexo) => anexo.id === id)).filter((anexo) => anexo !== undefined);
  const extras = [
    ...(pesos.length ? [`Peso do pedido, calculado pelo sistema: ${pesos.join(" ")} Use esse número somente se a descrição do cálculo corresponde ao mesmo produto, material, acabamento e medida pedidos; caso contrário não informe esse peso, deixe o vendedor confirmar. O pedido mínimo é outra coisa, compare somente com peso compatível.`] : []),
    ...(anexos.length
      ? [`Vai anexado nesta mensagem: ${anexos.map((anexo) => anexo.titulo).join(", ")}. Diga em poucas palavras que está enviando.`]
      : pedido.anexos?.length ? ["Nenhum arquivo vai anexado nesta mensagem: não diga que está enviando catálogo ou arquivo."] : [])
  ];
  const respondidas = ficha.perguntas.filter((item) => item.status === "respondida").flatMap(citacoes);
  if (respondidas.some(recusa)) extras.push("Diga com clareza quais itens ou regiões não atendemos. Não ofereça esses itens nem encaminhe uma recusa simples.");
  extras.push("Você representa a empresa nesta conversa. Responda os fatos conhecidos e faça a próxima pergunta de qualificação. Divergências e dados que exigem checagem ficam no resumo interno. Não acrescente vendedor, avaliação, confirmação, frete ou prazo não perguntado como ressalva automática. Não ofereça catálogo/vendedor como saída da coleta; anexe catálogo só quando solicitado.");
  if(ficha.prequalificacao?.situacao === "coletando") extras.push(`Ainda precisamos de: ${ficha.prequalificacao.faltantes.join("; ")}. Pergunte o próximo DADO DO CLIENTE necessário à etapa, priorizando detalhes técnicos antes do cadastro e sem repetir dados informados. Preço, disponibilidade, frete final e validação técnica são divergências internas, não perguntas ao cliente.`);
  return extras.length && !jogada.silencio ? { ...jogada, instrucao: `${jogada.instrucao} ${extras.join(" ")}` } : jogada;
}

const semAcento = (texto: string) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** A passage that says no: what the company does not supply, the places it does not serve. */
export const RECUSA = /\bnao (fornece|fornecemos|fornecidas?|trabalhamos|atendemos|vendemos|fazemos)\b/;
const recusa = (citacao: string) => RECUSA.test(semAcento(citacao));
/** Every passage that answers the question, in the order the reader cited them. */
export const citacoes = (pergunta: FichaDoAtendimento["perguntas"][number]) => [pergunta.resposta, ...(pergunta.maisRespostas ?? [])].filter((item) => item !== null).map((item) => item.citacao);

function jogadaDasPerguntas(ficha: FichaDoAtendimento): Jogada {
  const atuais = ficha.perguntas.filter((item) => item.status !== "tratada");
  const respondidas = atuais.filter((item) => item.status === "respondida");
  // Unanswered after a search, or never searched: a person answers it. Nothing is promised in general.
  const semBase = atuais.filter((item) => item.status === "sem_base" || (item.status === "aberta" && item.buscas > 0));
  const naoBuscadas = atuais.filter((item) => item.status === "aberta" && item.buscas === 0);
  const respostas = respondidas.map((item) => `"${item.texto}": a base diz ${citacoes(item).map((citacao) => `"${citacao}"`).join(" e ")}`);

  if (ficha.pediuPessoa) {
    return {
      tipo: "passar_pessoa",
      instrucao: [
        ...(respostas.length ? [`Responda primeiro, com estas informações da base: ${respostas.join("; ")}.`] : []),
        "O contato pediu uma pessoa. Diga em uma frase que vai chamar o vendedor para continuar."
      ].join(" "),
      avisarHumano: "O contato pediu para falar com uma pessoa.",
      dados: { podePrometerRetorno: true }
    };
  }
  if (ficha.prequalificacao?.situacao === "pronta" || ficha.prequalificacao?.situacao === "impedida") {
    const pronta = ficha.prequalificacao.situacao === "pronta";
    return {tipo: pronta ? "prequalificacao_pronta" : "prequalificacao_impedida",
      instrucao: pronta ? "O pedido está qualificado. Faça um resumo curto e diga que vai encaminhar para preparação do orçamento, sem declarar preço, venda ou pagamento confirmado." : "Há um impedimento real para continuar. Diga o assunto que precisa de atenção e que encaminhará para uma pessoa resolver, sem inventar resposta.",
      avisarHumano: `${pronta ? "Pedido qualificado para orçamento" : "Impedimento na pré-qualificação"}: ${ficha.prequalificacao.resumo}. Divergências: ${ficha.prequalificacao.divergencias.join("; ") || "nenhuma"}`};
  }
  if (semBase.length) {
    return {
      tipo: "qualificar_com_pendencias",
      instrucao: [
        ...(respostas.length ? [`Responda com estas informações da base: ${respostas.join("; ")}. Use só o que responde a última mensagem; não repita informações antigas sem motivo. Se o cliente perguntou novamente ou pediu confirmação, responda esse ponto de novo.`] : []),
        `Divergências internas ainda sem base: ${semBase.map(item => `"${item.texto}"`).join("; ")}. Não invente resposta nem prometa checar/retornar. Se o cliente perguntou um fato desconhecido, diga brevemente que o dado ainda não está definido (ex.: o valor será definido no orçamento), sem citar vendedor. Continue qualificando o pedido: aproveite os dados já fornecidos e pergunte o próximo detalhe necessário, respeitando a etapa da base. Uma especificação solicitada pode ficar registrada sem garantia da combinação exata.`
      ].join(" "),
      dados: { perguntasSemBase: semBase.map(item=>item.id) }

    };
  }
  if (respostas.length) {
    return {
      tipo: "responder",
      instrucao: `Responda com estas informações da base, com as palavras do cliente: ${respostas.join("; ")}. Use só o que responde a última mensagem; não repita informações antigas sem motivo. Se o cliente perguntou novamente ou pediu confirmação, responda esse ponto de novo.${naoBuscadas.length ? ` Sobre ${naoBuscadas.map((item) => `"${item.texto}"`).join(", ")}, não afirme nada; pergunte o detalhe que falta.` : ""} O objetivo é deixar o pedido pronto para orçar: termine com o próximo detalhe necessário para o vendedor orçar (produto, medida, quantidade ou cidade), respeitando a etapa de viabilidade da base. Reutilize o que o cliente já informou; uma pergunta anterior ainda sem resposta pode ser retomada se necessária para avançar. Não acumule dados técnicos, logística e cadastro numa só pergunta. Se não falta nada, não pergunte.`
    };
  }
  return {
    tipo: "conversar",
    instrucao: naoBuscadas.length
      ? `Sobre ${naoBuscadas.map((item) => `"${item.texto}"`).join(", ")}: não afirme preço, prazo, estoque nem condição. Pergunte o detalhe que falta (produto, medida, quantidade, cidade).`
      : "Responda ao que o contato disse, curto. Se for só conversa (cumprimento, o tempo, futebol), responda numa frase simpática acompanhando o que ele contou, sem dizer nada sobre você ou sobre o tempo aí da empresa, e pergunte se pode ajudar em algo. Se faltar algo para o pedido andar (produto, medida, quantidade, cidade), pergunte uma coisa só."
  };
}

export function aposEnvio(input: { ficha: FichaDoAtendimento; jogada: Jogada; texto: string }): FichaDoAtendimento {
  if (input.jogada.tipo !== "cobrar_pendencia") {
    // Only answered or explicitly handed-off questions advance after an accepted reply.
    const { ficha } = input;
    return {
      ...ficha,
      pediuPessoa: false,
      perguntas: ficha.perguntas.map((item) => ({ ...item, status: !soSaudacaoOuOferta(input.texto) && (item.status === "respondida" || item.status === "sem_base" && Boolean(input.jogada.avisarHumano)) ? "tratada" as const : item.status })),
      pesosDaVez: [],
      anexosDaVez: [],
      anexosEnviados: [...new Set([...(ficha.anexosEnviados ?? []), ...(ficha.anexosDaVez ?? [])])],
      catalogoOferecido: ficha.catalogoOferecido || input.jogada.dados?.ofereceCatalogo === true && /cat[aá]logo|vendedor/i.test(input.texto)
    };
  }
  const pendenciaId = input.jogada.dados?.pendenciaId;
  if (typeof pendenciaId !== "string") return input.ficha;
  return { ...input.ficha, followups: [...input.ficha.followups, { texto: input.texto, pendenciaId }] };
}
