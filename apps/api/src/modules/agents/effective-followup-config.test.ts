import { describe, expect, it } from "vitest";
import { resolveEffectiveFollowupConfig, VILLEFER_V1_PACKAGE_KEY } from "./effective-followup-config.js";

describe("resolveEffectiveFollowupConfig", () => {
  it("enforces the approved Villefer cadence over a stale imported package", () => {
    const resolved = resolveEffectiveFollowupConfig({
      packageMetadata: { key: VILLEFER_V1_PACKAGE_KEY },
      followup: {
        timeZone: "UTC",
        businessDays: [0, 6],
        businessHours: { start: "00:00", end: "23:59" },
        closeAfterBusinessMinutes: 9999,
        steps: [
          { afterBusinessMinutes: 720, instruction: "Primeiro texto importado." },
          { afterBusinessMinutes: 1200, instruction: "Segundo texto importado." },
          { afterBusinessMinutes: 2400, instruction: "Terceiro texto importado." }
        ]
      }
    });

    expect(resolved).toMatchObject({
      timeZone: "America/Sao_Paulo",
      businessDays: [1, 2, 3, 4, 5],
      businessHours: { start: "08:00", end: "18:00" }
    });
    expect(resolved?.steps.map((step) => step.afterBusinessMinutes)).toEqual([360, 1200, 2400]);
    expect(resolved?.steps[0]?.instruction).toBe("Primeiro texto importado.");
  });

  it("restores the approved Villefer config when an imported agent has no usable follow-up config", () => {
    const resolved = resolveEffectiveFollowupConfig({
      packageMetadata: { key: VILLEFER_V1_PACKAGE_KEY }
    });

    expect(resolved?.steps.map((step) => step.afterBusinessMinutes)).toEqual([360, 1200, 2400]);
  });

  it("does not rewrite another agent's valid configuration", () => {
    const resolved = resolveEffectiveFollowupConfig({
      packageMetadata: { key: "another-agent" },
      followup: {
        timeZone: "UTC",
        businessDays: [1],
        businessHours: { start: "09:00", end: "10:00" },
        closeAfterBusinessMinutes: 0,
        steps: [{ afterBusinessMinutes: 90, instruction: "Custom." }]
      }
    });

    expect(resolved?.steps[0]?.afterBusinessMinutes).toBe(90);
  });
});
