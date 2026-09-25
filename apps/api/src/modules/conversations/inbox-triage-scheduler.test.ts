import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createInboxTriageScheduler } from "./inbox-triage-scheduler.js";

describe("inbox triage scheduler", () => {
  it("claims due work once and ignores a losing worker", async () => {
    const due = {
      id: "t1", workspaceId: "w", conversationId: "c", anchorMessageId: "m1",
      version: 2, dueAt: new Date("2026-09-25T12:02:00Z"), lockToken: null
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      conversationInboxTriage: {
        updateMany,
        findMany: vi.fn().mockResolvedValue([due])
      },
      conversation: { findMany: vi.fn().mockResolvedValue([]) }
    } as unknown as PrismaClient;
    const assess = vi.fn();
    const scheduler = createInboxTriageScheduler({ prisma, classifier: { assess }, observer: { observeMessage: vi.fn() } });
    await scheduler.processDue({ now: new Date("2026-09-25T12:03:00Z"), reconcile: false });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: "t1", version: 2, lockToken: null
    }) }));
    expect(assess).not.toHaveBeenCalled();
  });

  it("does not classify after a newer inbound wins the anchor", async () => {
    const due = {
      id: "t1", workspaceId: "w", conversationId: "c", anchorMessageId: "m1",
      version: 2, dueAt: new Date("2026-09-25T12:02:00Z"), lockToken: null
    };
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
    const prisma = {
      conversationInboxTriage: {
        updateMany, findMany: vi.fn().mockResolvedValue([due]),
        findUnique: vi.fn().mockResolvedValue({ ...due, lockToken: "other-token" })
      },
      conversation: { findMany: vi.fn().mockResolvedValue([]) }
    } as unknown as PrismaClient;
    const assess = vi.fn();
    const scheduler = createInboxTriageScheduler({ prisma, classifier: { assess }, observer: { observeMessage: vi.fn() } });
    await scheduler.processDue({ now: new Date("2026-09-25T12:03:00Z"), reconcile: false });
    expect(assess).not.toHaveBeenCalled();
  });

  it("saves only a result whose latest message and human control are still current", async () => {
    const due = {
      id: "t1", workspaceId: "w", conversationId: "c", anchorMessageId: "m1",
      version: 2, dueAt: new Date("2026-09-25T12:02:00Z"), lockToken: null
    };
    let token = "";
    const updateMany = vi.fn(async (args: { data: { lockToken?: string | null } }) => {
      if (args.data.lockToken) token = args.data.lockToken;
      return { count: 1 };
    });
    const message = {
      id: "m1", workspaceId: "w", conversationId: "c", direction: "inbound", type: "text",
      body: "Pode orçar?", createdAt: new Date("2026-09-25T12:00:00Z"),
      sentByUserId: null, metadata: {}, status: "delivered"
    };
    const tx = {
      message: { findFirst: vi.fn().mockResolvedValue({ id: "m1", direction: "inbound" }) },
      conversation: { findUnique: vi.fn().mockResolvedValue({ status: "open", aiControlStatus: "human_controlled" }) },
      conversationInboxTriage: { updateMany }
    };
    const prisma = {
      conversationInboxTriage: {
        updateMany, findMany: vi.fn().mockResolvedValue([due]),
        findUnique: vi.fn().mockImplementation(async () => ({ ...due, lockToken: token }))
      },
      conversation: { findUnique: tx.conversation.findUnique },
      message: { findMany: vi.fn().mockResolvedValue([message]) },
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    } as unknown as PrismaClient;
    const assess = vi.fn().mockResolvedValue({
      decision: "needs_reply", reason: "Pedido de orçamento", model: "test", anchorMessageId: "m1"
    });
    const onUpdate = vi.fn();
    const scheduler = createInboxTriageScheduler({ prisma, classifier: { assess }, observer: { observeMessage: vi.fn() }, onUpdate });
    await scheduler.processDue({ now: new Date("2026-09-25T12:03:00Z"), reconcile: false });
    expect(assess).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({
      decision: "needs_reply", dueAt: null, lockToken: null
    }) }));
    expect(onUpdate).toHaveBeenCalledWith("w", "c");

    tx.message.findFirst.mockResolvedValueOnce({ id: "m2", direction: "inbound" });
    onUpdate.mockClear();
    await scheduler.processDue({ now: new Date("2026-09-25T12:04:00Z"), reconcile: false });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
