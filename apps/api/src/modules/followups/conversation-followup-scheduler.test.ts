import { describe, expect, it, vi } from "vitest";
import { createConversationFollowupScheduler } from "./conversation-followup-scheduler.js";

const ids = {
  workspace: "workspace_a",
  first: "00000000-0000-4000-8000-000000000101",
  second: "00000000-0000-4000-8000-000000000102"
};

function buildPrisma(followups: Array<{ id: string; workspaceId: string }> = []) {
  return {
    conversationFollowup: {
      findMany: vi.fn().mockResolvedValue(followups)
    }
  };
}

describe("createConversationFollowupScheduler", () => {
  it("screens candidates in the background after processing due sends", async () => {
    const due = { id: ids.first, workspaceId: ids.workspace };
    const candidate = { id: ids.second, workspaceId: ids.workspace };
    const prisma = {
      conversationFollowup: {
        findMany: vi.fn().mockImplementation(async (args: any) =>
          args.where.status === "scheduled" ? [due] : [candidate])
      }
    };
    const calls: string[] = [];
    const scheduler = createConversationFollowupScheduler({
      prisma,
      runtime: { runFollowup: vi.fn().mockImplementation(async () => { calls.push("send"); return { status: "sent" }; }) },
      evaluator: { evaluateCandidate: vi.fn().mockImplementation(async () => { calls.push("evaluate"); return { status: "skipped" }; }) }
    });

    await expect(scheduler.processDueFollowups()).resolves.toEqual([
      { id: ids.first, status: "sent" },
      { id: ids.second, status: "skipped" }
    ]);
    expect(calls).toEqual(["send", "evaluate"]);
  });

  it("reconciles stale processing leases before polling and never dispatches them", async () => {
    const prisma = buildPrisma([]);
    const reconcileStaleProcessingFollowups = vi.fn().mockResolvedValue({ reconciled: 2 });
    const runFollowup = vi.fn();
    const scheduler = createConversationFollowupScheduler({
      prisma,
      runtime: { runFollowup },
      reconciler: { reconcileStaleProcessingFollowups }
    });
    const now = new Date("2026-09-22T12:00:00.000Z");

    await expect(scheduler.processDueFollowups({ now })).resolves.toEqual([]);
    expect(reconcileStaleProcessingFollowups).toHaveBeenCalledWith({ now });
    expect(runFollowup).not.toHaveBeenCalled();
  });

  it("screens separate candidates concurrently while keeping one active poll", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prisma = buildPrisma([
      { id: ids.first, workspaceId: ids.workspace },
      { id: ids.second, workspaceId: ids.workspace }
    ]);
    const evaluateCandidate = vi.fn().mockImplementation(async () => {
      await gate;
      return { status: "scheduled" };
    });
    const scheduler = createConversationFollowupScheduler({ prisma, evaluator: { evaluateCandidate } });
    const poll = scheduler.processDueFollowups();
    await vi.waitFor(() => expect(evaluateCandidate).toHaveBeenCalledTimes(2));
    await expect(scheduler.processDueFollowups()).resolves.toEqual([]);
    release?.();
    await expect(poll).resolves.toEqual([
      { id: ids.first, status: "scheduled" }, { id: ids.second, status: "scheduled" }
    ]);
  });

  it("selects due scheduled follow-ups in a bounded, stable order and runs each one", async () => {
    const first = { id: ids.first, workspaceId: ids.workspace };
    const second = { id: ids.second, workspaceId: ids.workspace };
    const prisma = buildPrisma([first, second]);
    const runFollowup = vi
      .fn()
      .mockResolvedValueOnce({ status: "sent" })
      .mockResolvedValueOnce({ status: "review" });
    const scheduler = createConversationFollowupScheduler({
      prisma,
      runtime: { runFollowup },
      batchSize: 2
    });
    const now = new Date("2026-09-22T12:00:00.000Z");

    await expect(scheduler.processDueFollowups({ now })).resolves.toEqual([
      { id: ids.first, status: "sent" },
      { id: ids.second, status: "review" }
    ]);

    expect(prisma.conversationFollowup.findMany).toHaveBeenCalledWith({
      where: {
        status: "scheduled",
        activeKey: "active",
        lockedAt: null,
        scheduledAt: { lte: now }
      },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
      take: 2
    });
    expect(runFollowup).toHaveBeenNthCalledWith(1, {
      workspaceId: ids.workspace,
      followupId: ids.first
    });
    expect(runFollowup).toHaveBeenNthCalledWith(2, {
      workspaceId: ids.workspace,
      followupId: ids.second
    });
  });

  it("does not process the same due batch concurrently", async () => {
    let release: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prisma = buildPrisma([{ id: ids.first, workspaceId: ids.workspace }]);
    const runFollowup = vi.fn().mockImplementation(async () => {
      await completed;
      return { status: "sent" };
    });
    const scheduler = createConversationFollowupScheduler({ prisma, runtime: { runFollowup } });

    const firstRun = scheduler.processDueFollowups();
    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(1));

    await expect(scheduler.processDueFollowups()).resolves.toEqual([]);
    expect(prisma.conversationFollowup.findMany).toHaveBeenCalledTimes(1);

    release?.();
    await expect(firstRun).resolves.toEqual([{ id: ids.first, status: "sent" }]);
  });

  it("isolates runtime errors so later due follow-ups still run", async () => {
    const first = { id: ids.first, workspaceId: ids.workspace };
    const second = { id: ids.second, workspaceId: ids.workspace };
    const prisma = buildPrisma([first, second]);
    const failure = new Error("temporary database failure");
    const onError = vi.fn();
    const runFollowup = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ status: "sent" });
    const scheduler = createConversationFollowupScheduler({
      prisma,
      runtime: { runFollowup },
      onError
    });

    await expect(scheduler.processDueFollowups()).resolves.toEqual([
      { id: ids.first, status: "failed" },
      { id: ids.second, status: "sent" }
    ]);

    expect(onError).toHaveBeenCalledWith(failure, first);
    expect(runFollowup).toHaveBeenCalledTimes(2);
  });

  it("contains poll-level database errors from the scheduled callback", async () => {
    vi.useFakeTimers();
    const failure = new Error("database unavailable");
    const prisma = {
      conversationFollowup: {
        findMany: vi.fn().mockRejectedValue(failure)
      }
    };
    const onError = vi.fn();
    const scheduler = createConversationFollowupScheduler({
      prisma,
      runtime: { runFollowup: vi.fn() },
      onError
    });

    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(onError).toHaveBeenCalledWith(failure);
    } finally {
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("drains an active poll before stop resolves", async () => {
    let release: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prisma = buildPrisma([{ id: ids.first, workspaceId: ids.workspace }]);
    const runFollowup = vi.fn().mockImplementation(async () => {
      await completed;
      return { status: "sent" };
    });
    const scheduler = createConversationFollowupScheduler({ prisma, runtime: { runFollowup } });

    const poll = scheduler.processDueFollowups();
    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = Promise.resolve(scheduler.stop()).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release?.();
    await poll;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("starts one unref'd polling interval and stops it cleanly", async () => {
    vi.useFakeTimers();
    const prisma = buildPrisma([{ id: ids.first, workspaceId: ids.workspace }]);
    const runFollowup = vi.fn().mockResolvedValue({ status: "sent" });
    const scheduler = createConversationFollowupScheduler({
      prisma,
      runtime: { runFollowup },
      pollIntervalMs: 1_000
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runFollowup).toHaveBeenCalledTimes(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runFollowup).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
