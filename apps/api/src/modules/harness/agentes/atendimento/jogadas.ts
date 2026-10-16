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
  if (evento.tipo === "mensagem") return jogadaDaMensagem(ficha, input.triagem);
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
      humano: `Lembrete: ${daEmpresa.descricao} (mensagem [${daEmpresa.prova.mensagem}]: "${daEmpresa.prova.trecho}")`,
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
function jogadaDaMensagem(ficha: FichaDoAtendimento, triagem: TriageResult | null): Jogada {
  if (triagem?.kind === "robo") return { tipo: "aguardar_pessoa", silencio: true, instrucao: "Atendimento automático do outro lado." };
  if (triagem?.kind === "recusa" || triagem?.kind === "despedida") {
    return { tipo: "encerrar", instrucao: "O contato encerrou ou recusou. Agradeça em uma frase, sem insistir e sem perguntar nada." };
  }
  const atuais = ficha.perguntas.filter((item) => item.status !== "tratada");
  const respondidas = atuais.filter((item) => item.status === "respondida");
  // Unanswered after a search, or never searched: a person answers it. Nothing is promised in general.
  const semBase = atuais.filter((item) => item.status === "sem_base" || (item.status === "aberta" && item.buscas > 0));
  const naoBuscadas = atuais.filter((item) => item.status === "aberta" && item.buscas === 0);
  const respostas = respondidas.map((item) => `"${item.texto}": a base diz "${item.resposta!.citacao}"`);

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
        ...(respostas.length ? [`Responda com estas informações da base: ${respostas.join("; ")}.`] : []),
        `Os documentos não respondem: ${semBase.map((item) => `"${item.texto}"`).join(", ")}. Diga, nomeando esse assunto, que o vendedor confirma isso com ele. Não diga nada genérico como "vou consultar as informações".`
      ].join(" "),
      avisarHumano: `Sem base nos documentos para: ${semBase.map((item) => item.texto).join(" | ")}`,
      dados: { podePrometerRetorno: true, perguntasSemBase: semBase.map((item) => item.id) }
    };
  }
  if (respostas.length) {
    return {
      tipo: "responder",
      instrucao: `Responda com estas informações da base, com as palavras do cliente: ${respostas.join("; ")}.${naoBuscadas.length ? ` Sobre ${naoBuscadas.map((item) => `"${item.texto}"`).join(", ")}, não afirme nada; pergunte o detalhe que falta.` : ""} Se fizer sentido, termine com uma pergunta que ajude o pedido a andar.`
    };
  }
  return {
    tipo: "conversar",
    instrucao: naoBuscadas.length
      ? `Sobre ${naoBuscadas.map((item) => `"${item.texto}"`).join(", ")}: não afirme preço, prazo, estoque nem condição. Pergunte o detalhe que falta (produto, medida, quantidade, cidade).`
      : "Responda ao que o contato disse, curto. Se faltar algo para o pedido andar (produto, medida, quantidade, cidade), pergunte uma coisa só."
  };
}

export function aposEnvio(input: { ficha: FichaDoAtendimento; jogada: Jogada; texto: string }): FichaDoAtendimento {
  if (input.jogada.tipo !== "cobrar_pendencia") {
    // Everything asked so far was handled by this reply (answered here or passed to a person).
    return { ...input.ficha, pediuPessoa: false, perguntas: input.ficha.perguntas.map((item) => ({ ...item, status: "tratada" as const })) };
  }
  const pendenciaId = input.jogada.dados?.pendenciaId;
  if (typeof pendenciaId !== "string") return input.ficha;
  return { ...input.ficha, followups: [...input.ficha.followups, { texto: input.texto, pendenciaId }] };
}
