import { calculateFollowupDueAt, resolveFollowupPlan } from "./channel-followup-plan.js";
import {
  publishPersistedConversationFollowup,
  type ConversationFollowupPublisher
} from "./conversation-followup-events.js";

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
  channelId?: string;
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
  body?: string | null;
  status?: string;
  metadata?: unknown;
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
  lockedAt?: Date | string | null;
  decision: unknown;
  draftBody?: string | null;
  finalBody?: string | null;
  reason?: string | null;
  sentByUserId?: string | null;
  sentAt?: Date | string | null;
  cancelledByUserId?: string | null;
  cancelledAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

type ConversationFollowupStore = {
  findFirst(args: unknown): Promise<ConversationFollowupRecord | null>;
  findMany?(args: unknown): Promise<ConversationFollowupRecord[]>;
  updateMany(args: unknown): Promise<{ count: number }>;
  create(args: unknown): Promise<ConversationFollowupRecord>;
};

type ConversationFollowupsTransaction = {
  conversationFollowup: ConversationFollowupStore;
  message: ConversationFollowupsPrismaLike["message"];
};

export type ConversationFollowupsPrismaLike = {
  $transaction<T>(
    callback: (tx: ConversationFollowupsTransaction) => Promise<T>
  ): Promise<T>;
  conversation: {
    findUnique(args: unknown): Promise<ConversationRecord | null>;
  };
  channel?: {
    findUnique(args: unknown): Promise<{ followupConfig?: unknown } | null>;
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

export type ScheduledFollowupClaimResult =
  | { status: "claimed"; lockedAt: Date }
  | { status: "not_scheduled" };

export type ClaimedFollowupRecoveryResult =
  | { status: "recovered" }
  | { status: "not_active" };

export const MAX_AUTOMATIC_FOLLOWUP_STEPS = 10;
export const DEFAULT_FOLLOWUP_PROCESSING_LEASE_MS = 10 * 60 * 1_000;

const ACTIVE_FOLLOWUP_STATUSES: ActiveFollowupStatus[] = ["scheduled", "processing", "review"];
const MAX_UNIQUE_CONFLICT_RETRIES = 3;

export function createConversationFollowupsService(
  prisma: ConversationFollowupsPrismaLike,
  options: { publisher?: ConversationFollowupPublisher } = {}
) {
  const publish = (workspaceId: string, followupId: string) =>
    publishPersistedConversationFollowup({
      store: prisma.conversationFollowup,
      publisher: options.publisher,
      workspaceId,
      followupId
    });

  async function observeConversationActivity(
    input: ObserveConversationActivityInput
  ): Promise<ObserveConversationActivityResult> {
    if (input.direction === "inbound" && input.source === "customer") {
      const customerMessage = await findPersistedCustomerInboundMessage(prisma, input);
      if (!customerMessage?.ingestedAt) {
        return { status: "ignored" };
      }

      return cancelForCustomerReply(prisma, input, customerMessage.ingestedAt, options.publisher);
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

    if (isManagedFollowupDelivery(candidate.message)) {
      return { status: "ignored" };
    }

    if (input.source === "human" && await isCourtesyClosure(prisma, input, candidate.message)) {
      return cancelForCustomerReply(prisma, input, candidate.message.ingestedAt, options.publisher, "outbound_replaced");
    }

    const newerCustomerMessage = await findNewerCustomerReply(
      prisma,
      input,
      candidate.message.ingestedAt
    );
    if (newerCustomerMessage) {
      return cancelForCustomerReply(prisma, input, newerCustomerMessage.ingestedAt, options.publisher);
    }

    const scheduledAt = await calculateFirstScheduledAt(prisma, candidate.message.createdAt, candidate.conversation, candidate.agent);
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
        const mutation = await prisma.$transaction(async (tx) => {
          const current = await tx.conversationFollowup.findFirst({
            where: {
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
              activeKey: "active"
            }
          });

          if (current && toDate(current.anchorIngestedAt) >= candidateData.anchorIngestedAt) {
            return { followup: current, created: false, replacedId: null };
          }

          let replacedId: string | null = null;
          if (current) {
            const replaced = await tx.conversationFollowup.updateMany({
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
            if (replaced.count === 1) replacedId = current.id;
          }

          const followup = await tx.conversationFollowup.create({ data: candidateData });
          return { followup, created: true, replacedId };
        });

        if (mutation.replacedId) await publish(input.workspaceId, mutation.replacedId);
        if (mutation.created) await publish(input.workspaceId, mutation.followup.id);
        return finishOutboundScheduling(prisma, input, mutation.followup, options.publisher);
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
          return finishOutboundScheduling(prisma, input, active, options.publisher);
        }
      }
    }

    return { status: "ignored" };
  }

  async function revalidateActiveFollowup(input: {
    workspaceId: string;
    followupId: string;
    now?: Date;
    claim?: { lockedAt: Date };
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
      return cancelActiveFollowup(prisma, followup, "conversation_missing", input.now, undefined, options.publisher, input.claim);
    }
    if (conversation.status === "closed") {
      return cancelActiveFollowup(prisma, followup, "conversation_closed", input.now, conversation, options.publisher, input.claim);
    }
    if (
      conversation.aiControlStatus === "human_controlled" &&
      followup.kind === "qualification"
    ) {
      return cancelActiveFollowup(prisma, followup, "human_controlled", input.now, conversation, options.publisher, input.claim);
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
      return cancelActiveFollowup(prisma, followup, "customer_replied", input.now, conversation, options.publisher, input.claim);
    }

    const newerCompanyMessage = await findNewerCompanyMessage(
      prisma,
      followup,
      anchorIngestedAt
    );
    if (newerCompanyMessage) {
      return cancelActiveFollowup(prisma, followup, "outbound_replaced", input.now, conversation, options.publisher, input.claim);
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
      return cancelActiveFollowup(prisma, followup, "session_context_changed", input.now, conversation, options.publisher, input.claim);
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

  async function claimScheduledFollowup(input: {
    workspaceId: string;
    followupId: string;
    now?: Date;
  }): Promise<ScheduledFollowupClaimResult> {
    const lockedAt = input.now ?? new Date();
    const claim = await prisma.conversationFollowup.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: input.followupId,
        status: "scheduled",
        activeKey: "active",
        lockedAt: null
      },
      data: {
        status: "processing",
        lockedAt,
        attempts: { increment: 1 }
      }
    });
    if (claim.count !== 1) return { status: "not_scheduled" };
    await publish(input.workspaceId, input.followupId);
    return { status: "claimed", lockedAt };
  }

  async function recoverClaimedFollowup(input: {
    workspaceId: string;
    followupId: string;
    claim: { lockedAt: Date };
    outcome: "retry" | "failed";
    reason: string;
    scheduledAt?: Date;
  }): Promise<ClaimedFollowupRecoveryResult> {
    const recovery = await prisma.conversationFollowup.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: input.followupId,
        activeKey: "active",
        status: "processing",
        lockedAt: input.claim.lockedAt
      },
      data: input.outcome === "retry"
        ? {
            status: "scheduled",
            lockedAt: null,
            reason: input.reason,
            ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {})
          }
        : {
            status: "failed",
            activeKey: null,
            lockedAt: null,
            reason: input.reason
          }
    });
    if (recovery.count !== 1) return { status: "not_active" };
    await publish(input.workspaceId, input.followupId);
    return { status: "recovered" };
  }

  async function reconcileStaleProcessingFollowups(input: {
    now?: Date;
    leaseMs?: number;
    batchSize?: number;
  } = {}) {
    const now = input.now ?? new Date();
    const staleBefore = new Date(now.getTime() - (input.leaseMs ?? DEFAULT_FOLLOWUP_PROCESSING_LEASE_MS));
    if (!prisma.conversationFollowup.findMany) return { reconciled: 0 };
    const stale = await prisma.conversationFollowup.findMany({
      where: {
        status: "processing",
        activeKey: "active",
        lockedAt: { lte: staleBefore }
      },
      orderBy: [{ lockedAt: "asc" }, { createdAt: "asc" }],
      take: input.batchSize ?? 100
    });
    let reconciled = 0;
    for (const followup of stale) {
      const updated = await prisma.conversationFollowup.updateMany({
        where: {
          workspaceId: followup.workspaceId,
          id: followup.id,
          status: "processing",
          activeKey: "active",
          lockedAt: followup.lockedAt
        },
        data: {
          status: "failed",
          activeKey: null,
          lockedAt: null,
          reason: "processing_lease_expired"
        }
      });
      if (updated.count === 1) {
        reconciled += 1;
        await publish(followup.workspaceId, followup.id);
      }
    }
    return { reconciled };
  }

  async function completeAutomaticFollowup(input: {
    workspaceId: string;
    followupId: string;
    followup: ConversationFollowupRecord;
    claim: { lockedAt: Date };
    agentBehaviorConfig: unknown;
    finalBody: string;
    decision: unknown;
    sentMessageId?: string;
    sentMessageAt?: Date | string;
    now?: Date;
  }): Promise<CompleteAutomaticFollowupResult> {
    if (
      input.followup.workspaceId !== input.workspaceId ||
      input.followup.id !== input.followupId ||
      input.followup.activeKey !== "active" ||
      input.followup.status !== "processing" ||
      !sameTimestamp(input.followup.lockedAt, input.claim.lockedAt)
    ) {
      return { status: "not_active" };
    }

    const sentAt = input.now ?? new Date();
    const conversation = await prisma.conversation.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.followup.conversationId } }
    });
    const followupConfig = await loadPlan(prisma, input.workspaceId, conversation?.channelId, input.agentBehaviorConfig);
    const nextStep =
      followupConfig && input.followup.stepIndex < Math.min(MAX_AUTOMATIC_FOLLOWUP_STEPS, followupConfig.steps.length)
        ? followupConfig.steps[input.followup.stepIndex]
        : undefined;
    const nextScheduledAt = nextStep && followupConfig
      ? calculateNextScheduledAt(input.followup, sentAt, nextStep.afterMinutes, followupConfig)
      : null;

    const result = await prisma.$transaction(async (tx) => {
      const markedSent = await tx.conversationFollowup.updateMany({
        where: {
          id: input.followupId,
          workspaceId: input.workspaceId,
          activeKey: "active",
          status: "processing",
          lockedAt: input.claim.lockedAt
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
      const customerReplied = await tx.message.findFirst({
        where: {
          workspaceId: input.workspaceId,
          conversationId: input.followup.conversationId,
          direction: "inbound",
          ingestedAt: { gt: toDate(input.followup.anchorIngestedAt) }
        },
        orderBy: { ingestedAt: "desc" }
      });
      if (customerReplied) return { status: "sent" } as const;
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
          anchorMessageId: input.sentMessageId ?? input.followup.anchorMessageId,
          anchorMessageAt: input.sentMessageAt ? toDate(input.sentMessageAt) : sentAt,
          anchorIngestedAt: sentAt,
          scheduledAt: nextScheduledAt,
          decision: {},
          reason: "agent_followup_step"
        }
      });
      return { status: "scheduled", followupId: next.id } as const;
    });
    if (result.status !== "not_active") {
      await publish(input.workspaceId, input.followupId);
      if (result.status === "scheduled") await publish(input.workspaceId, result.followupId);
    }
    return result;
  }

  async function scheduleNextAfterManualSend(input: {
    workspaceId: string;
    followup: ConversationFollowupRecord;
    sentAt: Date;
  }): Promise<string | null> {
    const conversation = await prisma.conversation.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.followup.conversationId } }
    });
    if (!conversation || conversation.status === "closed") return null;
    const session = input.followup.sessionId
      ? await prisma.aiAgentSession.findFirst({
          where: { workspaceId: input.workspaceId, id: input.followup.sessionId },
          include: { agent: true }
        })
      : null;
    if (!session?.agent || !isCompatibleSession(session, input.workspaceId, input.followup.conversationId, input.followup.kind)) return null;
    const plan = await loadPlan(prisma, input.workspaceId, conversation.channelId, session.agent.behaviorConfig);
    const nextStep = plan?.steps[input.followup.stepIndex];
    if (!plan || !nextStep || input.followup.stepIndex >= MAX_AUTOMATIC_FOLLOWUP_STEPS) return null;
    const scheduledAt = calculateNextScheduledAt(input.followup, input.sentAt, nextStep.afterMinutes, plan);
    if (!scheduledAt) return null;

    const next = await prisma.$transaction(async (tx) => {
      const customerReplied = await tx.message.findFirst({
        where: {
          workspaceId: input.workspaceId,
          conversationId: input.followup.conversationId,
          direction: "inbound",
          ingestedAt: { gt: toDate(input.followup.anchorIngestedAt) }
        },
        orderBy: { ingestedAt: "desc" }
      });
      if (customerReplied) return null;
      const active = await tx.conversationFollowup.findFirst({
        where: { workspaceId: input.workspaceId, conversationId: input.followup.conversationId, activeKey: "active" }
      });
      if (active) return null;
      return tx.conversationFollowup.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: input.followup.conversationId,
          agentId: input.followup.agentId,
          sessionId: input.followup.sessionId,
          kind: input.followup.kind,
          status: "scheduled",
          activeKey: "active",
          stepIndex: input.followup.stepIndex + 1,
          anchorMessageId: input.followup.id,
          anchorMessageAt: input.sentAt,
          anchorIngestedAt: input.sentAt,
          scheduledAt,
          decision: {},
          reason: "manual_followup_step"
        }
      });
    });
    if (next) await publish(input.workspaceId, next.id);
    return next?.id ?? null;
  }

  return {
    observeConversationActivity,
    revalidateActiveFollowup,
    claimScheduledFollowup,
    recoverClaimedFollowup,
    reconcileStaleProcessingFollowups,
    completeAutomaticFollowup,
    scheduleNextAfterManualSend
  };
}

