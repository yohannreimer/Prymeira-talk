import { z } from "zod";
import type { ContextualFollowupContext } from "../../../followups/contextual-followup-context.js";

export const messageEvidenceSchema = z.strictObject({
  messageId: z.string().trim().min(1),
  author: z.enum(["cliente", "atendente", "nota interna", "sistema"]),
  excerpt: z.string().trim().min(2).max(2000)
});
export const factualEvidenceSchema = z.strictObject({ sourceId: z.string().trim().min(1), excerpt: z.string().trim().min(2).max(4000) });
export const pendingItemSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  owner: z.enum(["customer", "company"]),
  kind: z.enum(["time_choice", "technical_detail", "quote_evaluation", "quote", "answer", "referral", "other"]),
  subject: z.string().trim().min(2).max(300),
  evidence: messageEvidenceSchema,
  engagement: messageEvidenceSchema,
  factualEvidence: z.array(factualEvidenceSchema).max(30)
});
/** Structured observations only: no prompts, reasoning, actions or send schedule. */
export const followupAnalysisSchema = z.strictObject({
  contact: z.strictObject({ role: z.enum(["customer", "unknown", "personal", "colleague", "supplier", "carrier"]), evidence: messageEvidenceSchema.nullable() }),
  closure: z.strictObject({ kind: z.enum(["closed", "refusal"]), evidence: messageEvidenceSchema }).nullable(),
  customerTiming: z.strictObject({ notBefore: z.string().datetime({ offset: true }), evidence: messageEvidenceSchema }).nullable(),
  pendingItems: z.array(pendingItemSchema).max(100),
  resolutions: z.array(z.strictObject({ pendingId: z.string().min(1), evidence: messageEvidenceSchema })).max(100)
});
export type MessageEvidence = z.infer<typeof messageEvidenceSchema>;
export type FollowupAnalysis = z.infer<typeof followupAnalysisSchema>;
export type PendingItem = z.infer<typeof pendingItemSchema>;
export type FollowupFicha = {
  contextualFollowup: {
    version: 1;
    analysis: FollowupAnalysis | null;
    sentAttempts: ContextualFollowupContext["sentAttempts"];
  };
};
/** Intentionally contains only the safe Task2 context, never its policyInputs. */
export type FollowupPedido = { context: ContextualFollowupContext };
export type FollowupMove =
  | { type: "customer_message"; pendingItem: PendingItem; evidenceMessageIds: string[] }
  | { type: "seller_reminder"; summary: string; evidenceMessageIds: string[] }
  | { type: "skip"; reason: "closed" | "no_pending" | "non_customer" | "customer_timing" | "max_attempts" }
  | { type: "unavailable"; reason: "analysis_failed" | "invalid_evidence" | "policy_changed" };

export function createFollowupFicha(context: ContextualFollowupContext): FollowupFicha {
  return { contextualFollowup: { version: 1, analysis: null, sentAttempts: context.sentAttempts.map(attempt => ({ ...attempt })) } };
}
