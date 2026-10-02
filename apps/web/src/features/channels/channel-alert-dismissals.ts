import type { ChannelProblem } from "./channel-problems";

export const DISMISSALS_STORAGE_KEY = "prymeira-talk:channel-alert-dismissals";
export const DISMISS_DURATION_MS = 8 * 3_600_000;

export type Dismissal = { signature: string; until: number };
export type Dismissals = Record<string, Dismissal>;
type DismissalStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): DismissalStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

const signatureOf = (problem: ChannelProblem) => `${problem.tone}|${problem.title}`;

export function readDismissals(storage: DismissalStorage | undefined = defaultStorage()): Dismissals {
  try {
    const raw = storage?.getItem(DISMISSALS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Dismissals = {};
    for (const [channelId, value] of Object.entries(parsed)) {
      const entry = value as Partial<Dismissal> | null;
      if (entry && typeof entry.signature === "string" && typeof entry.until === "number" && Number.isFinite(entry.until)) {
        result[channelId] = { signature: entry.signature, until: entry.until };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeDismissals(map: Dismissals, storage: DismissalStorage | undefined = defaultStorage()) {
  try {
    storage?.setItem(DISMISSALS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage blocked or full: the dismissal just lasts until the page reloads.
  }
}

export function isDismissed(map: Dismissals, problem: ChannelProblem, now: Date): boolean {
  const entry = map[problem.channelId];
  return !!entry && entry.until > now.getTime() && entry.signature === signatureOf(problem);
}

export function dismissProblem(map: Dismissals, problem: ChannelProblem, now: Date): Dismissals {
  return { ...map, [problem.channelId]: { signature: signatureOf(problem), until: now.getTime() + DISMISS_DURATION_MS } };
}

export function pruneDismissals(map: Dismissals, now: Date): Dismissals {
  return Object.fromEntries(Object.entries(map).filter(([, entry]) => entry.until > now.getTime()));
}
