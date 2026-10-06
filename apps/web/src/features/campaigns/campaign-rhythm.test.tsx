// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CampaignTracking } from "./CampaignTracking";
import { SAFE_CADENCE } from "./GuidedCampaignEditor";
import { estimateDays, shortDay, weekdaysLabel, withDaily, withoutDaily } from "./campaign-rhythm";

describe("ritmo em vários dias", () => {
  it("estimates ~40 a day on weekdays only, skipping today once the window has closed", () => {
    const cadence = withDaily(SAFE_CADENCE);
    // Friday 10 Oct 2026, 19:00 (after 18:00): Friday is over, so it starts Monday.
    const days = estimateDays(200, cadence, new Date(2026, 9, 9, 19, 0));
    expect(days.map(day => [shortDay(day.date), day.count])).toEqual([
      ["Seg 12/10", 40], ["Ter 13/10", 40], ["Qua 14/10", 40], ["Qui 15/10", 40], ["Sex 16/10", 40]]);
    expect(estimateDays(90, cadence, new Date(2026, 9, 9, 10, 0)).map(day => [shortDay(day.date), day.count]))
      .toEqual([["Sex 09/10", 40], ["Seg 12/10", 40], ["Ter 13/10", 10]]);
  });
  it("names the chosen days and goes back to the usual window when spreading is turned off", () => {
    expect(weekdaysLabel([1, 2, 3, 4, 5])).toBe("Seg a Sex");
    expect(weekdaysLabel([1, 3, 5])).toBe("Seg, Qua e Sex");
    expect(weekdaysLabel(undefined)).toBe("Todos os dias");
    const back = withoutDaily(withDaily(SAFE_CADENCE));
    expect(back).toEqual(SAFE_CADENCE);
  });
});

describe("acompanhamento", () => {
  let container: HTMLDivElement | null = null;
  afterEach(() => { container?.remove(); container = null; });
  it("shows sent, planned and replies per day and per city", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<CampaignTracking progress={{ status: "sending", total: 80, sent: 41, pending: 39, skipped: 0, failed: 0, uncertain: 0,
      nextScheduledAt: null, days: [{ day: "2026-10-06", sent: 41, planned: 0, replied: 5 }, { day: "2099-10-07", sent: 0, planned: 39, replied: 0 }],
      cities: [{ city: "Joinville", total: 60, sent: 30, replied: 4 }, { city: "Araquari", total: 20, sent: 11, replied: 1 }] }} />));
    const text = container.textContent ?? "";
    expect(text).toContain("Por dia");
    expect(text).toContain("Ter 06/10");
    expect(text).toContain("5 responderam · 12% das enviadas");
    expect(text).toContain("Joinville");
    expect(text).toContain("Araquari");
    await act(async () => root.unmount());
  });
});
