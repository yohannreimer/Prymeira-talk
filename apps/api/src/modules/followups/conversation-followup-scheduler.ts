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

export interface ConversationFollowupReconciler {
  reconcileStaleProcessingFollowups(input: { now: Date }): Promise<{ reconciled: number }>;
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
  runtime?: ConversationFollowupSchedulerRuntime;
  reconciler?: ConversationFollowupReconciler;
  pollIntervalMs?: number;
  batchSize?: number;
  onError?: (error: unknown, followup?: DueConversationFollowup) => void;
}) {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_CONVERSATION_FOLLOWUP_POLL_INTERVAL_MS;
  const batchSize = input.batchSize ?? DEFAULT_CONVERSATION_FOLLOWUP_BATCH_SIZE;
  let timer: NodeJS.Timeout | null = null;
  let activePoll: Promise<Array<{ id: string; status: string }>> | null = null;
  let stopped = false;

  function reportError(error: unknown, followup?: DueConversationFollowup) {
    try {
      if (followup) {
        input.onError?.(error, followup);
      } else {
        input.onError?.(error);
      }
    } catch {
      // Reporting must not prevent future polls or shutdown from completing.
    }
  }

  async function executePoll(processInput: { now?: Date } = {}) {
    const now = processInput.now ?? new Date();
    try {
      await input.reconciler?.reconcileStaleProcessingFollowups({ now });
      if (!input.runtime) return [];
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
          reportError(error, followup);
          results.push({ id: followup.id, status: "failed" });
        }
      }

      return results;
    } catch (error) {
      reportError(error);
      return [];
    }
  }

  function processDueFollowups(processInput: { now?: Date } = {}) {
    if (activePoll) {
      return Promise.resolve([]);
    }

    const poll = executePoll(processInput);
    activePoll = poll;
    void poll.then(
      () => {
        if (activePoll === poll) activePoll = null;
      },
      () => {
        if (activePoll === poll) activePoll = null;
      }
    );
    return poll;
  }

  function start() {
    if (timer) {
      return;
    }

    stopped = false;
    timer = setInterval(() => {
      if (!stopped) {
        void processDueFollowups();
      }
    }, pollIntervalMs);
    timer.unref?.();
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    const poll = activePoll;
    if (poll) {
      await poll;
    }
  }

  return {
    processDueFollowups,
    start,
    stop
  };
}
