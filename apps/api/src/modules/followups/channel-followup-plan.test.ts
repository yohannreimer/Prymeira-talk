import { describe, expect, it } from "vitest";
import { calculateFollowupDueAt, DEFAULT_CHANNEL_FOLLOWUP_CONFIG, resolveFollowupPlan } from "./channel-followup-plan.js";

describe("channel follow-up cadence", () => {
  it("uses the selected number's intervals instead of the agent's fixed package cadence", () => {
    const plan = resolveFollowupPlan({ followup: {
      timeZone: "America/Sao_Paulo", businessDays: [1, 2, 3, 4, 5],
      businessHours: { start: "08:00", end: "18:00" },
      steps: [{ afterBusinessMinutes: 360, instruction: "Antiga." }], closeAfterBusinessMinutes: 0
    } }, DEFAULT_CHANNEL_FOLLOWUP_CONFIG);
    expect(plan?.mode).toBe("elapsed_between_steps");
    expect(plan?.steps.map((step) => step.afterMinutes)).toEqual([20, 40, 60, 360, 1440, 4320]);
    expect(plan?.humanCommercialDelivery).toBe("review");
  });

  it("counts elapsed time and defers a Saturday due time to Monday opening", () => {
    const plan = resolveFollowupPlan({}, DEFAULT_CHANNEL_FOLLOWUP_CONFIG);
    expect(plan).not.toBeNull();
    // Friday 25 Sep 2026, 12:00 in Sao Paulo. +24h lands Saturday.
    expect(calculateFollowupDueAt(new Date("2026-09-25T15:00:00.000Z"), 1440, plan!).toISOString())
      .toBe("2026-09-28T11:00:00.000Z");
  });

  it("keeps a short interval inside business hours unchanged", () => {
    const plan = resolveFollowupPlan({}, DEFAULT_CHANNEL_FOLLOWUP_CONFIG);
    expect(calculateFollowupDueAt(new Date("2026-09-25T16:00:00.000Z"), 20, plan!).toISOString())
      .toBe("2026-09-25T16:20:00.000Z");
  });

  it("pauses the entire channel cadence without removing the configured steps", () => {
    const paused = { ...DEFAULT_CHANNEL_FOLLOWUP_CONFIG, enabled: false };
    expect(paused.steps).toHaveLength(6);
    expect(resolveFollowupPlan({}, paused)).toBeNull();
    expect(resolveFollowupPlan({}, { ...paused, enabled: true })?.steps).toHaveLength(6);
  });
});
