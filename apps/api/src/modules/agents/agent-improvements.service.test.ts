import { describe, expect, it, vi } from "vitest";
import {
  AgentImprovementsServiceError,
  createAgentImprovementsService,
  type AgentImprovementsPrismaLike
} from "./agent-improvements.service.js";
import type {
  AgentImprovementDetector,
  AgentImprovementNormalizer
} from "./jev-agent-improvement.js";
import { selectRelevantKnowledge } from "./knowledge-retrieval.js";

const workspaceId = "workspace_a";
const agentId = "00000000-0000-4000-8000-000000000101";
const conversationId = "00000000-0000-4000-8000-000000000201";
const humanReplyId = "00000000-0000-4000-8000-000000000301";
const now = new Date("2026-09-22T14:00:00.000Z");

const agent = { id: agentId, workspaceId };
const handoffSession = { id: "session-1", agentId, lastRunAt: new Date("2026-09-22T13:58:00.000Z") };
const customerMessage = {
  id: "00000000-0000-4000-8000-000000000302",
  direction: "inbound" as const,
  type: "text",
  body: "Vocês têm barra chata galvanizada com furos de 7 mm?",
  createdAt: new Date("2026-09-22T13:56:00.000Z")
};
const humanReply = {
  id: humanReplyId,
  direction: "outbound" as const,
  type: "text",
  body: "Não trabalhamos com esse produto.",
  createdAt: new Date("2026-09-22T14:00:00.000Z")
};

const pendingImprovement = {
  id: "00000000-0000-4000-8000-000000000401",
  workspaceId,
  agentId,
  conversationId,
  sourceMessageId: humanReplyId,
  status: "pending" as const,
  kind: "not_sold" as const,
  title: "Produto não comercializado — revisar",
  content: "Não comercializamos este produto.",
  rationale: "A equipe confirmou uma decisão reutilizável.",
  sourceCustomerMessage: customerMessage.body,
  sourceHumanReply: humanReply.body,
  detector: { provider: "jev", confidence: 0.96, kind: "not_sold" },
  clarificationAnswers: {
    scope: "Sim, vale para todas as variações desse item.",
    exceptions: "Nenhuma."
  },
  clarificationNormalization: {
    scope: "requested_item_variations",
    confidence: 0.96,
    requiresHandoffOutsideScope: true
  },
  reviewedAt: null,
  acceptedKnowledgeSourceId: null,
  createdAt: now,
  updatedAt: now
};

type MockPrisma = {
  conversation: { findFirst: ReturnType<typeof vi.fn> };
  aiAgent: { findFirst: ReturnType<typeof vi.fn> };
  aiAgentSession: { findFirst: ReturnType<typeof vi.fn> };
  aiAgentRun: { findFirst: ReturnType<typeof vi.fn> };
  message: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  aiAgentImprovement: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  aiKnowledgeSource: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

function buildPrisma(): MockPrisma & AgentImprovementsPrismaLike {
  const prisma = {
    conversation: { findFirst: vi.fn().mockResolvedValue({ activeAgentSessionId: handoffSession.id }) },
    aiAgent: { findFirst: vi.fn().mockResolvedValue(agent) },
    aiAgentSession: { findFirst: vi.fn().mockResolvedValue(handoffSession) },
    aiAgentRun: { findFirst: vi.fn().mockResolvedValue({ createdAt: handoffSession.lastRunAt }) },
    message: {
      findFirst: vi.fn().mockResolvedValue(humanReply),
      findMany: vi.fn().mockResolvedValue([humanReply, customerMessage])
    },
    aiAgentImprovement: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        ...pendingImprovement,
        ...args.data
      })),
      update: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        ...pendingImprovement,
        ...args.data,
        updatedAt: now
      }))
    },
    aiKnowledgeSource: { create: vi.fn().mockResolvedValue({ id: "source-1" }) },
    $transaction: vi.fn()
  } as MockPrisma;

  prisma.$transaction.mockImplementation(async (callback: (tx: {
    aiKnowledgeSource: MockPrisma["aiKnowledgeSource"];
    aiAgentImprovement: Pick<MockPrisma["aiAgentImprovement"], "update">;
  }) => Promise<unknown>) => callback({
    aiKnowledgeSource: prisma.aiKnowledgeSource,
    aiAgentImprovement: { update: prisma.aiAgentImprovement.update }
  }));

  return prisma as MockPrisma & AgentImprovementsPrismaLike;
}

function detector(result: Awaited<ReturnType<AgentImprovementDetector["assess"]>>) {
  return { assess: vi.fn().mockResolvedValue(result) } satisfies AgentImprovementDetector;
}

