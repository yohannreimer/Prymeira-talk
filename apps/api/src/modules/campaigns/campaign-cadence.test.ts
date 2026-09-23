import { describe, expect, it } from "vitest";
import { addBusinessSeconds } from "../followups/business-time.js";
import { DEFAULT_CAMPAIGN_CADENCE, drawGap, drawPause, nextCampaignInstant } from "./campaign-cadence.js";

describe("campaign cadence", () => {
  it("draws each gap and the twentieth-attempt pause independently", () => {
    const draws = [150, 190, 245];
    expect([0, 1, 2].map(() => drawGap(DEFAULT_CAMPAIGN_CADENCE, () => draws.shift()!)))
      .toEqual([150, 190, 245]);
    expect(drawPause(DEFAULT_CAMPAIGN_CADENCE, (min) => min + 30, 19)).toBe(0);
    expect(drawPause(DEFAULT_CAMPAIGN_CADENCE, (min) => min + 30, 20)).toBe(930);
  });

  it("carries excess seconds into the next São Paulo window", () => {
    const from = new Date("2026-09-22T22:59:00.000Z"); // 19:59 local
    expect(nextCampaignInstant(from, 150, "America/Sao_Paulo", DEFAULT_CAMPAIGN_CADENCE)
      .toISOString()).toBe("2026-09-23T12:01:30.000Z");
    expect(nextCampaignInstant(new Date("2026-09-22T23:00:00.000Z"), 0,
      "America/Sao_Paulo", DEFAULT_CAMPAIGN_CADENCE).toISOString())
      .toBe("2026-09-23T12:00:00.000Z");
  });

  it("respects other IANA zones and retains second precision", () => {
    expect(addBusinessSeconds({
      from: new Date("2026-09-22T19:59:00.000Z"),
      seconds: 150,
      timeZone: "UTC",
      businessDays: [0, 1, 2, 3, 4, 5, 6],
      businessHours: { start: "09:00", end: "20:00" }
    }).toISOString()).toBe("2026-09-23T09:01:30.000Z");
  });
});
