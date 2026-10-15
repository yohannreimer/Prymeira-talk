/** Where a finding comes from: the message number in the numbered conversation and the exact words. */
export type Prova = { mensagem: number; trecho: string };

export type DonoDaVez = "cliente" | "empresa";

/** Something left open in the conversation. Every item points at the message that proves it. */
export type Pendencia = {
  id: string;
  dono: DonoDaVez;
  descricao: string;
  prova: Prova;
  status: "aberta" | "resolvida";
  resolvidaPor: Prova | null;
};

/** Only "cliente" and "indefinido" can get a follow-up. */
export type TipoDeContato = "cliente" | "colega" | "pessoal" | "fornecedor" | "transportadora" | "indefinido";

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
};

/** What the attendance agent knows about the company it works for. Shown to the model as is. */
export type ContextoDoAtendimento = {
  empresa: { nome: string; oQueVende: string };
  /** Follow-ups for the same open item before stopping (the cadence steps of the number). */
  maxFollowups: number;
  /** Short company rules that matter for follow-ups. Not the whole attendance prompt. */
  regrasDaEmpresa?: string;
};
