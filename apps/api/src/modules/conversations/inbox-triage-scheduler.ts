import { randomUUID } from "node:crypto";
import { Prisma, type Message, type PrismaClient } from "@prisma/client";
import type { InboxTriageClassifier } from "./inbox-triage-model.js";
import type { TriageMessage } from "./inbox-triage-policy.js";
import { nextInboxAnalysisAt, type InboxTriageObserver } from "./inbox-triage.service.js";

type DueItem = {
  id: string;
  workspaceId: string;
  conversationId: string;
  anchorMessageId: string | null;
  version: number;
  dueAt: Date | null;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? null;
}

export function toTriageMessage(message: Pick<Message,
  "id" | "direction" | "type" | "body" | "createdAt" | "sentByUserId" | "metadata" | "status"
>): TriageMessage {
  const metadata = object(message.metadata);
  const media = object(metadata.inboundMedia);
  const attachment = object(metadata.attachment);
  const assistantMedia = object(metadata.assistantMedia);
  const source = metadata.source;
  return {
    id: message.id,
    direction: message.direction,
    author: message.direction === "inbound" ? "cliente" :
      source === "ai_agent" || source === "agent" ? "empresa_ia" : "empresa_humano",
    type: message.type,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    caption: firstText(attachment.caption, metadata.caption),
    transcript: firstText(media.extractedText, media.text, metadata.transcript, object(assistantMedia.result).text),
    status: message.status,
    metadata: message.metadata
  };
}

const visibleMessageWhere = {
  type: { notIn: ["system", "internal_note"] as ["system", "internal_note"] },
  status: { not: "pending" as const }
};

