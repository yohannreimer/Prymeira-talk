import type { ContextualFollowupContext } from "../../../followups/contextual-followup-context.js";
import { validateFollowupAnalysis } from "./ferramentas.js";
import type { FollowupFicha, FollowupMove } from "./tipos.js";

/** No I/O, scheduling or mutation. Count only canonical sent rows across the whole sequence. */
export function decideContextualFollowup(input: { ficha: FollowupFicha; context: ContextualFollowupContext; maxAttempts: number }): FollowupMove {
  const { ficha, context, maxAttempts } = input;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) return { type: "unavailable", reason: "policy_changed" };
  if (ficha?.contextualFollowup?.version !== 1 || !ficha.contextualFollowup.analysis) return { type: "unavailable", reason: "analysis_failed" };
  let analysis;
  try { analysis = validateFollowupAnalysis(context, ficha.contextualFollowup.analysis); }
  catch { return { type: "unavailable", reason: "invalid_evidence" }; }
  if (!["customer", "unknown"].includes(analysis.contact.role)) return { type: "skip", reason: "non_customer" };
  const index = (id: string) => context.messages.findIndex(message => message.id === id);
  const unresolved = analysis.pendingItems.filter(item => !analysis.resolutions.some(resolution => resolution.pendingId === item.id))
    .sort((left, right) => index(right.evidence.messageId) - index(left.evidence.messageId));
  const pending = unresolved[0];
  if (analysis.closure && (analysis.closure.kind === "refusal" || !pending || index(analysis.closure.evidence.messageId) >= index(pending.evidence.messageId))) {
    return { type: "skip", reason: "closed" };
  }
  if (!pending) return { type: "skip", reason: "no_pending" };
  if (analysis.customerTiming && Date.parse(context.now) < Date.parse(analysis.customerTiming.notBefore)) return { type: "skip", reason: "customer_timing" };
  const evidenceMessageIds = [...new Set([pending.evidence.messageId, pending.engagement.messageId])];
  if (pending.owner === "company") return { type: "seller_reminder", summary: pending.subject, evidenceMessageIds };
  if (pending.kind === "time_choice" && context.profile.meeting.recordedBookings.length) return { type: "skip", reason: "closed" };
  if (context.sentAttempts.length >= maxAttempts) return { type: "skip", reason: "max_attempts" };
  return { type: "customer_message", pendingItem: pending, evidenceMessageIds };
}
