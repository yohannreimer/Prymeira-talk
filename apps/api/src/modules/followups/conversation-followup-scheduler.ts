type DueConversationFollowup = {
  id: string;
  workspaceId: string;
};

export interface ConversationFollowupSchedulerPrismaLike {
  conversationFollowup: {
    findMany(args: unknown): Promise<DueConversationFollowup[]>;
  };
}

export interface ConversationFollowupSchedulerRuntime {
  runFollowup(input: {
    workspaceId: string;
    followupId: string;
  }): Promise<{ status: string }>;
}

export const DEFAULT_CONVERSATION_FOLLOWUP_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_CONVERSATION_FOLLOWUP_BATCH_SIZE = 20;

/**
 * Finds due follow-ups and delegates their atomic claim and processing to the
 * follow-up runtime. This scheduler deliberately never changes follow-up
 * status: multiple application instances may observe the same record, but
 * only the runtime's claim may proceed with delivery.
 */
export function createConversationFollowupScheduler(input: {
  prisma: ConversationFollowupSchedulerPrismaLike;
  runtime: ConversationFollowupSchedulerRuntime;
  pollIntervalMs?: number;
  batchSize?: number;
  onError?: (error: unknown, followup: DueConversationFollowup) => void;
}) {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_CONVERSATION_FOLLOWUP_POLL_INTERVAL_MS;
  const batchSize = input.batchSize ?? DEFAULT_CONVERSATION_FOLLOWUP_BATCH_SIZE;
  let timer: NodeJS.Timeout | null = null;
  let isProcessing = false;

  async function processDueFollowups(processInput: { now?: Date } = {}) {
    if (isProcessing) {
      return [];
    }

    isProcessing = true;
    const now = processInput.now ?? new Date();

    try {
      const followups = await input.prisma.conversationFollowup.findMany({
        where: {
          status: "scheduled",
          activeKey: "active",
          lockedAt: null,
          scheduledAt: { lte: now }
        },
        orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
        take: batchSize
      });
      const results: Array<{ id: string; status: string }> = [];

      for (const followup of followups) {
        try {
          const result = await input.runtime.runFollowup({
            workspaceId: followup.workspaceId,
            followupId: followup.id
          });
          results.push({ id: followup.id, status: result.status });
        } catch (error) {
          try {
            input.onError?.(error, followup);
          } catch {
            // Reporting must not prevent the remainder of the batch from running.
          }
          results.push({ id: followup.id, status: "failed" });
        }
      }

      return results;
    } finally {
      isProcessing = false;
    }
  }

  function start() {
    if (timer) {
      return;
    }

    timer = setInterval(() => {
      void processDueFollowups();
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) {
      return;
    }

    clearInterval(timer);
    timer = null;
  }

  return {
    processDueFollowups,
    start,
    stop
  };
}
