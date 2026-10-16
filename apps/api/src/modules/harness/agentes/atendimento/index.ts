import type { AgentDefinition } from "../../core/types.js";
import { conferirLeitura, ferramentasDeLeitura, ferramentasDoAnalista } from "./ferramentas.js";
import { fichaInicial, renderContexto, renderFicha } from "./ficha.js";
import { instrucoes, instrucoesDoAnalista, instrucoesDoLeitor, skills } from "./instrucoes.js";
import { aposEnvio, decidirJogada } from "./jogadas.js";
import { regras } from "./regras.js";
import type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";

/**
 * The attendance agent on the new harness.
 * - Live reply: the reader registers each question and looks it up in the base; code answers what has a
 *   quoted passage and hands over only what the base does not cover.
 * - Silence (follow-up): the analyst subagent keeps the record true, code picks the move.
 * Still runs only in the simulator; the live engine is the current one.
 */
export const atendimento: AgentDefinition<FichaDoAtendimento, ContextoDoAtendimento> = {
  id: "atendimento",
  instrucoes,
  skills,
  fichaInicial: () => fichaInicial(),
  renderFicha: (ficha) => renderFicha(ficha),
  renderPedidoPublico: renderContexto,
  ferramentasDeLeitura,
  instrucoesDoLeitor,
  maxRodadasDeLeitura: 6,
  conferirLeitura,
  analista: { instrucoes: instrucoesDoAnalista, ferramentas: ferramentasDoAnalista, maxRodadas: 4 },
  decidirJogada,
  aposEnvio,
  regras,
  // The passages the reader already pulled from the base are true facts the judge must also see.
  fontesDoRevisor: (ficha) => Object.entries(ficha.trechosVistos).map(([id, texto]) => `[${id}] ${texto}`).join("\n"),
  janelaDeMensagens: 20,
  motivosParaHumano: {
    sem_base_para_retomar: "num follow-up, a pendência depende de um fato (preço, prazo, estoque) que não está na conversa",
    reclamacao: "o cliente está reclamando ou irritado com a empresa",
    fechar_pedido: "o cliente quer fechar o pedido agora (faturar, pagar, emitir nota)"
  }
};

export type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";
