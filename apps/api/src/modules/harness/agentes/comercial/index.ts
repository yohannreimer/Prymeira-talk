import { z } from "zod";
import type { AgentDefinition, HarnessTool, Jogada, ReviewRule } from "../../core/types.js";
import { instrucoes, instrucoesDoLeitor } from "./instrucoes.js";
import { fichaInicial, type ContextoComercial, type FichaComercial } from "./tipos.js";

const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const registro = z.object({
  intencao: z.enum(["conhecer", "duvida", "agendar", "recusar", "humano"]),
  assunto: z.string().max(1000).nullable(), empresa: z.string().max(200).nullable(), rotina: z.string().max(1000).nullable()
});
const registrar: HarnessTool<FichaComercial, ContextoComercial, z.infer<typeof registro>> = {
  name: "registrar_contexto", description: "Registra intenção, dúvidas e contexto informados pelo contato. Não inventa nome, empresa nem diagnóstico.",
  parameters: { type: "object", properties: {
    intencao: { type: "string", enum: ["conhecer", "duvida", "agendar", "recusar", "humano"] },
    assunto: { type: ["string", "null"] }, empresa: { type: ["string", "null"] }, rotina: { type: ["string", "null"] }
  }, required: ["intencao", "assunto", "empresa", "rotina"], additionalProperties: false },
  schema: registro,
  execute(args, context) {
    context.setFicha({ ...context.ficha, intencao: args.intencao, assunto: args.assunto,
      empresaDoContato: args.empresa ?? context.ficha.empresaDoContato,
      rotina: args.rotina ?? context.ficha.rotina });
    return "Contexto registrado. A intenção de agendar não confirma reunião.";
  }
};
const selecao = z.object({ startsAt: z.string().datetime({ offset: true }), trecho: z.string().min(2).max(300) });
const escolherHorario: HarnessTool<FichaComercial, ContextoComercial, z.infer<typeof selecao>> = {
  name: "escolher_horario", description: "Registra a escolha explícita de um horário da agenda pelo contato. Não reserva nem confirma reunião.",
  parameters: { type: "object", properties: { startsAt: { type: "string" }, trecho: { type: "string" } }, required: ["startsAt", "trecho"], additionalProperties: false },
  schema: selecao,
  execute(args, context) {
    if (context.ficha.intencao !== "agendar") return "Recusado: a pessoa ainda está tirando uma dúvida, não escolheu agendar.";
    if (!context.mensagemAtual.includes(args.trecho)) return "Recusado: o trecho não está na mensagem atual.";
    const slot = context.pedido.agenda?.availableSlots.find(s => s.startsAt === args.startsAt);
    if (!slot) return "Recusado: o horário não está na agenda disponível.";
    if (!escolhaExplicita(args.trecho, slot.startsAt, context.pedido.agenda!)) {
      return "Recusado: falta dia e horário inequívocos. Pergunte qual horário a pessoa escolheu.";
    }
    context.setFicha({ ...context.ficha, intencao: "agendar", horario: slot.startsAt });
    return "Escolha registrada. O sistema ainda precisa reservar a agenda.";
  }
};

