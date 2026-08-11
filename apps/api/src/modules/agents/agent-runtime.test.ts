import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime } from "./agent-runtime.js";
import type {
  AgentToolExecutorPrismaLike,
  AgentToolExecutorTransactionLike
} from "./agent-tool-executor.js";
import type { AgentProvider } from "./provider-gateway.js";

const now = new Date("2026-06-23T18:00:00.000Z");

const ids = {
  workspace: "workspace_a",
  agent: "00000000-0000-4000-8000-000000000101",
  session: "00000000-0000-4000-8000-000000000301",
  conversation: "00000000-0000-4000-8000-000000000401",
  contact: "00000000-0000-4000-8000-000000000501",
  message: "00000000-0000-4000-8000-000000000601",
  run: "00000000-0000-4000-8000-000000000701"
};

const baseAgent = {
  id: ids.agent,
  workspaceId: ids.workspace,
  name: "Secretaria IA",
  status: "active",
  providerMode: "prymeira_managed",
  provider: "simulated",
  model: "prymeira-simulated",
  systemPrompt: "Atenda bem.",
  behaviorConfig: {},
  handoffConfig: { confidenceThreshold: 0.55 },
  limitsConfig: { maxMessagesPerSession: 12 },
  allowedActions: ["send_message", "add_tag", "request_handoff"],
  allowedTags: [
    {
      tag: {
        id: "tag_allowed_ai",
        name: "Atendido pela IA",
        color: "#24564a",
        useGuide: "Use quando a IA respondeu ao cliente.",
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

const baseConversation = {
  id: ids.conversation,
  workspaceId: ids.workspace,
  contactId: ids.contact,
  channelId: "00000000-0000-4000-8000-000000000801",
  status: "open",
  assignedUserId: null,
  departmentId: null,
  assignedUser: null,
  department: null,
  lastMessageAt: now,
  lastMessagePreview: "Oi, quanto custa o plano profissional?",
  unreadCount: 0,
  priority: "normal",
  aiControlStatus: "agent_allowed",
  activeAgentSessionId: null,
  activeAgentSession: {
    status: "active",
    handoffReason: null,
    agent: { name: "Secretaria IA" }
  },
  contact: {
    id: ids.contact,
    name: "Maria",
    phone: "5511999999999",
    email: "maria@example.com",
    company: "Maria LTDA"
  },
  channel: {
    id: "00000000-0000-4000-8000-000000000801",
    displayName: "WhatsApp",
    phoneNumber: "5511888888888",
    provider: "evolution",
    providerKey: "instancia"
  },
  tags: [{ tag: { id: "tag_1", name: "Lead", color: "#24564a" } }]
};

const baseMessage = {
  id: ids.message,
  workspaceId: ids.workspace,
  conversationId: ids.conversation,
  direction: "inbound",
  type: "text",
  body: "Oi, quanto custa o plano profissional?",
  createdAt: now
};

const baseConversationMessages = [
  {
    id: "message_previous_inbound",
    workspaceId: ids.workspace,
    conversationId: ids.conversation,
    direction: "inbound",
    type: "text",
    body: "Oi, vocês atendem hoje?",
    createdAt: new Date("2026-06-23T17:58:00.000Z")
  },
  {
    id: "message_previous_outbound",
    workspaceId: ids.workspace,
    conversationId: ids.conversation,
    direction: "outbound",
    type: "text",
    body: "Sim, atendemos das 8h as 18h.",
    createdAt: new Date("2026-06-23T17:59:00.000Z")
  },
  baseMessage
];

function buildProvider(output: Awaited<ReturnType<AgentProvider["generate"]>>): AgentProvider {
  return {
    generate: vi.fn().mockResolvedValue(output)
  };
}

function buildPrisma(overrides: Record<string, any> = {}) {
  let transactionClient: AgentToolExecutorTransactionLike;
  const conversationFindUnique =
    overrides.conversation?.findUnique ?? vi.fn().mockResolvedValue(baseConversation);
  const conversationUpdate = overrides.conversation?.update ?? vi.fn().mockResolvedValue({});
  const transaction = vi.fn(
    <T,>(callback: Parameters<AgentToolExecutorPrismaLike["$transaction"]>[0]) =>
      callback(transactionClient)
  ) as AgentToolExecutorPrismaLike["$transaction"] & ReturnType<typeof vi.fn>;

  transactionClient = {
    conversation: {
      findUnique: conversationFindUnique,
      update: conversationUpdate
    },
    tag: {
      upsert: overrides.tag?.upsert ?? vi.fn().mockResolvedValue({ id: "tag_2" })
    },
    conversationTag: {
      upsert: overrides.conversationTag?.upsert ?? vi.fn().mockResolvedValue({}),
      deleteMany: overrides.conversationTag?.deleteMany ?? vi.fn().mockResolvedValue({ count: 0 })
    },
    contactNote: {
      create: overrides.contactNote?.create ?? vi.fn().mockResolvedValue({})
    },
    userProfile: {
      findUnique: overrides.userProfile?.findUnique ?? vi.fn().mockResolvedValue({ id: "user_1" })
    },
    department: {
      findUnique:
        overrides.department?.findUnique ?? vi.fn().mockResolvedValue({ id: "department_1" })
    },
    aiAgentSession: {
      update: overrides.aiAgentSession?.update ?? vi.fn().mockResolvedValue({})
    }
  } satisfies AgentToolExecutorTransactionLike;

  return {
    $transaction: overrides.$transaction ?? transaction,
    ...transactionClient,
    conversation: {
      findUnique: conversationFindUnique,
      update: conversationUpdate
    },
    aiAgent: {
      findFirst: vi.fn().mockResolvedValue(baseAgent)
    },
    integrationConfig: {
      findUnique: overrides.integrationConfig?.findUnique ?? vi.fn().mockResolvedValue(null)
    },
    aiKnowledgeSource: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "knowledge_1",
          title: "Tabela de preços",
          content: "Plano profissional custa R$ 199 por mes.",
          metadata: { category: "precos", keywords: ["plano profissional", "mensalidade"] },
          status: "ready"
        }
      ])
    },
    aiAgentSession: {
      ...transactionClient.aiAgentSession,
      upsert: vi.fn().mockResolvedValue({
        id: ids.session,
        workspaceId: ids.workspace,
        agentId: ids.agent,
        conversationId: ids.conversation,
        status: "active",
        messageCount: 0,
        lastRunAt: null,
        handoffReason: null,
        createdAt: now,
        updatedAt: now
      })
    },
    message: {
      findFirst: vi.fn().mockResolvedValue(baseMessage),
      findMany: vi.fn().mockResolvedValue(baseConversationMessages),
      create: vi.fn().mockResolvedValue({
        id: "outbound_1",
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        providerMessageId: "evo-out-1",
        direction: "outbound",
        type: "text",
        body: "O plano profissional custa R$ 199 por mes.",
        mediaUrl: null,
        status: "sent",
        sentByUserId: null,
        createdAt: now
      })
    },
    aiAgentRun: {
      create: vi.fn().mockResolvedValue({ id: ids.run, status: "completed" })
    },
    ...(overrides as object)
  };
}

