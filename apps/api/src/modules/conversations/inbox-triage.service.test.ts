import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createInboxTriageService, InboxTriageConflictError, nextInboxAnalysisAt, observationChange } from "./inbox-triage.service.js";

describe("inbox triage observation", () => {
  const at = new Date("2026-09-25T12:00:00.000Z");

  it("uses a sliding two-minute window for human inbound messages", () => {
    expect(nextInboxAnalysisAt(at).toISOString()).toBe("2026-09-25T12:02:00.000Z");
    const first = observationChange({ current: null, messageId: "m1", direction: "inbound", humanControlled: true, observedAt: at });
    expect(first).toMatchObject({ anchorMessageId: "m1", version: 1, decision: null });
    expect(first?.dueAt?.toISOString()).toBe("2026-09-25T12:02:00.000Z");
    const second = observationChange({ current: first!, messageId: "m2", direction: "inbound", humanControlled: true, observedAt: new Date("2026-09-25T12:01:00.000Z") });
    expect(second?.dueAt?.toISOString()).toBe("2026-09-25T12:03:00.000Z");
    expect(second?.version).toBe(2);
  });

  it("does not rerun for duplicate ids, and removes dismissal only on a new inbound", () => {
    const prior = {
      lastObservedMessageId: "m1", version: 5, anchorMessageId: "m1",
      decision: "needs_reply" as const, reason: "Pedido", model: "luna", analyzedAt: at,
      dismissedMessageId: "m1", dismissedAt: at, dueAt: null, lockToken: null, lockedAt: null
    };
    expect(observationChange({ current: prior, messageId: "m1", direction: "inbound", humanControlled: true, observedAt: at })).toBeNull();
    const next = observationChange({ current: prior, messageId: "m2", direction: "inbound", humanControlled: true, observedAt: at });
    expect(next).toMatchObject({ anchorMessageId: "m2", dismissedMessageId: null, decision: null, version: 6 });
  });

  it("clears semantic pending on outbound without clearing the manual mark", () => {
    const prior = {
      lastObservedMessageId: "m1", version: 1, anchorMessageId: "m1",
      decision: "needs_reply" as const, reason: "Pedido", model: "luna", analyzedAt: at,
      dismissedMessageId: null, dismissedAt: null, dueAt: at, lockToken: "lock", lockedAt: at
    };
    expect(observationChange({ current: prior, messageId: "m2", direction: "outbound", humanControlled: true, observedAt: at })).toMatchObject({
      anchorMessageId: null, decision: null, dueAt: null, lockToken: null, version: 2
    });
  });

  it("does not schedule normal AI traffic", () => {
    expect(observationChange({ current: null, messageId: "m1", direction: "inbound", humanControlled: false, observedAt: at })?.dueAt).toBeNull();
  });

  it("observes only the latest persisted message and is idempotent", async () => {
    const tx = {
      conversation: { findUnique: vi.fn().mockResolvedValue({ aiControlStatus: "human_controlled" }) },
      message: { findFirst: vi.fn().mockResolvedValue({ id: "m1", direction: "inbound" }) },
      conversationInboxTriage: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}), update: vi.fn()
      }
    };
    const prisma = { $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as unknown as PrismaClient;
    const service = createInboxTriageService(prisma);
    await service.observeMessage({ workspaceId: "w", conversationId: "c", messageId: "m1", direction: "inbound", observedAt: at });
    expect(tx.conversationInboxTriage.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      workspaceId: "w", conversationId: "c", anchorMessageId: "m1", dueAt: nextInboxAnalysisAt(at)
    }) });
    tx.conversationInboxTriage.findUnique.mockResolvedValueOnce({
      lastObservedMessageId: "m1", version: 1
    });
    await service.observeMessage({ workspaceId: "w", conversationId: "c", messageId: "m1", direction: "inbound", observedAt: at });
    expect(tx.conversationInboxTriage.create).toHaveBeenCalledTimes(1);
    expect(tx.conversationInboxTriage.update).not.toHaveBeenCalled();
    tx.message.findFirst.mockResolvedValueOnce({ id: "m2", direction: "inbound" });
    await service.observeMessage({ workspaceId: "w", conversationId: "c", messageId: "m1", direction: "inbound", observedAt: at });
    expect(tx.conversationInboxTriage.create).toHaveBeenCalledTimes(1);
  });

  it("guards manual dismissal by workspace, anchor, and ten-second undo window", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      conversation: { findUnique: vi.fn().mockResolvedValue({ id: "c" }) },
      conversationInboxTriage: { updateMany, upsert: vi.fn().mockResolvedValue({}) }
    } as unknown as PrismaClient;
    const service = createInboxTriageService(prisma);
    await service.setManualMark({ workspaceId: "w", conversationId: "c", actorId: "u", marked: true });
    expect(prisma.conversationInboxTriage.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ manualMarkedById: "u" })
    }));
    await service.dismiss({ workspaceId: "w", conversationId: "c", expectedAnchorMessageId: "m1" });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      workspaceId: "w", conversationId: "c", anchorMessageId: "m1", dismissedMessageId: null
    }) }));
    await service.undoDismiss({ workspaceId: "w", conversationId: "c", expectedAnchorMessageId: "m1" });
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({
      dismissedMessageId: "m1", dismissedAt: { gte: expect.any(Date) }
    }) }));
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.dismiss({ workspaceId: "w", conversationId: "c", expectedAnchorMessageId: "old" }))
      .rejects.toBeInstanceOf(InboxTriageConflictError);
  });
});
