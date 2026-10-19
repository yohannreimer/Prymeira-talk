import { contextualFollowupEngineSchema, selectContextualFollowupConfig, type ContextualFollowupEngine } from "@prymeira-talk/shared";
import { asRecord } from "../prospecting/prospecting-policy.js";

/** Existing rows use their marker only; enabling adoption never migrates an old row. */
export function resolveContextualFollowupEngine(input: { decision?: unknown; behaviorConfig?: unknown; channelId?: string; newSequence?: boolean }):
  { status: "contextual"; engine: ContextualFollowupEngine } | { status: "legacy" | "contained" } {
  const decision = asRecord(input.decision);
  if (Object.hasOwn(decision, "contextualEngine")) {
    const parsed = contextualFollowupEngineSchema.safeParse(decision.contextualEngine);
    return parsed.success ? { status: "contextual", engine: parsed.data } : { status: "contained" };
  }
  if (!input.newSequence) return { status: "legacy" };
  const selection = selectContextualFollowupConfig({ behaviorConfig: input.behaviorConfig, channelId: input.channelId ?? "" });
  if (selection.status === "invalid") return { status: "contained" };
  return selection.status === "enabled"
    ? { status: "contextual", engine: { version: 1, profile: selection.config.profile, policyRevision: "pending_snapshot" } }
    : { status: "legacy" };
}

export function contextualSequenceIds(decision: unknown): string[] {
  const ids = asRecord(decision).sequenceFollowupIds;
  return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string"))] : [];
}
