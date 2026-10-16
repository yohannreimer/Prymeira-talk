import { findMoneyAmounts, findPercentages, formatBRL, sameAmount } from "../../core/dinheiro.js";
import type { ReviewRule } from "../../core/types.js";
import { reducaoDaChoradinha, valoresPermitidos } from "./ficha.js";
import type { FichaDoFornecedor, PedidoDeCompra } from "./tipos.js";

type Rule = ReviewRule<FichaDoFornecedor, PedidoDeCompra>;

function normalize(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The supplier names that, if written, identify a competitor. Generic words alone ("Móveis") are ignored. */
function nameVariants(name: string) {
  const full = normalize(name).replace(/\b(ltda|me|epp|eireli|s\/?a|comercio|comercial|industria|distribuidora)\b/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return full.length >= 4 ? [full] : [];
}

export const nuncaNomeDeConcorrente: Rule = {
  id: "nunca_nome_concorrente",
  check: ({ texto, pedido }) => {
    const text = ` ${normalize(texto).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
    const hit = pedido.privado.concorrentes.flatMap(nameVariants).find((variant) => text.includes(` ${variant} `));
    return hit
      ? { ok: false, regra: "nunca_nome_concorrente", motivo: "A mensagem cita outro fornecedor do pedido. Nunca diga de quem é outra proposta." }
      : { ok: true };
  }
};

export const nuncaTeto: Rule = {
  id: "nunca_teto",
  check: ({ texto, pedido }) => {
    const teto = pedido.privado.teto;
    if (teto === undefined) return { ok: true };
    return findMoneyAmounts(texto).some((amount) => sameAmount(amount, teto))
      ? { ok: false, regra: "nunca_teto", motivo: "A mensagem revela quanto a empresa pode pagar." }
      : { ok: true };
  }
};

/**
 * Every money amount must be the supplier's own number (from the record) or a number this move is allowed
 * to reveal. This is what stops an invented competitor price or a leaked best offer.
 */
export const numerosComBase: Rule = {
  id: "numeros_com_base",
  check: ({ texto, ficha, pedido, jogada }) => {
    const allowed = [...valoresPermitidos(ficha, pedido), ...(jogada.revelar?.numeros ?? [])];
    const unknown = findMoneyAmounts(texto).filter((amount) => !allowed.some((value) => sameAmount(value, amount)));
    if (unknown.length) {
      return {
        ok: false,
        regra: "numeros_com_base",
        motivo: `A mensagem tem valor que não está na ficha nem pode ser dito nesta jogada: ${unknown.map(formatBRL).join(", ")}. Use só os números da ficha.`
      };
    }
    const reducao = reducaoDaChoradinha(ficha, pedido);
    const percents = findPercentages(texto).filter((value) => !reducao || Math.abs(value - reducao.percentual) > 0.6);
    return percents.length
      ? { ok: false, regra: "numeros_com_base", motivo: "A mensagem cita um percentual que não vem da ficha. Não fale em percentuais." }
      : { ok: true };
  }
};

export const semFecharCompra: Rule = {
  id: "sem_fechar_compra",
  check: ({ texto }) => /\b(fechado|fechamos|vamos fechar|pode (mandar|enviar|faturar|emitir)|est[aá] aprovad[oa]|aprovamos|pedido confirmado|confirmo o pedido|pode separar)\b/i.test(texto)
    ? { ok: false, regra: "sem_fechar_compra", motivo: "A mensagem fecha ou confirma a compra. Quem aprova é a empresa; diga que vai apresentar a proposta." }
    : { ok: true }
};

export const regras: Rule[] = [nuncaNomeDeConcorrente, nuncaTeto, numerosComBase, semFecharCompra];
