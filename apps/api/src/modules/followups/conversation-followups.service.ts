import { agentFollowupConfigSchema } from "@prymeira-talk/shared";
import { addBusinessMinutes } from "./business-time.js";

type FollowupActivityDirection = "inbound" | "outbound";
export type FollowupActivitySource = "customer" | "human" | "agent";
type ActiveFollowupStatus = "scheduled" | "processing" | "review";

type AgentRecord = {
  id: string;
  workspaceId: string;
  status: string;
  behaviorConfig: unknown;
};

type AgentSessionRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  status: string;
  updatedAt?: Date | string;
  agent?: AgentRecord | null;
};

type ConversationRecord = {
  id: string;
  workspaceId: string;
  status: string;
  aiControlStatus: string;
  activeAgentSessionId?: string | null;
  activeAgentSession?: AgentSessionRecord | null;
};

type MessageRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  direction: FollowupActivityDirection;
  createdAt: Date | string;
  ingestedAt: Date | string | null;
};

export type ConversationFollowupRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  sessionId: string | null;
  kind: "qualification" | "human_commercial";
  status: string;
  activeKey: string | null;
  stepIndex: number;
  anchorMessageId: string;
  anchorMessageAt: Date | string;
  anchorIngestedAt: Date | string;
  scheduledAt: Date | string;
  decision: unknown;
  reason?: string | null;
  cancelledAt?: Date | string | null;
};

type ConversationFollowupStore = {
  findFirst(args: unknown): Promise<ConversationFollowupRecord | null>;
  updateMany(args: unknown): Promise<{ count: number }>;
  create(args: unknown): Promise<ConversationFollowupRecord>;
};

type ConversationFollowupsTransaction = {
  conversationFollowup: ConversationFollowupStore;
};

export type ConversationFollowupsPrismaLike = {
  $transaction<T>(
    callback: (tx: ConversationFollowupsTransaction) => Promise<T>
  ): Promise<T>;
  conversation: {
    findUnique(args: unknown): Promise<ConversationRecord | null>;
  };
  message: {
    findFirst(args: unknown): Promise<MessageRecord | null>;
  };
  aiAgentSession: {
    findFirst(args: unknown): Promise<AgentSessionRecord | null>;
  };
  conversationFollowup: ConversationFollowupStore;
};

export type ObserveConversationActivityInput = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  direction: FollowupActivityDirection;
  source: FollowupActivitySource;
};

export type ObserveConversationActivityResult = {
  status: "scheduled" | "cancelled" | "ignored";
  followupId?: string;
};

export type ActiveFollowupContext = {
  followup: ConversationFollowupRecord;
  conversation: ConversationRecord;
  session: AgentSessionRecord;
  agent: AgentRecord;
};

export type RevalidateActiveFollowupResult =
  | { status: "missing" }
  | {
      status: "cancelled";
      reason:
        | "not_active"
        | "conversation_missing"
        | "conversation_closed"
        | "human_controlled"
        | "customer_replied"
        | "outbound_replaced"
        | "session_context_changed";
      followup: ConversationFollowupRecord;
      conversation?: ConversationRecord;
    }
  | { status: "valid"; context: ActiveFollowupContext };

export type ConversationFollowupsObserver = Pick<
  ReturnType<typeof createConversationFollowupsService>,
  "observeConversationActivity"
>;

export type CompleteAutomaticFollowupResult =
  | { status: "sent" }
  | { status: "scheduled"; followupId: string }
  | { status: "not_active" };

export const MAX_AUTOMATIC_FOLLOWUP_STEPS = 3;

const ACTIVE_FOLLOWUP_STATUSES: ActiveFollowupStatus[] = ["scheduled", "processing", "review"];
const MAX_UNIQUE_CONFLICT_RETRIES = 3;

