import { describe, expect, it } from "vitest";
import { addBusinessSeconds } from "../followups/business-time.js";
import { DEFAULT_CAMPAIGN_CADENCE, drawGap, drawPause, localDayKey, localDayStart, nextCampaignInstant, nextDayStart, planDailySchedule } from "./campaign-cadence.js";

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

  describe("spread over days (~40 por dia)", () => {
    const cadence = { ...DEFAULT_CAMPAIGN_CADENCE, windowStart: "09:00", windowEnd: "18:00", dailyMin: 38, dailyMax: 42, weekdays: [1, 2, 3, 4, 5] };
    const tz = "America/Sao_Paulo";
    const hour = (date: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(date));
    const weekday = (date: Date) => new Date(`${localDayKey(date, tz)}T12:00:00Z`).getUTCDay();

    it("draws each day's quota, skips the weekend and keeps every send inside the window", () => {
      const quotas = [38, 42, 40];
      // Quotas come from the calls with the daily bounds; gaps take the middle of their range.
      const draw = (min: number, max: number) => min === 38 && max === 42 ? quotas.shift()! : Math.round((min + max) / 2);
      const plan = planDailySchedule({ start: new Date("2026-10-09T12:00:00Z"), count: 100, timeZone: tz, cadence, draw }); // Fri 09:00
      const perDay = new Map<string, number>();
      for (const item of plan) perDay.set(localDayKey(item.scheduledAt, tz), (perDay.get(localDayKey(item.scheduledAt, tz)) ?? 0) + 1);
      expect([...perDay]).toEqual([["2026-10-09", 38], ["2026-10-12", 42], ["2026-10-13", 20]]);
      expect(plan.every(item => hour(item.scheduledAt) >= 9 && hour(item.scheduledAt) < 18)).toBe(true);
      expect(plan.every(item => weekday(item.scheduledAt) >= 1 && weekday(item.scheduledAt) <= 5)).toBe(true);
      // Spread over the day, not bunched in the morning: the 38th of Friday goes out in the afternoon.
      expect(hour(plan[37]!.scheduledAt)).toBeGreaterThanOrEqual(16);
      expect(plan.every(item => item.gapSeconds >= cadence.minDelaySeconds)).toBe(true);
    });

    it("starting mid-afternoon still fits the day's quota before the window closes", () => {
      const plan = planDailySchedule({ start: new Date("2026-10-07T18:30:00Z"), count: 40, timeZone: tz, // Wed 15:30
        cadence: { ...cadence, minDelaySeconds: 30 }, draw: (min, max) => max });
      expect(new Set(plan.map(item => localDayKey(item.scheduledAt, tz)))).toEqual(new Set(["2026-10-07"]));
      expect(hour(plan.at(-1)!.scheduledAt)).toBeLessThan(18);
    });

    it("finds local midnight and the next allowed weekday", () => {
      expect(localDayStart(new Date("2026-10-07T02:00:00Z"), tz).toISOString()).toBe("2026-10-06T03:00:00.000Z");
      expect(nextDayStart(new Date("2026-10-09T20:00:00Z"), tz, cadence).toISOString()).toBe("2026-10-12T12:00:00.000Z"); // Fri → Mon 09:00
    });
  });
});
