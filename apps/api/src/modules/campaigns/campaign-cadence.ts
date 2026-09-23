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
};

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
    businessDays: [0, 1, 2, 3, 4, 5, 6],
    businessHours: { start: cadence.windowStart, end: cadence.windowEnd }
  };
  if (seconds === 0) return nextBusinessStart(input);
  return addBusinessSeconds({ ...input, seconds });
}
