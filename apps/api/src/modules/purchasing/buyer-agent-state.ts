import type { PurchaseAgentMode, PurchaseInviteAgentDto } from "@prymeira-talk/shared";
import { fichaInicial } from "../harness/agentes/comprador/ficha.js";
import type { FichaDoFornecedor } from "../harness/agentes/comprador/tipos.js";
import type { Jogada } from "../harness/core/types.js";

/**
 * What the buyer agent keeps per supplier conversation, saved in purchase_quote_invites.ficha. The record (ficha)
 * only changes through the agent's own tools and moves; the rest is the plumbing around it.
 */
export type EstadoDoConvite = {
  ficha: FichaDoFornecedor;
  /** Written and reviewed, waiting for a person to send it (review mode). */
  rascunho: { texto: string; jogada: Jogada; criadoEm: string } | null;
  /** Work queued for the poller: the opening, or a supplier message waiting out the burst window. */
  pendente: { tipo: "abertura" } | { tipo: "mensagem"; desde: string; mensagemId: string } | null;
  /** Messages before this moment belong to an older conversation with the same number and are not read. */
  inicioDaConversa: string | null;
  ultimoEnvio: string | null;
  humano: { motivo: string; resumo: string; em: string } | null;
  erro: string | null;
  /** Lease while a turn runs, so two pollers never answer the same message. */
  ocupadoAte: string | null;
  /** Failed turns in a row; after three the queued work is dropped and the error stays on the card. */
  tentativas: number;
};

export function estadoInicial(): EstadoDoConvite {
  return { ficha: fichaInicial(), rascunho: null, pendente: null, inicioDaConversa: null, ultimoEnvio: null, humano: null, erro: null, ocupadoAte: null, tentativas: 0 };
}

/** The saved state, or a fresh one. Saved records missing newer fields get their defaults. */
export function lerEstado(value: unknown): EstadoDoConvite {
  if (!isObject(value) || !isObject(value.ficha)) return estadoInicial();
  const base = estadoInicial();
  return { ...base, ...(value as Partial<EstadoDoConvite>), ficha: { ...base.ficha, ...(value.ficha as Partial<FichaDoFornecedor>) } };
}

/** The agent settings of a request, kept in negotiation_rules.agente. */
export function modoDoAgente(negotiationRules: unknown): PurchaseAgentMode | null {
  const agente = isObject(negotiationRules) && isObject(negotiationRules.agente) ? negotiationRules.agente : null;
  return agente?.modo === "review" || agente?.modo === "auto" ? agente.modo : null;
}

export function agenteDoConviteDto(value: unknown, mode: PurchaseAgentMode | null): PurchaseInviteAgentDto | null {
  if (!mode) return null;
  const estado = lerEstado(value);
  return {
    stage: estado.ficha.etapa,
    draft: estado.rascunho ? { text: estado.rascunho.texto, move: estado.rascunho.jogada.tipo, createdAt: estado.rascunho.criadoEm } : null,
    needsHuman: estado.humano ? { reason: estado.humano.motivo, summary: estado.humano.resumo, at: estado.humano.em } : null,
    working: Boolean(estado.pendente),
    error: estado.erro
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
