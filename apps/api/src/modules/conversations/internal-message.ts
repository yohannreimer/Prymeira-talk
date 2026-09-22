export const followupReservationExclusion = {
  NOT: {
    status: "pending",
    metadata: { path: ["source"], equals: "followup_review" }
  }
} as const;

export function visibleConversationMessageWhere<T extends Record<string, unknown>>(where: T) {
  return { ...where, ...followupReservationExclusion };
}

export function isInternalFollowupReservation(message: { status?: string | null; metadata?: unknown }) {
  if (message.status !== "pending") return false;
  const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : null;
  return metadata?.source === "followup_review" && typeof metadata.followupId === "string";
}

export function withoutInternalFollowupReservations<T extends { status?: string | null; metadata?: unknown }>(messages: T[]) {
  return messages.filter((message) => !isInternalFollowupReservation(message));
}
