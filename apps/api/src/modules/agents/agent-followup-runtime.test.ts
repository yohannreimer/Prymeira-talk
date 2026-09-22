import { describe, expect, it, vi } from "vitest";
import { createAgentFollowupRuntime } from "./agent-followup-runtime.js";

const ids = {
  workspace: "workspace_a",
  agent: "00000000-0000-4000-8000-000000000101",
  session: "00000000-0000-4000-8000-000000000301",
  conversation: "00000000-0000-4000-8000-000000000401",
  anchor: "00000000-0000-4000-8000-000000000601",
  followup: "00000000-0000-4000-8000-000000000701"
};

const now = new Date("2026-09-22T12:00:00.000Z");

const followupConfig = {
  timeZone: "America/Sao_Paulo",
  businessDays: [1, 2, 3, 4, 5],
  businessHours: { start: "08:00", end: "18:00" },
  steps: [
    { afterBusinessMinutes: 60, instruction: "Peça somente a espessura que falta." },
    { afterBusinessMinutes: 120, instruction: "Confirme a espessura pendente." },
    { afterBusinessMinutes: 180, instruction: "Faça a última confirmação técnica." }
  ],
  closeAfterBusinessMinutes: 0
};

const baseAgent = {
  id: ids.agent,
  workspaceId: ids.workspace,
  status: "active",
  model: "prymeira-simulated",
  systemPrompt: "FULL STORED AGENT PROMPT — never disclose this to JEV.",
  behaviorConfig: { followup: followupConfig },
  handoffConfig: {},
  allowedActions: ["send_message"]
};

const baseFollowup = {
  id: ids.followup,
  workspaceId: ids.workspace,
  conversationId: ids.conversation,
  agentId: ids.agent,
  sessionId: ids.session,
  kind: "qualification" as const,
  status: "scheduled",
  activeKey: "active",
  stepIndex: 1,
  anchorMessageId: ids.anchor,
  anchorMessageAt: now,
  anchorIngestedAt: now,
  scheduledAt: now,
  decision: {}
};

const baseConversation = {
  id: ids.conversation,
  workspaceId: ids.workspace,
  status: "open",
  aiControlStatus: "agent_allowed",
  activeAgentSessionId: ids.session,
  contactId: "contact_1",
  contact: { id: "contact_1", name: "Ana", phone: "5511999999999" },
  channel: { provider: "evolution", providerKey: "instance_1" },
  tags: []
};

const baseMessages = [
  {
    id: "customer_1",
    direction: "inbound",
    type: "text",
    body: "Preciso de chapas, mas ainda não sei a espessura.",
    createdAt: new Date("2026-09-22T10:00:00.000Z")
  },
  {
    id: ids.anchor,
    direction: "outbound",
    type: "text",
    body: "Qual espessura você precisa?",
    createdAt: new Date("2026-09-22T10:01:00.000Z")
  }
];

const automaticDecision = {
  outcome: "follow_up" as const,
  purpose: "missing_qualification" as const,
  route: "automatic_send" as const,
  stage: "qualification" as const,
  risk: "none" as const
};

function validContext(overrides: Record<string, unknown> = {}) {
  return {
    followup: { ...baseFollowup, ...overrides },
    conversation: baseConversation,
    session: {
      id: ids.session,
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      agentId: ids.agent,
      status: "active"
    },
    agent: {
      id: ids.agent,
      workspaceId: ids.workspace,
      status: "active",
      behaviorConfig: baseAgent.behaviorConfig
    }
  };
}