export function createConversationFollowupsService(prisma: ConversationFollowupsPrismaLike) {
  async function observeConversationActivity(
    input: ObserveConversationActivityInput
  ): Promise<ObserveConversationActivityResult> {
    if (input.direction === "inbound" && input.source === "customer") {
      const customerMessage = await findPersistedCustomerInboundMessage(prisma, input);
      if (!customerMessage?.ingestedAt) {
        return { status: "ignored" };
      }

      return cancelForCustomerReply(prisma, input, customerMessage.ingestedAt);
    }

    if (
      input.direction !== "outbound" ||
      (input.source !== "agent" && input.source !== "human")
    ) {
      return { status: "ignored" };
    }

    const kind = input.source === "agent" ? "qualification" : "human_commercial";
    const candidate = await resolveCandidate(prisma, input, kind);
    if (!candidate || !candidate.message.ingestedAt) {
      return { status: "ignored" };
    }

    const newerCustomerMessage = await findNewerCustomerReply(
      prisma,
      input,
      candidate.message.ingestedAt
    );
    if (newerCustomerMessage) {
      return cancelForCustomerReply(prisma, input, newerCustomerMessage.ingestedAt);
    }

    const scheduledAt = calculateFirstScheduledAt(candidate.message.createdAt, candidate.agent);
    if (!scheduledAt) {
      return { status: "ignored" };
    }

    const reason = input.source === "agent" ? "agent_outbound" : "human_outbound";
    const candidateData = {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: candidate.agent.id,
      sessionId: candidate.session.id,
      kind,
      status: "scheduled",
      activeKey: "active",
      stepIndex: 1,
      anchorMessageId: candidate.message.id,
      anchorMessageAt: toDate(candidate.message.createdAt),
      anchorIngestedAt: toDate(candidate.message.ingestedAt),
      scheduledAt,
      decision: {},
      reason
    } as const;

    for (let attempt = 0; attempt < MAX_UNIQUE_CONFLICT_RETRIES; attempt += 1) {
      try {
        const followup = await prisma.$transaction(async (tx) => {
          const current = await tx.conversationFollowup.findFirst({
            where: {
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
              activeKey: "active"
            }
          });

          if (current && toDate(current.anchorIngestedAt) >= candidateData.anchorIngestedAt) {
            return current;
          }

          if (current) {
            await tx.conversationFollowup.updateMany({
              where: {
                id: current.id,
                workspaceId: input.workspaceId,
                activeKey: "active"
              },
              data: {
                status: "cancelled",
                activeKey: null,
                reason: "outbound_replaced",
                cancelledAt: new Date()
              }
            });
          }

          return tx.conversationFollowup.create({ data: candidateData });
        });

        return finishOutboundScheduling(prisma, input, followup);
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }

        const active = await prisma.conversationFollowup.findFirst({
          where: {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            activeKey: "active"
          }
        });
        if (active && toDate(active.anchorIngestedAt) >= candidateData.anchorIngestedAt) {
          return finishOutboundScheduling(prisma, input, active);
        }
      }
    }

    return { status: "ignored" };
  }

  async function revalidateActiveFollowup(input: {
    workspaceId: string;
    followupId: string;
    now?: Date;
  }): Promise<RevalidateActiveFollowupResult> {
    const followup = await prisma.conversationFollowup.findFirst({
      where: { workspaceId: input.workspaceId, id: input.followupId }
    });
    if (!followup) {
      return { status: "missing" };
    }

    const conversation = await prisma.conversation.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: followup.conversationId
        }
      }
    });

    if (!isActiveFollowup(followup)) {
      return { status: "cancelled", reason: "not_active", followup, conversation: conversation ?? undefined };
    }
    if (!conversation) {
      return cancelActiveFollowup(prisma, followup, "conversation_missing", input.now);
    }
    if (conversation.status === "closed") {
      return cancelActiveFollowup(prisma, followup, "conversation_closed", input.now, conversation);
    }
    if (
      conversation.aiControlStatus === "human_controlled" &&
      followup.kind === "qualification"
    ) {
      return cancelActiveFollowup(prisma, followup, "human_controlled", input.now, conversation);
    }

    const anchorIngestedAt = toDate(followup.anchorIngestedAt);
    const newerCustomerMessage = await prisma.message.findFirst({
      where: {
        workspaceId: input.workspaceId,
        conversationId: followup.conversationId,
        direction: "inbound",
        ingestedAt: { gt: anchorIngestedAt }
      },
      orderBy: { ingestedAt: "desc" }
    });
    if (newerCustomerMessage) {
      return cancelActiveFollowup(prisma, followup, "customer_replied", input.now, conversation);
    }

    const newerCompanyMessage = await prisma.message.findFirst({
      where: {
        workspaceId: input.workspaceId,
        conversationId: followup.conversationId,
        direction: "outbound",
        id: { not: followup.anchorMessageId },
        ingestedAt: { gt: anchorIngestedAt }
      },
      orderBy: { ingestedAt: "desc" }
    });
    if (newerCompanyMessage) {
      return cancelActiveFollowup(prisma, followup, "outbound_replaced", input.now, conversation);
    }

    const session = followup.sessionId
      ? await prisma.aiAgentSession.findFirst({
          where: { workspaceId: input.workspaceId, id: followup.sessionId },
          include: { agent: true }
        })
      : null;
    if (
      !isCompatibleSession(session, input.workspaceId, followup.conversationId, followup.kind) ||
      session.agentId !== followup.agentId ||
      (conversation.activeAgentSessionId != null && conversation.activeAgentSessionId !== session.id)
    ) {
      return cancelActiveFollowup(prisma, followup, "session_context_changed", input.now, conversation);
    }

    return {
      status: "valid",
      context: {
        followup,
        conversation,
        session,
        agent: session.agent
      }
    };
  }

  async function completeAutomaticFollowup(input: {
    workspaceId: string;
    followupId: string;
    followup: ConversationFollowupRecord;
    agentBehaviorConfig: unknown;
    finalBody: string;
    decision: unknown;
    now?: Date;
  }): Promise<CompleteAutomaticFollowupResult> {
    if (
      input.followup.workspaceId !== input.workspaceId ||
      input.followup.id !== input.followupId ||
      input.followup.activeKey !== "active"
    ) {
      return { status: "not_active" };
    }

    const sentAt = input.now ?? new Date();
    const parsed = agentFollowupConfigSchema.safeParse(asRecord(input.agentBehaviorConfig)?.followup);
    const nextStep =
      parsed.success && input.followup.stepIndex < MAX_AUTOMATIC_FOLLOWUP_STEPS
        ? parsed.data.steps[input.followup.stepIndex]
        : undefined;
    const nextScheduledAt = nextStep && parsed.success
      ? calculateScheduledAt(input.followup.anchorMessageAt, nextStep, parsed.data)
      : null;

    return prisma.$transaction(async (tx) => {
      const markedSent = await tx.conversationFollowup.updateMany({
        where: {
          id: input.followupId,
          workspaceId: input.workspaceId,
          activeKey: "active"
        },
        data: {
          status: "sent",
          activeKey: null,
          finalBody: input.finalBody,
          decision: input.decision,
          sentAt
        }
      });
      if (markedSent.count !== 1) {
        return { status: "not_active" } as const;
      }

      if (!nextScheduledAt) {
        return { status: "sent" } as const;
      }
      const next = await tx.conversationFollowup.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: input.followup.conversationId,
          agentId: input.followup.agentId,
          sessionId: input.followup.sessionId,
          kind: input.followup.kind,
          status: "scheduled",
          activeKey: "active",
          stepIndex: input.followup.stepIndex + 1,
          anchorMessageId: input.followup.anchorMessageId,
          anchorMessageAt: toDate(input.followup.anchorMessageAt),
          anchorIngestedAt: toDate(input.followup.anchorIngestedAt),
          scheduledAt: nextScheduledAt,
          decision: {},
          reason: "agent_followup_step"
        }
      });
      return { status: "scheduled", followupId: next.id } as const;
    });
  }

  return { observeConversationActivity, revalidateActiveFollowup, completeAutomaticFollowup };
}

