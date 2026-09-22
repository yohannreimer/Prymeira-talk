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
  const revalidateActiveFollowup = overrides.revalidateActiveFollowup ?? vi.fn()
    .mockResolvedValueOnce({ status: "valid", context: validContext() })
    .mockResolvedValueOnce({ status: "valid", context: validContext() });
  const completeAutomaticFollowup = overrides.completeAutomaticFollowup ?? vi.fn().mockResolvedValue({
    status: "scheduled",
    followupId: "next_followup"
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
      updateMany: overrides.conversationFollowup?.updateMany ?? vi.fn().mockResolvedValue({ count: 1 })
    }
  };
  const runtime = createAgentFollowupRuntime({
    prisma,
    provider,
    followups: { revalidateActiveFollowup, completeAutomaticFollowup },
    jevFollowupDecision: { decide },
    replyPreflight,
    outbound: { createPendingOutboundMessage }
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
    completeAutomaticFollowup
  };
}

describe("createAgentFollowupRuntime", () => {
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
    const harness = buildRuntime({
      decide: vi.fn().mockResolvedValue({ ...automaticDecision, route: "human_review", risk: "commercial" })
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

  it("does not persist outbound or final follow-up state when generation or transport fails", async () => {
    const providerFailure = buildRuntime({ provider: { generate: vi.fn().mockRejectedValue(new Error("provider down")) } });
    await expect(providerFailure.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "failed", followupId: ids.followup, message: "provider down" });
    expect(providerFailure.prisma.conversationFollowup.updateMany).not.toHaveBeenCalled();

    const transportFailure = buildRuntime({ createPendingOutboundMessage: vi.fn().mockRejectedValue(new Error("transport down")) });
    await expect(transportFailure.runtime.runFollowup({ workspaceId: ids.workspace, followupId: ids.followup }))
      .resolves.toEqual({ status: "failed", followupId: ids.followup, message: "transport down" });
    expect(transportFailure.completeAutomaticFollowup).not.toHaveBeenCalled();
    expect(transportFailure.prisma.conversationFollowup.updateMany).not.toHaveBeenCalled();

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
    expect(unconfirmedDelivery.prisma.conversationFollowup.updateMany).not.toHaveBeenCalled();
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
