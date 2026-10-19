export function requiresHumanReview(input: {
  delivery: "review" | "automatic" | undefined;
  profileAllowsAutomatic: boolean;
  legacyKindAllowsAutomatic: boolean;
  reviewApproved: boolean;
  risk: "none" | "commercial" | "unclear";
}): boolean {
  return input.delivery !== "automatic" || !input.profileAllowsAutomatic
    || !input.legacyKindAllowsAutomatic || !input.reviewApproved || input.risk !== "none";
}

export function contextualKindAllowsAutomatic(kind: string, pendingKind: string) {
  return kind === "qualification" ? ["technical_detail", "time_choice"].includes(pendingKind)
    : kind === "human_commercial" && ["quote_evaluation", "time_choice"].includes(pendingKind);
}
