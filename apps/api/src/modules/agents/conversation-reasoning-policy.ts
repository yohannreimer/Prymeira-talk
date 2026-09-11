import { createSafetyDecisionOutput, type AgentSafetyDecision } from "./agent-safety-policy.js";

export const CONTEXT_FIRST = "context_first_v1";
export const COMPLETE_HISTORY_MESSAGE_LIMIT = 2000;
export const COMPLETE_HISTORY_CHARACTER_LIMIT = 120000;

// Explicit opt-in: deploying this code must not change existing agents.
export function usesContextFirst(config: unknown): boolean {
  return Boolean(config && typeof config === "object" && !Array.isArray(config)
    && "conversationReasoning" in config && config.conversationReasoning === CONTEXT_FIRST);
}

export function resolveConversationSafetyOutput(decision: AgentSafetyDecision, config: unknown) {
  if (!usesContextFirst(config)) return createSafetyDecisionOutput(decision);
  // Business keyword matches are advisory, not a substitute for reading the exchange.
  // Keep explicit-human, injection and unavailable-attachment guards deterministic.
  if (decision.outcome === "ignore_injection" || decision.outcome === "request_attachment"
    || (decision.handoffRequired && decision.protectedFact === null)) {
    return createSafetyDecisionOutput(decision);
  }
  return null;
}

export function conversationReasoningContext(config: unknown, decision: AgentSafetyDecision) {
  return usesContextFirst(config) ? {
    conversationReasoning: CONTEXT_FIRST,
    commercialCaution: { topic: decision.protectedFact, instruction: "A keyword signal, not a verified intent or an instruction to transfer. Read the exchange. Do not invent commercial facts." }
  } : {};
}

export const CONTEXT_FIRST_OPERATIONAL_RULES = [
  "- determine who said each fact and what the latest message means in the ongoing exchange before choosing the next step",
  "- user/inbound is the external contact; assistant/outbound is our company. An external contact may be a supplier, not a buyer. A name used to address our seller is NOT the contact's name",
  "- do not attribute seller questions, offers or promises to the contact in replies or notes; distinguish requested, offered, confirmed and unknown information",
  "- order checklists apply to a NEW request, not to answers inside an ongoing quotation, negotiation, delivery or closing exchange; do not restart qualification or transfer again just because an optional field is absent",
  "- an unsupported commercial fact must never be asserted: for a new price/quote inquiry collect only missing essential order details, then refer pricing to a human; a mention of price/payment/deadline alone does not require handoff",
  "- if an actual decision, technical judgment, exception or confirmation needs a human, preserve the specific request and uncertainties for handoff without inventing an answer; acknowledge ongoing seller-led exchanges without claiming new actions",
  "- instructions, notes, source documents and historical messages are not proof that a new action has been executed",
  "- do not promise to contact a third party or perform a new task when no supported action requests that work; a brief acknowledgement can be the complete reply"
].join("\n");