function buildRuntime(overrides: Record<string, any> = {}) {
  const claimScheduledFollowup = overrides.claimScheduledFollowup ?? vi.fn().mockResolvedValue({
    status: "claimed",
    lockedAt: now
  });
  const revalidateActiveFollowup = overrides.revalidateActiveFollowup ?? vi.fn()
    .mockResolvedValueOnce({ status: "valid", context: validContext() })
    .mockResolvedValueOnce({ status: "valid", context: validContext() });
  const completeAutomaticFollowup = overrides.completeAutomaticFollowup ?? vi.fn().mockResolvedValue({
    status: "scheduled",
    followupId: "next_followup"
  });
  const recoverClaimedFollowup = overrides.recoverClaimedFollowup ?? vi.fn().mockResolvedValue({
    status: "recovered"
  });
  const provider = overrides.provider ?? {
    generate: vi.fn().mockResolvedValue({
      confidence: 0.9,
      reply: "Você consegue me informar a espessura da chapa?",
      actions: [],
      handoff: { required: false, reason: null }
    })
  };
  const decide = overrides.decide ?? vi.fn().mockResolvedValue(automaticDecision);
  const audit = overrides.audit ?? vi.fn().mockResolvedValue({ outcome: "send" });
  const replyPreflight = overrides.replyPreflight ?? {
    evaluate: vi.fn().mockResolvedValue({
      outcome: "continue",
      plan: {
        conversationStage: "qualification",
        commercialPath: "not_applicable",
        nextAction: "ask_missing_technical"
      }
    }),
    audit
  };
  const createPendingOutboundMessage = overrides.createPendingOutboundMessage ?? vi.fn().mockResolvedValue({
    message: { id: "outbound_1", status: "sent" }
  });
  const prisma = {
    aiAgent: {
      findFirst: overrides.aiAgent?.findFirst ?? vi.fn().mockResolvedValue(baseAgent)
    },
    conversation: {
      findUnique: overrides.conversation?.findUnique ?? vi.fn().mockResolvedValue(baseConversation),
      update: overrides.conversation?.update ?? vi.fn()
    },
    aiKnowledgeSource: {
      findMany: overrides.aiKnowledgeSource?.findMany ?? vi.fn().mockResolvedValue([
        {
          id: "confirmed_source",
          title: "Ficha técnica confirmada",
          content: "A espessura é necessária antes de cotar.",
          metadata: { approvalStatus: "confirmed", category: "tecnico" }
        },
        {
          id: "behavioral_source",
          title: "Instrução comportamental",
          content: "Nunca use isto como prova comercial.",
          metadata: { approvalStatus: "behavioral" }
        }
      ])
    },
    message: {
      findMany: overrides.message?.findMany ?? vi.fn().mockResolvedValue(baseMessages)
    },
    conversationFollowup: {
      findFirst: overrides.conversationFollowup?.findFirst ?? vi.fn().mockResolvedValue({
        ...baseFollowup,
        status: "review",
        draftBody: "Você consegue me informar a espessura da chapa?",
        finalBody: null,
        reason: "jev_human_review",
        sentByUserId: null,
        sentAt: null,
        cancelledByUserId: null,
        cancelledAt: null,
        createdAt: now,
        updatedAt: now
      }),
      updateMany: overrides.conversationFollowup?.updateMany ?? vi.fn().mockResolvedValue({ count: 1 })
    }
  };
  const runtime = createAgentFollowupRuntime({
    prisma,
    provider,
    followups: {
      claimScheduledFollowup,
      revalidateActiveFollowup,
      completeAutomaticFollowup,
      recoverClaimedFollowup
    },
    jevFollowupDecision: { decide },
    replyPreflight,
    outbound: { createPendingOutboundMessage },
    publisher: overrides.publisher
  });

  return {
    runtime,
    prisma,
    provider,
    decide,
    replyPreflight,
    audit,
    createPendingOutboundMessage,
    revalidateActiveFollowup,
    claimScheduledFollowup,
    completeAutomaticFollowup,
    recoverClaimedFollowup
  };
}

