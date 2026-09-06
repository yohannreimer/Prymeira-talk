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
  // A qualified handoff must leave a trace even when the model omitted its note.
  // Keep this to the supplied reason; it is not a reconstructed customer brief.
  if (options.preserveReply && !actionsWithoutHandoff.some((action) => action.type === "create_internal_note")) {
    actionsWithoutHandoff.push({
      type: "create_internal_note",
      body: reason === DEFAULT_HANDOFF_REASON
        ? "Repasse solicitado pelo agente; motivo específico não informado."
        : `Motivo do repasse: ${reason}`
    });
  }

  return {
    ...output,
    reply: options.preserveReply && output.reply?.trim()
      ? alignCommittedHandoffReply(output.reply)
      : HANDOFF_ACKNOWLEDGEMENT,
    actions: [
      ...actionsWithoutHandoff,
      { ...(firstAction ?? {}), type: "request_handoff", reason }
    ],
    handoff: { required: true, reason }
  };
}

function alignCommittedHandoffReply(reply: string): string {
  // Only rewrite a final permission question about the transfer already selected.
  // Preserve the preceding explanation and questions requesting customer details.
  return reply.replace(
    /(^|[.!]\s+|\n\s*)(Posso|Podemos)\s+(encaminhar|repassar|transferir|passar|chamar|acionar)\b([^?!.]{0,240})\?\s*$/i,
    (match, prefix: string, permission: string, verb: string, complement: string) => {
      if (complement.trim() && !/\b(vendedor|equipe|time|comercial|atendente|especialista|humano|setor)\b/i.test(complement)) return match;
      return `${prefix}${permission.toLowerCase() === "podemos" ? "Vamos" : "Vou"} ${verb.toLowerCase()}${complement}.`;
    }
  );
}

function normalizeReply(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
