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
