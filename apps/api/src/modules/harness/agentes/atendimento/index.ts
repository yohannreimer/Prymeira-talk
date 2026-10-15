import type { AgentDefinition } from "../../core/types.js";
import { ferramentasDoAnalista } from "./ferramentas.js";
import { fichaInicial, renderContexto, renderFicha } from "./ficha.js";
import { instrucoes, instrucoesDoAnalista, skills } from "./instrucoes.js";
import { aposEnvio, decidirJogada } from "./jogadas.js";
import { regras } from "./regras.js";
import type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";

/**
 * The attendance agent on the new harness. For now it owns the silence (follow-up): the analyst
 * subagent keeps the record true, code picks the move, the writer and reviewer handle the message.
 * Live replies still come from the current attendance engine until they move here too.
 */
export const atendimento: AgentDefinition<FichaDoAtendimento, ContextoDoAtendimento> = {
  id: "atendimento",
  instrucoes,
  skills,
  fichaInicial: () => fichaInicial(),
  renderFicha: (ficha) => renderFicha(ficha),
  renderPedidoPublico: renderContexto,
  ferramentasDeLeitura: [],
  analista: { instrucoes: instrucoesDoAnalista, ferramentas: ferramentasDoAnalista, maxRodadas: 4 },
  decidirJogada,
  aposEnvio,
  regras,
  janelaDeMensagens: 20,
  motivosParaHumano: {
    sem_base_para_retomar: "a pendência depende de um fato (preço, prazo, estoque) que não está na conversa"
  }
};

export type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";