describe("createAgentRuntime", () => {
  it("runs an agent and stores a completed run", async () => {
    const prisma = buildPrisma();
    const provider = buildProvider({
      confidence: 0.84,
      reply: "O plano profissional custa R$ 199 por mes.",
      actions: [{ type: "add_tag", tagName: "Atendido pela IA" }],
      handoff: { required: false, reason: null }
    });
    const boardRules = {
      applyBoardRulesForConversationTags: vi.fn().mockResolvedValue({
        evaluated: 1,
        added: 1,
        moved: 0,
        ignored: 0,
        conflicts: 0
      })
    };
    const runtime = createAgentRuntime({ prisma, provider, boardRules });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({ status: "completed", runId: ids.run });
    expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: ids.workspace,
        id: ids.agent,
        status: "active"
      },
      include: {
        allowedTags: {
          include: { tag: true },
          orderBy: { tag: { name: "asc" } }
        }
      }
    });
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: ids.workspace,
        conversationId: ids.conversation
      },
      orderBy: [{ createdAt: "desc" }],
      take: 80
    });
    expect(prisma.aiKnowledgeSource.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: ids.workspace,
        agentId: ids.agent,
        status: "ready"
      },
      orderBy: [{ createdAt: "desc" }],
      take: 50
    });
    expect(provider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "prymeira-simulated",
        systemPrompt: "Atenda bem.",
        userPrompt: "Oi, quanto custa o plano profissional?",
        context: expect.objectContaining({
          messageBody: "Oi, quanto custa o plano profissional?",
          conversationHistory: expect.stringContaining("cliente: Oi, vocês atendem hoje?"),
          conversationMessages: expect.arrayContaining([
            expect.objectContaining({
              id: "message_previous_inbound",
              label: "cliente",
              body: "Oi, vocês atendem hoje?"
            }),
            expect.objectContaining({
              id: "message_previous_outbound",
              label: "atendente",
              body: "Sim, atendemos das 8h as 18h."
            })
          ]),
          contact: expect.objectContaining({ name: "Maria", phone: "5511999999999" }),
          allowedActions: ["send_message", "add_tag", "request_handoff"],
          allowedTags: [
            {
              id: "tag_allowed_ai",
              name: "Atendido pela IA",
              color: "#24564a",
              useGuide: "Use quando a IA respondeu ao cliente."
            }
          ],
          tags: ["Lead"],
          knowledge: [
            {
              title: "Tabela de preços",
              content: "Plano profissional custa R$ 199 por mes."
            }
          ]
        })
      })
    );
    expect(provider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          conversationHistory: expect.stringContaining(
            "atendente: Sim, atendemos das 8h as 18h."
          )
        })
      })
    );
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        direction: "outbound",
        type: "text",
        body: "O plano profissional custa R$ 199 por mes.",
        status: "pending",
        sentByUserId: null,
        metadata: { source: "ai_agent", agentId: ids.agent }
      })
    });
    expect(prisma.tag.upsert).not.toHaveBeenCalled();
    expect(prisma.conversationTag.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_conversationId_tagId: {
          workspaceId: ids.workspace,
          conversationId: ids.conversation,
          tagId: "tag_allowed_ai"
        }
      },
      create: {
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        tagId: "tag_allowed_ai"
      },
      update: {}
    });
    expect(boardRules.applyBoardRulesForConversationTags).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      publish: expect.any(Function)
    });
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: ids.workspace,
        agentId: ids.agent,
        sessionId: ids.session,
        conversationId: ids.conversation,
        model: "prymeira-simulated",
        status: "completed",
        confidence: 0.84,
        contextSummary: expect.objectContaining({
          allowedTagCount: 1,
          knowledgeCount: 1,
          knowledgeTotal: 1,
          evaluatedKnowledgeChunks: 1,
          selectedKnowledgeSources: 1,
          selectedKnowledgeChunks: 1,
          protectedFact: "price",
          replyCharacters: "O plano profissional custa R$ 199 por mes.".length,
          replyCompacted: false
        }),
        knowledgeMatches: [
          expect.objectContaining({
            id: "knowledge_1",
            title: "Tabela de preços",
            category: "precos",
            score: expect.any(Number),
            reasons: expect.arrayContaining(["category_match", "keyword_match"]),
            includedAs: "full_document",
            chunkIndex: 0,
            start: 0,
            end: "Plano profissional custa R$ 199 por mes.".length
          })
        ]
      })
    });
  });

  it("uses the real OpenAI-compatible provider when workspace settings are active", async () => {
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
      confidence: 0.84,
      reply: "Fallback.",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const realProvider = buildProvider({
      confidence: 0.92,
      reply: "O plano profissional custa R$ 199 por mes.",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const providerFactory = vi.fn(() => realProvider);
    const runtime = createAgentRuntime({
      prisma,
      provider: fallbackProvider,
      providerFactory
    });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({ status: "completed", runId: ids.run });
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
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: "gpt-4.1-mini",
        status: "completed",
        confidence: 0.92
      })
    });
  });

  it("activates an agent session for continuous automation replies without generating immediately", async () => {
    const prisma = buildPrisma();
    const provider = buildProvider({
      confidence: 0.84,
      reply: "Olá!",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.activateForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      instruction: "Atenda como secretária comercial."
    });

    expect(result).toEqual({
      status: "completed",
      sessionId: ids.session,
      message: "Agent session activated."
    });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(prisma.aiAgentSession.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_agentId_conversationId: {
          workspaceId: ids.workspace,
          agentId: ids.agent,
          conversationId: ids.conversation
        }
      },
      create: expect.objectContaining({
        workspaceId: ids.workspace,
        agentId: ids.agent,
        conversationId: ids.conversation,
        status: "active",
        metadata: { instruction: "Atenda como secretária comercial." }
      }),
      update: expect.objectContaining({
        status: "active",
        metadata: { instruction: "Atenda como secretária comercial." }
      })
    });
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: ids.workspace, id: ids.conversation } },
      data: {
        activeAgentSessionId: ids.session,
        aiControlStatus: "agent_allowed"
      }
    });
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("explains activation failures when the selected agent is inactive", async () => {
    const prisma = buildPrisma({
      aiAgent: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ ...baseAgent, status: "inactive" })
      }
    });
    const provider = buildProvider({
      confidence: 0.84,
      reply: "Olá!",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.activateForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message
    });

    expect(result).toEqual({
      status: "failed",
      message: "O agente selecionado está inativo. Ative o agente antes de usar em automações."
    });
    expect(prisma.aiAgentSession.upsert).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("sends agent replies through Evolution in real mode", async () => {
    const prisma = buildPrisma();
    const provider = buildProvider({
      confidence: 0.84,
      reply: "O plano profissional custa R$ 199 por mes.",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const sendText = vi.fn().mockResolvedValue({ providerMessageId: "evo-out-1" });
    const realtime = { publish: vi.fn() };
    const runtime = createAgentRuntime({
      prisma,
      provider,
      realtime,
      evolution: {
        mode: "real",
        client: { sendText }
      }
    });

    await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(sendText).toHaveBeenCalledWith({
      instanceName: "instancia",
      number: "5511999999999",
      text: "O plano profissional custa R$ 199 por mes."
    });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerMessageId: "evo-out-1",
        status: "sent"
      })
    });
    expect(realtime.publish).toHaveBeenCalledWith({
      type: "message.created",
      workspaceId: ids.workspace,
      payload: expect.objectContaining({
        id: "outbound_1",
        conversationId: ids.conversation,
        direction: "outbound",
        body: "O plano profissional custa R$ 199 por mes.",
        status: "sent"
      })
    });
    expect(realtime.publish).toHaveBeenCalledWith({
      type: "conversation.updated",
      workspaceId: ids.workspace,
      payload: expect.objectContaining({
        id: ids.conversation,
        activeAgentName: "Secretaria IA",
        lastMessagePreview: "Oi, quanto custa o plano profissional?"
      })
    });
  });

  it("requests handoff for document-dependent questions without relevant knowledge", async () => {
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
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({ status: "handoff_requested", runId: ids.run });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "handoff_requested",
        confidence: 0.2,
        knowledgeMatches: [],
        output: expect.objectContaining({
          reply:
            "Não quero te passar uma informação errada. Vou encaminhar para o comercial confirmar com segurança.",
          handoff: expect.objectContaining({
            required: true
          })
        })
      })
    });
  });

  it("sends a compacted reply no longer than 500 characters", async () => {
    const prisma = buildPrisma();
    const provider = buildProvider({
      confidence: 0.9,
      reply: "Produto metálico. ".repeat(80),
      actions: [],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    const body = prisma.message.create.mock.calls[0]?.[0].data.body as string;
    expect(body.length).toBeLessThanOrEqual(500);
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contextSummary: expect.objectContaining({
          replyCharacters: body.length,
          replyCompacted: true
        })
      })
    });
  });

  it("skips when conversation is human controlled", async () => {
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseConversation,
          aiControlStatus: "human_controlled"
        }),
        update: vi.fn().mockResolvedValue({})
      }
    });
    const provider = buildProvider({
      confidence: 0.84,
      reply: "Olá!",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({
      status: "skipped",
      runId: ids.run,
      message: "Conversation is controlled by a human."
    });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(prisma.aiAgentSession.upsert).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("requests handoff for low confidence output", async () => {
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseConversation,
          activeAgentSessionId: ids.session
        }),
        update: vi.fn().mockResolvedValue({})
      }
    });
    const provider = buildProvider({
      confidence: 0.32,
      reply: "Vou chamar uma pessoa do time.",
      actions: [{ type: "request_handoff", reason: "Baixa confiança." }],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "manual_test"
    });

    expect(result).toEqual({ status: "handoff_requested", runId: ids.run });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.aiAgentSession.update).toHaveBeenLastCalledWith({
      where: { workspaceId_id: { workspaceId: ids.workspace, id: ids.session } },
      data: expect.objectContaining({
        status: "handoff_requested",
        handoffReason: "Baixa confiança.",
        messageCount: { increment: 1 }
      })
    });
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "handoff_requested",
        confidence: 0.32
      })
    });
  });

  it("requests handoff from a request_handoff action even with high confidence and a reply", async () => {
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseConversation,
          activeAgentSessionId: ids.session
        }),
        update: vi.fn().mockResolvedValue({})
      }
    });
    const provider = buildProvider({
      confidence: 0.91,
      reply: "Posso ajudar com isso.",
      actions: [{ type: "request_handoff", reason: "Cliente pediu atendente humano." }],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({ status: "handoff_requested", runId: ids.run });
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.aiAgentSession.update).toHaveBeenLastCalledWith({
      where: { workspaceId_id: { workspaceId: ids.workspace, id: ids.session } },
      data: expect.objectContaining({
        status: "handoff_requested",
        handoffReason: "Cliente pediu atendente humano."
      })
    });
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "handoff_requested",
        confidence: 0.91,
        output: expect.objectContaining({
          reply: "Posso ajudar com isso.",
          handoff: { required: false, reason: null }
        })
      })
    });
  });

  it("logs skipped action execution issues without blocking the reply", async () => {
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseConversation,
          activeAgentSessionId: ids.session
        }),
        update: vi.fn().mockResolvedValue({})
      }
    });
    const provider = buildProvider({
      confidence: 0.84,
      reply: "Vou registrar uma etiqueta.",
      actions: [{ type: "add_tag" }],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({
      status: "completed",
      runId: ids.run
    });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        direction: "outbound",
        body: "Vou registrar uma etiqueta."
      })
    });
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: ids.workspace,
        agentId: ids.agent,
        sessionId: ids.session,
        conversationId: ids.conversation,
        model: "prymeira-simulated",
        status: "completed",
        confidence: 0.84,
        actions: [
          {
            type: "add_tag",
            status: "skipped",
            code: "TOOL_INVALID_INPUT",
            reason: "Tag ID or name is required."
          }
        ],
        output: expect.objectContaining({
          reply: "Vou registrar uma etiqueta."
        }),
        contextSummary: expect.objectContaining({
          knowledgeCount: 1,
          knowledgeTotal: 1,
          rejectedActionCodes: ["TOOL_INVALID_INPUT"]
        }),
        knowledgeMatches: [
          expect.objectContaining({
            id: "knowledge_1",
            title: "Tabela de preços",
            category: "precos",
            reasons: expect.arrayContaining(["category_match"]),
            includedAs: "full_document"
          })
        ]
      })
    });
  });

  it("logs a failed run when knowledge lookup fails after session creation", async () => {
    const prisma = buildPrisma({
      aiKnowledgeSource: {
        findMany: vi.fn().mockRejectedValue(new Error("Knowledge lookup failed."))
      }
    });
    const provider = buildProvider({
      confidence: 0.84,
      reply: "Atendemos das 8h as 18h.",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({
      status: "failed",
      runId: ids.run,
      message: "Knowledge lookup failed."
    });
    expect(prisma.aiAgentSession.upsert).toHaveBeenCalled();
    expect(provider.generate).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: ids.workspace,
        agentId: ids.agent,
        sessionId: ids.session,
        conversationId: ids.conversation,
        model: "prymeira-simulated",
        status: "failed",
        errorMessage: "Knowledge lookup failed."
      })
    });
  });

  it("logs a failed run when the provider does not produce a reply", async () => {
    const prisma = buildPrisma();
    const provider = buildProvider({
      confidence: 0.9,
      reply: null,
      actions: [],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({
      status: "failed",
      runId: ids.run,
      message: "Agent did not produce a reply."
    });
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "failed",
        confidence: 0.9,
        errorMessage: "Agent did not produce a reply.",
        output: expect.objectContaining({
          reply: null
        })
      })
    });
  });

  it("logs a failed run without a conversation foreign key when conversation is missing", async () => {
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({})
      }
    });
    const provider = buildProvider({
      confidence: 0.84,
      reply: "Olá!",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({
      status: "failed",
      runId: ids.run,
      message: "Conversation or message was not found."
    });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(prisma.aiAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: ids.workspace,
        agentId: ids.agent,
        conversationId: null,
        status: "failed",
        errorMessage: "Conversation or message was not found."
      })
    });
  });

  it("returns a failed result without writing a run when agent is missing", async () => {
    const aiAgentFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = buildPrisma({
      aiAgent: {
        findFirst: aiAgentFindFirst
      }
    });
    const provider = buildProvider({
      confidence: 0.84,
      reply: "Olá!",
      actions: [],
      handoff: { required: false, reason: null }
    });
    const runtime = createAgentRuntime({ prisma, provider });

    const result = await runtime.runForMessage({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.message,
      trigger: "automation"
    });

    expect(result).toEqual({ status: "failed", message: "Agent was not found." });
    expect(aiAgentFindFirst).toHaveBeenCalledTimes(2);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(prisma.aiAgentRun.create).not.toHaveBeenCalled();
  });
});
