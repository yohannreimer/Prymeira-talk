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
 * Live only where the agent turns it on for a channel (producao.ts); elsewhere the current engine answers.
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
  orientacaoDaConversa: "Não repita informações sem necessidade. Responda novamente ao que o cliente perguntou de novo; retome um dado ainda pendente se ele aceitou avançar. Não repita ofertas de catálogo/vendedor. Use as fontes completas para confirmar cidades listadas e preservar ressalvas do produto.",
  fontesDoEscritor: (ficha) => Object.entries(ficha.trechosVistos).map(([id, texto]) => `[${id}] ${texto}`).join("\n"),
  fontesDoRevisor: (ficha) => Object.entries(ficha.trechosVistos).map(([id, texto]) => `[${id}] ${texto}`).join("\n"),
  janelaDeMensagens: 20,
  anexosDaVez: (ficha, pedido) => (ficha.anexosDaVez ?? [])
    .map((id) => pedido.anexos?.find((anexo) => anexo.id === id))
    .filter((anexo) => anexo !== undefined)
    .map((anexo) => ({ url: anexo.url, legenda: anexo.titulo, nomeArquivo: anexo.nomeArquivo, mimeType: anexo.mimeType })),
  motivosParaHumano: {
    sem_base_para_retomar: "num follow-up, a pendência depende de um fato (preço, prazo, estoque) que não está na conversa",
    reclamacao: "o cliente está reclamando ou irritado com a empresa",
    fechar_pedido: "o cliente quer fechar o pedido agora (faturar, pagar, emitir nota)"
  },
  motivosAoVivo: ["reclamacao", "fechar_pedido"],
  avisoDeRepasse: "Vou passar sua mensagem para um vendedor, que continua o atendimento com você por aqui."
};

export type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";
