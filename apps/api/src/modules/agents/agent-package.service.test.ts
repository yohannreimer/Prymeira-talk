import type { Prisma } from "@prisma/client";
import type { AgentPackage } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentPackageService,
  type AgentPackagePrismaLike
} from "./agent-package.service.js";

const now = new Date("2026-09-05T12:00:00.000Z");
const agentId = "00000000-0000-4000-8000-000000000101";

const validPackage: AgentPackage = {
  schemaVersion: 1,
  kind: "prymeira.agent-package",
  metadata: {
    key: "example-sales-qualifier",
    name: "Example Sales Qualifier",
    companyName: "Example Company",
    industry: "b2b-sales",
    language: "pt-BR",
    description: "Qualifies inbound sales requests."
  },
  variables: [{ key: "seller_name", label: "Nome do vendedor", required: true }],
  agent: {
    name: "Agente de {{seller_name}}",
    description: "Qualifica e encaminha oportunidades.",
    systemPrompt: "Qualifique o contato e encaminhe para {{seller_name}}.",
    qualification: {
      completionStage: "proposal_handoff",
      fields: [
        {
          key: "city",
          label: "Cidade",
          question: "Qual é a cidade de atendimento?",
          valueType: "text",
          requiredFor: ["proposal_handoff"],
          acceptedInputs: ["text"],
          dependsOn: [],
          condition: null,
          confirmationRequired: true
        }
      ]
    },
    knowledgeTaxonomy: [
      {
        key: "service_area",
        label: "Área de atendimento",
        aliases: ["cidade", "região"],
        requiresSource: true
      }
    ],
    behavior: { tone: "consultivo" },
    handoff: { confidenceThreshold: 0.6 },
    limits: { maxMessagesPerSession: 12 },
    followup: {
      timeZone: "America/Sao_Paulo",
      businessDays: [1, 2, 3, 4, 5],
      businessHours: { start: "08:00", end: "18:00" },
      steps: [],
      closeAfterBusinessMinutes: 0
    },
    allowedActions: ["send_message", "create_internal_note", "request_handoff"]
  },
  knowledge: [
    {
      key: "service_area",
      type: "faq",
      title: "Área de atendimento",
      category: "service_area",
      content: "{{seller_name}} confirmará a área de atendimento.",
      approvalStatus: "confirmed",
      source: "Manual comercial",
      approvedBy: "Responsável comercial",
      approvedAt: "2026-09-05T12:00:00.000Z",
      validUntil: null,
      aliases: ["região atendida"]
    }
  ]
};

function buildPrisma() {
  const aiAgentCreate = vi.fn().mockImplementation(async ({ data }) => ({
    id: agentId,
    ...data,
    createdAt: now,
    updatedAt: now
  }));
  const knowledgeCreate = vi.fn().mockImplementation(async ({ data }) => ({
    id: "knowledge_1",
    fileUrl: null,
    fileName: null,
    mimeType: null,
    ...data,
    createdAt: now,
    updatedAt: now
  }));
  const transactionClient = {
    aiAgent: { create: aiAgentCreate },
    aiKnowledgeSource: { create: knowledgeCreate }
  };
  const prisma = {
    aiAgent: { findFirst: vi.fn() },
    aiKnowledgeSource: { findMany: vi.fn() },
    $transaction: vi.fn(async (callback) => callback(transactionClient))
  } as unknown as AgentPackagePrismaLike;

  return { prisma, aiAgentCreate, knowledgeCreate };
}

