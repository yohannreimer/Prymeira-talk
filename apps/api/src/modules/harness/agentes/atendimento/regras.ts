import { citacoes, RECUSA } from "./jogadas.js";
import { findMoneyAmounts, findPercentages, sameAmount } from "../../core/dinheiro.js";
import type { ReviewRule } from "../../core/types.js";
import type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";
import { soSaudacaoOuOferta } from "./cobertura.js";

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

/** Each sentence as its words; short ones ("Bom dia!", "Quantas você precisa?") never count as repeats. */
const frases = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((frase) => [...words(frase)]).filter((palavras) => palavras.length >= 4);

/**
 * A live reply says only what is new. Seen in the Villefer test of 17/10: asked about one size, the reply
 * restated product, standard size, lead time and the catalogue offer from the reply before, word for word.
 */
const naoRepeteFrase: Rule = {
  id: "nao_repete_frase",
  check: ({ texto, historico, jogada }) => {
    if (jogada.tipo === "cobrar_pendencia") return { ok: true };
    const ditas = historico.filter((message) => message.autor !== "contato").slice(-4).flatMap((message) => frases(message.texto));
    const repetida = frases(texto).find((frase) => ditas.some((dita) => {
      const common = frase.filter((word) => dita.includes(word)).length;
      return common / (frase.length + dita.length - common) >= 0.6;
    }));
    return repetida
      ? { ok: false, regra: "nao_repete_frase", motivo: `Uma frase repete o que a empresa já disse nesta conversa (${repetida.join(" ").slice(0, 80)}). Tire o que já foi dito e responda só o que a última mensagem pergunta.` }
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

const sem = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * A question answered by "não fornece" must be answered with a "no". Seen in the shadow run of 16/10: the
 * base said "NÃO FORNECE: … oxicorte ou material cortado" and the reply said "Trabalhamos com oxicorte".
 */
const naoInverteRecusa: Rule = {
  id: "nao_inverte_recusa",
  check: ({ texto, ficha }) => {
    const recusa = ficha.perguntas.filter((pergunta) => pergunta.status === "respondida").flatMap(citacoes).find((citacao) => RECUSA.test(sem(citacao)));
    if (!recusa || /\b(nao|nem)\b/.test(sem(texto))) return { ok: true };
    return { ok: false, regra: "nao_inverte_recusa", motivo: `A base diz que a empresa não fornece o que foi pedido ("${recusa.slice(0, 100)}"), mas a mensagem não diz isso. Diga ao contato que não fornecem.` };
  }
};

/** "Segue o catálogo em PDF" with nothing attached. Seen 4 times in the shadow run of 16/10. */
const ANUNCIA_ARQUIVO = /\b(segue|seguem|envio|enviando|mando|mandando|te mandei|estou te enviando|anexo|anexei)\b.{0,40}\b(catalogo|arquivo|pdf)\b|\b(catalogo|pdf)\b.{0,30}\b(segue|anexo|em anexo|abaixo)\b/;
const naoPrometeAnexo: Rule = {
  id: "nao_promete_anexo",
  check: ({ texto, ficha }) => !(ficha.anexosDaVez ?? []).length && ANUNCIA_ARQUIVO.test(sem(texto))
    ? { ok: false, regra: "nao_promete_anexo", motivo: "A mensagem diz que um arquivo segue, mas nenhum vai anexado. Não diga que está enviando." }
    : { ok: true }
};

/** Notes the base marks as internal ("EA36 é anotação interna"): seen in a reply on the shadow rerun of 16/10. */
const semTermoInterno: Rule = {
  id: "sem_termo_interno",
  check: ({ texto, pedido }) => {
    const termo = (pedido.termosInternos ?? []).find((item) => new RegExp(`\\b${sem(item)}\\b`).test(sem(texto)));
    return termo
      ? { ok: false, regra: "sem_termo_interno", motivo: `A mensagem cita "${termo}", que é anotação interna da empresa. Não cite; diga que o vendedor confirma a especificação.` }
      : { ok: true };
  }
};

const respondePerguntas: Rule = {
  id: "resposta_omitida",
  check: ({ texto, ficha, jogada }) => {
    if (!["responder", "responder_e_passar"].includes(jogada.tipo)) return { ok: true };
    const perguntas = ficha.perguntas.filter(p => p.status === "respondida");
    return perguntas.length && soSaudacaoOuOferta(texto)
      ? { ok: false, regra: "resposta_omitida", motivo: `A mensagem só cumprimenta ou oferece catálogo/vendedor. Responda primeiro: ${perguntas.map(p => `${p.id}: ${p.texto}`).join("; ")}, usando as citações da ficha.` }
      : { ok: true };
  }
};

export const regras: Rule[] = [respondePerguntas, naoRepete, naoRepeteFrase, semValorNovo, semPressao, naoInverteRecusa, naoPrometeAnexo, semTermoInterno];