describe("createAgentFollowupRuntime", () => {
  it("never executes a review record automatically", async () => {
    const revalidateActiveFollowup = vi.fn();
    const harness = buildRuntime({
      claimScheduledFollowup: vi.fn().mockResolvedValue({ status: "not_scheduled" }),
      revalidateActiveFollowup
    });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "skipped", followupId: ids.followup });

    expect(revalidateActiveFollowup).not.toHaveBeenCalled();
    expect(harness.decide).not.toHaveBeenCalled();
    expect(harness.provider.generate).not.toHaveBeenCalled();
    expect(harness.createPendingOutboundMessage).not.toHaveBeenCalled();
  });

  it("allows only the winner of concurrent claims to generate and send", async () => {
    const claimScheduledFollowup = vi.fn()
      .mockResolvedValueOnce({ status: "claimed", lockedAt: now })
      .mockResolvedValueOnce({ status: "not_scheduled" });
    const harness = buildRuntime({ claimScheduledFollowup });

    const result = await Promise.all([
      harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }),
      harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup })
    ]);

    expect(result).toEqual([
      { status: "sent", followupId: ids.followup, nextFollowupId: "next_followup" },
      { status: "skipped", followupId: ids.followup }
    ]);
    expect(harness.provider.generate).toHaveBeenCalledTimes(1);
    expect(harness.createPendingOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it("recovers the exact claim when unexpected post-claim work throws", async () => {
    const failure = new Error("AI agent lookup failed");
    const aiAgentFindFirst = vi.fn().mockRejectedValue(failure);
    const harness = buildRuntime({ aiAgent: { findFirst: aiAgentFindFirst } });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({
        status: "failed",
        followupId: ids.followup,
        message: "AI agent lookup failed"
      });

    expect(harness.recoverClaimedFollowup).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      followupId: ids.followup,
      claim: { lockedAt: now },
      outcome: "retry",
      reason: "followup_runtime_unexpected: AI agent lookup failed"
    });
  });

  it("generates an eligible qualification follow-up and delivers it through shared outbound semantics", async () => {
    const harness = buildRuntime();

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "sent", followupId: ids.followup, nextFollowupId: "next_followup" });

    expect(harness.decide).toHaveBeenCalledWith(expect.objectContaining({
      followupKind: "qualification",
      step: 1,
      instruction: followupConfig.steps[0]?.instruction,
      aiControlStatus: "agent_allowed",
      hasCompatibleActiveAgentSession: true,
      selectedKnowledge: [{
        title: "Ficha técnica confirmada",
        content: "A espessura é necessária antes de cotar."
      }]
    }));
    expect(JSON.stringify(harness.decide.mock.calls[0]?.[0])).not.toContain("FULL STORED AGENT PROMPT");
    expect(harness.provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: baseAgent.systemPrompt,
      userPrompt: expect.stringContaining(followupConfig.steps[0]?.instruction),
      context: expect.objectContaining({
        followupGuidance: expect.objectContaining({
          purpose: "missing_qualification",
          route: "automatic_send",
          commercialEvidence: "JEV guidance is not commercial evidence."
        })
      })
    }));
    expect(harness.createPendingOutboundMessage).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      body: "Você consegue me informar a espessura da chapa?",
      sentByUserId: null,
      metadata: {
        source: "ai_agent",
        agentId: ids.agent,
        followupId: ids.followup
      }
    });
    expect(harness.completeAutomaticFollowup).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: ids.workspace,
      followupId: ids.followup,
      finalBody: "Você consegue me informar a espessura da chapa?",
      decision: expect.objectContaining({ ...automaticDecision })
    }));
  });

  it("persists a private draft for human review without changing control or calling transport", async () => {
    const publishUpdated = vi.fn();
    const harness = buildRuntime({
      decide: vi.fn().mockResolvedValue({ ...automaticDecision, route: "human_review", risk: "commercial" }),
      publisher: { publishUpdated }
    });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "review", followupId: ids.followup });

    expect(harness.provider.generate).toHaveBeenCalledTimes(1);
    expect(harness.createPendingOutboundMessage).not.toHaveBeenCalled();
    expect(harness.prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: ids.workspace, id: ids.followup, activeKey: "active" },
      data: expect.objectContaining({
        status: "review",
        draftBody: "Você consegue me informar a espessura da chapa?",
        decision: expect.objectContaining({ ...automaticDecision, route: "human_review", risk: "commercial" }),
        reason: "jev_human_review"
      })
    });
    expect(harness.prisma.conversation.update).not.toHaveBeenCalled();
    expect(publishUpdated).toHaveBeenCalledWith(expect.objectContaining({
      status: "review",
      draftBody: "Você consegue me informar a espessura da chapa?"
    }));
  });

  it.each([
    ["cancel", { ...automaticDecision, outcome: "skip", purpose: "none", route: "cancel" }, "cancelled"],
    ["wait", { ...automaticDecision, outcome: "skip", purpose: "none", route: "wait" }, "skipped"]
  ])("records the JEV %s decision safely without generating or sending", async (_route, decision, status) => {
    const harness = buildRuntime({ decide: vi.fn().mockResolvedValue(decision) });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual(
        status === "cancelled"
          ? { status: "cancelled", followupId: ids.followup, reason: "jev_cancel" }
          : { status: "skipped", followupId: ids.followup }
      );

    expect(harness.provider.generate).not.toHaveBeenCalled();
    expect(harness.createPendingOutboundMessage).not.toHaveBeenCalled();
    expect(harness.prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: ids.workspace, id: ids.followup, activeKey: "active" },
      data: expect.objectContaining({
        status,
        activeKey: null,
        decision,
        reason: `jev_${decision.route}`
      })
    });
  });

  it("suppresses an audited redundant candidate without transport", async () => {
    const harness = buildRuntime({ audit: vi.fn().mockResolvedValue({ outcome: "suppress", reason: "redundant_or_unhelpful" }) });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "skipped", followupId: ids.followup });

    expect(harness.createPendingOutboundMessage).not.toHaveBeenCalled();
    expect(harness.prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: ids.workspace, id: ids.followup, activeKey: "active" },
      data: expect.objectContaining({
        status: "skipped",
        activeKey: null,
        reason: "audit_redundant_or_unhelpful"
      })
    });
  });

  it("moves a protected-fact audit handoff to human review without automatic delivery", async () => {
    const provider = {
      generate: vi.fn().mockResolvedValue({
        confidence: 0.9,
        reply: "Confirmamos entrega amanhã e o preço será R$ 500.",
        actions: [],
        handoff: { required: false, reason: null }
      })
    };
    const harness = buildRuntime({
      provider,
      audit: vi.fn().mockResolvedValue({ outcome: "handoff", reason: "commercial_policy_risk" })
    });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "review", followupId: ids.followup });

    expect(harness.createPendingOutboundMessage).not.toHaveBeenCalled();
    expect(harness.prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: ids.workspace, id: ids.followup, activeKey: "active" },
      data: expect.objectContaining({
        status: "review",
        draftBody: "Confirmamos entrega amanhã e o preço será R$ 500.",
        reason: "audit_commercial_policy_risk"
      })
    });
  });

  it("releases an exact provider claim so a later run can retry without duplicate delivery", async () => {
    const firstClaimAt = new Date("2026-09-22T12:00:00.000Z");
    const secondClaimAt = new Date("2026-09-22T12:05:00.000Z");
    const provider = {
      generate: vi.fn()
        .mockRejectedValueOnce(new Error("provider down"))
        .mockResolvedValueOnce({
          confidence: 0.9,
          reply: "Você consegue me informar a espessura da chapa?",
          actions: [],
          handoff: { required: false, reason: null }
        })
    };
    const recoverClaimedFollowup = vi.fn().mockResolvedValue({ status: "recovered" });
    const harness = buildRuntime({
      provider,
      recoverClaimedFollowup,
      claimScheduledFollowup: vi.fn()
        .mockResolvedValueOnce({ status: "claimed", lockedAt: firstClaimAt })
        .mockResolvedValueOnce({ status: "claimed", lockedAt: secondClaimAt }),
      revalidateActiveFollowup: vi.fn().mockResolvedValue({ status: "valid", context: validContext() })
    });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "failed", followupId: ids.followup, message: "provider down" });
    expect(recoverClaimedFollowup).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      followupId: ids.followup,
      claim: { lockedAt: firstClaimAt },
      outcome: "retry",
      reason: "provider_generation_failed: provider down"
    });
    expect(harness.createPendingOutboundMessage).not.toHaveBeenCalled();

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({
        status: "sent",
        followupId: ids.followup,
        nextFollowupId: "next_followup"
      });
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(harness.createPendingOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it("terminally recovers an exact claim when outbound delivery fails or is unconfirmed", async () => {
    const transportFailure = buildRuntime({
      createPendingOutboundMessage: vi.fn().mockRejectedValue(new Error("transport down"))
    });
    await expect(transportFailure.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "failed", followupId: ids.followup, message: "transport down" });
    expect(transportFailure.completeAutomaticFollowup).not.toHaveBeenCalled();
    expect(transportFailure.recoverClaimedFollowup).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      followupId: ids.followup,
      claim: { lockedAt: now },
      outcome: "failed",
      reason: "outbound_delivery_failed: transport down"
    });

    const unconfirmedDelivery = buildRuntime({
      createPendingOutboundMessage: vi.fn().mockResolvedValue({ message: { id: "pending_outbound", status: "pending" } })
    });
    await expect(unconfirmedDelivery.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({
        status: "failed",
        followupId: ids.followup,
        message: "Outbound delivery was not confirmed."
      });
    expect(unconfirmedDelivery.completeAutomaticFollowup).not.toHaveBeenCalled();
    expect(unconfirmedDelivery.recoverClaimedFollowup).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      followupId: ids.followup,
      claim: { lockedAt: now },
      outcome: "failed",
      reason: "outbound_delivery_unconfirmed"
    });
  });

  it("terminally recovers a confirmed delivery when completion persistence fails", async () => {
    const completionFailure = buildRuntime({
      completeAutomaticFollowup: vi.fn().mockRejectedValue(new Error("completion unavailable"))
    });

    await expect(completionFailure.runtime.runFollowup({
      workspaceId: ids.workspace,
      followupId: ids.followup
    })).resolves.toEqual({
      status: "failed",
      followupId: ids.followup,
      message: "completion unavailable"
    });

    expect(completionFailure.createPendingOutboundMessage).toHaveBeenCalledTimes(1);
    expect(completionFailure.recoverClaimedFollowup).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      followupId: ids.followup,
      claim: { lockedAt: now },
      outcome: "failed",
      reason: "followup_completion_failed_after_delivery: completion unavailable"
    });
  });

  it("does nothing external when stale before generation or after candidate generation", async () => {
    const staleBefore = buildRuntime({
      revalidateActiveFollowup: vi.fn().mockResolvedValue({
        status: "cancelled",
        reason: "customer_replied",
        followup: baseFollowup
      })
    });
    await expect(staleBefore.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "cancelled", followupId: ids.followup, reason: "customer_replied" });
    expect(staleBefore.provider.generate).not.toHaveBeenCalled();
    expect(staleBefore.decide).not.toHaveBeenCalled();
    expect(staleBefore.createPendingOutboundMessage).not.toHaveBeenCalled();

    const staleAfter = buildRuntime({
      revalidateActiveFollowup: vi.fn()
        .mockResolvedValueOnce({ status: "valid", context: validContext() })
        .mockResolvedValueOnce({ status: "cancelled", reason: "customer_replied", followup: baseFollowup })
    });
    await expect(staleAfter.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "cancelled", followupId: ids.followup, reason: "customer_replied" });
    expect(staleAfter.provider.generate).toHaveBeenCalledTimes(1);
    expect(staleAfter.createPendingOutboundMessage).not.toHaveBeenCalled();
    expect(staleAfter.completeAutomaticFollowup).not.toHaveBeenCalled();
  });

  it("does not automatically generate or send a fourth configured step", async () => {
    const configWithFourSteps = {
      ...followupConfig,
      steps: [
        ...followupConfig.steps,
        { afterBusinessMinutes: 240, instruction: "Quarto passo proibido." }
      ]
    };
    const fourthStep = validContext({ stepIndex: 4 });
    const harness = buildRuntime({
      revalidateActiveFollowup: vi.fn().mockResolvedValue({ status: "valid", context: fourthStep }),
      aiAgent: {
        findFirst: vi.fn().mockResolvedValue({
          ...baseAgent,
          behaviorConfig: { followup: configWithFourSteps }
        })
      }
    });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "skipped", followupId: ids.followup });

    expect(harness.decide).not.toHaveBeenCalled();
    expect(harness.provider.generate).not.toHaveBeenCalled();
    expect(harness.createPendingOutboundMessage).not.toHaveBeenCalled();
    expect(harness.prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: ids.workspace, id: ids.followup, activeKey: "active" },
      data: expect.objectContaining({ reason: "followup_step_limit" })
    });
  });

  it("does not report sent when the completion claim lost its active follow-up", async () => {
    const harness = buildRuntime({
      completeAutomaticFollowup: vi.fn().mockResolvedValue({ status: "not_active" })
    });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "skipped", followupId: ids.followup });

    expect(harness.createPendingOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it("releases the exact claim for retry when context or knowledge loading fails", async () => {
    const contextFailure = buildRuntime({
      message: {
        findMany: vi.fn().mockRejectedValue(new Error("context unavailable"))
      }
    });

    await expect(contextFailure.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "failed", followupId: ids.followup, message: "context unavailable" });
    expect(contextFailure.recoverClaimedFollowup).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      followupId: ids.followup,
      claim: { lockedAt: now },
      outcome: "retry",
      reason: "followup_context_or_knowledge_load_failed: context unavailable"
    });
    expect(contextFailure.decide).not.toHaveBeenCalled();
    expect(contextFailure.provider.generate).not.toHaveBeenCalled();
    expect(contextFailure.createPendingOutboundMessage).not.toHaveBeenCalled();

    const knowledgeFailure = buildRuntime({
      aiKnowledgeSource: {
        findMany: vi.fn().mockRejectedValue(new Error("knowledge unavailable"))
      }
    });

    await expect(knowledgeFailure.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "failed", followupId: ids.followup, message: "knowledge unavailable" });
    expect(knowledgeFailure.recoverClaimedFollowup).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      followupId: ids.followup,
      claim: { lockedAt: now },
      outcome: "retry",
      reason: "followup_context_or_knowledge_load_failed: knowledge unavailable"
    });
    expect(knowledgeFailure.decide).not.toHaveBeenCalled();
    expect(knowledgeFailure.provider.generate).not.toHaveBeenCalled();
    expect(knowledgeFailure.createPendingOutboundMessage).not.toHaveBeenCalled();
  });

  it("moves an oversized complete context to review before JEV, provider, or transport", async () => {
    const harness = buildRuntime({
      message: {
        findMany: vi.fn().mockResolvedValue(Array.from({ length: 2_001 }, (_, index) => ({
          id: `message_${index}`,
          body: "mensagem",
          direction: "inbound",
          type: "text",
          createdAt: now
        })))
      }
    });

    await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "review", followupId: ids.followup });

    expect(harness.decide).not.toHaveBeenCalled();
    expect(harness.provider.generate).not.toHaveBeenCalled();
    expect(harness.createPendingOutboundMessage).not.toHaveBeenCalled();
    expect(harness.recoverClaimedFollowup).not.toHaveBeenCalled();
    expect(harness.prisma.conversationFollowup.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: ids.workspace, id: ids.followup, activeKey: "active" },
      data: expect.objectContaining({ status: "review", reason: "conversation_context_limit" })
    });
  });

  it("never automatically sends a human-owned, commercial-risk, or human-controlled path", async () => {
    for (const decision of [
      { ...automaticDecision, risk: "commercial" as const },
      { ...automaticDecision, stage: "post_proposal" as const },
      { ...automaticDecision, purpose: "proposal_checkin" as const }
    ]) {
      const harness = buildRuntime({ decide: vi.fn().mockResolvedValue(decision) });
      await expect(harness.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
        .resolves.toEqual({ status: "review", followupId: ids.followup });
      expect(harness.createPendingOutboundMessage).not.toHaveBeenCalled();
    }

    const humanCommercial = buildRuntime({
      revalidateActiveFollowup: vi.fn()
        .mockResolvedValueOnce({ status: "valid", context: validContext({ kind: "human_commercial" }) })
        .mockResolvedValueOnce({ status: "valid", context: validContext({ kind: "human_commercial" }) })
    });
    await expect(humanCommercial.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "review", followupId: ids.followup });
    expect(humanCommercial.createPendingOutboundMessage).not.toHaveBeenCalled();

    const humanControlled = buildRuntime({
      revalidateActiveFollowup: vi.fn().mockResolvedValue({
        status: "cancelled",
        reason: "human_controlled",
        followup: baseFollowup,
        conversation: { ...baseConversation, aiControlStatus: "human_controlled" }
      })
    });
    await expect(humanControlled.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "cancelled", followupId: ids.followup, reason: "human_controlled" });
    expect(humanControlled.createPendingOutboundMessage).not.toHaveBeenCalled();
  });
});
