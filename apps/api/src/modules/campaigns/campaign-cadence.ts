import { randomInt } from "node:crypto";
import { addBusinessSeconds, nextBusinessStart } from "../followups/business-time.js";

export const DEFAULT_CAMPAIGN_CADENCE = {
  minDelaySeconds: 120,
  maxDelaySeconds: 300,
  batchSize: 20,
  pauseMinSeconds: 900,
  pauseMaxSeconds: 1200,
  windowStart: "09:00",
  windowEnd: "20:00"
} as const;

export type CampaignCadence = {
  minDelaySeconds: number;
  maxDelaySeconds: number;
  batchSize: number;
  pauseMinSeconds: number;
  pauseMaxSeconds: number;
  windowStart: string;
  windowEnd: string;
  /** Spread over days: each day sends a drawn number between dailyMin and dailyMax (e.g. 38–42), spaced over the window. */
  dailyMin?: number;
  dailyMax?: number;
  /** Days of the week allowed to send (0 = Sunday). Absent = every day. */
  weekdays?: number[];
};

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
export function cadenceWeekdays(cadence: Pick<CampaignCadence, "weekdays">) {
  return cadence.weekdays?.length ? cadence.weekdays : EVERY_DAY;
}
/** "Espalhar em vários dias": a daily quota instead of everything on the same day. */
export function isDailyCadence(cadence: Pick<CampaignCadence, "dailyMax">) {
  return typeof cadence.dailyMax === "number" && cadence.dailyMax > 0;
}

export type Draw = (minInclusive: number, maxInclusive: number) => number;

export function secureDraw(minInclusive: number, maxInclusive: number): number {
  return randomInt(minInclusive, maxInclusive + 1);
}

export function drawGap(cadence: CampaignCadence, draw: Draw = secureDraw): number {
  return draw(cadence.minDelaySeconds, cadence.maxDelaySeconds);
}

export function drawPause(
  cadence: CampaignCadence,
  draw: Draw = secureDraw,
  afterAttempts: number
): number {
  return cadence.batchSize > 0 && afterAttempts > 0 && afterAttempts % cadence.batchSize === 0
    ? draw(cadence.pauseMinSeconds, cadence.pauseMaxSeconds)
    : 0;
}

export function nextCampaignInstant(
  from: Date,
  seconds: number,
  timeZone: string,
  cadence: CampaignCadence
): Date {
  const input = {
    from,
    timeZone,
    businessDays: cadenceWeekdays(cadence),
    businessHours: { start: cadence.windowStart, end: cadence.windowEnd }
  };
  if (seconds === 0) return nextBusinessStart(input);
  return addBusinessSeconds({ ...input, seconds });
}

type LocalDay = { year: number; month: number; day: number };
function localDay(date: Date, timeZone: string): LocalDay {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (name: string) => Number(parts.find((item) => item.type === name)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}
/** The instant of a local wall-clock time on a local day (converges in a couple of steps, also across DST changes). */
function zonedInstant(day: LocalDay, time: string, timeZone: string): Date {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const target = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const part = (name: string) => Number(parts.find((item) => item.type === name)?.value);
    const shown = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
    if (shown === target) break;
    guess += target - shown;
  }
  return new Date(guess);
}
/** "YYYY-MM-DD" of an instant in the campaign's time zone. */
export function localDayKey(date: Date, timeZone: string) {
  const day = localDay(date, timeZone);
  return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}
/** Local midnight of the instant's day: where "sent today" starts counting. */
export function localDayStart(date: Date, timeZone: string) {
  return zonedInstant(localDay(date, timeZone), "00:00", timeZone);
}
/** The first allowed instant on a later day than `from` (the next allowed weekday, at the window start). */
export function nextDayStart(from: Date, timeZone: string, cadence: CampaignCadence) {
  const day = localDay(from, timeZone);
  const tomorrow = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
  const midnight = zonedInstant({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate() },
    "00:00", timeZone);
  return nextCampaignInstant(midnight, 0, timeZone, cadence);
}

/**
 * The plan of a campaign spread over days. Each day draws its quota (dailyMin–dailyMax, so 38, 42, 40…) and spaces
 * those messages across what is left of the window, with each gap varied ±25% (never below the minimum interval).
 * Day one may start mid-window: the same quota then goes out a little closer together.
 */
export function planDailySchedule(input: { start: Date; count: number; timeZone: string; cadence: CampaignCadence; draw?: Draw }) {
  const draw = input.draw ?? secureDraw;
  const { cadence, timeZone } = input;
  const dailyMax = cadence.dailyMax ?? 40;
  const dailyMin = Math.min(cadence.dailyMin ?? dailyMax, dailyMax);
  const plan: Array<{ scheduledAt: Date; gapSeconds: number }> = [];
  let dayStart = nextCampaignInstant(input.start, 0, timeZone, cadence);
  for (let guard = 0; plan.length < input.count && guard < 3660; guard += 1) {
    const quota = draw(dailyMin, dailyMax);
    const today = Math.min(quota, input.count - plan.length);
    const windowEnd = zonedInstant(localDay(dayStart, timeZone), cadence.windowEnd, timeZone);
    const available = Math.max(60, Math.floor((windowEnd.getTime() - dayStart.getTime()) / 1000));
    const base = Math.max(cadence.minDelaySeconds, Math.floor(available / quota));
    const gaps = Array.from({ length: today }, () =>
      Math.max(cadence.minDelaySeconds, draw(Math.floor(base * 0.75), Math.ceil(base * 1.25))));
    // Keep the day inside its window: shrink the gaps if the draws added up to more than the time left.
    const used = gaps.slice(0, -1).reduce((sum, gap) => sum + gap, 0);
    const limit = Math.floor(available * 0.95);
    const scale = used > limit ? limit / used : 1;
    let at = dayStart;
    gaps.forEach((gap, index) => {
      const last = index === gaps.length - 1;
      const spaced = Math.max(cadence.minDelaySeconds, Math.floor(gap * scale));
      plan.push({ scheduledAt: at, gapSeconds: last ? cadence.minDelaySeconds : spaced });
      at = new Date(at.getTime() + spaced * 1000);
    });
    dayStart = nextDayStart(dayStart, timeZone, cadence);
  }
  return plan;
}
