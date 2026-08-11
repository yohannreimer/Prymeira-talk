import { describe, expect, it, vi } from "vitest";
import { AgentTestChatError, createAgentTestChatService } from "./agent-test-chat.js";
import type { AgentProvider } from "./provider-gateway.js";

const baseAgent = {
  id: "00000000-0000-4000-8000-000000000101",
  workspaceId: "workspace_a",
  model: "prymeira-simulated",
  systemPrompt: "Atenda como secretaria.",
  handoffConfig: { confidenceThreshold: 0.55 },
  allowedTags: [
    {
      tag: {
        id: "tag_hot_lead",
        name: "Lead quente",
        color: "#f97316",
        useGuide: "Use quando o cliente demonstrar intenção clara de compra.",
        isActive: true
      }
    },
    {
      tag: {
        id: "tag_inactive",
        name: "Tag inativa",
        color: "#6b7280",
        useGuide: "Nao deve aparecer para o agente.",
        isActive: false
      }
    }
  ]
};

function buildProvider(output: Awaited<ReturnType<AgentProvider["generate"]>>): AgentProvider {
  return {
    generate: vi.fn().mockResolvedValue(output)
  };
}

function buildPrisma(overrides: Record<string, any> = {}) {
  return {
    aiAgent: {
      findFirst: overrides.aiAgent?.findFirst ?? vi.fn().mockResolvedValue(baseAgent)
    },
    aiKnowledgeSource: {
      findMany:
        overrides.aiKnowledgeSource?.findMany ??
        vi.fn().mockResolvedValue([
          {
            id: "knowledge_price",
            title: "Tabela de preços",
            content: "Plano profissional custa R$ 199 por mes.",
            metadata: { category: "precos", keywords: ["plano profissional", "mensalidade"] }
          }
        ])
    },
    integrationConfig: {
      findUnique: overrides.integrationConfig?.findUnique ?? vi.fn().mockResolvedValue(null)
    }
  };
}

