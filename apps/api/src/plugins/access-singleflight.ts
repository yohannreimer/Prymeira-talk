import { createHash } from "node:crypto";

const HUB_TIMEOUT_MS = 3000;

// Shares unfinished validations. By default every request after settlement checks access again. With `keepMs`,
// an answer that `keep` accepts (an allowed access) is reused by the same token for that long: each Hub round trip
// costs ~250 ms on every screen, and a revocation then takes effect within `keepMs`. Denials and failures are never
// kept, so a refused or broken check is always asked again.
export function createAccessSingleflight<T>(options: { keepMs?: number; keep?: (value: T) => boolean; now?: () => number } = {}) {
  const pending = new Map<string, Promise<T>>();
  const kept = new Map<string, { value: T; until: number }>();
  const keepMs = options.keepMs ?? 0;
  const now = options.now ?? Date.now;
  return (productKey: string, accountApiUrl: string, token: string, validate: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const key = createHash("sha256").update(JSON.stringify([productKey, accountApiUrl, token])).digest("hex");
    const fresh = kept.get(key);
    if (fresh && fresh.until > now()) return Promise.resolve(fresh.value);
    if (fresh) kept.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Product access validation timed out."));
      }, HUB_TIMEOUT_MS);
      timer.unref?.();
    });
    const promise = Promise.race([Promise.resolve().then(() => validate(controller.signal)), timeout]).finally(() => {
      clearTimeout(timer);
      if (pending.get(key) === promise) pending.delete(key);
    });
    pending.set(key, promise);
    if (keepMs > 0) {
      void promise.then((value) => {
        if (!options.keep?.(value)) return;
        // Tokens are short lived: drop expired answers so the map stays small.
        if (kept.size > 2000) for (const [entry, record] of kept) if (record.until <= now()) kept.delete(entry);
        kept.set(key, { value, until: now() + keepMs });
      }, () => undefined);
    }
    return promise;
  };
}
