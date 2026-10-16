import { findMoneyAmounts, findPercentages, sameAmount } from "../../core/dinheiro.js";
import type { ReviewRule, ReviewVerdict } from "../../core/types.js";
import { findRepeatedQuestion } from "../../../prospecting/repeated-question.js";
import type { CampanhaDeProspeccao, FichaDoLead } from "./tipos.js";

type Rule = ReviewRule<FichaDoLead, CampanhaDeProspeccao>;
const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const block = (regra: string, motivo: string): ReviewVerdict => ({ ok: false, regra, motivo });

/** The company name, without legal suffixes and Google Maps tails ("Trevo Metais | Aços | ..."). */
export function nomeCurtoDaEmpresa(nome: string) {
  return nome.split("|")[0].replace(/\b(ltda|s\/?a|eireli|me|epp)\b\.?/gi, "").replace(/[\s\-–,.]+$/g, "").trim();
}

const semComoPossoAjudar: Rule = {
  id: "sem_como_posso_ajudar",
  check: ({ texto }) => /como (posso|podemos) (te |lhe )?ajudar/.test(normalize(texto))
    ? block("sem_como_posso_ajudar", "Fomos nós que procuramos o lead: não pergunte como pode ajudar.")
    : { ok: true }
};

const semReapresentar: Rule = {
  id: "sem_reapresentar",
  check: ({ texto, historico }) => historico.some((message) => message.autor === "agente") && /\b(meu nome e|me chamo)\b/.test(normalize(texto))
    ? block("sem_reapresentar", "A abertura já apresentou quem somos: não se apresente de novo.")
    : { ok: true }
};

const naoChamaPelaEmpresa: Rule = {
  id: "nao_chama_pela_empresa",
  check: ({ texto, pedido }) => {
    const empresa = normalize(nomeCurtoDaEmpresa(pedido.lead.empresa));
    if (empresa.length < 3) return { ok: true };
    const escaped = empresa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const asName = new RegExp(`\\b(oi|ola|bom dia|boa tarde|obrigad[oa](?: pela atencao)?|valeu)[ ,!]+${escaped}\\b|,\\s*${escaped}\\s*[!?.]`);
    return asName.test(normalize(texto))
      ? block("nao_chama_pela_empresa", "A mensagem chama a pessoa pelo nome da empresa. Use o nome da pessoa se ela se apresentou, ou nenhum nome.")
      : { ok: true };
  }
};

const naoRepetePergunta: Rule = {
  id: "nao_repete_pergunta",
  check: ({ texto, historico }) => {
    const repetida = findRepeatedQuestion(texto, historico.filter((message) => message.autor !== "contato").map((message) => message.texto));
    return repetida ? block("nao_repete_pergunta", `Essa pergunta já foi feita antes ("${repetida}"). Pergunte outra coisa ou avance.`) : { ok: true };
  }
};

const encerrarSemPergunta: Rule = {
  id: "encerrar_sem_pergunta",
  check: ({ texto, jogada }) => jogada.dados?.semPergunta && texto.includes("?")
    ? block("encerrar_sem_pergunta", "Esta mensagem fecha a conversa: sem pergunta.")
    : { ok: true }
};

const semValorInventado: Rule = {
  id: "sem_valor_inventado",
  check: ({ texto, pedido, historico }) => {
    const base = [pedido.contextoDaOferta, ...historico.map((message) => message.texto)].join("\n");
    const valores = findMoneyAmounts(base);
    const percentuais = findPercentages(base);
    const valor = findMoneyAmounts(texto).find((value) => !valores.some((known) => sameAmount(known, value)));
    const pct = findPercentages(texto).find((value) => !percentuais.some((known) => sameAmount(known, value)));
    if (valor !== undefined || pct !== undefined) return block("sem_valor_inventado", "A mensagem cita um preço ou percentual que a campanha não traz. Diga que depende do caso.");
    return { ok: true };
  }
};

export const regras: Rule[] = [semComoPossoAjudar, semReapresentar, naoChamaPelaEmpresa, naoRepetePergunta, encerrarSemPergunta, semValorInventado];
