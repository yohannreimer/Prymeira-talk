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
