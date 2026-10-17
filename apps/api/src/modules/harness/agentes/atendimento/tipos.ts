import type { Catalogo } from "./catalogo.js";
/** Where a finding comes from: the message number in the numbered conversation and the exact words. */
export type Prova = { mensagem: number; trecho: string };

export type DonoDaVez = "cliente" | "empresa";

/** Something left open in the conversation. Every item points at the message that proves it. */
export type Pendencia = {
  id: string;
  dono: DonoDaVez;
  descricao: string;
  prova: Prova;
  /** The contact's own message behind it: interest in the sale (cliente) or the unanswered question (empresa). */
  doContato?: Prova | null;
  status: "aberta" | "resolvida";
  resolvidaPor: Prova | null;
};

/** Only "cliente" and "indefinido" can get a follow-up. */
export type TipoDeContato = "cliente" | "colega" | "pessoal" | "fornecedor" | "transportadora" | "indefinido";

/** One passage of the company's approved knowledge (catalog, policies, FAQ). */
export type TrechoDaBase = { id: string; titulo: string; texto: string };

/** Where the agent looks answers up. In the simulator it is in memory; in production, the knowledge retrieval. */
export type BaseDeConhecimento = {
  buscar(consulta: string): TrechoDaBase[] | Promise<TrechoDaBase[]>;
  /** Every passage, when the base is small enough to read whole: search misses synonyms ("metalon" is a tube). */
  todos?(): TrechoDaBase[];
};

/**
 * A question the contact asked. It is answered only with a passage of the base that says so; it is
 * "sem_base" only after the base was searched. That order is what keeps a person from getting
 * everything that looks hard.
 */
export type Pergunta = {
  id: string;
  texto: string;
  status: "aberta" | "respondida" | "sem_base" | "tratada";
  resposta: { trechoId: string; citacao: string } | null;
  /** More passages that answer part of it (the minimum after "we supply it", the weight after the minimum). */
  maisRespostas?: Array<{ trechoId: string; citacao: string }>;
  buscas: number;
};

/** A file the company approved for sending (the PDF catalogue). Only these are ever attached. */
export type AnexoAprovado = { id: string; titulo: string; url: string; nomeArquivo: string | null; mimeType: string | null };

/** The record of one attendance conversation. It persists between silences instead of being guessed again. */
export type FichaDoAtendimento = {
  contato: { tipo: TipoDeContato; prova: Prova | null };
  pendencias: Pendencia[];
  /** The demand ended (order closed, no interest, thanked after getting what was needed). */
  encerrada: { motivo: string; prova: Prova } | null;
  /** Pickup or delivery under way ("tô chegando", location): nothing to chase now. */
  emAndamento: { motivo: string; prova: Prova } | null;
  /** The contact passed someone else's contact (the buyer): the seller should talk to that person. */
  indicado: { nome: string; telefone: string | null; prova: Prova } | null;
  /** Follow-ups this agent sent, and the open item each one was about. */
  followups: Array<{ texto: string; pendenciaId: string }>;
  /** Questions of the live conversation and how each was answered. */
  perguntas: Pergunta[];
  /** Passages the reader saw, by id: the writer and the reviewer check numbers against them. */
  trechosVistos: Record<string, string>;
  /** The contact asked for a person in the latest message. */
  pediuPessoa: boolean;
  /** Weights computed by code in this reading (ids in trechosVistos), shown to the writer next to the answers. */
  pesosDaVez?: string[];
  /** Approved files to attach to this reply, because the contact asked for them. */
  anexosDaVez?: string[];
  /** Approved files already sent in this conversation. */
  anexosEnviados?: string[];
};

/** What the attendance agent knows about the company it works for. Shown to the model as is. */
export type ContextoDoAtendimento = {
  empresa: { nome: string; oQueVende: string };
  /** Follow-ups for the same open item before stopping (the cadence steps of the number). */
  maxFollowups: number;
  /** Short company rules that matter for follow-ups. Not the whole attendance prompt. */
  regrasDaEmpresa?: string;
  /** The approved knowledge. Without it every question ends up with a person. */
  base?: BaseDeConhecimento;
  /** Product tables (sizes, theoretical weights), consulted by a tool. What is supplied is still the base. */
  catalogo?: Catalogo;
  /** Files approved for sending, such as the PDF catalogue. */
  anexos?: AnexoAprovado[];
  /** Internal notes of the base that never go to the contact ("EA36"). */
  termosInternos?: string[];
};
