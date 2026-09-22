import type { LeadJob } from "@prisma/client";
import type { LeadsRepositoryLike } from "./leads.repository.js";
import type { LeadsService } from "./leads.service.js";

export interface LeadsSchedulerOptions {
  repository: LeadsRepositoryLike;
  service: Pick<LeadsService, "runClaimedJob" | "publishRecoveredJob" | "publishRecoveredList">;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  maxGoogleConcurrentJobs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

let activeGoogleJobsInProcess = 0;

export function createLeadsScheduler(options: LeadsSchedulerOptions) {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const leaseMs = options.leaseMs ?? 300_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const batchSize = Math.max(options.batchSize ?? 2, 2);
  const maxGoogleConcurrentJobs = options.maxGoogleConcurrentJobs ?? 1;
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeTick: Promise<void> | undefined;
  const activeWorkers = new Set<Promise<void>>();
  let stopping = false;

  async function performTick() {
    const recovered = await options.repository.recoverExpiredJobs(now(), maxAttempts);
    for (const transition of recovered) {
      options.service.publishRecoveredJob(transition.job);
      if (transition.list) options.service.publishRecoveredList(transition.list);
    }
    const candidates = await options.repository.findQueuedJobs(batchSize, maxAttempts);
    for (const candidate of candidates) {
      if (stopping) break;
      const isGoogle = candidate.operation === "google_maps_search";
      if (isGoogle && activeGoogleJobsInProcess >= maxGoogleConcurrentJobs) continue;
      if (isGoogle) activeGoogleJobsInProcess += 1;
      let claimed;
      try {
        claimed = await options.repository.claimJob(
          candidate.workspaceId,
          candidate.id,
          now(),
          leaseMs,
          maxAttempts
        );
      } catch (error) {
        if (isGoogle) activeGoogleJobsInProcess -= 1;
        throw error;
      }
      if (!claimed && isGoogle) activeGoogleJobsInProcess -= 1;
      if (!claimed) continue;
      options.service.publishRecoveredJob(claimed as LeadJob);
      const worker = options.service.runClaimedJob(claimed)
        .then(() => undefined)
        .catch((error) => {
          // The service normally persists a terminal status. Unexpected repository
          // failures are left leased and recovered durably after expiry.
          options.onError?.(error);
        })
        .finally(() => {
          activeWorkers.delete(worker);
          if (isGoogle) activeGoogleJobsInProcess -= 1;
        });
      activeWorkers.add(worker);
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
      await Promise.allSettled([...activeWorkers]);
    }
  };
}

export type LeadsScheduler = ReturnType<typeof createLeadsScheduler>;
