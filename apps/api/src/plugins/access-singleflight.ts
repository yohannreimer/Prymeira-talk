import { createHash } from "node:crypto";

const HUB_TIMEOUT_MS = 3000;

// Share only unfinished validations. Every request after settlement must check
// access again, including immediately after a workspace membership is revoked.
export function createAccessSingleflight<T>() {
  const pending = new Map<string, Promise<T>>();
  return (productKey: string, accountApiUrl: string, token: string, validate: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const key = createHash("sha256").update(JSON.stringify([productKey, accountApiUrl, token])).digest("hex");
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
    return promise;
  };
}
