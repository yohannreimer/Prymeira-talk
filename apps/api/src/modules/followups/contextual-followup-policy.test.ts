import { expect, it } from "vitest";
import { requiresHumanReview } from "./contextual-followup-policy.js";
it.each(["attendance", "commercial", "prospecting"])("%s cannot bypass channel review", () => {
  expect(requiresHumanReview({ delivery: "review", profileAllowsAutomatic: true, legacyKindAllowsAutomatic: true, reviewApproved: true, risk: "none" })).toBe(true);
});
it("requires every independent automatic gate", () => {
  const allowed = { delivery: "automatic" as const, profileAllowsAutomatic: true, legacyKindAllowsAutomatic: true, reviewApproved: true, risk: "none" as const };
  expect(requiresHumanReview(allowed)).toBe(false);
  for (const change of [{ delivery: undefined }, { profileAllowsAutomatic: false }, { legacyKindAllowsAutomatic: false }, { reviewApproved: false }, { risk: "unclear" as const }, { risk: "commercial" as const }]) expect(requiresHumanReview({ ...allowed, ...change })).toBe(true);
});
