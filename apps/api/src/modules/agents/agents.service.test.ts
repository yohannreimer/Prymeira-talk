import { describe, expect, it, vi } from "vitest";
import { AgentsServiceError, createAgentsService } from "./agents.service.js";
import type { AgentsPrismaLike } from "./agents.service.js";

const now = new Date("2026-06-23T18:00:00.000Z");
const agentId = "00000000-0000-4000-8000-000000000101";
const knowledgeSourceId = "00000000-0000-4000-8000-000000000201";
const tagIdA = "00000000-0000-4000-8000-000000000301";
const tagIdB = "00000000-0000-4000-8000-000000000302";
const tagIdC = "00000000-0000-4000-8000-000000000303";

type MockPrisma = {
  aiAgent: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  aiKnowledgeSource: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  tag: {
    count: ReturnType<typeof vi.fn>;
  };
  aiAgentAllowedTag: {
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const baseAgent = {
  id: agentId,
  workspaceId: "workspace_a",
  name: "Secretaria IA",
  description: null,
  status: "inactive" as const,
  providerMode: "prymeira_managed" as const,
  provider: "simulated",
  model: "prymeira-simulated",
  systemPrompt: "Atenda com clareza.",
  behaviorConfig: {},
  handoffConfig: { confidenceThreshold: 0.55 },
  limitsConfig: { maxMessagesPerSession: 12 },
  allowedActions: ["send_message"],
  createdAt: now,
  updatedAt: now
};

const baseKnowledgeSource = {
  id: knowledgeSourceId,
  workspaceId: "workspace_a",
  agentId,
  type: "faq" as const,
  title: "Horário",
  content: "Atendemos das 8h as 18h.",
  fileUrl: null,
  fileName: null,
  mimeType: null,
  status: "ready" as const,
  metadata: {},
  createdAt: now,
  updatedAt: now
};

function buildPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & AgentsPrismaLike {
  const prisma = {
    aiAgent: {
      findMany: overrides.aiAgent?.findMany ?? vi.fn().mockResolvedValue([]),
      findFirst: overrides.aiAgent?.findFirst ?? vi.fn().mockResolvedValue(null),
      create:
        overrides.aiAgent?.create ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseAgent,
          ...args.data
        })),
      update:
        overrides.aiAgent?.update ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseAgent,
          ...args.data
        }))
    },
    aiKnowledgeSource: {
      findMany: overrides.aiKnowledgeSource?.findMany ?? vi.fn().mockResolvedValue([]),
      create:
        overrides.aiKnowledgeSource?.create ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseKnowledgeSource,
          ...args.data
        }))
    },
    tag: {
      count: overrides.tag?.count ?? vi.fn().mockResolvedValue(0)
    },
    aiAgentAllowedTag: {
      deleteMany: overrides.aiAgentAllowedTag?.deleteMany ?? vi.fn().mockResolvedValue({ count: 0 }),
      createMany: overrides.aiAgentAllowedTag?.createMany ?? vi.fn().mockResolvedValue({ count: 0 })
    },
    $transaction: overrides.$transaction ?? vi.fn()
  } as MockPrisma & AgentsPrismaLike;

  prisma.$transaction.mockImplementation(async (callback) => {
    const tx = {
      aiAgent: prisma.aiAgent,
      tag: prisma.tag,
      aiAgentAllowedTag: prisma.aiAgentAllowedTag
    };

    return callback(tx);
  });

  return prisma;
}