async function findPersistedCustomerInboundMessage(
  prisma: Pick<ConversationFollowupsPrismaLike, "message">,
  input: ObserveConversationActivityInput
): Promise<MessageRecord | null> {
  return prisma.message.findFirst({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      id: input.messageId,
      direction: "inbound"
    }
  });
}

async function cancelForCustomerReply(
  prisma: Pick<ConversationFollowupsPrismaLike, "conversationFollowup">,
  input: Pick<ObserveConversationActivityInput, "workspaceId" | "conversationId">,
  customerMessageIngestedAt?: Date | string | null
): Promise<ObserveConversationActivityResult> {
  const result = await prisma.conversationFollowup.updateMany({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      activeKey: "active",
      ...(customerMessageIngestedAt
        ? { anchorIngestedAt: { lt: toDate(customerMessageIngestedAt) } }
        : {})
    },
    data: {
      status: "cancelled",
      activeKey: null,
      reason: "customer_replied",
      cancelledAt: new Date()
    }
  });

  return result.count > 0 ? { status: "cancelled" } : { status: "ignored" };
}

async function findNewerCustomerReply(
  prisma: Pick<ConversationFollowupsPrismaLike, "message">,
  input: Pick<ObserveConversationActivityInput, "workspaceId" | "conversationId">,
  anchorIngestedAt: Date | string
): Promise<MessageRecord | null> {
  return prisma.message.findFirst({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      direction: "inbound",
      ingestedAt: { gt: toDate(anchorIngestedAt) }
    },
    orderBy: { ingestedAt: "desc" }
  });
}

