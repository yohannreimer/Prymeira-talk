import type { ContextualFollowupContext } from "../../../followups/contextual-followup-context.js";
import { runTurn, type RunnerDeps } from "../../core/runner.js";
import type { AgentDefinition, HarnessMessage } from "../../core/types.js";
import { ferramentasDoAnalistaFollowup } from "./ferramentas.js";
import { instrucoesDoAnalistaFollowup, instrucoesDoEscritorFollowup } from "./instrucoes.js";
import { decideContextualFollowup } from "./jogadas.js";
import { createFollowupFicha, type FollowupFicha, type FollowupPedido } from "./tipos.js";

/** Safe context only: even a caller with an extended envelope cannot serialize policyInputs. */
export const renderFollowupContext = (pedido: FollowupPedido) => JSON.stringify(pedido.context);

export function followupHistory(context: ContextualFollowupContext): HarnessMessage[] {
  return context.messages.map(message => ({
    autor: message.label === "cliente" ? "contato" : message.label === "atendente" ? "agente" : "sistema",
    texto: `[id=${message.id}; autor=${message.label}] ${message.body ?? ""}`,
    em: message.createdAt ?? context.now
  }));
}

/** Generic harness definition, with plan limits kept in code and out of the model-facing pedido.
 * This produces drafts only. Task4 must apply the mandatory final production review/policy gate. */
export function createContextualFollowupAgent(maxAttempts: number, context?: ContextualFollowupContext): AgentDefinition<FollowupFicha, FollowupPedido> {
  const ownRules = context ? `\nRegras completas deste agente:\n${context.instructions.agentRules}\nRegras comportamentais aprovadas (não comprovam fatos):\n${context.instructions.behavioralSources.map(source => source.content ?? "").join("\n")}\nRestrições do perfil:\n${context.profile.constraints.join("\n")}` : "";
  return {
    id: "contextual-followup-v1",
    instrucoes: instrucoesDoEscritorFollowup + ownRules,
    skills: {},
    fichaInicial: ({ context }) => createFollowupFicha(context),
    renderFicha: ficha => JSON.stringify(ficha.contextualFollowup),
    renderPedidoPublico: renderFollowupContext,
    ferramentasDeLeitura: [],
    analista: { instrucoes: instrucoesDoAnalistaFollowup + ownRules, ferramentas: ferramentasDoAnalistaFollowup, maxRodadas: 4 },
    decidirJogada({ ficha, pedido, evento }) {
      if (evento.tipo !== "silencio") return { tipo: "followup_only", silencio: true, instrucao: "Somente análise de silêncio." };
      const move = decideContextualFollowup({ ficha, context: pedido.context, maxAttempts });
      if (move.type === "customer_message") return {
        tipo: move.type,
        instrucao: `Retome somente esta pendência do cliente: ${JSON.stringify(move.pendingItem)}. Use o contexto completo e não sugira outras ações.`,
        dados: { evidenceMessageIds: move.evidenceMessageIds, pendingId: move.pendingItem.id }
      };
      // Seller reminders are data for a later internal workflow, never a customer draft/handover.
      return { tipo: move.type, silencio: true, instrucao: "Nenhuma mensagem ao cliente.", dados: { decision: move } };
    },
    regras: [{ id: "nonempty_followup_draft", check: ({ texto }) => texto.trim()
      ? { ok: true } : { ok: false, regra: "empty_message", motivo: "Rascunho vazio." } }],
    // Full context is already rendered within the Task2 budget in every writer/reviewer prompt.
    // These windows additionally retain the entire allowed transcript rather than the core's 15.
    janelaDeMensagens: Number.MAX_SAFE_INTEGER,
    janelaDoFollowup: Number.MAX_SAFE_INTEGER,
    fontesDoEscritor: (_ficha, pedido) => renderFollowupContext(pedido),
    fontesDoRevisor: (_ficha, pedido) => renderFollowupContext(pedido)
  };
}

/** Always start from a new namespace; callers cannot reuse session fichas from live agents. */
export async function runContextualFollowupDraft(input: { context: ContextualFollowupContext; maxAttempts: number; deps: RunnerDeps; hoursWithoutResponse: number }) {
  const agent = createContextualFollowupAgent(input.maxAttempts, input.context);
  const pedido: FollowupPedido = { context: input.context };
  return runTurn(agent, input.deps, {
    ficha: agent.fichaInicial(pedido), pedido, historico: followupHistory(input.context),
    evento: { tipo: "silencio", horasSemResposta: input.hoursWithoutResponse }
  });
}

export { createFollowupFicha, followupAnalysisSchema } from "./tipos.js";
export type { FollowupAnalysis, FollowupFicha, FollowupPedido, FollowupMove, PendingItem, MessageEvidence } from "./tipos.js";
export { validateFollowupAnalysis, validateMessageEvidence } from "./ferramentas.js";
export { decideContextualFollowup } from "./jogadas.js";