describe("createAgentPackageService", () => {
  it("imports a valid package as an inactive workspace agent", async () => {
    const { prisma, aiAgentCreate, knowledgeCreate } = buildPrisma();
    const service = createAgentPackageService(prisma);

    const created = await service.importPackage({
      workspaceId: "workspace_a",
      package: validPackage,
      variableValues: { seller_name: "Henry" }
    });

    expect(created.agent.status).toBe("inactive");
    expect(created.agent.name).toBe("Agente de Henry");
    expect(created.agent.systemPrompt).toContain("Henry");
    expect(created.knowledgeCount).toBe(1);
    expect(aiAgentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_a",
        status: "inactive",
        behaviorConfig: expect.objectContaining({
          knowledgeTaxonomy: validPackage.agent.knowledgeTaxonomy,
          deploymentVariables: { seller_name: "Henry" }
        })
      })
    });
    expect(knowledgeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_a",
        agentId,
        content: "Henry confirmará a área de atendimento.",
        metadata: expect.objectContaining({
          approvalStatus: "confirmed",
          packageKey: "example-sales-qualifier"
        })
      })
    });
  });

  it("rejects missing required variables before writing", async () => {
    const { prisma } = buildPrisma();
    const service = createAgentPackageService(prisma);

    await expect(
      service.importPackage({
        workspaceId: "workspace_a",
        package: validPackage,
        variableValues: {}
      })
    ).rejects.toMatchObject({ code: "PACKAGE_VARIABLE_MISSING" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects unknown prompt variables before writing", async () => {
    const { prisma } = buildPrisma();
    const service = createAgentPackageService(prisma);

    await expect(
      service.importPackage({
        workspaceId: "workspace_a",
        package: {
          ...validPackage,
          agent: { ...validPackage.agent, systemPrompt: "Encaminhe para {{unknown_owner}}." }
        },
        variableValues: { seller_name: "Henry" }
      })
    ).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not export an agent from another workspace", async () => {
    const { prisma } = buildPrisma();
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);
    const service = createAgentPackageService(prisma);

    await expect(
      service.exportPackage({ workspaceId: "workspace_b", agentId })
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "workspace_b", id: agentId } })
    );
  });

  it("exports imported templates without deployment values", async () => {
    const { prisma } = buildPrisma();
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      id: agentId,
      workspaceId: "workspace_a",
      name: "Agente de Henry",
      description: validPackage.agent.description,
      status: "inactive",
      providerMode: "prymeira_managed",
      provider: "simulated",
      model: "prymeira-simulated",
      systemPrompt: "Qualifique o contato e encaminhe para Henry.",
      behaviorConfig: {
        packageMetadata: validPackage.metadata,
        packageVariables: validPackage.variables,
        packageAgentNameTemplate: validPackage.agent.name,
        packagePromptTemplate: validPackage.agent.systemPrompt,
        qualification: validPackage.agent.qualification,
        knowledgeTaxonomy: validPackage.agent.knowledgeTaxonomy,
        followup: validPackage.agent.followup,
        deploymentVariables: { seller_name: "Henry" },
        tone: "consultivo"
      },
      handoffConfig: validPackage.agent.handoff as Prisma.JsonObject,
      limitsConfig: validPackage.agent.limits as Prisma.JsonObject,
      allowedActions: validPackage.agent.allowedActions,
      createdAt: now,
      updatedAt: now
    });
    vi.mocked(prisma.aiKnowledgeSource.findMany).mockResolvedValue([
      {
        id: "knowledge_1",
        workspaceId: "workspace_a",
        agentId,
        type: "faq",
        title: "Área de atendimento",
        content: "Henry confirmará a área de atendimento.",
        fileUrl: null,
        fileName: null,
        mimeType: null,
        status: "ready",
        metadata: {
          category: "service_area",
          aliases: ["região atendida"],
          approvalStatus: "confirmed",
          source: "Manual comercial",
          approvedBy: "Responsável comercial",
          approvedAt: "2026-09-05T12:00:00.000Z",
          validUntil: null,
          packageContentTemplate: "{{seller_name}} confirmará a área de atendimento."
        },
        createdAt: now,
        updatedAt: now
      }
    ]);
    const service = createAgentPackageService(prisma);

    const exported = await service.exportPackage({ workspaceId: "workspace_a", agentId });

    expect(exported.variables).toEqual(validPackage.variables);
    expect(exported.agent.name).toBe("Agente de {{seller_name}}");
    expect(exported.agent.systemPrompt).toContain("{{seller_name}}");
    expect(exported.knowledge[0]?.content).toContain("{{seller_name}}");
    expect(JSON.stringify(exported)).not.toContain('"seller_name":"Henry"');
  });
});
