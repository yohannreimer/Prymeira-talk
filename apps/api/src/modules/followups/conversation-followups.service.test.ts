import { describe, expect, it, vi } from "vitest";
import { createConversationFollowupsService } from "./conversation-followups.service.js";

const ids = {
  workspace: "workspace_a",
  conversation: "00000000-0000-4000-8000-000000000401",
  agent: "00000000-0000-4000-8000-000000000101",
  session: "00000000-0000-4000-8000-000000000301",
  anchor: "00000000-0000-4000-8000-000000000601",
  followup: "00000000-0000-4000-8000-000000000701"
};

const anchorAt = new Date("2026-09-21T12:00:00.000Z");
const anchorIngestedAt = new Date("2026-09-21T12:00:00.100Z");

const followupConfig = {
  timeZone: "America/Sao_Paulo",
  businessDays: [1, 2, 3, 4, 5],
  businessHours: { start: "08:00", end: "18:00" },
  steps: [{ afterBusinessMinutes: 60, instruction: "Retome somente a qualificação pendente." }],
  closeAfterBusinessMinutes: 0
};

const baseAgent = {
  id: ids.agent,
  workspaceId: ids.workspace,
  status: "active",
  behaviorConfig: { followup: followupConfig }
};

const baseSession = {
  id: ids.session,
  workspaceId: ids.workspace,
  conversationId: ids.conversation,
  agentId: ids.agent,
  status: "active",
  updatedAt: anchorAt,
  agent: baseAgent
};

const baseConversation = {
  id: ids.conversation,
  workspaceId: ids.workspace,
  status: "open",
  aiControlStatus: "agent_allowed",
  activeAgentSessionId: ids.session,
  activeAgentSession: baseSession
};

const baseMessage = {
  id: ids.anchor,
  workspaceId: ids.workspace,
  conversationId: ids.conversation,
  direction: "outbound",
  createdAt: anchorAt,
  ingestedAt: anchorIngestedAt
};

function activeFollowup(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.followup,
    workspaceId: ids.workspace,
    conversationId: ids.conversation,
    agentId: ids.agent,
    sessionId: ids.session,
    kind: "qualification",
    status: "scheduled",
    activeKey: "active",
    stepIndex: 1,
    anchorMessageId: ids.anchor,
    anchorMessageAt: anchorAt,
    anchorIngestedAt,
    scheduledAt: new Date("2026-09-21T13:00:00.000Z"),
    decision: {},
    ...overrides
  };
}

function buildPrisma(overrides: Record<string, any> = {}) {
  const conversationFollowup = {
    findFirst: overrides.conversationFollowup?.findFirst ?? vi.fn().mockResolvedValue(null),
    updateMany: overrides.conversationFollowup?.updateMany ?? vi.fn().mockResolvedValue({ count: 0 }),
    create:
      overrides.conversationFollowup?.create ??
      vi.fn().mockResolvedValue(activeFollowup())
  };
  const prisma = {
    conversation: {
      findUnique:
        overrides.conversation?.findUnique ?? vi.fn().mockResolvedValue(baseConversation)
    },
    message: {
      findFirst:
        overrides.message?.findFirst ??
        vi.fn().mockImplementation(async (args: any) =>
          args.where.direction === "inbound" ? null : baseMessage
        )
    },
    aiAgentSession: {
      findFirst: overrides.aiAgentSession?.findFirst ?? vi.fn().mockResolvedValue(baseSession)
    },
    conversationFollowup
  };

  return {
    ...prisma,
    $transaction:
      overrides.$transaction ??
      vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma))
  };
}

