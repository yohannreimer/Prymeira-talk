import type { CampaignCadenceDto } from "../../app/api";

export const WEEKDAY_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;
export const WORKDAYS = [1, 2, 3, 4, 5];

/** "Espalhar em vários dias": ~40 a day (38–42), weekdays, business hours. Gaps are spread over the window by the server. */
export const DAILY_PRESET: Pick<CampaignCadenceDto, "dailyMin" | "dailyMax" | "weekdays" | "windowStart" | "windowEnd"> = {
  dailyMin: 38, dailyMax: 42, weekdays: WORKDAYS, windowStart: "09:00", windowEnd: "18:00"
};

export function isDaily(cadence: CampaignCadenceDto) {
  return typeof cadence.dailyMax === "number" && cadence.dailyMax > 0;
}

export function withDaily(cadence: CampaignCadenceDto): CampaignCadenceDto {
  return { ...cadence, ...DAILY_PRESET };
}

export function withoutDaily(cadence: CampaignCadenceDto): CampaignCadenceDto {
  const { dailyMin: _min, dailyMax: _max, weekdays: _weekdays, ...rest } = cadence;
  // Back to the same-day pace: the spread preset's business hours return to the usual 09:00–20:00 window.
  return rest.windowStart === DAILY_PRESET.windowStart && rest.windowEnd === DAILY_PRESET.windowEnd ? { ...rest, windowEnd: "20:00" } : rest;
}

/** "Seg a Sex", "Seg, Qua e Sex", "Todos os dias". */
export function weekdaysLabel(weekdays: number[] | undefined) {
  const days = [...new Set(weekdays?.length ? weekdays : [0, 1, 2, 3, 4, 5, 6])].sort();
  if (days.length === 7) return "Todos os dias";
  const consecutive = days.every((day, index) => index === 0 || day === days[index - 1]! + 1);
  if (consecutive && days.length > 2) return `${WEEKDAY_SHORT[days[0]!]} a ${WEEKDAY_SHORT[days.at(-1)!]}`;
  const names = days.map(day => WEEKDAY_SHORT[day]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names.at(-1)}` : names[0] ?? "";
}

function minutes(time: string | undefined, fallback: number) {
  const match = /^(\d{2}):(\d{2})$/.exec(time ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

/**
 * The expected calendar of a spread campaign, for the preview before sending: the average of the daily range per
 * allowed day (the real quota is drawn per day by the server, so it is "aproximado"). Day one counts only if the
 * window is still open at the start.
 */
export function estimateDays(count: number, cadence: CampaignCadenceDto, start: Date) {
  if (!isDaily(cadence) || count <= 0) return [];
  const perDay = Math.max(1, Math.round(((cadence.dailyMin ?? cadence.dailyMax!) + cadence.dailyMax!) / 2));
  const allowed = new Set(cadence.weekdays?.length ? cadence.weekdays : [0, 1, 2, 3, 4, 5, 6]);
  const end = minutes(cadence.windowEnd, 18 * 60);
  const days: Array<{ date: Date; count: number }> = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  if (start.getHours() * 60 + start.getMinutes() >= end) cursor.setDate(cursor.getDate() + 1);
  let left = count;
  for (let guard = 0; left > 0 && guard < 3660; guard += 1) {
    if (allowed.has(cursor.getDay())) {
      const today = Math.min(perDay, left);
      days.push({ date: new Date(cursor), count: today });
      left -= today;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function shortDay(date: Date) {
  return `${WEEKDAY_SHORT[date.getDay()]} ${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** "2026-10-07" (campaign day) → "Ter 07/10". */
export function shortDayKey(key: string) {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return shortDay(new Date(year, month - 1, day));
}
