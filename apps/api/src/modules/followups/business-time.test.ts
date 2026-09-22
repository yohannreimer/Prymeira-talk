import { describe, expect, it } from "vitest";
import { addBusinessMinutes } from "./business-time.js";

const villeferBusinessCalendar = {
  timeZone: "America/Sao_Paulo",
  businessDays: [1, 2, 3, 4, 5],
  businessHours: { start: "08:00", end: "18:00" }
};

describe("addBusinessMinutes", () => {
  it("counts minutes inside the São Paulo business window", () => {
    const result = addBusinessMinutes({
      ...villeferBusinessCalendar,
      from: new Date("2026-09-22T14:30:00.000Z"),
      minutes: 90
    });

    expect(result.toISOString()).toBe("2026-09-22T16:00:00.000Z");
  });

  it("starts at opening when the input is before business hours", () => {
    const result = addBusinessMinutes({
      ...villeferBusinessCalendar,
      from: new Date("2026-09-22T10:30:00.000Z"),
      minutes: 90
    });

    expect(result.toISOString()).toBe("2026-09-22T12:30:00.000Z");
  });

  it("starts on the next business day when the input is after business hours", () => {
    const result = addBusinessMinutes({
      ...villeferBusinessCalendar,
      from: new Date("2026-09-22T21:30:00.000Z"),
      minutes: 90
    });

    expect(result.toISOString()).toBe("2026-09-23T12:30:00.000Z");
  });

  it("carries Friday business time into Monday", () => {
    const result = addBusinessMinutes({
      ...villeferBusinessCalendar,
      from: new Date("2026-09-25T20:00:00.000Z"),
      minutes: 120
    });

    expect(result.toISOString()).toBe("2026-09-28T12:00:00.000Z");
  });

  it("moves a weekend input to Monday opening", () => {
    const result = addBusinessMinutes({
      ...villeferBusinessCalendar,
      from: new Date("2026-09-26T14:00:00.000Z"),
      minutes: 120
    });

    expect(result.toISOString()).toBe("2026-09-28T13:00:00.000Z");
  });

  it("preserves years from 0001 through 0099 when crossing a business day", () => {
    const result = addBusinessMinutes({
      from: new Date("0099-01-02T17:30:00.000Z"),
      minutes: 60,
      timeZone: "UTC",
      businessDays: [0, 1, 2, 3, 4, 5, 6],
      businessHours: { start: "08:00", end: "18:00" }
    });

    expect(result.toISOString()).toBe("0099-01-03T08:30:00.000Z");
  });

  it("preserves proleptic year zero inside a UTC business window", () => {
    const result = addBusinessMinutes({
      from: new Date("0000-01-01T09:00:00.000Z"),
      minutes: 60,
      timeZone: "UTC",
      businessDays: [0, 1, 2, 3, 4, 5, 6],
      businessHours: { start: "08:00", end: "18:00" }
    });

    expect(result.toISOString()).toBe("0000-01-01T10:00:00.000Z");
  });

  it("rejects a duration that would scan too many sparse business windows", () => {
    expect(() => addBusinessMinutes({
      from: new Date("2026-09-21T11:00:00.000Z"),
      minutes: 1500,
      timeZone: "UTC",
      businessDays: [1],
      businessHours: { start: "08:00", end: "08:01" }
    })).toThrow(/supported calendar range/i);
  });

  it("rejects zero duration and invalid calendar configuration", () => {
    expect(() => addBusinessMinutes({
      ...villeferBusinessCalendar,
      from: new Date("2026-09-22T14:30:00.000Z"),
      minutes: 0
    })).toThrow(RangeError);
    expect(() => addBusinessMinutes({
      ...villeferBusinessCalendar,
      from: new Date("2026-09-22T14:30:00.000Z"),
      minutes: 30,
      businessHours: { start: "18:00", end: "08:00" }
    })).toThrow(RangeError);
    expect(() => addBusinessMinutes({
      ...villeferBusinessCalendar,
      from: new Date("2026-09-22T14:30:00.000Z"),
      minutes: 30,
      businessDays: []
    })).toThrow(RangeError);
  });
});