async function findNewerCompanyMessage(
  prisma: Pick<ConversationFollowupsPrismaLike, "message">,
  followup: ConversationFollowupRecord,
  anchorIngestedAt: Date
) {
  const where = {
    workspaceId: followup.workspaceId,
    conversationId: followup.conversationId,
    direction: "outbound" as const,
    ingestedAt: { gt: anchorIngestedAt }
  };
  const newest = await prisma.message.findFirst({
    where: { ...where, id: { not: followup.anchorMessageId } },
    orderBy: { ingestedAt: "desc" }
  });
  if (!isOwnPendingDeliveryReservation(newest, followup)) return newest;

  // The review route reserves a Message row before provider delivery. Ignore
  // only that exact pending row, then look again so any other outbound still
  // invalidates the follow-up.
  return prisma.message.findFirst({
    where: { ...where, id: { notIn: [followup.anchorMessageId, followup.id] } },
    orderBy: { ingestedAt: "desc" }
  });
}

function isOwnPendingDeliveryReservation(
  message: MessageRecord | null,
  followup: ConversationFollowupRecord
) {
  if (!message || message.id !== followup.id || message.status !== "pending") return false;
  const metadata = asRecord(message.metadata);
  return metadata?.source === "followup_review" && metadata.followupId === followup.id;
}