async function finishOutboundScheduling(
  prisma: ConversationFollowupsPrismaLike,
  input: ObserveConversationActivityInput,
  followup: Pick<ConversationFollowupRecord, "id" | "anchorIngestedAt">
): Promise<ObserveConversationActivityResult> {
  const newerCustomerMessage = await findNewerCustomerReply(
    prisma,
    input,
    followup.anchorIngestedAt
  );
  if (newerCustomerMessage) {
    return cancelForCustomerReply(prisma, input, newerCustomerMessage.ingestedAt);
  }

  return { status: "scheduled", followupId: followup.id };
}

async function resolveCandidate(
  prisma: ConversationFollowupsPrismaLike,
  input: ObserveConversationActivityInput,
  kind: ConversationFollowupRecord["kind"]
): Promise<
  | { conversation: ConversationRecord; message: MessageRecord; session: AgentSessionRecord; agent: AgentRecord }
  | null
> {
  const [conversation, message] = await Promise.all([
    prisma.conversation.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.conversationId
        }
      },
      include: { activeAgentSession: { include: { agent: true } } }
    }),
    prisma.message.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.messageId,
        conversationId: input.conversationId,
        direction: "outbound"
      }
    })
  ]);

  if (
    !conversation ||
    !message ||
    conversation.status === "closed" ||
    (conversation.aiControlStatus === "human_controlled" && kind === "qualification")
  ) {
    return null;
  }

  const session = isCompatibleSession(
    conversation.activeAgentSession,
    input.workspaceId,
    input.conversationId,
    kind
  )
    ? conversation.activeAgentSession
    : await prisma.aiAgentSession.findFirst({
        where: {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          status:
            kind === "human_commercial"
              ? { in: ["active", "paused_by_human"] }
              : "active",
          agent: { status: "active" }
        },
        include: { agent: true },
        orderBy: { updatedAt: "desc" }
      });

  if (!isCompatibleSession(session, input.workspaceId, input.conversationId, kind)) {
    return null;
  }

  return { conversation, message, session, agent: session.agent };
}

function calculateFirstScheduledAt(anchorMessageAt: Date | string, agent: AgentRecord): Date | null {
  const behaviorConfig = asRecord(agent.behaviorConfig);
  const parsed = agentFollowupConfigSchema.safeParse(behaviorConfig?.followup);
  if (!parsed.success) {
    return null;
  }

  const firstStep = parsed.data.steps[0];
  return firstStep ? calculateScheduledAt(anchorMessageAt, firstStep, parsed.data) : null;
}

function calculateScheduledAt(
  anchorMessageAt: Date | string,
  step: { afterBusinessMinutes: number },
  config: {
    timeZone: string;
    businessDays: number[];
    businessHours: { start: string; end: string };
  }
): Date | null {
  try {
    return addBusinessMinutes({
      from: toDate(anchorMessageAt),
      minutes: step.afterBusinessMinutes,
      timeZone: config.timeZone,
      businessDays: config.businessDays,
      businessHours: config.businessHours
    });
  } catch {
    return null;
  }
}

async function cancelActiveFollowup(
  prisma: ConversationFollowupsPrismaLike,
  followup: ConversationFollowupRecord,
  reason: Extract<RevalidateActiveFollowupResult, { status: "cancelled" }>["reason"],
  now?: Date,
  conversation?: ConversationRecord
): Promise<Extract<RevalidateActiveFollowupResult, { status: "cancelled" }>> {
  const cancelledAt = now ?? new Date();
  await prisma.conversationFollowup.updateMany({
    where: { id: followup.id, workspaceId: followup.workspaceId, activeKey: "active" },
    data: { status: "cancelled", activeKey: null, reason, cancelledAt }
  });

  return {
    status: "cancelled",
    reason,
    followup: { ...followup, status: "cancelled", activeKey: null, reason, cancelledAt },
    conversation
  };
}

function isCompatibleSession(
  session: AgentSessionRecord | null | undefined,
  workspaceId: string,
  conversationId: string,
  kind: ConversationFollowupRecord["kind"]
): session is AgentSessionRecord & { agent: AgentRecord } {
  return Boolean(
    session &&
      session.workspaceId === workspaceId &&
      session.conversationId === conversationId &&
      (session.status === "active" ||
        (kind === "human_commercial" && session.status === "paused_by_human")) &&
      session.agent?.workspaceId === workspaceId &&
      session.agent.status === "active"
  );
}

function isActiveFollowup(followup: ConversationFollowupRecord): boolean {
  return followup.activeKey === "active" && ACTIVE_FOLLOWUP_STATUSES.includes(followup.status as ActiveFollowupStatus);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Follow-up anchor message must have a valid timestamp.");
  }
  return date;
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
