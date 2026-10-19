import { z } from "zod";

export const followupProfileSchema = z.enum(["attendance", "commercial", "prospecting"]);
export type FollowupProfile = z.infer<typeof followupProfileSchema>;

const nonemptyText = z.string().trim().min(1);

export const contextualFollowupConfigSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  profile: followupProfileSchema,
  channels: z.array(nonemptyText).min(1)
});
export type ContextualFollowupConfig = z.infer<typeof contextualFollowupConfigSchema>;

/** Persist on each adopted sequence; policyRevision is a hash, never the rules themselves. */
export const contextualFollowupEngineSchema = z.strictObject({
  version: z.literal(1),
  profile: followupProfileSchema,
  policyRevision: nonemptyText
});
export type ContextualFollowupEngine = z.infer<typeof contextualFollowupEngineSchema>;

/** Evidence existence, author and supporting excerpt require domain validation. */
const evidenceMessageIds = z.array(nonemptyText).min(1);
export const contextualFollowupDecisionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("customer_message"), body: nonemptyText, evidenceMessageIds }),
  z.strictObject({ type: z.literal("seller_reminder"), summary: nonemptyText, evidenceMessageIds }),
  z.strictObject({
    type: z.literal("skip"),
    reason: z.enum(["closed", "no_pending", "non_customer", "customer_timing"])
  }),
  z.strictObject({
    type: z.literal("unavailable"),
    reason: z.enum(["context_limit", "invalid_evidence", "analysis_failed", "empty_message", "review_failed", "policy_changed"])
  })
]);
export type ContextualFollowupDecision = z.infer<typeof contextualFollowupDecisionSchema>;

export type ContextualFollowupSelection =
  | { status: "legacy" | "invalid" | "disabled" | "channel_not_enabled" }
  | { status: "enabled"; config: ContextualFollowupConfig };

/**
 * Select NEW sequence adoption only. Already marked sequences must retain their
 * versioned handler even when the flag is disabled or removed. Agent names and
 * inbound-agent harness settings never select a follow-up profile.
 */
export function selectContextualFollowupConfig(input: {
  behaviorConfig: unknown;
  channelId: string | null | undefined;
}): ContextualFollowupSelection {
  const behavior = isRecord(input.behaviorConfig) ? input.behaviorConfig : null;
  if (!behavior || behavior.contextualFollowup === undefined) return { status: "legacy" };
  const parsed = contextualFollowupConfigSchema.safeParse(behavior.contextualFollowup);
  if (!parsed.success) return { status: "invalid" };
  if (!parsed.data.enabled) return { status: "disabled" };
  if (!input.channelId || !parsed.data.channels.includes(input.channelId)) return { status: "channel_not_enabled" };
  return { status: "enabled", config: parsed.data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
