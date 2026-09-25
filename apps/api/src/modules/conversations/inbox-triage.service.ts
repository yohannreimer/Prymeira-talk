import { Prisma, type PrismaClient } from "@prisma/client";

export type InboxTriageObserver = {
  observeMessage(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    direction: "inbound" | "outbound";
    observedAt: Date;
  }): Promise<void>;
};

export class InboxTriageConflictError extends Error {
  statusCode = 409 as const;
  code = "INBOX_TRIAGE_CONFLICT" as const;
  constructor() {
    super("The conversation changed. Refresh it and try again.");
  }
}

export class InboxTriageNotFoundError extends Error {
  statusCode = 404 as const;
  code = "INBOX_TRIAGE_NOT_FOUND" as const;
  constructor() {
    super("Conversation not found.");
  }
}

type ObservationState = {
  lastObservedMessageId: string | null;
  anchorMessageId: string | null;
  decision: "needs_reply" | "no_reply" | "uncertain" | null;
  reason: string | null;
  model: string | null;
  analyzedAt: Date | null;
  dismissedMessageId: string | null;
  dismissedAt: Date | null;
  dueAt: Date | null;
  lockToken: string | null;
  lockedAt: Date | null;
  version: number;
};

export function nextInboxAnalysisAt(observedAt: Date) {
  return new Date(observedAt.getTime() + 120_000);
}

export function observationChange(input: {
  current: ObservationState | null;
  messageId: string;
  direction: "inbound" | "outbound";
  humanControlled: boolean;
  observedAt: Date;
}): ObservationState | null {
  if (input.current?.lastObservedMessageId === input.messageId) return null;
  return {
    lastObservedMessageId: input.messageId,
    anchorMessageId: input.direction === "inbound" ? input.messageId : null,
    decision: null,
    reason: null,
    model: null,
    analyzedAt: null,
    dismissedMessageId: null,
    dismissedAt: null,
    dueAt: input.direction === "inbound" && input.humanControlled
      ? nextInboxAnalysisAt(input.observedAt) : null,
    lockToken: null,
    lockedAt: null,
    version: (input.current?.version ?? 0) + 1
  };
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || error.code === "P2002");
}

async function serializableRetry<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (!retryable(error)) throw error;
    return run();
  }
}

export function createInboxTriageService(prisma: PrismaClient): InboxTriageObserver & {
  setManualMark(input: { workspaceId: string; conversationId: string; actorId: string; marked: boolean }): Promise<void>;
  dismiss(input: { workspaceId: string; conversationId: string; expectedAnchorMessageId: string }): Promise<void>;
  undoDismiss(input: { workspaceId: string; conversationId: string; expectedAnchorMessageId: string }): Promise<void>;
} {
  async function assertConversation(workspaceId: string, conversationId: string) {
    const conversation = await prisma.conversation.findUnique({
      where: { workspaceId_id: { workspaceId, id: conversationId } },
      select: { id: true }
    });
    if (!conversation) throw new InboxTriageNotFoundError();
  }

  return {
    async observeMessage(input) {
      await serializableRetry(() => prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.findUnique({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
          select: { aiControlStatus: true }
        });
        if (!conversation) return;
        // A later message can already be stored when a slow webhook calls us.
        const latest = await tx.message.findFirst({
          where: {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            type: { notIn: ["system", "internal_note"] },
            status: { not: "pending" }
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, direction: true }
        });
        if (!latest || latest.id !== input.messageId || latest.direction !== input.direction) return;

        const key = { workspaceId: input.workspaceId, conversationId: input.conversationId };
        const current = await tx.conversationInboxTriage.findUnique({
          where: { workspaceId_conversationId: key }
        });
        const change = observationChange({
          current, messageId: input.messageId, direction: input.direction,
          humanControlled: conversation.aiControlStatus === "human_controlled",
          observedAt: input.observedAt
        });
        if (!change) return;
        if (current) {
          await tx.conversationInboxTriage.update({
            where: { id: current.id }, data: change
          });
        } else {
          await tx.conversationInboxTriage.create({ data: { ...key, ...change } });
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async setManualMark(input) {
      await assertConversation(input.workspaceId, input.conversationId);
      const key = { workspaceId: input.workspaceId, conversationId: input.conversationId };
      const data = input.marked
        ? { manualMarkedAt: new Date(), manualMarkedById: input.actorId }
        : { manualMarkedAt: null, manualMarkedById: null };
      await prisma.conversationInboxTriage.upsert({
        where: { workspaceId_conversationId: key },
        create: { ...key, ...data }, update: data
      });
    },

    async dismiss(input) {
      await assertConversation(input.workspaceId, input.conversationId);
      const result = await prisma.conversationInboxTriage.updateMany({
        where: {
          workspaceId: input.workspaceId, conversationId: input.conversationId,
          anchorMessageId: input.expectedAnchorMessageId,
          decision: { in: ["needs_reply", "uncertain"] },
          dismissedMessageId: null
        },
        data: { dismissedMessageId: input.expectedAnchorMessageId, dismissedAt: new Date() }
      });
      if (result.count !== 1) throw new InboxTriageConflictError();
    },

    async undoDismiss(input) {
      await assertConversation(input.workspaceId, input.conversationId);
      const result = await prisma.conversationInboxTriage.updateMany({
        where: {
          workspaceId: input.workspaceId, conversationId: input.conversationId,
          anchorMessageId: input.expectedAnchorMessageId,
          dismissedMessageId: input.expectedAnchorMessageId,
          dismissedAt: { gte: new Date(Date.now() - 10_000) }
        },
        data: { dismissedMessageId: null, dismissedAt: null }
      });
      if (result.count !== 1) throw new InboxTriageConflictError();
    }
  };
}
