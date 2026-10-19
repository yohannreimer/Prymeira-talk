import type { ChannelHealthDto, ChannelStatus } from "@prymeira-talk/shared";

export type EvolutionState = "open" | "connecting" | "close" | null;
export type HealthState = ChannelHealthDto["state"];

export const RECONNECT_BACKOFF_MS = [2, 5, 10, 30, 60].map((minutes) => minutes * 60_000);
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;
export const SILENCE_THRESHOLD_MS = 3 * 60 * 60 * 1000;
export const SILENCE_RECENT_ACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;
const BUSINESS_TIME_ZONE = "America/Sao_Paulo";

export type HealthMemory = {
  state: HealthState;
  since: string | null;
  attempts: number;
  nextAttemptAt: string | null;
};

export type HealthDecision = HealthMemory & {
  talkStatus: ChannelStatus | null;
  action: "none" | "reconnect";
};

export function isBusinessHours(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE, weekday: "short", hour: "numeric", hourCycle: "h23"
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return weekday !== "Sun" && hour >= 8 && hour < 19;
}

export function decideChannelHealth(input: {
  evolutionState: EvolutionState;
  previous: HealthMemory | null;
  lastInboundAt: Date | null;
  now: Date;
}): HealthDecision {
  const { evolutionState, previous, lastInboundAt, now } = input;
  const nowIso = now.toISOString();
  const finish = (state: HealthState, rest: Omit<HealthDecision, "state" | "since">): HealthDecision => ({
    state,
    since: previous && previous.state === state ? previous.since : nowIso,
    ...rest
  });

  if (evolutionState === null) {
    return {
      state: previous?.state ?? "ok",
      since: previous?.since ?? null,
      attempts: previous?.attempts ?? 0,
      nextAttemptAt: previous?.nextAttemptAt ?? null,
      talkStatus: null,
      action: "none"
    };
  }

  if (evolutionState === "open") {
    const silentFor = lastInboundAt ? now.getTime() - lastInboundAt.getTime() : null;
    const silent = silentFor !== null && isBusinessHours(now) &&
      silentFor >= SILENCE_THRESHOLD_MS && silentFor <= SILENCE_RECENT_ACTIVITY_MS;
    return finish(silent ? "silent" : "ok", { attempts: 0, nextAttemptAt: null, talkStatus: "connected", action: "none" });
  }

  if (evolutionState === "connecting") {
    return finish("reconnecting", {
      attempts: previous?.attempts ?? 0, nextAttemptAt: previous?.nextAttemptAt ?? null,
      talkStatus: "connecting", action: "none"
    });
  }

  const attempts = previous?.attempts ?? 0;
  if (attempts >= MAX_RECONNECT_ATTEMPTS) {
    return finish("needs_qr", { attempts, nextAttemptAt: null, talkStatus: "disconnected", action: "none" });
  }
  const due = !previous?.nextAttemptAt || new Date(previous.nextAttemptAt).getTime() <= now.getTime();
  if (!due) {
    return finish("reconnecting", {
      attempts, nextAttemptAt: previous!.nextAttemptAt, talkStatus: "disconnected", action: "none"
    });
  }
  const nextAttempts = attempts + 1;
  return finish("reconnecting", {
    attempts: nextAttempts,
    nextAttemptAt: new Date(now.getTime() + RECONNECT_BACKOFF_MS[nextAttempts - 1]!).toISOString(),
    talkStatus: "disconnected",
    action: "reconnect"
  });
}
