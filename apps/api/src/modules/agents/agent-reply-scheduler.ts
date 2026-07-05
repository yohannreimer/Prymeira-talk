type JsonValue = unknown;

type ActiveConversationRecord = {
  id: string;
  workspaceId: string;
  aiControlStatus: string;
  activeAgentSessionId?: string | null;
  activeAgentSession?: {
    id: string;
    agentId: string;
    status: string;
    metadata?: JsonValue;
  } | null;
};

type PendingReplyRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  sessionId?: string | null;
  lastMessageId: string;
  instruction?: string | null;
  attempts: number;
};

export interface AgentReplySchedulerPrismaLike {
  conversation: {
    findUnique(args: unknown): Promise<ActiveConversationRecord | null>;
  };
  aiAgentPendingReply: {
    upsert(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<PendingReplyRecord[]>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
}

export interface AgentReplySchedulerRuntime {
  runForMessage(input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    messageId: string;
    trigger: "automation";
    instruction?: string | null;
  }): Promise<{
    status: "completed" | "handoff_requested" | "skipped" | "failed";
    runId?: string;
    message?: string;
  }>;
}

export const DEFAULT_AGENT_REPLY_DEBOUNCE_MS = 40_000;

export function createAgentReplyScheduler(input: {
  prisma: AgentReplySchedulerPrismaLike;
  agentRuntime: AgentReplySchedulerRuntime;
  debounceMs?: number;
  pollIntervalMs?: number;
  batchSize?: number;
}) {
  const debounceMs = input.debounceMs ?? DEFAULT_AGENT_REPLY_DEBOUNCE_MS;
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  const batchSize = input.batchSize ?? 20;
  let timer: NodeJS.Timeout | null = null;
  let isProcessing = false;

  async function scheduleActiveSessionForMessage(scheduleInput: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    now?: Date;
  }) {
    const conversation = await input.prisma.conversation.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: scheduleInput.workspaceId,
          id: scheduleInput.conversationId
        }
      },
      include: {
        activeAgentSession: true
      }
    });

    if (
      !conversation?.activeAgentSession ||
      conversation.aiControlStatus === "human_controlled" ||
      conversation.activeAgentSession.status !== "active"
    ) {
      return { scheduled: false as const };
    }

    const now = scheduleInput.now ?? new Date();
    const scheduledAt = new Date(now.getTime() + debounceMs);
    const session = conversation.activeAgentSession;
    const instruction = readInstruction(session.metadata);

    await input.prisma.aiAgentPendingReply.upsert({
      where: {
        workspaceId_conversationId: {
          workspaceId: scheduleInput.workspaceId,
          conversationId: scheduleInput.conversationId
        }
      },
      create: {
        workspaceId: scheduleInput.workspaceId,
        conversationId: scheduleInput.conversationId,
        agentId: session.agentId,
        sessionId: session.id,
        lastMessageId: scheduleInput.messageId,
        instruction,
        scheduledAt,
        status: "pending"
      },
      update: {
        agentId: session.agentId,
        sessionId: session.id,
        lastMessageId: scheduleInput.messageId,
        instruction,
        scheduledAt,
        status: "pending",
        lockedAt: null,
        lastError: null
      }
    });

    return { scheduled: true as const, scheduledAt };
  }

  async function processDueReplies(processInput: { now?: Date } = {}) {
    if (isProcessing) {
      return [];
    }

    isProcessing = true;
    const now = processInput.now ?? new Date();

    try {
      const pendingReplies = await input.prisma.aiAgentPendingReply.findMany({
        where: {
          status: "pending",
          scheduledAt: { lte: now }
        },
        orderBy: [{ scheduledAt: "asc" }],
        take: batchSize
      });
      const results: Array<{ id: string; status: string; runId?: string }> = [];

      for (const pendingReply of pendingReplies) {
        await input.prisma.aiAgentPendingReply.update({
          where: {
            workspaceId_id: {
              workspaceId: pendingReply.workspaceId,
              id: pendingReply.id
            }
          },
          data: {
            status: "processing",
            lockedAt: now,
            attempts: { increment: 1 }
          }
        });

        try {
          const run = await input.agentRuntime.runForMessage({
            workspaceId: pendingReply.workspaceId,
            agentId: pendingReply.agentId,
            conversationId: pendingReply.conversationId,
            messageId: pendingReply.lastMessageId,
            trigger: "automation",
            instruction: pendingReply.instruction ?? null
          });
          const terminalStatus =
            run.status === "failed" || run.status === "skipped" ? run.status : "completed";
          const terminalError =
            run.status === "failed" || run.status === "skipped"
              ? run.message ?? `Agent reply ${run.status}.`
              : null;

          await input.prisma.aiAgentPendingReply.updateMany({
            where: {
              workspaceId: pendingReply.workspaceId,
              id: pendingReply.id,
              status: "processing",
              lockedAt: now
            },
            data: {
              status: terminalStatus,
              lockedAt: null,
              lastError: terminalError
            }
          });
          results.push({ id: pendingReply.id, status: run.status, runId: run.runId });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Agent reply processing failed.";
          await input.prisma.aiAgentPendingReply.updateMany({
            where: {
              workspaceId: pendingReply.workspaceId,
              id: pendingReply.id,
              status: "processing",
              lockedAt: now
            },
            data: {
              status: "failed",
              lockedAt: null,
              lastError: message
            }
          });
          results.push({ id: pendingReply.id, status: "failed" });
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
      void processDueReplies();
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
    scheduleActiveSessionForMessage,
    processDueReplies,
    start,
    stop
  };
}

function readInstruction(metadata: JsonValue) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const instruction = (metadata as Record<string, unknown>).instruction;
  return typeof instruction === "string" && instruction.trim().length > 0
    ? instruction.trim()
    : null;
}
