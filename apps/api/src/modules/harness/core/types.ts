import type { z } from "zod";

/** One message of the conversation, as the harness sees it. "contato" is the other side (supplier, lead, customer). */
export type HarnessMessage = {
  autor: "contato" | "agente" | "humano" | "sistema";
  texto: string;
  em: string;
};

/** What the entry triage says about the contact's latest message, before any agent call. */
export type TriageKind = "humano" | "robo" | "despedida" | "recusa" | "injecao";

export type TriageResult = {
  kind: TriageKind;
  /** Where the answer came from: the deterministic rules or the JEV classifier. */
  fonte: "regras" | "jev";
  motivo: string;
};

/**
 * The next move, decided by code from the record (ficha). The model never chooses the move; it only
 * writes the message for it. `instrucao` is shown to the writer; `revelar` lists facts the reviewer
 * allows in this message only (for example the best competing total, when the contact asked for it).
 */
export type Jogada = {
  tipo: string;
  instrucao: string;
  /** No message is sent at all (robot, waiting, closed). */
  silencio?: boolean;
  /** Hand the conversation to a person with this reason, without writing a reply first. */
  humano?: string;
  /**
   * Send the reply AND hand over with this reason: the agent answered what it could and a person
   * takes the rest (for example a question the knowledge base does not answer).
   */
  avisarHumano?: string;
  revelar?: { numeros?: number[] };
  /** Skills (procedures in plain text) the writer receives only for this move. */
  skills?: string[];
  /** Agent-specific data the move carries to `aposEnvio` (for example the total before a discount ask). */
  dados?: Record<string, unknown>;
};

export type ToolContext<Ficha, Pedido> = {
  ficha: Ficha;
  pedido: Pedido;
  /** Replaces the record. Tools are the only way the model changes it. */
  setFicha: (next: Ficha) => void;
  mensagemAtual: string;
  /** The whole conversation. Tools that need proof check quotes against it. */
  historico: HarnessMessage[];
};

export type HarnessTool<Ficha, Pedido, Args = unknown> = {
  name: string;
  description: string;
  /** JSON Schema sent to the model. Kept explicit (not generated) so the prompt is ours. */
  parameters: Record<string, unknown>;
  schema: z.ZodType<Args>;
  /** Returns the text the model sees as the tool result. Throwing returns the error text instead. */
  execute: (args: Args, context: ToolContext<Ficha, Pedido>) => string | Promise<string>;
};

export type ReviewVerdict = { ok: true } | { ok: false; regra: string; motivo: string };
/** A judge's verdict with its scores (0..1 per question), kept in the trace to calibrate thresholds. */
export type VerificacaoDoJuiz = { id: string; exigencia: string; resultado: string; ok: boolean; motivo: string | null };
export type JudgeVerdict = ReviewVerdict & { notas?: Record<string, number>; verificacoes?: VerificacaoDoJuiz[] };

export type ReviewInput<Ficha, Pedido> = {
  texto: string;
  ficha: Ficha;
  pedido: Pedido;
  jogada: Jogada;
  historico: HarnessMessage[];
};

/** A hard rule: plain code, no model. A failed rule blocks the message. */
export type ReviewRule<Ficha, Pedido> = {
  id: string;
  check: (input: ReviewInput<Ficha, Pedido>) => ReviewVerdict;
};

/**
 * Everything that makes one agent different from another. The harness (runner, review, triage, trace,
 * simulator) is the same for all of them; a new agent fills this in.
 */
