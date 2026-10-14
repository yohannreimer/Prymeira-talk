/** A quiet SQL poll backs off, while actual work immediately resets it. The broker still delivers live webhooks. */
export function createIdleBackoff(minMs: number, maxMs: number) {
  let idleMs = minMs;
  return {
    next(worked: boolean) {
      if (worked) { idleMs = minMs; return minMs; }
      const next = idleMs;
      idleMs = Math.min(maxMs, idleMs * 2);
      return next;
    }
  };
}
/** Independent periodic jobs. Failures of one job must not starve another job. */
export function createSweepCadence(now = Date.now) {
  const nextAt = new Map<string, number>();
  return (job: string, intervalMs: number) => {
    const at = now();
    if ((nextAt.get(job) ?? -Infinity) > at) return false;
    nextAt.set(job, at + intervalMs);
    return true;
  };
}