function isManagedFollowupDelivery(message: MessageRecord) {
  const metadata = asRecord(message.metadata);
  return typeof metadata?.followupId === "string" &&
    (metadata.source === "followup_review" || metadata.source === "ai_agent");
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
  customerMessageIngestedAt?: Date | string | null,
  publisher?: ConversationFollowupPublisher,
  reason: "customer_replied" | "outbound_replaced" = "customer_replied"
): Promise<ObserveConversationActivityResult> {
  const where = {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    activeKey: "active",
    status: { in: ["scheduled", "review"] },
    ...(customerMessageIngestedAt
      ? { anchorIngestedAt: { lt: toDate(customerMessageIngestedAt) } }
      : {})
  };
  const active = publisher ? await prisma.conversationFollowup.findFirst({ where }) : null;
  if (publisher && !active) return { status: "ignored" };
  const result = await prisma.conversationFollowup.updateMany({
    where: active ? { ...where, id: active.id } : where,
    data: {
      status: "cancelled",
      activeKey: null,
      reason,
      cancelledAt: new Date()
    }
  });

  if (result.count !== 1) return { status: "ignored" };
  if (active) {
    await publishPersistedConversationFollowup({
      store: prisma.conversationFollowup,
      publisher,
      workspaceId: input.workspaceId,
      followupId: active.id
    });
  }
  return { status: "cancelled" };
}