export type AgentDefinition<Ficha, Pedido> = {
  id: string;
  /** Who the agent is, tone, what it never does. Plain text, Portuguese. */
  instrucoes: string;
  /** Procedures loaded only when a move asks for them, by name. */
  skills: Record<string, string>;
  fichaInicial: (pedido: Pedido) => Ficha;
  /** Compact text of the record for the model. The model never sees the raw object. */
  renderFicha: (ficha: Ficha, pedido: Pedido) => string;
  /** Facts about the order that the agent may say. Anything else (ceiling, competitor names) stays out. */
  renderPedidoPublico: (pedido: Pedido) => string;
  /** Tools for the update step: the model reads the contact's message and records what it learned. */
  ferramentasDeLeitura: HarnessTool<Ficha, Pedido, any>[];
  /** Extra instructions for the update step (for example: look questions up in the knowledge base). */
  instrucoesDoLeitor?: string;
  /** Tool rounds in the update step. Defaults to the runner's (3). */
  maxRodadasDeLeitura?: number;
  /** Code decides the next move from the record and the triage. */
  decidirJogada: (input: { ficha: Ficha; pedido: Pedido; triagem: TriageResult | null; evento: HarnessEvent }) => Jogada;
  /** Called after a message is sent for a move, so the record reflects what was said. */
  aposEnvio?: (input: { ficha: Ficha; jogada: Jogada; texto: string }) => Ficha;
  /** Called after triage, before the update step (for example to mark a robot or a refusal). */
  aposTriagem?: (input: { ficha: Ficha; triagem: TriageResult }) => Ficha;
  regras: ReviewRule<Ficha, Pedido>[];
  /** How many recent messages the writer sees verbatim. The record carries the rest. */
  janelaDeMensagens?: number;
  /**
   * The only reasons the writer may hand the conversation to a person, as {key: when it applies}.
   * Without it the writer may hand over for any reason, which is how "anything hard goes to a human" starts.
   */
  motivosParaHumano?: Record<string, string>;
  /**
   * Reasons the writer may use on a live message (the rest only on a silence). A hand-over on a live message
   * also carries a short message to the contact, so the contact is never left without an answer.
   */
  motivosAoVivo?: string[];
  /**
   * Sent on a live hand-over when no written message passed the review (blocked twice, judge down). Fixed text,
   * so it promises nothing; without it the contact would get no answer at all.
   */
  avisoDeRepasse?: string;
  /**
   * Checks the record after the reader and, when something is missing or doubtful, returns a note that
   * gives the reader extra rounds (once per turn). Models stop early or give up on a passage that does
   * answer; code can see that and ask them to look again.
   */
  conferirLeitura?: (input: { ficha: Ficha; mensagem: string; pedido?: Pedido }) => string | null;
  /** Final reader gate after bounded retries; enabled only by agents opting in. */
  validarLeitura?: (input: { ficha: Ficha; mensagem: string; pedido: Pedido }) => string | null;
  /**
   * Approved files that go with this turn's message (the PDF catalogue the contact asked for). The agent
   * picks them by id with a tool; the URL always comes from the company's approved list, never the model.
   */
  anexosDaVez?: (ficha: Ficha, pedido: Pedido) => Anexo[];
  /** Extra sources the writer could use and the judge must see too (e.g. knowledge-base passages already read). */
  fontesDoRevisor?: (ficha: Ficha, pedido: Pedido) => string;
  /**
   * Subagent that runs on a silence, before the move: it reads the WHOLE conversation (numbered) and
   * brings the record up to date with its own tools. It only reads; it never writes to the contact.
   */
  analista?: {
    instrucoes: string;
    ferramentas: HarnessTool<Ficha, Pedido, any>[];
    /** Tool rounds before the harness stops asking. Defaults to 4. */
    maxRodadas?: number;
  };
};

/** Why the harness is running now. */
export type HarnessEvent =
  | { tipo: "abertura" }
  | { tipo: "mensagem"; texto: string }
  | { tipo: "silencio"; horasSemResposta: number };

export type TraceStep = {
  fase: "triagem" | "leitura" | "analise" | "jogada" | "escrita" | "revisao" | "envio" | "humano" | "silencio";
  detalhe: unknown;
  ms?: number;
};

/** A file sent with the message, as the send_attachment action of the live engine takes it. */
export type Anexo = { url: string; legenda: string | null; nomeArquivo: string | null; mimeType: string | null };

export type TurnResult<Ficha> = {
  /** Message to send to the contact, already reviewed. Null when nothing is sent. */
  enviar: string | null;
  /** Files sent with the message; only when there is a message. */
  anexos?: Anexo[];
  /** Set when a person must take over, with the reason and a short summary for them. */
  humano: { motivo: string; resumo: string } | null;
  ficha: Ficha;
  jogada: Jogada | null;
  trace: TraceStep[];
};
