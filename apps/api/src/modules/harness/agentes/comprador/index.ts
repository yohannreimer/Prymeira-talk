import type { AgentDefinition } from "../../core/types.js";
import { ferramentasDeLeitura } from "./ferramentas.js";
import { fichaInicial, renderFicha, renderPedidoPublico } from "./ficha.js";
import { instrucoes, skills } from "./instrucoes.js";
import { aposEnvio, aposTriagem, decidirJogada } from "./jogadas.js";
import { regras } from "./regras.js";
import type { FichaDoFornecedor, PedidoDeCompra } from "./tipos.js";

/** The buyer agent: one conversation with one supplier inside a purchase request. */
export const comprador: AgentDefinition<FichaDoFornecedor, PedidoDeCompra> = {
  id: "comprador",
  instrucoes,
  skills,
  fichaInicial: () => fichaInicial(),
  renderFicha,
  renderPedidoPublico,
  ferramentasDeLeitura,
  decidirJogada,
  aposTriagem,
  aposEnvio,
  regras,
  janelaDeMensagens: 15
};

export type { FichaDoFornecedor, PedidoDeCompra } from "./tipos.js";
