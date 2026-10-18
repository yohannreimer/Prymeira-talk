import type { MeetingAvailability } from "../../../agents/meeting-scheduler.js";

/** No company defaults: each agent supplies its own identity, approved sources and process. */
export type ContextoComercial = {
  empresa: string;
  instrucoes: string;
  fontes: Array<{ id: string; title: string; content: string | null }>;
  agenda: MeetingAvailability | null;
};

export type FichaComercial = {
  empresaDoContato: string | null;
  rotina: string | null;
  intencao: "conhecer" | "duvida" | "agendar" | "recusar" | "humano";
  assunto: string | null;
  horario: string | null;
  turnos: number;
  convites: number;
  encerrada: boolean;
};

export const fichaInicial = (): FichaComercial => ({
  empresaDoContato: null, rotina: null, intencao: "conhecer", assunto: null,
  horario: null, turnos: 0, convites: 0, encerrada: false
});