function normalizer(result: Awaited<ReturnType<AgentImprovementNormalizer["normalize"]>>) {
  return { normalize: vi.fn().mockResolvedValue(result) } satisfies AgentImprovementNormalizer;
}

describe("createAgentImprovementsService", () => {
  it("learns from a paused handoff and preserves the complete multi-message request", async () => {
    const prisma = buildPrisma();
    const request = { ...customerMessage, id: "00000000-0000-4000-8000-000000000310", body: "Quanto está uma barra de 10 mm e 12 m?", createdAt: new Date("2026-09-22T13:54:00.000Z") };
    const clarification = { ...customerMessage, id: "00000000-0000-4000-8000-000000000311", body: "Barra para viga baldrame. 10 mm.", createdAt: new Date("2026-09-22T13:56:00.000Z") };
    prisma.message.findMany.mockResolvedValue([humanReply, clarification, request]);
    const improvementDetector = detector({ outcome: "suggest", kind: "not_sold", confidence: 0.96 });
    const service = createAgentImprovementsService(prisma, { detector: improvementDetector });

    await expect(service.observeHumanReply({ workspaceId, conversationId, messageId: humanReplyId })).resolves.toEqual({ created: true });
    expect(prisma.aiAgentSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: handoffSession.id, status: { in: ["handoff_requested", "paused_by_human"] } })
    }));
    expect(improvementDetector.assess).toHaveBeenCalledWith(expect.objectContaining({
      customerMessage: expect.stringContaining("Quanto está uma barra de 10 mm e 12 m?")
    }));
    expect(prisma.aiAgentImprovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceCustomerMessage: expect.stringContaining("Barra para viga baldrame. 10 mm.")
      })
    }));
  });
  it("creates a pending, carefully scoped proposal only after a human resolution following handoff", async () => {
    const prisma = buildPrisma();
    const improvementDetector = detector({ outcome: "suggest", kind: "not_sold", confidence: 0.96 });
    const service = createAgentImprovementsService(prisma, { detector: improvementDetector });

    await expect(service.observeHumanReply({ workspaceId, conversationId, messageId: humanReplyId })).resolves.toEqual({
      created: true
    });

    expect(improvementDetector.assess).toHaveBeenCalledWith(expect.objectContaining({
      customerMessage: customerMessage.body,
      humanReply: humanReply.body
    }));
    expect(prisma.aiAgentImprovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId,
        agentId,
        conversationId,
        sourceMessageId: humanReplyId,
        status: "pending",
        kind: "not_sold",
        clarificationAnswers: {},
        clarificationNormalization: {},
        sourceCustomerMessage: customerMessage.body,
        sourceHumanReply: humanReply.body,
        content: expect.stringContaining("Não generalize para materiais parecidos")
      })
    }));
    expect(prisma.aiKnowledgeSource.create).not.toHaveBeenCalled();
  });

  it("does not create a suggestion for a response that JEV cannot classify as reusable", async () => {
    const prisma = buildPrisma();
    prisma.message.findFirst.mockResolvedValue({ ...humanReply, body: "Vou consultar e retorno." });
    const service = createAgentImprovementsService(prisma, {
      detector: detector({ outcome: "ignore", reason: "not_a_durable_human_resolution" })
    });

    await expect(service.observeHumanReply({ workspaceId, conversationId, messageId: humanReplyId })).resolves.toEqual({
      created: false,
      reason: "not_a_durable_human_resolution"
    });
    expect(prisma.aiAgentImprovement.create).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeSource.create).not.toHaveBeenCalled();
  });

  it("recovers an old João-style reply when the reviewer completes the handoff", async () => {
    const prisma = buildPrisma();
    const reply = { ...humanReply, body: "Construção civil não trabalhamos" };
    prisma.message.findMany.mockImplementation(async (args: { where?: { direction?: string } }) =>
      args.where?.direction === "outbound" ? [reply] : [reply, customerMessage]
    );
    prisma.message.findFirst.mockResolvedValue(reply);
    const service = createAgentImprovementsService(prisma, {
      detector: detector({ outcome: "ignore", reason: "not_a_durable_human_resolution" })
    });

    await expect(service.observeLatestHumanReplyAfterHandoff({ workspaceId, conversationId })).resolves.toEqual({
      created: true,
      reason: "not_a_durable_human_resolution_explicit_refusal_fallback"
    });
    expect(prisma.aiAgentImprovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceMessageId: reply.id,
        status: "pending",
        kind: "not_sold",
        detector: expect.objectContaining({ provider: "explicit_human_refusal" })
      })
    }));
  });

  it("still proposes a direct refusal for review when the detector fails", async () => {
    const prisma = buildPrisma();
    const service = createAgentImprovementsService(prisma, {
      detector: { assess: vi.fn().mockRejectedValue(new Error("JEV unavailable")) }
    });
    await expect(service.observeHumanReply({ workspaceId, conversationId, messageId: humanReplyId })).resolves.toEqual({
      created: true,
      reason: "detector_failed_explicit_refusal_fallback"
    });
    expect(prisma.aiAgentImprovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "pending", detector: expect.objectContaining({ provider: "explicit_human_refusal" }) })
    }));
  });

  it("does not claim an improvement when there is no human reply after handoff", async () => {
    const prisma = buildPrisma();
    prisma.message.findMany.mockResolvedValue([]);
    const service = createAgentImprovementsService(prisma);
    await expect(service.observeLatestHumanReplyAfterHandoff({ workspaceId, conversationId })).resolves.toEqual({
      created: false, reason: "no_human_reply_since_handoff"
    });
    expect(prisma.aiAgentImprovement.create).not.toHaveBeenCalled();
  });

  it("never treats an automatic agent message as a human resolution", async () => {
    const prisma = buildPrisma();
    prisma.message.findFirst.mockResolvedValue({ ...humanReply, metadata: { source: "ai_agent" } });
    const improvementDetector = detector({ outcome: "suggest", kind: "not_sold", confidence: 0.96 });
    const service = createAgentImprovementsService(prisma, { detector: improvementDetector });

    await expect(service.observeHumanReply({ workspaceId, conversationId, messageId: humanReplyId })).resolves.toEqual({
      created: false,
      reason: "not_a_text_human_reply"
    });
    expect(improvementDetector.assess).not.toHaveBeenCalled();
    expect(prisma.aiAgentImprovement.create).not.toHaveBeenCalled();
  });

  it("keeps a reply idempotent when the same outbound event is observed twice", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue(pendingImprovement);
    const improvementDetector = detector({ outcome: "suggest", kind: "not_sold", confidence: 0.96 });
    const service = createAgentImprovementsService(prisma, { detector: improvementDetector });

    await expect(service.observeHumanReply({ workspaceId, conversationId, messageId: humanReplyId })).resolves.toEqual({
      created: false,
      reason: "already_observed"
    });
    expect(improvementDetector.assess).not.toHaveBeenCalled();
    expect(prisma.aiAgentImprovement.create).not.toHaveBeenCalled();
  });

  it("adds the reviewed proposal to knowledge only when it is explicitly approved", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue(pendingImprovement);
    const service = createAgentImprovementsService(prisma);

    const approved = await service.approveImprovement({
      workspaceId,
      agentId,
      improvementId: pendingImprovement.id,
      title: "Barra galvanizada furada — não comercializamos"
    });

    expect(prisma.aiKnowledgeSource.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId,
        agentId,
        type: "text",
        title: "Barra galvanizada furada — não comercializamos",
        metadata: expect.objectContaining({
          source: "approved_agent_improvement",
          improvementId: pendingImprovement.id,
          kind: "not_sold",
          normalizedBy: "jev",
          normalizationScope: "requested_item_variations"
        })
      })
    }));
    expect(prisma.aiAgentImprovement.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "accepted",
        acceptedKnowledgeSourceId: "source-1"
      })
    }));
    expect(approved.status).toBe("accepted");
    expect(approved.acceptedKnowledgeSourceId).toBe("source-1");
  });

  it("makes an approved João-style resolution retrievable on the next matching inquiry", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue({
      ...pendingImprovement,
      title: "Barra para viga baldrame — não fornecemos",
      content: "Pedido do cliente: barra de 10 mm e 12 m para viga baldrame.\nDecisão confirmada pelo time: não fornecemos vergalhão para construção civil."
    });
    const service = createAgentImprovementsService(prisma);

    await service.approveImprovement({ workspaceId, agentId, improvementId: pendingImprovement.id });
    const created = prisma.aiKnowledgeSource.create.mock.calls[0]![0].data;
    const selection = selectRelevantKnowledge({
      latestMessage: "Vocês fornecem barra de 10 mm para viga baldrame?",
      conversationHistory: "",
      instruction: null,
      sources: [{ id: "source-1", title: created.title, content: created.content, metadata: created.metadata }]
    });

    expect(selection.selected).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "source-1", content: expect.stringContaining("não fornecemos vergalhão") })
    ]));
  });

  it("requires the team to complete the clarification before it can approve a rule", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue({ ...pendingImprovement, clarificationAnswers: {} });
    const service = createAgentImprovementsService(prisma);

    await expect(service.approveImprovement({ workspaceId, agentId, improvementId: pendingImprovement.id })).rejects.toMatchObject({
      code: "IMPROVEMENT_CLARIFICATION_REQUIRED"
    } satisfies Partial<AgentImprovementsServiceError>);
    expect(prisma.aiKnowledgeSource.create).not.toHaveBeenCalled();
  });

  it("requires a confident JEV interpretation even after the team completed the clarification", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue({
      ...pendingImprovement,
      clarificationNormalization: {}
    });
    const service = createAgentImprovementsService(prisma);

    await expect(service.approveImprovement({ workspaceId, agentId, improvementId: pendingImprovement.id })).rejects.toMatchObject({
      code: "IMPROVEMENT_NORMALIZATION_REQUIRED"
    } satisfies Partial<AgentImprovementsServiceError>);
    expect(prisma.aiKnowledgeSource.create).not.toHaveBeenCalled();
  });

  it("incorporates the team answers into the proposed knowledge before approval", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue({
      ...pendingImprovement,
      content: "Não comercializamos este produto.",
      clarificationAnswers: {}
    });
    const service = createAgentImprovementsService(prisma);

    const updated = await service.updateImprovement({
      workspaceId,
      agentId,
      improvementId: pendingImprovement.id,
      clarificationAnswers: {
        scope: "Sim, vale para todas as medidas e furações.",
        exceptions: "Nenhuma."
      }
    });

    expect(updated.clarification.answers).toEqual({
      scope: "Sim, vale para todas as medidas e furações.",
      exceptions: "Nenhuma."
    });
    expect(updated.content).toContain("Escopo confirmado pelo time:");
    expect(updated.content).toContain("Sim, vale para todas as medidas e furações.");
    expect(updated.content).toContain("Nenhuma.");
    expect(updated.clarification.normalization).toBeNull();
  });

  it("uses JEV to turn the saved team answers into a stable, reviewed scope", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue({
      ...pendingImprovement,
      clarificationNormalization: {}
    });
    const improvementNormalizer = normalizer({
      outcome: "ready",
      normalization: {
        scope: "material_or_finish_family",
        confidence: 0.94,
        requiresHandoffOutsideScope: true
      }
    });
    const service = createAgentImprovementsService(prisma, { normalizer: improvementNormalizer });

    const updated = await service.normalizeImprovement({
      workspaceId,
      agentId,
      improvementId: pendingImprovement.id
    });

    expect(improvementNormalizer.normalize).toHaveBeenCalledWith(expect.objectContaining({
      customerMessage: customerMessage.body,
      humanReply: humanReply.body,
      clarificationAnswers: pendingImprovement.clarificationAnswers
    }));
    expect(updated.clarification.normalization).toEqual({
      scope: "material_or_finish_family",
      confidence: 0.94,
      requiresHandoffOutsideScope: true
    });
    expect(updated.content).toContain("Modo de aplicação interpretado pelo JEV:");
    expect(updated.content).toContain("família de material ou acabamento");
    expect(updated.content).toContain("Fora desse escopo, encaminhe para o comercial");
  });

  it("does not save a rule when JEV cannot delimit the scope safely", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue({
      ...pendingImprovement,
      clarificationNormalization: {}
    });
    const service = createAgentImprovementsService(prisma, {
      normalizer: normalizer({ outcome: "needs_clarification", reason: "normalization_ambiguous" })
    });

    await expect(service.normalizeImprovement({
      workspaceId,
      agentId,
      improvementId: pendingImprovement.id
    })).rejects.toMatchObject({
      code: "IMPROVEMENT_NORMALIZATION_AMBIGUOUS"
    } satisfies Partial<AgentImprovementsServiceError>);
    expect(prisma.aiAgentImprovement.update).not.toHaveBeenCalled();
  });

  it("rejects a pending proposal without creating knowledge", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue(pendingImprovement);
    const service = createAgentImprovementsService(prisma);

    const rejected = await service.updateImprovement({
      workspaceId,
      agentId,
      improvementId: pendingImprovement.id,
      reject: true
    });

    expect(rejected.status).toBe("rejected");
    expect(prisma.aiKnowledgeSource.create).not.toHaveBeenCalled();
  });

  it("does not allow a reviewed proposal to be approved again", async () => {
    const prisma = buildPrisma();
    prisma.aiAgentImprovement.findFirst.mockResolvedValue({ ...pendingImprovement, status: "accepted" as const });
    const service = createAgentImprovementsService(prisma);

    await expect(service.approveImprovement({ workspaceId, agentId, improvementId: pendingImprovement.id })).rejects.toMatchObject({
      code: "IMPROVEMENT_ALREADY_REVIEWED"
    } satisfies Partial<AgentImprovementsServiceError>);
    expect(prisma.aiKnowledgeSource.create).not.toHaveBeenCalled();
  });
});
