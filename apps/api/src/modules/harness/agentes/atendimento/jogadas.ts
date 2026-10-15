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
  if (evento.tipo !== "silencio") {
    return { tipo: "atendimento_atual", silencio: true, instrucao: "As respostas ao vivo ainda saem do atendimento atual; este agente cuida do silêncio." };
  }
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

export function aposEnvio(input: { ficha: FichaDoAtendimento; jogada: Jogada; texto: string }): FichaDoAtendimento {
  const pendenciaId = input.jogada.dados?.pendenciaId;
  if (input.jogada.tipo !== "cobrar_pendencia" || typeof pendenciaId !== "string") return input.ficha;
  return { ...input.ficha, followups: [...input.ficha.followups, { texto: input.texto, pendenciaId }] };
}