describe("createAgentTestChatService", () => {
  it("generates a test reply with chat history and selected knowledge", async () => {
    const prisma = buildPrisma();
    const provider = buildProvider({
      confidence: 0.91,
      reply: "O plano profissional custa R$ 199 por mes.",
      actions: [],
      handoff: { required: false, reason: null },
      sources: [{ id: "knowledge_price", title: "Tabela de preços", category: "precos" }]
    });
    const service = createAgentTestChatService({ prisma, provider });

    const result = await service.sendMessage({
      workspaceId: "workspace_a",
      agentId: baseAgent.id,
      messages: [
        { role: "user", content: "Oi, tudo bem?" },
        { role: "assistant", content: "Tudo bem, como posso ajudar?" },
        { role: "user", content: "Quanto custa o plano profissional?" }
      ]
    });

    expect(result.message).toEqual({
      role: "assistant",
      content: "O plano profissional custa R$ 199 por mes."
    });
    expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        id: baseAgent.id
      },
      include: {
        allowedTags: {
          include: { tag: true },
          orderBy: { tag: { name: "asc" } }
        }
      }
    });
    expect(result.knowledgeMatches).toEqual([
      expect.objectContaining({
        id: "knowledge_price",
        category: "precos",
        reasons: expect.arrayContaining(["category_match"])
      })
    ]);
    expect(result.debug).toEqual(expect.objectContaining({
      providerMode: "simulated",
      model: "prymeira-simulated",
      totalKnowledgeSources: 1,
      selectedKnowledgeSources: 1,
      evaluatedKnowledgeChunks: 1,
      selectedKnowledgeChunks: 1,
      selectedKnowledgeCharacters: "Plano profissional custa R$ 199 por mes.".length,
      protectedFact: "price",
      replyCharacters: "O plano profissional custa R$ 199 por mes.".length,
      replyCompacted: false,
      conversationMessages: 3,
      knowledgeMatches: result.knowledgeMatches,
      allowedTags: ["Lead quente"],
      output: expect.objectContaining({
        confidence: 0.91,
        handoffRequired: false,
        handoffReason: null
      })
    }));
    expect(provider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "prymeira-simulated",
        systemPrompt: "Atenda como secretaria.",
        userPrompt: "Quanto custa o plano profissional?",
        context: expect.objectContaining({
          conversationHistory: expect.stringContaining("cliente: Oi, tudo bem?"),
          conversationMessages: expect.arrayContaining([
            expect.objectContaining({ role: "assistant", content: "Tudo bem, como posso ajudar?" })
          ]),
          allowedTags: [
            {
              id: "tag_hot_lead",
              name: "Lead quente",
              color: "#f97316",
              useGuide: "Use quando o cliente demonstrar intenção clara de compra."
            }
          ],
          knowledge: [
            {
              title: "Tabela de preços",
              content: "Plano profissional custa R$ 199 por mes."
            }
          ]
        })
      })
    );
  });

  it("uses the real provider when workspace settings are active", async () => {
    const prisma = buildPrisma({
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "real",
          settings: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
            chatModel: "gpt-4.1-mini"
          }
        })
      }
    });
    const fallbackProvider = buildProvider({
      confidence: 0.8,
      reply: "Fallback.",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const realProvider = buildProvider({
      confidence: 0.93,
      reply: "Resposta real.",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const providerFactory = vi.fn(() => realProvider);
    const service = createAgentTestChatService({
      prisma,
      provider: fallbackProvider,
      providerFactory
    });

    const result = await service.sendMessage({
      workspaceId: "workspace_a",
      agentId: baseAgent.id,
      messages: [{ role: "user", content: "Qual o preço?" }]
    });

    expect(result.message.content).toBe("Resposta real.");
    expect(providerFactory).toHaveBeenCalledWith({
      active: true,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      chatModel: "gpt-4.1-mini"
    });
    expect(fallbackProvider.generate).not.toHaveBeenCalled();
    expect(realProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4.1-mini"
      })
    );
  });

  it("requests handoff instead of inventing document-dependent answers without knowledge", async () => {
    const prisma = buildPrisma({
      aiKnowledgeSource: {
        findMany: vi.fn().mockResolvedValue([])
      }
    });
    const provider = buildProvider({
      confidence: 0.84,
      reply: "Inventaria um preço.",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const service = createAgentTestChatService({ prisma, provider });

    const result = await service.sendMessage({
      workspaceId: "workspace_a",
      agentId: baseAgent.id,
      messages: [{ role: "user", content: "Qual o preço?" }]
    });

    expect(provider.generate).not.toHaveBeenCalled();
    expect(result.message.content).toBe("Vou consultar essas informações e já te dou um retorno.");
    expect(result.output.handoff.required).toBe(true);
  });

  it("shows the same acknowledgement as WhatsApp when the provider requests handoff", async () => {
    const provider = buildProvider({
      confidence: 0.82,
      reply: "Vou encaminhar você para o comercial.",
      actions: [{ type: "request_handoff", reason: "Cotação pronta para o comercial." }],
      handoff: { required: true, reason: "Cotação pronta para o comercial." }
    });
    const service = createAgentTestChatService({ prisma: buildPrisma(), provider });

    const result = await service.sendMessage({
      workspaceId: "workspace_a",
      agentId: baseAgent.id,
      messages: [{ role: "user", content: "Já passei os dados da cotação." }]
    });

    expect(result.message.content).toBe("Vou consultar essas informações e já te dou um retorno.");
    expect(result.output.reply).toBe("Vou consultar essas informações e já te dou um retorno.");
  });

  it("returns a controlled error when the provider fails", async () => {
    const prisma = buildPrisma({
      aiKnowledgeSource: {
        findMany: vi.fn().mockResolvedValue([])
      }
    });
    const provider: AgentProvider = {
      generate: vi.fn().mockRejectedValue(new Error("provider exploded"))
    };
    const service = createAgentTestChatService({ prisma, provider });

    await expect(
      service.sendMessage({
        workspaceId: "workspace_a",
        agentId: baseAgent.id,
        messages: [{ role: "user", content: "Me fale mais sobre os produtos da Prymeira." }]
      })
    ).rejects.toMatchObject({
      code: "AGENT_PROVIDER_FAILED",
      message:
        "Não foi possível obter resposta do provedor de IA. Verifique a chave, modelo e URL em Ajustes. Detalhe: provider exploded",
      debug: expect.objectContaining({
        providerError: "provider exploded",
        totalKnowledgeSources: 0,
        selectedKnowledgeSources: 0
      })
    } satisfies Partial<AgentTestChatError>);
  });
});
