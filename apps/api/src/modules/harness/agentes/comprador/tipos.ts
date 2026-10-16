export type ItemDoPedido = {
  id: string;
  descricao: string;
  quantidade: number;
  unidade: string;
  especificacao?: string;
};

/** The purchase request as one supplier conversation sees it. `privado` never reaches the model. */
export type PedidoDeCompra = {
  id: string;
  empresa: { nome: string; descricao?: string };
  itens: ItemDoPedido[];
  /** Until when we accept quotes (ISO date). */
  prazoResposta: string;
  /** Latest delivery date (ISO date). */
  dataEntrega: string;
  cep: string;
  cidade?: string;
  exigeNotaFiscal: boolean;
  pagamentoPreferido?: string;
  observacoes?: string;
  privado: {
    /** The company's ceiling for the whole order. Never said, never shown to the model. */
    teto?: number;
    /** Names of the other suppliers in this request, so the reviewer can block them. */
    concorrentes: string[];
    /** Best competing total (items + freight) right now, computed by the module from the other conversations. */
    melhorProposta?: { total: number } | null;
    maxChoradinhas: number;
    maxCobrancas: number;
  };
};

export type VersaoDaProposta = {
  itens: Array<{ itemId: string; precoUnitario: number }>;
  /** 0 is free freight. Null while the supplier has not said. */
  frete: number | null;
  prazoEntrega: string | null;
  pagamento: string | null;
  validade: string | null;
  observacao: string | null;
  /** The contact's words this version came from. */
  origem: string;
};

export type EtapaDoFornecedor =
  | "nao_iniciado"
  | "abordado"
  | "conversando"
  | "choradinha"
  | "aguardando_empresa"
  | "declinou"
  | "encerrado"
  | "humano";

/** The record of one supplier conversation: what the agent knows, kept as data. */
export type FichaDoFornecedor = {
  contato: { nome: string | null; ehRobo: boolean; humanoConfirmado: boolean };
  etapa: EtapaDoFornecedor;
  propostas: VersaoDaProposta[];
  choradinhas: { usadas: number; totalAntes: number | null };
  cobrancas: number;
  /** Flags the reader sets from the latest message; cleared once answered. */
  perguntouValorConcorrente: boolean;
  perguntouNomeConcorrente: boolean;
  perguntasPendentes: string[];
  fornecedorVaiVerificar: boolean;
  semDesconto: boolean;
  valorConcorrenteRevelado: boolean;
  observacoes: string[];
  motivoRecusa: string | null;
  /** How many versions the quote had when the latest message arrived, to tell whether it brought anything new. */
  versoesNaTriagem: number;
};
