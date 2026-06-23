import { describe, expect, it, vi } from "vitest";
import { AgentsServiceError, createAgentsService } from "./agents.service.js";
import type { AgentsPrismaLike } from "./agents.service.js";

const now = new Date("2026-06-23T18:00:00.000Z");
const agentId = "00000000-0000-4000-8000-000000000101";
const knowledgeSourceId = "00000000-0000-4000-8000-000000000201";

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
  title: "Horario",
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
  return {
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
    }
  } as MockPrisma & AgentsPrismaLike;
}

describe("createAgentsService", () => {
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
      }
    });
    expect(prisma.aiAgent.update).not.toHaveBeenCalled();
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
      title: "Horario",
      content: "Atendemos das 8h as 18h."
    });

    expect(source).toEqual(
      expect.objectContaining({
        agentId,
        type: "faq",
        title: "Horario",
        status: "ready"
      })
    );
    expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        id: agentId
      }
    });
    expect(prisma.aiKnowledgeSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_a",
        agentId,
        type: "faq",
        title: "Horario",
        status: "ready"
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
        content: "Conteudo"
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
        content: "Conteudo"
      })
    ).rejects.toBeInstanceOf(AgentsServiceError);
    expect(prisma.aiKnowledgeSource.create).not.toHaveBeenCalled();
  });
});