/** Conservative match: the contact must specify the day and time; ambiguous acknowledgements never book. */
export function escolhaExplicita(texto: string, startsAt: string, agenda: NonNullable<ContextoComercial["agenda"]>) {
  const text = normalize(texto);
  if (/\bnao\b.{0,35}\b(?:posso|serve|quero|consigo|marque|agende|da|fica)\b/.test(text)) return false;
  if (text.includes("?") && !/\b(?:pode marcar|pode agendar|quero marcar|quero agendar|agende|marque)\b/.test(text)) return false;
  const date = new Date(startsAt);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: agenda.timeZone, hour: "2-digit", hourCycle: "h23" }).format(date));
  const minute = Number(new Intl.DateTimeFormat("en-GB", { timeZone: agenda.timeZone, minute: "2-digit" }).format(date));
  const time = new RegExp(`(?:^|\\D)0?${hour}(?::|h)${String(minute).padStart(2, "0")}(?:\\D|$)|(?:^|\\D)0?${hour}(?:h| horas?)(?:\\D|$)`);
  if (!time.test(text)) return false;
  // "10h" cannot select 10:30.
  if (minute !== 0 && !new RegExp(`(?:^|\\D)0?${hour}(?::|h)${String(minute).padStart(2, "0")}(?:\\D|$)`).test(text)) return false;
  const weekday = normalize(new Intl.DateTimeFormat("pt-BR", { timeZone: agenda.timeZone, weekday: "long" }).format(date)).replace("-feira", "");
  const localDate = new Intl.DateTimeFormat("pt-BR", { timeZone: agenda.timeZone, day: "2-digit", month: "2-digit" }).format(date);
  if (text.includes(localDate) || text.includes(weekday)) {
    // Two Tuesdays in the offered window still need a date.
    return text.includes(localDate) || agenda.availableSlots.filter(s => {
      const d = new Date(s.startsAt);
      return normalize(new Intl.DateTimeFormat("pt-BR", { timeZone: agenda.timeZone, weekday: "long" }).format(d)).includes(weekday)
        && new Intl.DateTimeFormat("en-GB", { timeZone: agenda.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)
          === `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }).length === 1;
  }
  return false;
}

export function decidirComercial({ ficha, pedido, triagem, evento }: Parameters<AgentDefinition<FichaComercial, ContextoComercial>["decidirJogada"]>[0]): Jogada {
  if (evento.tipo !== "mensagem" || ficha.encerrada) return { tipo: "aguardar", silencio: true, instrucao: "" };
  if (triagem?.kind === "robo" || triagem?.kind === "despedida") return { tipo: "aguardar", silencio: true, instrucao: "" };
  if (triagem?.kind === "recusa" || ficha.intencao === "recusar") return { tipo: "encerrar", instrucao: "Acolha a recusa em uma frase, sem pergunta, convite ou insistência." };
  if (ficha.intencao === "humano") return { tipo: "repassar", instrucao: "Avise brevemente que uma pessoa da empresa continua por aqui, sem prometer prazo.", avisarHumano: ficha.assunto ?? "Contato pediu atendimento humano.", dados: { podePrometerRetorno: true } };
  if (ficha.intencao === "agendar") {
    if (pedido.agenda?.bookedMeeting && !ficha.horario) return { tipo: "ja_agendada", instrucao: "A reunião já está marcada conforme a agenda. Informe somente o que a pessoa perguntou. Não proponha outra nem diga que remarcou." };
    if (!pedido.agenda || !pedido.agenda.availableSlots.length) return { tipo: "agenda_indisponivel", instrucao: "Diga que não tem um horário disponível aqui e que uma pessoa da empresa continua o agendamento, sem prometer data.", avisarHumano: "Agendamento manual: agenda indisponível ou sem horários.", dados: { podePrometerRetorno: true } };
    if (ficha.horario) return { tipo: "solicitar_reserva", instrucao: "Diga apenas que vai reservar o horário escolhido. Não confirme reunião, dia, link ou reserva concluída: a agenda fará a confirmação real.", dados: { startsAt: ficha.horario } };
    return { tipo: "oferecer_horarios", instrucao: "A pessoa quer marcar: ofereça 2 ou 3 horários da agenda, com data e hora, e pergunte qual serve. Não peça dados de qualificação antes disso." };
  }
  if (ficha.intencao === "duvida") return { tipo: "responder_duvida", instrucao: "Responda todas as dúvidas atuais, usando as fontes aprovadas e o contexto. Não desvie para a call, não reapresente a empresa nem repita o convite. Se não existe confirmação, diga isso brevemente. Não use uma pergunta para evitar a resposta." };
  if (ficha.turnos > 0 && ficha.rotina && ficha.convites === 0 && !pedido.agenda?.bookedMeeting) return { tipo: "convidar", instrucao: "Relacione um exemplo da oferta à rotina informada e convide para a conversa descrita na base. Pergunte se faz sentido, sem pressionar e sem inventar horário." };
  return { tipo: "entender", instrucao: "Responda à mensagem. Se é o começo, apresente-se brevemente e explique a oferta em uma frase conforme a base. Faça no máximo uma pergunta útil sobre a rotina, apenas se falta esse contexto. Não suponha formulário nem apresse o convite." };
}

const regras: ReviewRule<FichaComercial, ContextoComercial>[] = [
  { id: "comercial_uma_pergunta", check: ({ texto }) => (texto.match(/\?/g) ?? []).length > 1 ? { ok: false, regra: "comercial_uma_pergunta", motivo: "Faça no máximo uma pergunta." } : { ok: true } },
  { id: "sem_formulario_presumido", check: ({ texto, historico }) => /(?:vi|recebi|recebemos)\b.{0,35}\b(?:formul[aá]rio|pedido (?:do|de) raio[- ]?x)/i.test(texto) && !historico.some(m => m.autor === "sistema" && /formul[aá]rio/i.test(m.texto)) ? { ok: false, regra: "sem_formulario_presumido", motivo: "Esta é uma entrada direta; não existe formulário recebido." } : { ok: true } },
  { id: "agenda_confirma", check: ({ texto, pedido }) => !pedido.agenda?.bookedMeeting && /\b(?:marcad[ao]|agendad[ao]|confirmad[ao]|reservei|remarquei)\b/i.test(texto) ? { ok: false, regra: "agenda_confirma", motivo: "A agenda ainda não confirmou a reserva. Não diga que marcou ou confirmou." } : { ok: true } },
  { id: "sem_link_inventado", check: ({ texto }) => /https?:\/\//i.test(texto) ? { ok: false, regra: "sem_link_inventado", motivo: "Não escreva links; o agendador adiciona o link verdadeiro." } : { ok: true } },
  { id: "recusa_sem_convite", check: ({ texto, jogada }) => jogada.tipo === "encerrar" && /\?|\b(?:agendar|marcar|hor[aá]rio|topa|que tal)\b/i.test(texto) ? { ok: false, regra: "recusa_sem_convite", motivo: "A pessoa recusou: encerre sem pergunta nem novo convite." } : { ok: true } },
  { id: "nao_repete_resposta", check: ({ texto, historico }) => historico.filter(m => m.autor === "agente" || m.autor === "humano").slice(-4).some(m => normalize(m.texto).trim() === normalize(texto).trim()) ? { ok: false, regra: "nao_repete_resposta", motivo: "A resposta inteira já foi enviada. Responda apenas ao assunto novo." } : { ok: true } }
];

export const comercial: AgentDefinition<FichaComercial, ContextoComercial> = {
  id: "comercial", instrucoes, skills: {}, fichaInicial, renderFicha: ficha => JSON.stringify(ficha),
  renderPedidoPublico: pedido => JSON.stringify({ empresa: pedido.empresa, instrucoesComerciais: pedido.instrucoes, fontesAprovadas: pedido.fontes, agenda: pedido.agenda }),
  ferramentasDeLeitura: [registrar, escolherHorario], instrucoesDoLeitor, maxRodadasDeLeitura: 3,
  decidirJogada: decidirComercial,
  aposEnvio: ({ ficha, jogada }) => ({ ...ficha, turnos: ficha.turnos + 1, convites: ficha.convites + (jogada.tipo === "convidar" ? 1 : 0), encerrada: jogada.tipo === "encerrar", horario: null }),
  regras, janelaDeMensagens: 20,
  motivosParaHumano: { pediu_pessoa: "pediu uma pessoa", impedimento: "precisa de uma resposta sem base para continuar", reclamacao: "reclamação que impede continuar" },
  motivosAoVivo: ["pediu_pessoa", "impedimento", "reclamacao"],
  avisoDeRepasse: "Uma pessoa da empresa vai continuar o atendimento por aqui."
};
