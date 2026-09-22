import type { LeadJob } from "@prisma/client";
import type { LeadsRepositoryLike } from "./leads.repository.js";
import type { LeadsService } from "./leads.service.js";

export interface LeadsSchedulerOptions {
  repository: LeadsRepositoryLike;
  service: Pick<LeadsService, "runClaimedJob" | "publishRecoveredJob">;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export function createLeadsScheduler(options: LeadsSchedulerOptions) {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const leaseMs = options.leaseMs ?? 300_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const batchSize = options.batchSize ?? 2;
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeTick: Promise<void> | undefined;
  let stopping = false;

  async function performTick() {
    const recovered = await options.repository.recoverExpiredJobs(now(), maxAttempts);
    for (const job of recovered) options.service.publishRecoveredJob(job);
    const candidates = await options.repository.findQueuedJobs(batchSize, maxAttempts);
    for (const candidate of candidates) {
      if (stopping) break;
      const claimed = await options.repository.claimJob(
        candidate.workspaceId,
        candidate.id,
        now(),
        leaseMs,
        maxAttempts
      );
      if (!claimed) continue;
      options.service.publishRecoveredJob(claimed as LeadJob);
      try {
        await options.service.runClaimedJob(claimed);
      } catch (error) {
        // The service normally persists a terminal status. Unexpected repository
        // failures are left leased and recovered durably after expiry.
        options.onError?.(error);
      }
    }
  }

  function tick() {
    if (activeTick || stopping) return activeTick ?? Promise.resolve();
    activeTick = performTick()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        activeTick = undefined;
      });
    return activeTick;
  }

  return {
    tick,
    start() {
      if (timer) return;
      stopping = false;
      timer = setInterval(() => void tick(), pollIntervalMs);
      timer.unref();
      void tick();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await activeTick;
    }
  };
}

export type LeadsScheduler = ReturnType<typeof createLeadsScheduler>;
