import type { HarnessEvent, Jogada, TriageResult } from "../../core/types.js";
import type { CampanhaDeProspeccao, FichaDoLead } from "./tipos.js";

const ENCERRAR = "Agradeça em uma frase, pelo nome se a pessoa se apresentou, e deixe a porta aberta. Sem pergunta e sem insistir.";

/**
 * João's process, in code. The model reads the lead's message into the record and writes; it never
 * decides to insist, to stop, or to hand over. The cases of 13/10 are rules here: a robot gets
 * silence, a polite no gets one thank-you, an explanation always ends with the next step.
 */
export function decidirJogada(input: { ficha: FichaDoLead; pedido: CampanhaDeProspeccao; triagem: TriageResult | null; evento: HarnessEvent }): Jogada {
  const { ficha, pedido, triagem, evento } = input;
  if (evento.tipo === "abertura") return { tipo: "abertura_da_campanha", silencio: true, instrucao: "A abertura é o texto da campanha." };
  if (ficha.etapa === "encerrado" || ficha.etapa === "objetivo_aceito") return { tipo: "conversa_fechada", silencio: true, instrucao: "" };

  if (evento.tipo === "silencio") {
    if (!ficha.respondeu) return { tipo: "sem_resposta_do_lead", silencio: true, instrucao: "O lead nunca respondeu como pessoa." };
    if (ficha.retomadas >= pedido.maxRetomadas) return { tipo: "limite_de_retomadas", silencio: true, instrucao: "" };
    const ultima = ficha.retomadas + 1 >= pedido.maxRetomadas;
    return {
      tipo: "retomar",
      instrucao: `Retome a conversa que esfriou${ficha.dor ? `, ligando ao que o lead contou: ${ficha.dor}` : ""}.${ultima ? " É a última retomada." : ""}`,
      skills: ["retomada"],
      dados: { limiteDeCaracteres: 300 }
    };
  }

  if (triagem?.kind === "robo") return { tipo: "aguardar_pessoa", silencio: true, instrucao: "Recepção automática: esperar uma pessoa." };
  if (triagem?.kind === "recusa" || ficha.interesse === "sem_interesse") {
    return { tipo: "agradecer_e_encerrar", instrucao: ENCERRAR, dados: { semPergunta: true } };
  }
  if (triagem?.kind === "despedida") return { tipo: "nada_a_responder", silencio: true, instrucao: "" };

  const responder = ficha.perguntasDoLead.length
    ? `Primeiro responda, só com o que a campanha diz, a: ${ficha.perguntasDoLead.map((pergunta) => `"${pergunta}"`).join(", ")}. Se a campanha não diz (preço, prazo), diga que depende do caso. `
    : "";

  if (ficha.aceite) {
    return {
      tipo: "confirmar_objetivo",
      instrucao: `${responder}O lead aceitou: ${ficha.aceite}. Confirme o próximo passo em uma frase curta, sem nova pergunta.`,
      avisarHumano: `Lead aceitou: ${ficha.aceite}`,
      dados: { podePrometerRetorno: true, semPergunta: true }
    };
  }
  if (ficha.indicado) {
    return ficha.indicado.contato
      ? {
          tipo: "agradecer_indicacao",
          instrucao: `${responder}O lead indicou ${ficha.indicado.nome}. Agradeça e diga que vai falar com ${ficha.indicado.nome}. Sem pergunta.`,
          avisarHumano: `Indicação: falar com ${ficha.indicado.nome} (${ficha.indicado.contato})`,
          dados: { podePrometerRetorno: true, semPergunta: true }
        }
      : { tipo: "pedir_contato_do_indicado", instrucao: `${responder}O lead indicou ${ficha.indicado.nome}. Agradeça e peça o WhatsApp ou o melhor contato dessa pessoa.` };
  }
  if (ficha.contato.papel === "nao_decisor") {
    return { tipo: "pedir_responsavel", instrucao: `${responder}Quem responde não decide. Peça com educação o nome ou o melhor contato de quem cuida disso.` };
  }
  if (ficha.objecao) {
    if (ficha.objecao.tratada) return { tipo: "agradecer_e_encerrar", instrucao: ENCERRAR, dados: { semPergunta: true } };
    return {
      tipo: "tratar_objecao",
      instrucao: `${responder}O lead levantou: "${ficha.objecao.texto}". Reconheça em poucas palavras, mostre em uma frase por que ainda pode valer (ligado ao que ele contou, se contou) e proponha ${pedido.objetivo} sem pressão.`,
      dados: { objecao: true, propoeObjetivo: true }
    };
  }
  // Every answer ends with the next step: what Meccatus did not get on 13/10.
  const propor = ficha.propostasDoObjetivo < 2;
  return {
    tipo: responder ? "responder_e_puxar" : "puxar_objetivo",
    instrucao: `${responder}${propor
      ? `Depois, proponha ${pedido.objetivo}${ficha.dor ? `, ligando ao que ele contou: ${ficha.dor}` : ""}.`
      : "O objetivo já foi proposto; agora faça uma pergunta sobre a rotina dele (volume, quem atende, o que trava)."}`,
    dados: { propoeObjetivo: propor }
  };
}

export function aposTriagem(input: { ficha: FichaDoLead; triagem: TriageResult }): FichaDoLead {
  if (input.triagem.kind === "robo") return { ...input.ficha, contato: { ...input.ficha.contato, ehRobo: true } };
  return { ...input.ficha, respondeu: true, etapa: input.ficha.etapa === "abordado" ? "conversando" : input.ficha.etapa };
}

export function aposEnvio(input: { ficha: FichaDoLead; jogada: Jogada; texto: string }): FichaDoLead {
  const { jogada } = input;
  let ficha: FichaDoLead = { ...input.ficha, perguntasDoLead: [] };
  if (jogada.tipo === "agradecer_e_encerrar" || jogada.tipo === "agradecer_indicacao") ficha = { ...ficha, etapa: "encerrado" };
  if (jogada.tipo === "confirmar_objetivo") ficha = { ...ficha, etapa: "objetivo_aceito" };
  if (jogada.tipo === "retomar") ficha = { ...ficha, retomadas: ficha.retomadas + 1 };
  if (jogada.dados?.propoeObjetivo) ficha = { ...ficha, propostasDoObjetivo: ficha.propostasDoObjetivo + 1 };
  if (jogada.dados?.objecao && ficha.objecao) ficha = { ...ficha, objecao: { ...ficha.objecao, tratada: true } };
  return ficha;
}
