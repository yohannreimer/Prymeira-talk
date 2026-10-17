import type { HarnessEvent, Jogada, TriageResult } from "../../core/types.js";
import { pendenciasAbertas } from "./ficha.js";
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
    ...(pesos.length ? [`Peso do pedido, calculado pelo sistema: ${pesos.join(" ")} Use esse número como o peso; o pedido mínimo é outra coisa, compare os dois.`] : []),
    ...(anexos.length
      ? [`Vai anexado nesta mensagem: ${anexos.map((anexo) => anexo.titulo).join(", ")}. Diga em poucas palavras que está enviando.`]
      : pedido.anexos?.length ? ["Nenhum arquivo vai anexado nesta mensagem: não diga que está enviando catálogo ou arquivo."] : [])
  ];
  // The company asked for this choice the first time a made-to-order item comes up.
  const respondidas = ficha.perguntas.filter((item) => item.status === "respondida").flatMap(citacoes);
  if (respondidas.some(recusa)) extras.push("Atenção: a base diz que a empresa NÃO fornece ou NÃO atende parte do que foi pedido. Diga isso com clareza; não ofereça esse item.");
  // Not after a "no": a catalogue offer right after refusing the item or the region reads as ignoring it.
  // Offered once per conversation: asking it again on every reply read as a script in the test of 17/10.
  const encomenda = !ficha.catalogoOferecido && !anexos.length && !(ficha.anexosEnviados ?? []).length && pedido.anexos?.some((anexo) => /catalogo/i.test(semAcento(anexo.titulo))) &&
    respondidas.some((citacao) => /encomenda/i.test(citacao)) && !respondidas.some(recusa);
  if (encomenda && (jogada.tipo === "responder" || jogada.tipo === "conversar")) {
    extras.push("É um item sob encomenda: termine perguntando se ele prefere ver o catálogo em PDF ou falar com um vendedor, no lugar de outra pergunta.");
    return { ...jogada, instrucao: `${jogada.instrucao} ${extras.join(" ")}`, dados: { ...jogada.dados, ofereceCatalogo: true } };
  }
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
  if (semBase.length) {
    return {
      tipo: "responder_e_passar",
      instrucao: [
        ...(respostas.length ? [`Responda com estas informações da base: ${respostas.join("; ")}. Use só o que responde a última mensagem; o que a conversa já disse ao cliente, não repita.`] : []),
        `Os documentos não respondem: ${semBase.map((item) => `"${item.texto}"`).join(", ")}. Diga, nomeando esse assunto, que o vendedor confirma isso com ele. Não diga nada genérico como "vou consultar as informações". E siga atendendo: termine pedindo o que o vendedor vai precisar para o orçamento (a quantidade, se o cliente ainda não disse, ou a cidade de entrega).`
      ].join(" "),
      avisarHumano: `Sem base nos documentos para: ${semBase.map((item) => item.texto).join(" | ")}`,
      dados: { podePrometerRetorno: true, perguntasSemBase: semBase.map((item) => item.id) }
    };
  }
  if (respostas.length) {
    return {
      tipo: "responder",
      instrucao: `Responda com estas informações da base, com as palavras do cliente: ${respostas.join("; ")}. Use só o que responde a última mensagem; o que a conversa já disse ao cliente, não repita.${naoBuscadas.length ? ` Sobre ${naoBuscadas.map((item) => `"${item.texto}"`).join(", ")}, não afirme nada; pergunte o detalhe que falta.` : ""} Se fizer sentido, termine com uma pergunta que ajude o vendedor a montar o orçamento: a quantidade, se o cliente ainda não disse, ou a cidade de entrega.`
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
    // Everything asked so far was handled by this reply (answered here or passed to a person), files included.
    const { ficha } = input;
    return {
      ...ficha,
      pediuPessoa: false,
      perguntas: ficha.perguntas.map((item) => ({ ...item, status: "tratada" as const })),
      pesosDaVez: [],
      anexosDaVez: [],
      anexosEnviados: [...new Set([...(ficha.anexosEnviados ?? []), ...(ficha.anexosDaVez ?? [])])],
      catalogoOferecido: ficha.catalogoOferecido || input.jogada.dados?.ofereceCatalogo === true
    };
  }
  const pendenciaId = input.jogada.dados?.pendenciaId;
  if (typeof pendenciaId !== "string") return input.ficha;
  return { ...input.ficha, followups: [...input.ficha.followups, { texto: input.texto, pendenciaId }] };
}
