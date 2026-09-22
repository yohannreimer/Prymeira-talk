import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LeadJob } from "@prisma/client";
import { createLeadsScheduler } from "./leads.scheduler.js";

const now = new Date("2026-09-22T15:00:00.000Z");

function job(overrides: Partial<LeadJob> = {}): LeadJob {
  return {
    id: randomUUID(),
    workspaceId: "workspace_a",
    listId: randomUUID(),
    operation: "receita_search",
    status: "queued",
    input: {},
    output: {},
    errorMessage: null,
    attempts: 0,
    leaseToken: null,
    leaseUntil: null,
    startedAt: null,
    finishedAt: null,
    idempotencyKey: randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    recoverExpiredJobs: vi.fn(async () => []),
    findQueuedJobs: vi.fn(async () => []),
    claimJob: vi.fn(async () => null),
    ...overrides
  } as any;
}

describe("Leads scheduler", () => {
  it("allows only one scheduler owner to win the atomic lease claim", async () => {
    const candidate = job();
    let leased = false;
    const repo = repository({
      findQueuedJobs: vi.fn(async () => [candidate]),
      claimJob: vi.fn(async () => {
        if (leased) return null;
        leased = true;
        return {
          ...candidate,
          status: "running",
          attempts: 1,
          leaseToken: randomUUID(),
          leaseUntil: new Date(now.getTime() + 300_000)
        };
      })
    });
    const service = { runClaimedJob: vi.fn(async () => undefined), publishRecoveredJob: vi.fn(), publishRecoveredList: vi.fn() };
    const first = createLeadsScheduler({ repository: repo, service: service as any, now: () => now });
    const second = createLeadsScheduler({ repository: repo, service: service as any, now: () => now });

    await Promise.all([first.tick(), second.tick()]);

    expect(repo.claimJob).toHaveBeenCalledTimes(2);
    expect(service.runClaimedJob).toHaveBeenCalledTimes(1);
    expect(service.publishRecoveredJob).toHaveBeenCalledWith(expect.objectContaining({ status: "running", workspaceId: "workspace_a" }));
  });

  it("recovers expired leases before selecting queued work and publishes each durable transition", async () => {
    const recovered = job({
      status: "queued",
      attempts: 1,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: new Date(now.getTime() + 1)
    });
    const calls: string[] = [];
    const recoveredList = { id: recovered.listId, workspaceId: recovered.workspaceId };
    const repo = repository({
      recoverExpiredJobs: vi.fn(async () => { calls.push("recover"); return [{ job: recovered, list: recoveredList }]; }),
      findQueuedJobs: vi.fn(async () => { calls.push("find"); return []; })
    });
    const service = {
      runClaimedJob: vi.fn(),
      publishRecoveredJob: vi.fn(() => calls.push("publish-job")),
      publishRecoveredList: vi.fn(() => calls.push("publish-list"))
    };
    const scheduler = createLeadsScheduler({ repository: repo, service: service as any, maxAttempts: 3, now: () => now });

    await scheduler.tick();

    expect(calls).toEqual(["recover", "publish-job", "publish-list", "find"]);
    expect(repo.recoverExpiredJobs).toHaveBeenCalledWith(now, 3);
    expect(service.publishRecoveredJob).toHaveBeenCalledWith(recovered);
    expect(service.publishRecoveredList).toHaveBeenCalledWith(recoveredList);
  });

  it("does not overlap ticks and waits for active work during graceful stop", async () => {
    const candidate = job();
    let release!: () => void;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const repo = repository({
      findQueuedJobs: vi.fn(async () => [candidate]),
      claimJob: vi.fn(async () => ({
        ...candidate,
        status: "running",
        attempts: 1,
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 300_000)
      }))
    });
    const service = { runClaimedJob: vi.fn(async () => running), publishRecoveredJob: vi.fn(), publishRecoveredList: vi.fn() };
    const scheduler = createLeadsScheduler({ repository: repo, service: service as any, now: () => now });

    const first = scheduler.tick();
    const second = scheduler.tick();
    await Promise.resolve();
    expect(first).toBe(second);
    expect(repo.findQueuedJobs).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(stopped).toBe(true);
  });

  it("retries a failed worker only after durable lease recovery and within the attempt bound", async () => {
    const candidate = job();
    let attempts = 0;
    let status: "queued" | "running" | "failed" = "queued";
    const repo = repository({
      recoverExpiredJobs: vi.fn(async () => {
        if (status === "running") {
          status = attempts >= 3 ? "failed" : "queued";
          return [{ job: { ...candidate, status, attempts, leaseToken: null, leaseUntil: null } }];
        }
        return [];
      }),
      findQueuedJobs: vi.fn(async () => status === "queued" && attempts < 3 ? [{ ...candidate, status, attempts }] : []),
      claimJob: vi.fn(async () => {
        if (status !== "queued" || attempts >= 3) return null;
        status = "running";
        attempts += 1;
        return { ...candidate, status, attempts, leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() - 1) };
      })
    });
    const service = {
      runClaimedJob: vi.fn(async () => { throw new Error("operational failure"); }),
      publishRecoveredJob: vi.fn(),
      publishRecoveredList: vi.fn()
    };
    const scheduler = createLeadsScheduler({ repository: repo, service: service as any, now: () => now, maxAttempts: 3 });

    await scheduler.tick();
    expect(service.runClaimedJob).toHaveBeenCalledTimes(1);
    await scheduler.tick();
    expect(service.runClaimedJob).toHaveBeenCalledTimes(2);
    await scheduler.tick();
    expect(service.runClaimedJob).toHaveBeenCalledTimes(3);
    await scheduler.tick();
    expect(service.runClaimedJob).toHaveBeenCalledTimes(3);
    expect(attempts).toBe(3);
    expect(status).toBe("failed");
  });

  it("runs at most one Google scrape while starting non-Google work without starvation", async () => {
    const firstGoogle = job({ operation: "google_maps_search" });
    const secondGoogle = job({ id: randomUUID(), operation: "google_maps_search" });
    const receita = job({ id: randomUUID(), operation: "receita_search" });
    let releaseGoogle!: () => void;
    const googleRunning = new Promise<void>((resolve) => { releaseGoogle = resolve; });
    const claimed = new Set<string>();
    const repo = repository({
      findQueuedJobs: vi.fn(async () => [firstGoogle, secondGoogle, receita]),
      claimJob: vi.fn(async (_workspaceId: string, id: string) => {
        const candidate = [firstGoogle, secondGoogle, receita].find((entry) => entry.id === id);
        if (!candidate || claimed.has(id)) return null;
        claimed.add(id);
        return { ...candidate, status: "running", leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + 300_000) };
      })
    });
    const service = {
      runClaimedJob: vi.fn(async (candidate: LeadJob) => {
        if (candidate.operation === "google_maps_search") await googleRunning;
      }),
      publishRecoveredJob: vi.fn(),
      publishRecoveredList: vi.fn()
    };
    const scheduler = createLeadsScheduler({
      repository: repo,
      service: service as any,
      maxGoogleConcurrentJobs: 1,
      batchSize: 3,
      now: () => now
    });

    await scheduler.tick();

    expect(service.runClaimedJob).toHaveBeenCalledWith(expect.objectContaining({ id: firstGoogle.id }));
    expect(service.runClaimedJob).not.toHaveBeenCalledWith(expect.objectContaining({ id: secondGoogle.id }));
    expect(service.runClaimedJob).toHaveBeenCalledWith(expect.objectContaining({ id: receita.id }));
    releaseGoogle();
    await scheduler.stop();
  });
});