describe("conversation followups", () => {
  it("cancels the active cycle immediately when the customer replies", async () => {
    const prisma = buildPrisma({
      conversationFollowup: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    });
    const service = createConversationFollowupsService(prisma);

    const result = await service.observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: "customer_message",
      direction: "inbound",
      source: "customer"
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        activeKey: "active"
      },
      data: expect.objectContaining({
        status: "cancelled",
        activeKey: null,
        reason: "customer_replied"
      })
    });
  });

  it("schedules qualification from an agent outbound message", async () => {
    const prisma = buildPrisma();
    const service = createConversationFollowupsService(prisma);

    const result = await service.observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "scheduled", followupId: ids.followup });
    expect(prisma.conversationFollowup.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        agentId: ids.agent,
        sessionId: ids.session,
        kind: "qualification",
        status: "scheduled",
        activeKey: "active",
        stepIndex: 1,
        anchorMessageId: ids.anchor,
        anchorMessageAt: anchorAt,
        anchorIngestedAt,
        scheduledAt: new Date("2026-09-21T13:00:00.000Z"),
        decision: {},
        reason: "agent_outbound"
      })
    });
  });

  it("schedules a human commercial candidate from a human outbound message", async () => {
    const prisma = buildPrisma();
    const service = createConversationFollowupsService(prisma);

    const result = await service.observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "human"
    });

    expect(result).toEqual({ status: "scheduled", followupId: ids.followup });
    expect(prisma.conversationFollowup.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "human_commercial",
        reason: "human_outbound"
      })
    });
  });

  it("schedules a human commercial candidate while a human controls the conversation", async () => {
    const pausedSession = { ...baseSession, status: "paused_by_human" };
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseConversation,
          aiControlStatus: "human_controlled",
          activeAgentSession: pausedSession
        })
      },
      aiAgentSession: { findFirst: vi.fn().mockResolvedValue(null) }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "human"
    });

    expect(result).toEqual({ status: "scheduled", followupId: ids.followup });
    expect(prisma.conversationFollowup.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "human_commercial" })
    });
  });

  it("blocks qualification scheduling during the actual human takeover state", async () => {
    const pausedSession = { ...baseSession, status: "paused_by_human" };
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseConversation,
          aiControlStatus: "human_controlled",
          activeAgentSession: pausedSession
        })
      },
      aiAgentSession: { findFirst: vi.fn().mockResolvedValue(null) }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "ignored" });
    expect(prisma.conversationFollowup.create).not.toHaveBeenCalled();
  });

  it("ignores outbound activity when no suitable agent session exists", async () => {
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseConversation,
          activeAgentSessionId: null,
          activeAgentSession: null
        })
      },
      aiAgentSession: { findFirst: vi.fn().mockResolvedValue(null) }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "ignored" });
    expect(prisma.conversationFollowup.create).not.toHaveBeenCalled();
  });

  it.each([
    ["conversation is closed", { ...baseConversation, status: "closed" }],
    ["the agent has no first follow-up step", { ...baseConversation, activeAgentSession: { ...baseSession, agent: { ...baseAgent, behaviorConfig: { followup: { ...followupConfig, steps: [] } } } } }],
    ["the agent has an invalid follow-up configuration", { ...baseConversation, activeAgentSession: { ...baseSession, agent: { ...baseAgent, behaviorConfig: { followup: { ...followupConfig, timeZone: "" } } } } }]
  ])("ignores outbound activity when %s", async (_label, conversation) => {
    const prisma = buildPrisma({
      conversation: { findUnique: vi.fn().mockResolvedValue(conversation) }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "ignored" });
    expect(prisma.conversationFollowup.create).not.toHaveBeenCalled();
  });

  it("clears a previous active row before scheduling a replacement", async () => {
    const old = activeFollowup({
      id: "old_followup",
      anchorMessageAt: new Date("2026-09-21T11:00:00.000Z"),
      anchorIngestedAt: new Date("2026-09-21T11:00:00.100Z")
    });
    const prisma = buildPrisma({
      conversationFollowup: {
        findFirst: vi.fn().mockResolvedValue(old),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    });

    await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
      where: {
        id: "old_followup",
        workspaceId: ids.workspace,
        activeKey: "active"
      },
      data: expect.objectContaining({
        status: "cancelled",
        activeKey: null,
        reason: "outbound_replaced"
      })
    });
    expect(prisma.conversationFollowup.create).toHaveBeenCalledOnce();
  });

  it("clears an existing candidate when a customer reply was persisted before delayed outbound observation", async () => {
    let active: ReturnType<typeof activeFollowup> | null = activeFollowup();
    const newerCustomerMessage = {
      ...baseMessage,
      id: "customer_reply",
      direction: "inbound" as const,
      createdAt: new Date("2026-09-21T12:01:00.000Z"),
      ingestedAt: new Date("2026-09-21T12:01:00.100Z")
    };
    const updateMany = vi.fn().mockImplementation(async () => {
      active = null;
      return { count: 1 };
    });
    const prisma = buildPrisma({
      message: {
        findFirst: vi.fn().mockImplementation(async (args: any) =>
          args.where.id === ids.anchor
            ? baseMessage
            : args.where.direction === "inbound"
              ? newerCustomerMessage
              : null
        )
      },
      conversationFollowup: {
        findFirst: vi.fn().mockImplementation(async () => active),
        updateMany
      }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(active).toBeNull();
    expect(prisma.conversationFollowup.create).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        activeKey: "active",
        anchorIngestedAt: { lt: newerCustomerMessage.ingestedAt }
      },
      data: expect.objectContaining({
        status: "cancelled",
        activeKey: null,
        reason: "customer_replied"
      })
    });
  });

  it("does not create a candidate after a same-second customer reply was ingested later", async () => {
    let active: ReturnType<typeof activeFollowup> | null = activeFollowup();
    const customerReply = {
      ...baseMessage,
      id: "same_second_customer_reply_before_observation",
      direction: "inbound" as const,
      createdAt: anchorAt,
      ingestedAt: new Date("2026-09-21T12:00:00.200Z")
    };
    const updateMany = vi.fn().mockImplementation(async () => {
      active = null;
      return { count: 1 };
    });
    const prisma = buildPrisma({
      message: {
        findFirst: vi.fn().mockImplementation(async (args: any) =>
          args.where.id === ids.anchor
            ? baseMessage
            : args.where.direction === "inbound"
              ? customerReply
              : null
        )
      },
      conversationFollowup: {
        findFirst: vi.fn().mockImplementation(async () => active),
        updateMany
      }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(prisma.conversationFollowup.create).not.toHaveBeenCalled();
    expect(prisma.message.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ingestedAt: { gt: anchorIngestedAt } })
    }));
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ anchorIngestedAt: { lt: customerReply.ingestedAt } })
    }));
  });

  it("does not create a candidate after a later customer ingestion with an older provider timestamp", async () => {
    let active: ReturnType<typeof activeFollowup> | null = activeFollowup();
    const customerReply = {
      ...baseMessage,
      id: "out_of_order_customer_reply_before_observation",
      direction: "inbound" as const,
      createdAt: new Date("2026-09-21T11:59:59.000Z"),
      ingestedAt: new Date("2026-09-21T12:00:00.200Z")
    };
    const prisma = buildPrisma({
      message: {
        findFirst: vi.fn().mockImplementation(async (args: any) =>
          args.where.id === ids.anchor
            ? baseMessage
            : args.where.direction === "inbound"
              ? customerReply
              : null
        )
      },
      conversationFollowup: {
        findFirst: vi.fn().mockImplementation(async () => active),
        updateMany: vi.fn().mockImplementation(async () => {
          active = null;
          return { count: 1 };
        })
      }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(active).toBeNull();
    expect(prisma.conversationFollowup.create).not.toHaveBeenCalled();
  });

  it("clears a newly created candidate when a customer reply arrives during outbound scheduling", async () => {
    let active: ReturnType<typeof activeFollowup> | null = null;
    let inboundChecks = 0;
    const newerCustomerMessage = {
      ...baseMessage,
      id: "customer_reply_during_schedule",
      direction: "inbound" as const,
      createdAt: new Date("2026-09-21T12:01:00.000Z"),
      ingestedAt: new Date("2026-09-21T12:01:00.100Z")
    };
    const updateMany = vi.fn().mockImplementation(async () => {
      active = null;
      return { count: 1 };
    });
    const create = vi.fn().mockImplementation(async () => {
      active = activeFollowup({ id: "created_before_customer_reply" });
      return active;
    });
    const prisma = buildPrisma({
      message: {
        findFirst: vi.fn().mockImplementation(async (args: any) => {
          if (args.where.id === ids.anchor) return baseMessage;
          if (args.where.direction === "inbound") {
            inboundChecks += 1;
            return inboundChecks === 1 ? null : newerCustomerMessage;
          }
          return null;
        })
      },
      conversationFollowup: {
        findFirst: vi.fn().mockImplementation(async () => active),
        create,
        updateMany
      }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(create).toHaveBeenCalledOnce();
    expect(active).toBeNull();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        activeKey: "active",
        anchorIngestedAt: { lt: newerCustomerMessage.ingestedAt }
      },
      data: expect.objectContaining({ reason: "customer_replied", activeKey: null })
    });
  });

  it("does not cancel a later outbound candidate while ignoring a stale anchor", async () => {
    const laterActive = activeFollowup({
      id: "later_outbound_candidate",
      anchorMessageAt: new Date("2026-09-21T12:02:00.000Z"),
      anchorIngestedAt: new Date("2026-09-21T12:02:00.100Z")
    });
    const newerCustomerMessage = {
      ...baseMessage,
      id: "customer_reply_before_later_outbound",
      direction: "inbound" as const,
      createdAt: new Date("2026-09-21T12:01:00.000Z"),
      ingestedAt: new Date("2026-09-21T12:01:00.100Z")
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = buildPrisma({
      message: {
        findFirst: vi.fn().mockImplementation(async (args: any) =>
          args.where.id === ids.anchor
            ? baseMessage
            : args.where.direction === "inbound"
              ? newerCustomerMessage
              : null
        )
      },
      conversationFollowup: {
        findFirst: vi.fn().mockResolvedValue(laterActive),
        updateMany
      }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "ignored" });
    expect(prisma.conversationFollowup.create).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        activeKey: "active",
        anchorIngestedAt: { lt: newerCustomerMessage.ingestedAt }
      },
      data: expect.objectContaining({ reason: "customer_replied", activeKey: null })
    });
  });

  it("treats an active-key unique conflict as a safe re-read", async () => {
    const concurrent = activeFollowup({ id: "concurrent_followup" });
    const findFirst = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(concurrent);
    const prisma = buildPrisma({
      conversationFollowup: {
        findFirst,
        create: vi.fn().mockRejectedValue(Object.assign(new Error("Duplicate"), { code: "P2002" }))
      }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "scheduled", followupId: "concurrent_followup" });
    expect(prisma.conversationFollowup.create).toHaveBeenCalledOnce();
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("retries a unique conflict when the re-read active candidate has an older anchor", async () => {
    const older = activeFollowup({
      id: "older_followup",
      anchorMessageAt: new Date("2026-09-21T11:00:00.000Z"),
      anchorIngestedAt: new Date("2026-09-21T11:00:00.100Z")
    });
    const findFirst = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(older)
      .mockResolvedValueOnce(older);
    const create = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Duplicate"), { code: "P2002" }))
      .mockResolvedValueOnce(activeFollowup({ id: "replacement_followup" }));
    const prisma = buildPrisma({
      conversationFollowup: { findFirst, create, updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    });

    const result = await createConversationFollowupsService(prisma).observeConversationActivity({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.anchor,
      direction: "outbound",
      source: "agent"
    });

    expect(result).toEqual({ status: "scheduled", followupId: "replacement_followup" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
      where: { id: "older_followup", workspaceId: ids.workspace, activeKey: "active" },
      data: expect.objectContaining({ status: "cancelled", activeKey: null })
    });
  });

  it("cancels revalidation when customer or company activity supersedes the anchor", async () => {
    for (const newerMessage of [
      {
        ...baseMessage,
        id: "customer_reply",
        direction: "inbound",
        createdAt: new Date("2026-09-21T12:01:00.000Z"),
        ingestedAt: new Date("2026-09-21T12:01:00.100Z")
      },
      {
        ...baseMessage,
        id: "human_reply",
        direction: "outbound",
        createdAt: new Date("2026-09-21T12:01:00.000Z"),
        ingestedAt: new Date("2026-09-21T12:01:00.100Z")
      }
    ]) {
      const prisma = buildPrisma({
        conversationFollowup: { findFirst: vi.fn().mockResolvedValue(activeFollowup()) },
        message: {
          findFirst: vi.fn().mockImplementation(async (args: any) =>
            args.where.direction === newerMessage.direction ? newerMessage : null
          )
        }
      });

      const result = await createConversationFollowupsService(prisma).revalidateActiveFollowup({
        workspaceId: ids.workspace,
        followupId: ids.followup,
        now: new Date("2026-09-21T12:02:00.000Z")
      });

      expect(result.status).toBe("cancelled");
      expect(prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
        where: { id: ids.followup, workspaceId: ids.workspace, activeKey: "active" },
        data: expect.objectContaining({ status: "cancelled", activeKey: null })
      });
    }
  });

  it("cancels a candidate when a same-second customer reply was persisted later", async () => {
    const customerReply = {
      ...baseMessage,
      id: "same_second_customer_reply",
      direction: "inbound" as const,
      createdAt: anchorAt,
      ingestedAt: new Date("2026-09-21T12:00:00.200Z")
    };
    const prisma = buildPrisma({
      message: {
        findFirst: vi.fn().mockImplementation(async (args: any) =>
          args.where.direction === "inbound" ? customerReply : null
        )
      },
      conversationFollowup: { findFirst: vi.fn().mockResolvedValue(activeFollowup()) }
    });

    const result = await createConversationFollowupsService(prisma).revalidateActiveFollowup({
      workspaceId: ids.workspace,
      followupId: ids.followup
    });

    expect(result).toMatchObject({ status: "cancelled", reason: "customer_replied" });
    expect(prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ingestedAt: { gt: anchorIngestedAt } })
    }));
  });

  it("cancels a candidate when a provider timestamp arrives out of order", async () => {
    const customerReply = {
      ...baseMessage,
      id: "out_of_order_customer_reply",
      direction: "inbound" as const,
      createdAt: new Date("2026-09-21T11:59:59.000Z"),
      ingestedAt: new Date("2026-09-21T12:00:00.200Z")
    };
    const prisma = buildPrisma({
      message: {
        findFirst: vi.fn().mockImplementation(async (args: any) =>
          args.where.direction === "inbound" ? customerReply : null
        )
      },
      conversationFollowup: { findFirst: vi.fn().mockResolvedValue(activeFollowup()) }
    });

    const result = await createConversationFollowupsService(prisma).revalidateActiveFollowup({
      workspaceId: ids.workspace,
      followupId: ids.followup
    });

    expect(result).toMatchObject({ status: "cancelled", reason: "customer_replied" });
  });

  it("does not treat older inbound history without a later ingestion marker as a reply", async () => {
    const historicalMessages: Array<{
      id: string;
      direction: "inbound";
      createdAt: Date;
      ingestedAt: Date | null;
    }> = [{
      id: "older_history",
      direction: "inbound",
      createdAt: new Date("2099-09-21T12:00:00.000Z"),
      ingestedAt: null
    }];
    const findFirst = vi.fn().mockImplementation(async (args: any) => {
      if (args.where.direction !== "inbound") return null;
      const cutoff = args.where.ingestedAt?.gt as Date | undefined;
      return historicalMessages.find((message) =>
        message.ingestedAt !== null && cutoff !== undefined && message.ingestedAt > cutoff
      ) ?? null;
    });
    const prisma = buildPrisma({
      message: { findFirst },
      conversationFollowup: { findFirst: vi.fn().mockResolvedValue(activeFollowup()) }
    });

    const result = await createConversationFollowupsService(prisma).revalidateActiveFollowup({
      workspaceId: ids.workspace,
      followupId: ids.followup
    });

    expect(result.status).toBe("valid");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ingestedAt: { gt: anchorIngestedAt } })
    }));
  });

  it.each([
    ["the conversation is closed", { ...baseConversation, status: "closed" }],
    [
      "a human takes over",
      {
        ...baseConversation,
        aiControlStatus: "human_controlled",
        activeAgentSession: { ...baseSession, status: "paused_by_human" }
      }
    ]
  ])("cancels revalidation when %s", async (_label, conversation) => {
    const prisma = buildPrisma({
      conversation: { findUnique: vi.fn().mockResolvedValue(conversation) },
      conversationFollowup: { findFirst: vi.fn().mockResolvedValue(activeFollowup()) },
      message: { findFirst: vi.fn().mockResolvedValue(null) }
    });

    const result = await createConversationFollowupsService(prisma).revalidateActiveFollowup({
      workspaceId: ids.workspace,
      followupId: ids.followup
    });

    expect(result.status).toBe("cancelled");
    expect(prisma.conversationFollowup.updateMany).toHaveBeenCalledOnce();
  });

  it("keeps a human commercial cycle valid after human takeover", async () => {
    const pausedSession = { ...baseSession, status: "paused_by_human" };
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseConversation,
          aiControlStatus: "human_controlled",
          activeAgentSession: pausedSession
        })
      },
      conversationFollowup: {
        findFirst: vi.fn().mockResolvedValue(activeFollowup({ kind: "human_commercial" }))
      },
      message: { findFirst: vi.fn().mockResolvedValue(null) },
      aiAgentSession: { findFirst: vi.fn().mockResolvedValue(pausedSession) }
    });

    const result = await createConversationFollowupsService(prisma).revalidateActiveFollowup({
      workspaceId: ids.workspace,
      followupId: ids.followup
    });

    expect(result.status).toBe("valid");
    expect(prisma.conversationFollowup.updateMany).not.toHaveBeenCalled();
  });

  it("cancels revalidation when its session context is no longer compatible", async () => {
    const prisma = buildPrisma({
      conversationFollowup: { findFirst: vi.fn().mockResolvedValue(activeFollowup()) },
      message: { findFirst: vi.fn().mockResolvedValue(null) },
      aiAgentSession: { findFirst: vi.fn().mockResolvedValue({ ...baseSession, status: "closed" }) }
    });

    const result = await createConversationFollowupsService(prisma).revalidateActiveFollowup({
      workspaceId: ids.workspace,
      followupId: ids.followup
    });

    expect(result).toMatchObject({ status: "cancelled", reason: "session_context_changed" });
    expect(prisma.conversationFollowup.updateMany).toHaveBeenCalledOnce();
  });

  it("treats a terminal history row as cancelled without changing it", async () => {
    const prisma = buildPrisma({
      conversationFollowup: {
        findFirst: vi.fn().mockResolvedValue(activeFollowup({ status: "sent", activeKey: null }))
      }
    });

    const result = await createConversationFollowupsService(prisma).revalidateActiveFollowup({
      workspaceId: ids.workspace,
      followupId: ids.followup
    });

    expect(result).toMatchObject({ status: "cancelled", reason: "not_active" });
    expect(prisma.conversationFollowup.updateMany).not.toHaveBeenCalled();
  });
});
