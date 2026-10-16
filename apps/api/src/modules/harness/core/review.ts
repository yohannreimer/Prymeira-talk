import { noul, type JevClient } from "./jev.js";
import type { JudgeVerdict, ReviewInput, ReviewRule } from "./types.js";

/** A second opinion on a message that already passed the hard rules. */
/**
 * The judge sees the same sources the writer was allowed to use: the order or campaign (`pedidoTexto`),
 * the record, the move and any agent-specific sources (`fontesExtras`, e.g. knowledge-base passages).
 * A judge that sees less than the writer flags every true fact it cannot see as invented.
 */
export type JudgeInput = ReviewInput<unknown, unknown> & { fichaTexto: string; pedidoTexto?: string; fontesExtras?: string };
export type Judge = (input: JudgeInput) => Promise<JudgeVerdict>;

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
    // "Vou consultar e já te aviso" became an escape hatch in the old engine: anything hard got parked.
    // Here the writer answers with what it has, asks for what is missing, or hands over with a reason.
    id: "sem_promessa_de_retorno",
    check: ({ texto, jogada }) => jogada.dados?.podePrometerRetorno === true || !PROMESSA_DE_RETORNO.test(normalizeText(texto))
      ? { ok: true }
      : { ok: false, regra: "sem_promessa_de_retorno", motivo: "Não prometa consultar e retornar depois. Responda com o que está no pedido, na ficha ou na conversa, ou pergunte o dado que falta. Se não der mesmo para responder, use pedir_humano com o motivo." }
  },
  {
    id: "sem_bastidores",
    check: ({ texto }) => /\b(minhas instru[cç][oõ]es|meu prompt|system prompt|minha ficha|a jogada|minhas ferramentas|tool_call)\b/i.test(texto)
      ? { ok: false, regra: "sem_bastidores", motivo: "A mensagem fala dos bastidores do agente (instruções, ficha, ferramentas)." }
      : { ok: true }
  }
];

const PROMESSA_DE_RETORNO = /\b(?:vou|vamos|irei|deixa eu|deixe-me|vou so)\s+(?:consultar|verificar|checar|conferir|confirmar|ver|levantar|olhar)\b.{0,80}\b(?:retorno|retornar|aviso|avisar|volto|te falo|te passo|te digo)\b|\bja (?:te |lhe )?(?:dou um |trago um )?(?:retorno|aviso|volto)\b|\bem breve (?:te |lhe )?(?:retorno|retornamos|aviso)\b/;

function normalizeText(text: string) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export type ReviewOutcome =
  | { ok: true; juiz: "aprovou" | "sem_juiz" | "falhou_aberto"; notas?: Record<string, number> }
  | { ok: false; regra: string; motivo: string; fonte: "regra" | "juiz"; notas?: Record<string, number> };

/**
 * Hard rules first (code, no model). Only a message that passes them goes to the judge. When the judge is
 * unavailable, `judgeFailClosed` decides: closed blocks the message (a person takes over), open sends it.
 */
export async function reviewMessage<Ficha, Pedido>(input: ReviewInput<Ficha, Pedido> & {
  rules: ReviewRule<Ficha, Pedido>[];
  judge?: Judge;
  judgeFailClosed?: boolean;
  fichaTexto: string;
  pedidoTexto?: string;
  fontesExtras?: string;
}): Promise<ReviewOutcome> {
  const all = [...(coreRules as ReviewRule<Ficha, Pedido>[]), ...input.rules];
  for (const rule of all) {
    const verdict = rule.check(input);
    if (!verdict.ok) return { ok: false, regra: verdict.regra, motivo: verdict.motivo, fonte: "regra" };
  }
  if (!input.judge) return { ok: true, juiz: "sem_juiz" };
  try {
    const verdict = await input.judge(input as JudgeInput);
    return verdict.ok ? { ok: true, juiz: "aprovou", notas: verdict.notas } : { ok: false, regra: verdict.regra, motivo: verdict.motivo, fonte: "juiz", notas: verdict.notas };
  } catch {
    return input.judgeFailClosed === false
      ? { ok: true, juiz: "falhou_aberto" }
      : { ok: false, regra: "juiz_indisponivel", motivo: "O revisor não respondeu; por segurança a mensagem não sai sozinha.", fonte: "juiz" };
  }
}

/** Shared by every judge: what counts as invented, given all the sources the writer had. */
export const PERGUNTA_INVENTA =
  "A mensagemCandidata afirma número, preço, prazo, estoque, condição, compromisso ou fato concreto que NÃO aparece em nenhuma das fontes (pedido, ficha, jogada, outrasFontes, ultimasMensagens)? Não contam como afirmação: cumprimento, agradecimento, pergunta, apresentação da empresa feita a partir do pedido, repetir o que está no pedido, dizer que não pode informar algo, e dizer o que a jogada ou o procedimento mandam dizer (por exemplo: o vendedor confirma com você; a empresa escolhe a melhor condição).";
export const CRITERIO_INVENTA = {
  true: "Afirma algo concreto que não está em nenhuma fonte.",
  false: "Tudo que afirma está em alguma fonte, ou a mensagem só cumprimenta, se apresenta, agradece ou pergunta."
};

/** JEV as the judge: three yes/no questions about the candidate message. */
export function createJevJudge(jev: JevClient, thresholds = { inventa: 0.6, segue: 0.2, responde: 0.15 }): Judge {
  return async ({ texto, jogada, historico, fichaTexto, pedidoTexto, fontesExtras }) => {
    const answers = await jev.ask(
      {
        pedido: pedidoTexto ?? "",
        ficha: fichaTexto,
        jogada: jogada.instrucao,
        ...(fontesExtras ? { outrasFontes: fontesExtras } : {}),
        ultimasMensagens: historico.slice(-8),
        mensagemCandidata: texto
      },
      {
        inventa: { type: "noul", instructions: PERGUNTA_INVENTA, criteria: CRITERIO_INVENTA },
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
    const notas = { inventa: noul(answers.inventa), segue: noul(answers.segue), responde: noul(answers.responde) };
    if (notas.inventa >= thresholds.inventa) return { ok: false, regra: "juiz_inventa", motivo: "O revisor achou uma afirmação sem base na ficha ou na conversa.", notas };
    if (notas.segue < thresholds.segue) return { ok: false, regra: "juiz_jogada", motivo: "O revisor achou que a mensagem não segue a jogada.", notas };
    if (notas.responde < thresholds.responde) return { ok: false, regra: "juiz_responde", motivo: "O revisor achou que a mensagem ignora o que o contato acabou de dizer.", notas };
    return { ok: true, notas };
  };
}