describe("createAgentsService", () => {
  it.each([undefined, "none", "low"] as const)("stores an explicitly bounded reasoning setting on create: %s", async (reasoningEffort) => {
    const prisma = buildPrisma();
    const result = await createAgentsService(prisma).createAgent({ workspaceId: "workspace_a", name: "Pilot", systemPrompt: "Atenda com clareza.", reasoningEffort });
    expect(result.behaviorConfig.reasoningEffort).toBe(reasoningEffort ?? "none");
    expect(result.status).toBe("inactive");
  });

  it("updates reasoning without replacing the agent's other behavior fields", async () => {
    const prisma = buildPrisma();
    prisma.aiAgent.findFirst.mockResolvedValue({ ...baseAgent, behaviorConfig: { reasoningEffort: "none", qualification: { requiredFields: ["city"] }, taxonomy: ["produto"] } });
    const result = await createAgentsService(prisma).updateAgent({ workspaceId: "workspace_a", agentId, data: { reasoningEffort: "low" } });
    expect(result.behaviorConfig).toEqual({ reasoningEffort: "low", qualification: { requiredFields: ["city"] }, taxonomy: ["produto"] });
    expect(prisma.aiAgent.update).toHaveBeenCalledWith(expect.objectContaining({ data: { behaviorConfig: result.behaviorConfig } }));
  });

  it("does not touch behavior configuration when reasoning is omitted", async () => {
    const prisma = buildPrisma();
    prisma.aiAgent.findFirst.mockResolvedValue({ ...baseAgent, behaviorConfig: { reasoningEffort: "low", qualification: { requiredFields: ["city"] } } });
    await createAgentsService(prisma).updateAgent({ workspaceId: "workspace_a", agentId, data: { name: "Renamed pilot" } });
    expect(prisma.aiAgent.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "Renamed pilot" } }));
  });

  it.each(["medium", "high", "", null])( "rejects unsupported reasoning values in service calls: %s", async (reasoningEffort) => {
    const prisma = buildPrisma();
    prisma.aiAgent.findFirst.mockResolvedValue(baseAgent);
    const service = createAgentsService(prisma);
    await expect(service.createAgent({ workspaceId: "workspace_a", name: "Pilot", systemPrompt: "Atenda com clareza.", reasoningEffort: reasoningEffort as never })).rejects.toMatchObject({ code: "AGENT_INVALID_CONFIG" });
    await expect(service.updateAgent({ workspaceId: "workspace_a", agentId, data: { reasoningEffort: reasoningEffort as never } })).rejects.toMatchObject({ code: "AGENT_INVALID_CONFIG" });
    expect(prisma.aiAgent.create).not.toHaveBeenCalled();
    expect(prisma.aiAgent.update).not.toHaveBeenCalled();
  });
  it("returns allowed tags from agent relations when listing agents", async () => {
    const prisma = buildPrisma({
      aiAgent: {
        findMany: vi.fn().mockResolvedValue([
          {
            ...baseAgent,
            allowedTags: [
              {
                tag: {
                  id: tagIdB,
                  name: "VIP",
                  color: "#f97316",
                  useGuide: "Use para clientes prioritários.",
                  isActive: true
                }
              },
              {
                tag: {
                  id: tagIdC,
                  name: "Arquivada",
                  color: "#64748b",
                  useGuide: "Não deve aparecer.",
                  isActive: false
                }
              }
            ]
          }
        ]),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    const service = createAgentsService(prisma);

    const agents = await service.listAgents({ workspaceId: "workspace_a" });

    expect(agents[0]?.allowedTags).toEqual([
      {
        id: tagIdB,
        name: "VIP",
        color: "#f97316",
        useGuide: "Use para clientes prioritários."
      }
    ]);
    expect(prisma.aiAgent.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a" },
      orderBy: [{ createdAt: "asc" }],
      include: expect.objectContaining({
        allowedTags: expect.any(Object)
      })
    });
  });

  it("creates an inactive agent with safe defaults", async () => {
    const prisma = buildPrisma();
    const service = createAgentsService(prisma);

    const agent = await service.createAgent({
      workspaceId: "workspace_a",
      name: "Secretaria IA",
      systemPrompt: "Atenda com clareza."
    });

    expect(agent).toEqual(
      expect.objectContaining({
        status: "inactive",
        providerMode: "prymeira_managed",
        provider: "simulated",
        model: "prymeira-simulated",
        allowedActions: ["send_message"]
      })
    );
    expect(prisma.aiAgent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_a",
        name: "Secretaria IA",
        description: null,
        status: "inactive",
        providerMode: "prymeira_managed",
        provider: "simulated",
        model: "prymeira-simulated",
        systemPrompt: "Atenda com clareza.",
        allowedActions: ["send_message"]
      })
    });
  });

  it("can create an active agent when message sending is allowed", async () => {
    const prisma = buildPrisma();
    const service = createAgentsService(prisma);

    const agent = await service.createAgent({
      workspaceId: "workspace_a",
      name: "Secretaria IA",
      status: "active",
      systemPrompt: "Atenda com clareza.",
      allowedActions: ["send_message"]
    });

    expect(agent.status).toBe("active");
    expect(prisma.aiAgent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "active",
        allowedActions: ["send_message"]
      })
    });
  });

  it("rejects creating an agent with missing or inactive allowed tags before creating", async () => {
    const prisma = buildPrisma({
      tag: {
        count: vi.fn().mockResolvedValue(1)
      }
    });
    const service = createAgentsService(prisma);

    await expect(
      service.createAgent({
        workspaceId: "workspace_a",
        name: "Secretaria IA",
        systemPrompt: "Atenda com clareza.",
        allowedTagIds: [tagIdA, tagIdC]
      })
    ).rejects.toMatchObject({
      code: "AGENT_INVALID_CONFIG",
      message: "Allowed tags must exist and be active."
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tag.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        id: { in: [tagIdA, tagIdC] },
        isActive: true
      }
    });
    expect(prisma.aiAgent.create).not.toHaveBeenCalled();
    expect(prisma.aiAgentAllowedTag.createMany).not.toHaveBeenCalled();
  });

  it("rejects activating an agent when allowedActions does not include send_message", async () => {
    const prisma = buildPrisma({
      aiAgent: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(baseAgent),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    const service = createAgentsService(prisma);

    await expect(
      service.updateAgent({
        workspaceId: "workspace_a",
        agentId,
        data: {
          status: "active",
          allowedActions: ["add_tag"]
        }
      })
    ).rejects.toMatchObject({
      code: "AGENT_INVALID_CONFIG"
    });
    await expect(
      service.updateAgent({
        workspaceId: "workspace_a",
        agentId,
        data: {
          status: "active",
          allowedActions: ["add_tag"]
        }
      })
    ).rejects.toBeInstanceOf(AgentsServiceError);
    expect(prisma.aiAgent.update).not.toHaveBeenCalled();
  });

  it("rejects activating an existing agent whose stored allowedActions lacks send_message", async () => {
    const prisma = buildPrisma({
      aiAgent: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({
          ...baseAgent,
          allowedActions: ["add_tag"]
        }),
        create: vi.fn(),
        update: vi.fn().mockImplementation(async (args) => ({
          ...baseAgent,
          allowedActions: ["add_tag"],
          ...args.data
        }))
      }
    });
    const service = createAgentsService(prisma);

    await expect(
      service.updateAgent({
        workspaceId: "workspace_a",
        agentId,
        data: {
          status: "active"
        }
      })
    ).rejects.toMatchObject({
      code: "AGENT_INVALID_CONFIG"
    });
    expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        id: agentId
      },
      include: expect.objectContaining({
        allowedTags: expect.any(Object)
      })
    });
    expect(prisma.aiAgent.update).not.toHaveBeenCalled();
  });

  it("replaces allowed tags when updating an agent", async () => {
    const prisma = buildPrisma({
      aiAgent: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(baseAgent)
          .mockResolvedValueOnce({
            ...baseAgent,
            allowedTags: [
              {
                tag: {
                  id: tagIdA,
                  name: "Lead quente",
                  color: "#dc2626",
                  useGuide: "Use quando houver intenção clara.",
                  isActive: true
                }
              },
              {
                tag: {
                  id: tagIdB,
                  name: "VIP",
                  color: "#f97316",
                  useGuide: "Use para clientes prioritários.",
                  isActive: true
                }
              }
            ]
          }),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(baseAgent)
      },
      tag: {
        count: vi.fn().mockResolvedValue(2)
      }
    });
    const service = createAgentsService(prisma);

    const agent = await service.updateAgent({
      workspaceId: "workspace_a",
      agentId,
      data: {
        allowedTagIds: [tagIdA, tagIdB, tagIdA]
      }
    });

    expect(agent.allowedTags).toEqual([
      {
        id: tagIdA,
        name: "Lead quente",
        color: "#dc2626",
        useGuide: "Use quando houver intenção clara."
      },
      {
        id: tagIdB,
        name: "VIP",
        color: "#f97316",
        useGuide: "Use para clientes prioritários."
      }
    ]);
    expect(prisma.tag.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        id: { in: [tagIdA, tagIdB] },
        isActive: true
      }
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.aiAgent.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: agentId
        }
      },
      data: {},
      include: expect.objectContaining({
        allowedTags: expect.any(Object)
      })
    });
    const transactionCallback = prisma.$transaction.mock.calls[0]?.[0];
    expect(transactionCallback).toBeDefined();
    expect(prisma.aiAgent.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.$transaction.mock.invocationCallOrder[0]
    );
    expect(prisma.aiAgentAllowedTag.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        agentId
      }
    });
    expect(prisma.aiAgentAllowedTag.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: "workspace_a", agentId, tagId: tagIdA },
        { workspaceId: "workspace_a", agentId, tagId: tagIdB }
      ]
    });
  });

  it("rejects replacing allowed tags with missing or inactive tags", async () => {
    const prisma = buildPrisma({
      aiAgent: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(baseAgent),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(baseAgent)
      },
      tag: {
        count: vi.fn().mockResolvedValue(1)
      }
    });
    const service = createAgentsService(prisma);

    await expect(
      service.updateAgent({
        workspaceId: "workspace_a",
        agentId,
        data: {
          allowedTagIds: [tagIdA, tagIdC]
        }
      })
    ).rejects.toMatchObject({
      code: "AGENT_INVALID_CONFIG",
      message: "Allowed tags must exist and be active."
    });
    expect(prisma.tag.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        id: { in: [tagIdA, tagIdC] },
        isActive: true
      }
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.aiAgentAllowedTag.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiAgentAllowedTag.createMany).not.toHaveBeenCalled();
  });

  it("rejects updating fields with missing or inactive allowed tags before updating", async () => {
    const prisma = buildPrisma({
      aiAgent: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(baseAgent),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(baseAgent)
      },
      tag: {
        count: vi.fn().mockResolvedValue(1)
      }
    });
    const service = createAgentsService(prisma);

    await expect(
      service.updateAgent({
        workspaceId: "workspace_a",
        agentId,
        data: {
          name: "Novo nome",
          allowedTagIds: [tagIdA, tagIdC]
        }
      })
    ).rejects.toMatchObject({
      code: "AGENT_INVALID_CONFIG",
      message: "Allowed tags must exist and be active."
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tag.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        id: { in: [tagIdA, tagIdC] },
        isActive: true
      }
    });
    expect(prisma.aiAgent.update).not.toHaveBeenCalled();
    expect(prisma.aiAgentAllowedTag.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiAgentAllowedTag.createMany).not.toHaveBeenCalled();
  });

  it("creates a knowledge source for an existing agent, status ready", async () => {
    const prisma = buildPrisma({
      aiAgent: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(baseAgent),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    const service = createAgentsService(prisma);

    const source = await service.createKnowledgeSource({
      workspaceId: "workspace_a",
      agentId,
      type: "faq",
      title: "Horário",
      content: "Atendemos das 8h as 18h.",
      metadata: {
        category: "precos",
        sourceKind: "text"
      }
    });

    expect(source).toEqual(
      expect.objectContaining({
        agentId,
        type: "faq",
        title: "Horário",
        status: "ready"
      })
    );
    expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        id: agentId
      },
      include: expect.objectContaining({
        allowedTags: expect.any(Object)
      })
    });
    expect(prisma.aiKnowledgeSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_a",
        agentId,
        type: "faq",
        title: "Horário",
        status: "ready",
        metadata: {
          category: "precos",
          sourceKind: "text"
        }
      })
    });
  });

  it("throws AgentsServiceError when creating knowledge for a missing agent", async () => {
    const prisma = buildPrisma();
    const service = createAgentsService(prisma);

    await expect(
      service.createKnowledgeSource({
        workspaceId: "workspace_a",
        agentId,
        type: "text",
        title: "Base",
        content: "Conteúdo"
      })
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND"
    });
    await expect(
      service.createKnowledgeSource({
        workspaceId: "workspace_a",
        agentId,
        type: "text",
        title: "Base",
        content: "Conteúdo"
      })
    ).rejects.toBeInstanceOf(AgentsServiceError);
    expect(prisma.aiKnowledgeSource.create).not.toHaveBeenCalled();
  });
});
