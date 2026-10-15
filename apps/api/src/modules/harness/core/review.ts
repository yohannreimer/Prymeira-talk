import { noul, type JevClient } from "./jev.js";
import type { ReviewInput, ReviewRule, ReviewVerdict } from "./types.js";

/** A second opinion on a message that already passed the hard rules. */
export type Judge = (input: ReviewInput<unknown, unknown> & { fichaTexto: string }) => Promise<ReviewVerdict>;

const MAX_CHARACTERS = 600;

/** Rules every agent gets, whatever it does. */
export const coreRules: ReviewRule<unknown, unknown>[] = [
  {
    id: "nao_vazio",
    check: ({ texto }) => texto.trim().length > 0 ? { ok: true } : { ok: false, regra: "nao_vazio", motivo: "Mensagem vazia." }
  },
  {
    id: "tamanho_whatsapp",
    check: ({ texto, jogada }) => {
      // An opening that lists several items may need more room; the move says so.
      const limit = typeof jogada.dados?.limiteDeCaracteres === "number" ? jogada.dados.limiteDeCaracteres : MAX_CHARACTERS;
      return texto.length <= limit
        ? { ok: true }
        : { ok: false, regra: "tamanho_whatsapp", motivo: `Mensagem com ${texto.length} caracteres; o limite é ${limit}. Escreva curto, como no WhatsApp.` };
    }
  },
  {
    id: "uma_pergunta",
    check: ({ texto }) => (texto.match(/\?/g) ?? []).length <= 2
      ? { ok: true }
      : { ok: false, regra: "uma_pergunta", motivo: "Mais de duas perguntas numa mensagem. Junte numa pergunta só." }
  },
  {
    id: "sem_bastidores",
    check: ({ texto }) => /\b(minhas instru[cç][oõ]es|meu prompt|system prompt|minha ficha|a jogada|minhas ferramentas|tool_call)\b/i.test(texto)
      ? { ok: false, regra: "sem_bastidores", motivo: "A mensagem fala dos bastidores do agente (instruções, ficha, ferramentas)." }
      : { ok: true }
  }
];

export type ReviewOutcome = { ok: true; juiz: "aprovou" | "sem_juiz" | "falhou_aberto" } | { ok: false; regra: string; motivo: string; fonte: "regra" | "juiz" };

/**
 * Hard rules first (code, no model). Only a message that passes them goes to the judge. When the judge is
 * unavailable, `judgeFailClosed` decides: closed blocks the message (a person takes over), open sends it.
 */
export async function reviewMessage<Ficha, Pedido>(input: ReviewInput<Ficha, Pedido> & {
  rules: ReviewRule<Ficha, Pedido>[];
  judge?: Judge;
  judgeFailClosed?: boolean;
  fichaTexto: string;
}): Promise<ReviewOutcome> {
  const all = [...(coreRules as ReviewRule<Ficha, Pedido>[]), ...input.rules];
  for (const rule of all) {
    const verdict = rule.check(input);
    if (!verdict.ok) return { ok: false, regra: verdict.regra, motivo: verdict.motivo, fonte: "regra" };
  }
  if (!input.judge) return { ok: true, juiz: "sem_juiz" };
  try {
    const verdict = await input.judge(input as ReviewInput<unknown, unknown> & { fichaTexto: string });
    return verdict.ok ? { ok: true, juiz: "aprovou" } : { ok: false, regra: verdict.regra, motivo: verdict.motivo, fonte: "juiz" };
  } catch {
    return input.judgeFailClosed === false
      ? { ok: true, juiz: "falhou_aberto" }
      : { ok: false, regra: "juiz_indisponivel", motivo: "O revisor não respondeu; por segurança a mensagem não sai sozinha.", fonte: "juiz" };
  }
}

/** JEV as the judge: three yes/no questions about the candidate message. */
export function createJevJudge(jev: JevClient, thresholds = { inventa: 0.6, segue: 0.2, responde: 0.15 }): Judge {
  return async ({ texto, jogada, historico, fichaTexto }) => {
    const answers = await jev.ask(
      { ficha: fichaTexto, jogada: jogada.instrucao, ultimasMensagens: historico.slice(-8), mensagemCandidata: texto },
      {
        inventa: {
          type: "noul",
          instructions: "A mensagemCandidata afirma número, preço, prazo, condição, compromisso ou fato que não está na ficha nem nas últimas mensagens?",
          criteria: { true: "Afirma algo sem base na ficha ou na conversa.", false: "Tudo que afirma tem base na ficha ou na conversa." }
        },
        segue: {
          type: "noul",
          instructions: "A mensagemCandidata faz o que a jogada pede?",
          criteria: { true: "Segue a jogada.", false: "Ignora, contradiz ou faz outra coisa." }
        },
        responde: {
          type: "noul",
          instructions: "Se a última mensagem do contato tem pergunta ou informação nova, a mensagemCandidata responde ou reconhece isso?",
          criteria: { true: "Responde ou reconhece, ou não havia nada a responder.", false: "Ignora o que o contato acabou de dizer." }
        }
      }
    );
    if (noul(answers.inventa) >= thresholds.inventa) return { ok: false, regra: "juiz_inventa", motivo: "O revisor achou uma afirmação sem base na ficha ou na conversa." };
    if (noul(answers.segue) < thresholds.segue) return { ok: false, regra: "juiz_jogada", motivo: "O revisor achou que a mensagem não segue a jogada." };
    if (noul(answers.responde) < thresholds.responde) return { ok: false, regra: "juiz_responde", motivo: "O revisor achou que a mensagem ignora o que o contato acabou de dizer." };
    return { ok: true };
  };
}
