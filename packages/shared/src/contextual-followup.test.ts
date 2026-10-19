import { describe, expect, it } from "vitest";
import {
  contextualFollowupConfigSchema,
  contextualFollowupDecisionSchema,
  contextualFollowupEngineSchema,
  selectContextualFollowupConfig
} from "./contextual-followup.js";

const config = { version: 1, enabled: true, profile: "commercial", channels: ["synthetic_channel"] };
const select = (behaviorConfig: unknown, channelId: string | null | undefined = "synthetic_channel") =>
  selectContextualFollowupConfig({ behaviorConfig, channelId });

describe("contextual follow-up adoption", () => {
  it.each([undefined, null, {}, { followup: { steps: [] } }])("keeps the legacy engine when the option is absent: %j", (behavior) => {
    expect(select(behavior)).toEqual({ status: "legacy" });
  });
  it("does not adopt new sequences when disabled", () => {
    expect(select({ contextualFollowup: { ...config, enabled: false } })).toEqual({ status: "disabled" });
  });
  it.each([
    { ...config, version: 2 }, { ...config, profile: "sales" }, { ...config, channels: [] },
    { ...config, channels: [" "] }, { ...config, enabled: "true" }, null
  ])("rejects invalid configuration without falling back to legacy: %j", (value) => {
    expect(contextualFollowupConfigSchema.safeParse(value).success).toBe(false);
    expect(select({ contextualFollowup: value })).toEqual({ status: "invalid" });
  });
  it.each(["other_channel", "SYNTHETIC_CHANNEL", "*", null, undefined])("does not adopt an unlisted channel: %j", (channelId) => {
    expect(selectContextualFollowupConfig({ behaviorConfig: { contextualFollowup: config }, channelId }))
      .toEqual({ status: "channel_not_enabled" });
  });
  it("adopts exactly the explicit profile and channel", () => {
    expect(select({ contextualFollowup: config })).toEqual({ status: "enabled", config });
  });
  it("never infers a profile from agent names or the inbound harness", () => {
    expect(select({ name: "Maria Comercial", harness: { profile: "commercial", channels: config.channels } }))
      .toEqual({ status: "legacy" });
    expect(select({ name: "João Prospecção", contextualFollowup: { ...config, profile: "attendance" } }))
      .toMatchObject({ status: "enabled", config: { profile: "attendance" } });
    const { profile: _, ...withoutProfile } = config;
    expect(select({ name: "Maria Comercial", contextualFollowup: withoutProfile })).toEqual({ status: "invalid" });
  });
  it("requires an explicit version, profile and policy revision in the persisted marker", () => {
    expect(contextualFollowupEngineSchema.parse({ version: 1, profile: "prospecting", policyRevision: "hash_v1" }))
      .toEqual({ version: 1, profile: "prospecting", policyRevision: "hash_v1" });
    expect(contextualFollowupEngineSchema.safeParse({ version: 2, profile: "commercial", policyRevision: "hash_v1" }).success).toBe(false);
    expect(contextualFollowupEngineSchema.safeParse({ version: 1, profile: "commercial", policyRevision: " " }).success).toBe(false);
  });
});

describe("contextual follow-up decisions", () => {
  it.each([
    { type: "customer_message", body: "  Conseguiu escolher o horário?  ", evidenceMessageIds: ["message_1"] },
    { type: "seller_reminder", summary: "  Preparar o orçamento solicitado.  ", evidenceMessageIds: ["message_1"] }
  ])("trims nonempty message and reminder text: $type", (decision) => {
    const parsed = contextualFollowupDecisionSchema.parse(decision);
    expect(parsed).toEqual({ ...decision, ...(typeof decision.body === "string" ? { body: decision.body.trim() } : { summary: decision.summary!.trim() }) });
  });
  it.each([
    { type: "customer_message", body: " " , evidenceMessageIds: ["message_1"] },
    { type: "seller_reminder", summary: "\n", evidenceMessageIds: ["message_1"] },
    { type: "customer_message", body: "Pergunta", evidenceMessageIds: [] },
    { type: "seller_reminder", summary: "Lembrete", evidenceMessageIds: [] },
    { type: "customer_message", body: "Pergunta", evidenceMessageIds: [" "] },
    { type: "seller_reminder", summary: "Lembrete" }
  ])("rejects empty text or missing evidence: %j", (decision) => {
    expect(contextualFollowupDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it.each(["closed", "no_pending", "non_customer", "customer_timing"])("accepts skip reason %s", (reason) => {
    expect(contextualFollowupDecisionSchema.parse({ type: "skip", reason })).toEqual({ type: "skip", reason });
  });
  it.each(["context_limit", "invalid_evidence", "analysis_failed", "empty_message", "review_failed", "policy_changed"])("accepts unavailable reason %s", (reason) => {
    expect(contextualFollowupDecisionSchema.parse({ type: "unavailable", reason })).toEqual({ type: "unavailable", reason });
  });
  it.each([
    { type: "skip", reason: "unknown" }, { type: "unavailable", reason: "unknown" },
    { type: "schedule_event", scheduledAt: "2026-10-21T15:00:00.000Z" },
    { type: "customer_message", body: "Pergunta", evidenceMessageIds: ["message_1"], scheduledAt: "2026-10-21T15:00:00.000Z" },
    { type: "seller_reminder", summary: "Lembrete", evidenceMessageIds: ["message_1"], action: "send_external" },
    { type: "skip", reason: "closed", actions: [] }
  ])("rejects arbitrary actions, schedules and unknown reasons: %j", (decision) => {
    expect(contextualFollowupDecisionSchema.safeParse(decision).success).toBe(false);
  });
});