async function isCourtesyClosure(
  prisma: Pick<ConversationFollowupsPrismaLike, "message">,
  input: Pick<ObserveConversationActivityInput, "workspaceId" | "conversationId">,
  sellerMessage: MessageRecord
): Promise<boolean> {
  const sellerText = sellerMessage.body?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!sellerText || !/^(imagina|de nada|por nada|disponha|as ordens|obrigado|obrigada)$/.test(sellerText) || !sellerMessage.ingestedAt) return false;
  const previousCustomer = await prisma.message.findFirst({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      direction: "inbound",
      ingestedAt: { lte: toDate(sellerMessage.ingestedAt) }
    },
    orderBy: { ingestedAt: "desc" }
  });
  const customerText = previousCustomer?.body?.toLowerCase() ?? "";
  return !customerText.includes("?") && /\b(obrigad[oa]|agradec|valeu)\b/u.test(customerText);
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
  followup: Pick<ConversationFollowupRecord, "id" | "anchorIngestedAt">,
  publisher?: ConversationFollowupPublisher
): Promise<ObserveConversationActivityResult> {
  const newerCustomerMessage = await findNewerCustomerReply(
    prisma,
    input,
    followup.anchorIngestedAt
  );
  if (newerCustomerMessage) {
    return cancelForCustomerReply(prisma, input, newerCustomerMessage.ingestedAt, publisher);
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
              ? { in: ["active", "paused_by_human", "handoff_requested"] }
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

async function loadPlan(
  prisma: ConversationFollowupsPrismaLike,
  workspaceId: string,
  channelId: string | undefined,
  agentBehaviorConfig: unknown
) {
  const channel = channelId && prisma.channel
    ? await prisma.channel.findUnique({ where: { workspaceId_id: { workspaceId, id: channelId } } })
    : null;
  return resolveFollowupPlan(agentBehaviorConfig, channel?.followupConfig);
}

async function calculateFirstScheduledAt(
  prisma: ConversationFollowupsPrismaLike,
  anchorMessageAt: Date | string,
  conversation: ConversationRecord,
  agent: AgentRecord
): Promise<Date | null> {
  const followupConfig = await loadPlan(prisma, conversation.workspaceId, conversation.channelId, agent.behaviorConfig);
  if (!followupConfig) {
    return null;
  }

  const firstStep = followupConfig.steps[0];
  return firstStep ? calculateFollowupDueAt(toDate(anchorMessageAt), firstStep.afterMinutes, followupConfig) : null;
}

function calculateNextScheduledAt(
  followup: ConversationFollowupRecord,
  sentAt: Date,
  nextMinutes: number,
  plan: NonNullable<ReturnType<typeof resolveFollowupPlan>>
): Date | null {
  try {
    const previousMinutes = plan.steps[followup.stepIndex - 1]?.afterMinutes ?? 0;
    const delay = plan.mode === "business_cumulative"
      ? Math.max(1, nextMinutes - previousMinutes)
      : nextMinutes;
    return calculateFollowupDueAt(sentAt, delay, plan);
  } catch {
    return null;
  }
}

async function cancelActiveFollowup(
  prisma: ConversationFollowupsPrismaLike,
  followup: ConversationFollowupRecord,
  reason: Extract<RevalidateActiveFollowupResult, { status: "cancelled" }>["reason"],
  now?: Date,
  conversation?: ConversationRecord,
  publisher?: ConversationFollowupPublisher,
  claim?: { lockedAt: Date }
): Promise<Extract<RevalidateActiveFollowupResult, { status: "cancelled" }>> {
  const cancelledAt = now ?? new Date();
  const updated = await prisma.conversationFollowup.updateMany({
    where: {
      id: followup.id,
      workspaceId: followup.workspaceId,
      activeKey: "active",
      ...(claim ? { status: "processing", lockedAt: claim.lockedAt } : {})
    },
    data: { status: "cancelled", activeKey: null, reason, cancelledAt }
  });

  if (updated.count === 1) {
    await publishPersistedConversationFollowup({
        store: prisma.conversationFollowup,
        publisher,
        workspaceId: followup.workspaceId,
        followupId: followup.id
      });
  }

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
        (kind === "human_commercial" && (session.status === "paused_by_human" || session.status === "handoff_requested"))) &&
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

function sameTimestamp(left: Date | string | null | undefined, right: Date | string): boolean {
  if (!left) {
    return false;
  }

  try {
    return toDate(left).getTime() === toDate(right).getTime();
  } catch {
    return false;
  }
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
