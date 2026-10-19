import type { ContextualFollowupContext } from "../../../followups/contextual-followup-context.js";
import type { HarnessTool } from "../../core/types.js";
import { createFollowupFicha, followupAnalysisSchema, type FollowupAnalysis, type FollowupFicha, type FollowupPedido, type MessageEvidence } from "./tipos.js";

/** Preserve punctuation, negation and numbers; normalize only Unicode/case/spacing. */
export const normalizeEvidence = (text: string) => text.normalize("NFC").toLocaleLowerCase("pt-BR").replace(/\s+/gu, " ").trim();

export function validateMessageEvidence(context: ContextualFollowupContext, evidence: MessageEvidence): number {
  const index = context.messages.findIndex(message => message.id === evidence.messageId);
  const message = context.messages[index];
  if (!message || message.label !== evidence.author) throw new Error("Message evidence does not exist or has the wrong author");
  const excerpt = normalizeEvidence(evidence.excerpt);
  if (!excerpt || !normalizeEvidence(message.body ?? "").includes(excerpt)) throw new Error("Message excerpt is not present verbatim");
  return index;
}

/** Schema parsing alone is never evidence validation. Re-run against this fresh canonical context. */
export function validateFollowupAnalysis(context: ContextualFollowupContext, value: unknown): FollowupAnalysis {
  const analysis = followupAnalysisSchema.parse(value);
  const evidence = (proof: MessageEvidence) => validateMessageEvidence(context, proof);
  const engaged = (proof: MessageEvidence) => {
    const index = evidence(proof);
    if (proof.author !== "cliente" && !(proof.author === "sistema" && context.profile.formEvidenceMessageIds.includes(proof.messageId))) {
      throw new Error("Engagement requires customer evidence or persisted form provenance");
    }
    return index;
  };
  if (analysis.contact.role !== "unknown" && !analysis.contact.evidence) throw new Error("Contact role requires evidence");
  if (analysis.contact.evidence) {
    evidence(analysis.contact.evidence);
    if (analysis.contact.role === "customer") engaged(analysis.contact.evidence);
    else if (analysis.contact.evidence.author !== "cliente") throw new Error("Non-customer role requires customer-authored evidence");
  }
  if (analysis.closure) {
    evidence(analysis.closure.evidence);
    if (analysis.closure.kind === "refusal" && analysis.closure.evidence.author !== "cliente") throw new Error("Refusal requires customer evidence");
    if (!["cliente", "atendente"].includes(analysis.closure.evidence.author)) throw new Error("Closure requires conversation evidence");
  }
  if (analysis.customerTiming) {
    evidence(analysis.customerTiming.evidence);
    if (analysis.customerTiming.evidence.author !== "cliente") throw new Error("Timing requires customer evidence");
  }
  const ids = new Set<string>();
  for (const pending of analysis.pendingItems) {
    if (ids.has(pending.id)) throw new Error("Duplicate pending ID");
    ids.add(pending.id);
    const opened = evidence(pending.evidence);
    if (!["cliente", "atendente", "sistema"].includes(pending.evidence.author)) throw new Error("Pending item requires conversation or form evidence");
    if (pending.evidence.author === "sistema" && !context.profile.formEvidenceMessageIds.includes(pending.evidence.messageId)) throw new Error("Unproven form origin");
    if (engaged(pending.engagement) > opened) throw new Error("Engagement cannot postdate the pending item");
    if (["quote", "answer", "referral"].includes(pending.kind) && pending.owner !== "company") throw new Error("Company obligations cannot be charged to the customer");
    if (pending.kind === "referral" && pending.evidence.author !== "cliente") throw new Error("Referral requires customer evidence");
    for (const proof of pending.factualEvidence) {
      const source = context.factualSources.find(item => item.id === proof.sourceId);
      if (!source || !context.profile.factualSourceIds.includes(proof.sourceId)
        || !normalizeEvidence(source.content ?? "").includes(normalizeEvidence(proof.excerpt))) {
        throw new Error("Fact requires an approved factual source and exact excerpt");
      }
    }
  }
  for (const resolution of analysis.resolutions) {
    const pending = analysis.pendingItems.find(item => item.id === resolution.pendingId);
    if (!pending) throw new Error("Resolution references an unknown pending item");
    if (evidence(resolution.evidence) <= evidence(pending.evidence)) throw new Error("Resolution must follow the pending item");
    if (!["cliente", "atendente"].includes(resolution.evidence.author)) throw new Error("Resolution requires conversation evidence");
  }
  return analysis;
}

export const registrarAnaliseFollowup: HarnessTool<FollowupFicha, FollowupPedido, FollowupAnalysis> = {
  name: "registrar_analise_followup",
  description: "Registra a análise completa desta conversa, com IDs reais, autores e trechos exatos. Inclua todas as pendências e resoluções em ordem histórica. Não escolha ações externas, perfil, horário de envio ou número de tentativas.",
  // Zod's JSON schema keeps this single strict observation contract consistent for every provider.
  parameters: followupAnalysisSchema.toJSONSchema(),
  schema: followupAnalysisSchema,
  execute(args, { pedido, setFicha }) {
    const analysis = validateFollowupAnalysis(pedido.context, args);
    setFicha({ contextualFollowup: { ...createFollowupFicha(pedido.context).contextualFollowup, analysis } });
    return "Análise estruturada registrada com evidências validadas. A decisão será feita pelo código.";
  }
};
export const ferramentasDoAnalistaFollowup = [registrarAnaliseFollowup];
