/** One prospecting campaign as the agent sees it: who we are, what we offer, the goal, and the lead. */
export type CampanhaDeProspeccao = {
  nossaEmpresa: { nome: string; oQueFazemos: string };
  /** What counts as success, e.g. "marcar uma call de 15 minutos". */
  objetivo: string;
  /** Approved facts about the offer the agent may say (plans, how it works, a concrete example). */
  contextoDaOferta: string;
  /** A concrete pain example the agent can connect to what the lead says. */
  exemploDeDor?: string;
  lead: { empresa: string; nomeContato: string | null };
  /** Follow-ups after the lead went quiet, only if the lead ever replied. */
  maxRetomadas: number;
};

export type PapelDoContato = "decisor" | "nao_decisor" | "desconhecido";
export type Interesse = "desconhecido" | "curioso" | "interessado" | "sem_interesse";

/** The record of one prospecting conversation. It carries what was said so nothing is asked twice. */
export type FichaDoLead = {
  etapa: "abordado" | "conversando" | "objetivo_aceito" | "encerrado";
  contato: { nome: string | null; papel: PapelDoContato; ehRobo: boolean };
  /** The lead ever wrote as a person (a robot does not count). Follow-ups only after that. */
  respondeu: boolean;
  interesse: Interesse;
  dor: string | null;
  objecao: { texto: string; tratada: boolean } | null;
  /** Questions of the lead not answered yet. */
  perguntasDoLead: string[];
  /** Someone else to talk to (the owner, the buyer). */
  indicado: { nome: string; contato: string | null } | null;
  /** What the lead agreed to (time of the call, "pode me ligar"). */
  aceite: string | null;
  /** How many times the goal was proposed, so it is not pushed on every message. */
  propostasDoObjetivo: number;
  retomadas: number;
};
