import { expect, it } from "vitest";
import { resolveContextualFollowupEngine } from "./contextual-followup-engine.js";
import { calculateFollowupDueAt, resolveFollowupPlan } from "./channel-followup-plan.js";
import { contextualPolicyRevision } from "./contextual-followup-snapshot.js";
import type { ContextualFollowupPolicyInputs } from "./contextual-followup-context.js";
const behaviorConfig = { contextualFollowup: { version: 1, enabled: true, profile: "commercial", channels: ["c"] } };
it("new adoption never migrates old rows and an existing marker survives flag rollback/removal", () => {
  expect(resolveContextualFollowupEngine({ behaviorConfig, channelId: "c" }).status).toBe("legacy");
  expect(resolveContextualFollowupEngine({ behaviorConfig, channelId: "c", newSequence: true }).status).toBe("contextual");
  const decision = { contextualEngine: { version: 1, profile: "commercial", policyRevision: "hash" } };
  expect(resolveContextualFollowupEngine({ decision }).status).toBe("contextual");
  expect(resolveContextualFollowupEngine({ decision, behaviorConfig: { contextualFollowup: { ...behaviorConfig.contextualFollowup, enabled: false } } }).status).toBe("contextual");
  expect(resolveContextualFollowupEngine({ decision: { contextualEngine: { version: 99 } }, behaviorConfig, channelId: "c" }).status).toBe("contained");
});
it("keeps the Prymeira elapsed intervals and advances a Saturday result to Monday at 09h", () => {
  const plan = resolveFollowupPlan({}, { enabled: true, timeZone: "America/Sao_Paulo", businessDays: [1, 2, 3, 4, 5], businessHours: { start: "09:00", end: "18:00" }, steps: [120, 1440, 2880, 5760].map(afterMinutes => ({ afterMinutes })), humanCommercialDelivery: "review" })!;
  expect(plan.steps).toHaveLength(4);
  expect(calculateFollowupDueAt(new Date("2026-10-19T15:38Z"), plan.steps[0]!.afterMinutes, plan).toISOString()).toBe("2026-10-19T17:38:00.000Z");
  expect(calculateFollowupDueAt(new Date("2026-10-23T15:38Z"), plan.steps[1]!.afterMinutes, plan).toISOString()).toBe("2026-10-26T12:00:00.000Z");
});
it("hashes semantic rules deterministically while excluding only the adoption switch and source timestamps", () => {
  const inputs = { version: 1, profile: "commercial", stepInstruction: "Retome", agent: { systemPrompt: "x".repeat(4100) + "TAIL", behaviorConfig }, channel: { id: "c" }, conversation: { aiControlUpdatedAt: null }, session: null, reservation: null, workspaceAuthorization: {}, approvedSources: [] } as unknown as ContextualFollowupPolicyInputs;
  const first = contextualPolicyRevision(inputs, { steps: [120] }, {});
  const disabled = structuredClone(inputs); (disabled.agent.behaviorConfig as any).contextualFollowup.enabled = false;
  expect(contextualPolicyRevision(disabled, { steps: [120] }, {})).toBe(first);
  disabled.agent.systemPrompt = String(disabled.agent.systemPrompt) + "changed";
  expect(contextualPolicyRevision(disabled, { steps: [120] }, {})).not.toBe(first);
  expect(contextualPolicyRevision({ ...inputs, conversation: { aiControlUpdatedAt: "2026-10-19T12:00Z" } }, { steps: [120] }, {})).not.toBe(first);
});
