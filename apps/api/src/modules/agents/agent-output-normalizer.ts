import { HANDOFF_ACKNOWLEDGEMENT } from "./agent-safety-policy.js";
import type { AgentOutput } from "./provider-gateway.js";

const DEFAULT_HANDOFF_REASON = "Agent requested consultation.";

// Imported qualification packages use their own contextual handoff wording.
// Legacy/manual agents retain the existing reserved acknowledgement.
export function usesQualificationHandoff(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config) || !("qualification" in config)) return false;
  const qualification = config.qualification;
  return Boolean(qualification && typeof qualification === "object" && !Array.isArray(qualification)
    && "fields" in qualification && Array.isArray(qualification.fields) && qualification.fields.length > 0);
}

export function normalizeAgentHandoffOutput(
  output: AgentOutput,
  options: { preserveReply?: boolean } = {}
): AgentOutput {
  const handoffActions = output.actions.filter((action) => action.type === "request_handoff");
  const acknowledgementUsed = normalizeReply(output.reply) === normalizeReply(HANDOFF_ACKNOWLEDGEMENT);
  const handoffRequired = output.handoff.required || handoffActions.length > 0 || acknowledgementUsed;

  if (!handoffRequired) {
    return output;
  }

  const firstAction = handoffActions[0];
  const actionReason = firstAction && typeof firstAction.reason === "string"
    ? firstAction.reason.trim()
    : "";
  const reason = actionReason || output.handoff.reason?.trim() || DEFAULT_HANDOFF_REASON;
  const actionsWithoutHandoff = output.actions.filter((action) => action.type !== "request_handoff");

  return {
    ...output,
    reply: options.preserveReply && output.reply?.trim() ? output.reply : HANDOFF_ACKNOWLEDGEMENT,
    actions: [
      ...actionsWithoutHandoff,
      { ...(firstAction ?? {}), type: "request_handoff", reason }
    ],
    handoff: { required: true, reason }
  };
}

function normalizeReply(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
