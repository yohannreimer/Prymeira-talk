import type { AgentDefinition } from "../../core/types.js";
import { ferramentasDeLeitura } from "./ferramentas.js";
import { fichaInicial, renderCampanha, renderFicha } from "./ficha.js";
import { instrucoes, instrucoesDoLeitor, skills } from "./instrucoes.js";
import { aposEnvio, aposTriagem, decidirJogada } from "./jogadas.js";
import { regras } from "./regras.js";
import type { CampanhaDeProspeccao, FichaDoLead } from "./tipos.js";

/** João: one cold prospecting conversation opened by a campaign. Runs only in the simulator for now. */
export const prospeccao: AgentDefinition<FichaDoLead, CampanhaDeProspeccao> = {
  id: "prospeccao",
  instrucoes,
  skills,
  fichaInicial: () => fichaInicial(),
  renderFicha: (ficha) => renderFicha(ficha),
  renderPedidoPublico: renderCampanha,
  ferramentasDeLeitura,
  instrucoesDoLeitor,
  maxRodadasDeLeitura: 3,
  decidirJogada,
  aposTriagem,
  aposEnvio,
  regras,
  janelaDeMensagens: 15,
  motivosParaHumano: {
    lead_pediu_pessoa: "o lead pediu para falar com uma pessoa",
    reclamacao: "o lead está irritado ou reclamando do contato"
  }
};

export type { CampanhaDeProspeccao, FichaDoLead } from "./tipos.js";