export function createInboxTriageScheduler(input: {
  prisma: PrismaClient;
  classifier: InboxTriageClassifier;
  observer: InboxTriageObserver;
  onUpdate?: (workspaceId: string, conversationId: string) => Promise<void> | void;
  onError?: (error: unknown, conversationId?: string) => void;
  pollIntervalMs?: number;
}) {
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  let activePoll: Promise<void> | null = null;
  let fullScanCursor: string | null = null;
  let nextFullScanAt: Date | null = null;

  function report(error: unknown, conversationId?: string) {
    try { input.onError?.(error, conversationId); } catch { /* logging cannot stop polling */ }
  }

  async function release(item: DueItem, token: string, dueAt: Date | null) {
    await input.prisma.conversationInboxTriage.updateMany({
      where: { id: item.id, version: item.version, lockToken: token },
      data: { lockToken: null, lockedAt: null, dueAt }
    });
  }

  async function processItem(item: DueItem, now: Date) {
    const token = randomUUID();
    const claimed = await input.prisma.conversationInboxTriage.updateMany({
      where: { id: item.id, version: item.version, lockToken: null, dueAt: { lte: now } },
      data: { lockToken: token, lockedAt: now }
    });
    if (claimed.count !== 1) return;
    try {
      const current = await input.prisma.conversationInboxTriage.findUnique({ where: { id: item.id } });
      if (!current || current.lockToken !== token || current.version !== item.version ||
        current.anchorMessageId !== item.anchorMessageId) return;
      const conversation = await input.prisma.conversation.findUnique({
        where: { workspaceId_id: { workspaceId: item.workspaceId, id: item.conversationId } },
        select: { status: true, aiControlStatus: true }
      });
      if (!conversation || conversation.status === "closed" || conversation.aiControlStatus !== "human_controlled") {
        await release(item, token, null);
        return;
      }
      const recent = await input.prisma.message.findMany({
        where: { workspaceId: item.workspaceId, conversationId: item.conversationId, ...visibleMessageWhere },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20
      });
      const latest = recent[0];
      if (!latest || latest.id !== item.anchorMessageId || latest.direction !== "inbound") {
        if (latest) {
          await input.observer.observeMessage({
            workspaceId: item.workspaceId, conversationId: item.conversationId,
            messageId: latest.id, direction: latest.direction, observedAt: now
          });
        } else {
          await release(item, token, null);
        }
        return;
      }
      const result = await input.classifier.assess({
        workspaceId: item.workspaceId,
        anchorMessageId: latest.id,
        messages: recent.reverse().map(toTriageMessage)
      });
      if (result.anchorMessageId !== item.anchorMessageId) return;
      const saved = await input.prisma.$transaction(async (tx) => {
        const last = await tx.message.findFirst({
          where: { workspaceId: item.workspaceId, conversationId: item.conversationId, ...visibleMessageWhere },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, direction: true }
        });
        const control = await tx.conversation.findUnique({
          where: { workspaceId_id: { workspaceId: item.workspaceId, id: item.conversationId } },
          select: { status: true, aiControlStatus: true }
        });
        if (!last || last.id !== item.anchorMessageId || last.direction !== "inbound" ||
          !control || control.status === "closed" || control.aiControlStatus !== "human_controlled") return false;
        const updated = await tx.conversationInboxTriage.updateMany({
          where: {
            id: item.id, version: item.version, lockToken: token,
            anchorMessageId: item.anchorMessageId,
            dismissedMessageId: null
          },
          data: {
            decision: result.decision, reason: result.reason, model: result.model,
            analyzedAt: new Date(), dueAt: null, lockToken: null, lockedAt: null
          }
        });
        return updated.count === 1;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (saved) await input.onUpdate?.(item.workspaceId, item.conversationId);
    } catch (error) {
      report(error, item.conversationId);
      await release(item, token, new Date(Date.now() + 30_000));
    }
  }

  async function reconcileConversation(workspaceId: string, conversationId: string, now: Date) {
    const latest = await input.prisma.message.findFirst({
      where: { workspaceId, conversationId, ...visibleMessageWhere },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, direction: true }
    });
    if (!latest) return;
    const triage = await input.prisma.conversationInboxTriage.findUnique({
      where: { workspaceId_conversationId: { workspaceId, conversationId } },
      select: { id: true, lastObservedMessageId: true, anchorMessageId: true, decision: true, dueAt: true, version: true }
    });
    if (triage?.lastObservedMessageId !== latest.id) {
      await input.observer.observeMessage({ workspaceId, conversationId, messageId: latest.id, direction: latest.direction, observedAt: now });
      return;
    }
    if (latest.direction !== "inbound" || triage.decision || triage.dueAt || triage.anchorMessageId !== latest.id) return;
    const conversation = await input.prisma.conversation.findUnique({
      where: { workspaceId_id: { workspaceId, id: conversationId } },
      select: { status: true, aiControlStatus: true }
    });
    if (conversation?.status !== "closed" && conversation?.aiControlStatus === "human_controlled") {
      await input.prisma.conversationInboxTriage.updateMany({
        where: { id: triage.id, version: triage.version, decision: null, dueAt: null, anchorMessageId: latest.id },
        data: { dueAt: nextInboxAnalysisAt(now) }
      });
    }
  }

  async function reconcile(now: Date) {
    await input.prisma.conversationInboxTriage.updateMany({
      where: { lockedAt: { lt: new Date(now.getTime() - 60_000) } },
      data: { lockToken: null, lockedAt: null }
    });
    const recent = await input.prisma.message.findMany({
      where: { ...visibleMessageWhere, ingestedAt: { gte: new Date(now.getTime() - 15 * 60_000) } },
      orderBy: [{ ingestedAt: "desc" }, { id: "desc" }],
      select: { workspaceId: true, conversationId: true }, take: 100
    });
    const keys = new Set(recent.map((message) => `${message.workspaceId}:${message.conversationId}`));
    for (const key of keys) {
      const divider = key.indexOf(":");
      await reconcileConversation(key.slice(0, divider), key.slice(divider + 1), now);
    }
    if (fullScanCursor !== null || nextFullScanAt === null || now >= nextFullScanAt) {
      const page = await input.prisma.conversation.findMany({
        select: { id: true, workspaceId: true }, orderBy: { id: "asc" }, take: 50,
        ...(fullScanCursor ? { cursor: { id: fullScanCursor }, skip: 1 } : {})
      });
      for (const conversation of page) {
        await reconcileConversation(conversation.workspaceId, conversation.id, now);
      }
      fullScanCursor = page.length === 50 ? page.at(-1)!.id : null;
      if (!fullScanCursor) nextFullScanAt = new Date(now.getTime() + 10 * 60_000);
    }
  }

  async function execute(now: Date, shouldReconcile: boolean) {
    if (shouldReconcile) {
      try { await reconcile(now); } catch (error) { report(error); }
    }
    const due = await input.prisma.conversationInboxTriage.findMany({
      where: { dueAt: { lte: now }, lockToken: null },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }], take: 20,
      select: { id: true, workspaceId: true, conversationId: true, anchorMessageId: true, version: true, dueAt: true }
    });
    for (let start = 0; start < due.length; start += 3) {
      await Promise.all(due.slice(start, start + 3).map((item) => processItem(item, now).catch((error) => report(error, item.conversationId))));
    }
  }

  function processDue(options: { now?: Date; reconcile?: boolean } = {}) {
    if (activePoll) return activePoll;
    const poll = execute(options.now ?? new Date(), options.reconcile !== false);
    activePoll = poll;
    void poll.then(
      () => { if (activePoll === poll) activePoll = null; },
      () => { if (activePoll === poll) activePoll = null; }
    );
    return poll;
  }

  function start() {
    if (timer) return;
    void processDue().catch((error) => report(error));
    timer = setInterval(() => { void processDue().catch((error) => report(error)); }, pollIntervalMs);
    timer.unref?.();
  }

  async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    await activePoll;
  }

  return { processDue, start, stop };
}
