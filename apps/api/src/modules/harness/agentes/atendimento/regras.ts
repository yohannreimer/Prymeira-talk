import { findMoneyAmounts, findPercentages, sameAmount } from "../../core/dinheiro.js";
import type { ReviewRule } from "../../core/types.js";
import type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";

type Rule = ReviewRule<FichaDoAtendimento, ContextoDoAtendimento>;

const words = (text: string) => new Set(text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/\p{L}{3,}/gu) ?? []);

/** Share of words two messages have in common (Jaccard). */
export function semelhanca(a: string, b: string) {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  const common = [...left].filter((word) => right.has(word)).length;
  return common / (left.size + right.size - common);
}

const naoRepete: Rule = {
  id: "nao_repete",
  check: ({ texto, ficha, historico, jogada }) => {
    if (jogada.tipo !== "cobrar_pendencia") return { ok: true };
    const anteriores = [
      ...ficha.followups.map((item) => item.texto),
      ...historico.filter((message) => message.autor !== "contato").slice(-6).map((message) => message.texto)
    ];
    const parecida = anteriores.find((anterior) => semelhanca(texto, anterior) >= 0.6);
    return parecida
      ? { ok: false, regra: "nao_repete", motivo: `A mensagem repete uma que a empresa já mandou ("${parecida.slice(0, 80)}"). Mude a abordagem.` }
      : { ok: true };
  }
};

/** Prices and percentages only come from the conversation or the base passages seen: never a new one. */
const semValorNovo: Rule = {
  id: "sem_valor_novo",
  check: ({ texto, historico, ficha }) => {
    // Known values: the conversation and the base passages the reader actually saw.
    const conversa = [...historico.map((message) => message.texto), ...Object.values(ficha.trechosVistos ?? {})].join("\n");
    const valores = findMoneyAmounts(conversa);
    const novo = findMoneyAmounts(texto).find((value) => !valores.some((known) => sameAmount(known, value)));
    if (novo !== undefined) return { ok: false, regra: "sem_valor_novo", motivo: `A mensagem cita R$ ${novo}, que não aparece na conversa. Não invente valores.` };
    const percentuais = findPercentages(conversa);
    const pct = findPercentages(texto).find((value) => !percentuais.some((known) => sameAmount(known, value)));
    if (pct !== undefined) return { ok: false, regra: "sem_valor_novo", motivo: `A mensagem cita ${pct}%, que não aparece na conversa. Não invente desconto.` };
    return { ok: true };
  }
};

const semPressao: Rule = {
  id: "sem_pressao",
  check: ({ texto }) => /\b(ultimas? unidades|so hoje|corre que|nao perca|promocao acaba|ultima chance)\b/.test(texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase())
    ? { ok: false, regra: "sem_pressao", motivo: "A mensagem pressiona com urgência que a conversa não tem." }
    : { ok: true }
};

export const regras: Rule[] = [naoRepete, semValorNovo, semPressao];
