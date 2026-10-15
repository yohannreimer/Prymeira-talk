import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime } from "./agent-runtime.js";
import { AgentMediaError } from "./agent-media-resolver.js";
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
    overrides.conversation?.findUnique ?? vi.fn().mockImplementation(async () => ({ ...baseConversation }));
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
      count: vi.fn().mockResolvedValue(0),
      update: overrides.message?.update ?? vi.fn().mockImplementation(
        async (args: { data: Partial<typeof baseMessage> }) => ({
          ...baseMessage,
          ...args.data
        })
      ),
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
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit_loop" })
    },
    ...(overrides as object)
  };
}



import { createSimulatedAgentProvider } from "./provider-gateway.js";
import { createAgentReplyScheduler } from "./agent-reply-scheduler.js";

describe("audit: real-channel AI recovery", () => {
  it('does not reactivate AI after human takeover while checking first-message freshness', async () => {
    const prisma = buildPrisma();
    prisma.aiAgent.findFirst.mockResolvedValue({ ...baseAgent, behaviorConfig: { onlyNewConversations: true } });
    const chatHistory = { hasPriorMessages: vi.fn(async () => {
      prisma.conversation.findUnique.mockResolvedValue({ ...baseConversation, aiControlStatus: 'human_controlled' });
      return false;
    }) };
    const runtime = createAgentRuntime({ prisma, provider: createSimulatedAgentProvider(), chatHistory });
    const result = await runtime.activateForMessage({ workspaceId: ids.workspace, conversationId: ids.conversation,
      agentId: ids.agent, messageId: ids.message });
    expect(result.status).toBe('skipped');
    expect(prisma.aiAgentSession.upsert).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it.each([true, false])('notifies only a committed failure handoff that still owns the session (current=%s)', async current => {
    const prisma = buildPrisma(), schedule = vi.fn(), publish = vi.fn();
    const reason = 'Delivery outcome is uncertain; automatic retry is disabled.';
    prisma.conversation.findUnique.mockResolvedValue({ ...baseConversation, aiControlStatus: 'human_controlled',
      activeAgentSessionId: current ? ids.session : 'replacement', activeAgentSession: {
        id: ids.session, agentId: ids.agent, status: 'handoff_requested', handoffReason: reason } });
    const runtime = createAgentRuntime({ prisma, provider: createSimulatedAgentProvider(),
      handoffBriefService: { schedule }, realtime: { publish } });
    await runtime.notifyReplyFailureHandoff({ workspaceId: ids.workspace, conversationId: ids.conversation,
      agentId: ids.agent, sessionId: ids.session, messageId: ids.message, reason });
    expect(schedule).toHaveBeenCalledTimes(current ? 1 : 0);
    expect(publish).toHaveBeenCalledTimes(current ? 1 : 0);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.aiAgentSession.update).not.toHaveBeenCalled();
  });

  it("does not send simulated fallback to a real channel without AI configuration", async () => {
    const prisma = buildPrisma();
    // The real runtime persists this session pointer before provider resolution.
    prisma.conversation.findUnique.mockResolvedValue({ ...baseConversation, activeAgentSessionId: ids.session });
    prisma.message.findFirst.mockResolvedValue({ ...baseMessage, body: "Olá" });
    prisma.message.findMany.mockResolvedValue([{ ...baseMessage, body: "Olá" }]);
    prisma.aiKnowledgeSource.findMany.mockResolvedValue([]);
    const sendText = vi.fn(async () => ({ providerMessageId: "sent", raw: {} }));
    const runtime = createAgentRuntime({ prisma, provider: createSimulatedAgentProvider(), evolution: { mode: "real", client: { sendText } } });
    const result = await runtime.runForMessage({ workspaceId: ids.workspace, agentId: ids.agent, conversationId: ids.conversation, messageId: ids.message, trigger: "automation" });
    expect(sendText).not.toHaveBeenCalled();
    expect(result.status).toBe("handoff_requested");
    expect(prisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ aiControlStatus: "human_controlled" }) }));
  });

  it("marks generation failure as retryable only before dispatch when queue owns the reply", async () => {
    const prisma = buildPrisma();
    (prisma as any).aiAgentPendingReply = { findFirst: vi.fn(async () => ({ id: "reply" })) };
    const sendText = vi.fn();
    const runtime = createAgentRuntime({ prisma, provider: { generate: vi.fn(async () => { throw Object.assign(new Error("provider HTTP 429"), { statusCode: 429 }); }) }, evolution: { mode: "real", client: { sendText } } });
    const result = await runtime.runForMessage({ workspaceId: ids.workspace, agentId: ids.agent, conversationId: ids.conversation, messageId: ids.message, trigger: "automation", replyClaim: { id: "reply", token: "lease" } });
    expect(result).toMatchObject({ status: "failed", retryable: true });
    expect(sendText).not.toHaveBeenCalled();
    expect(prisma.conversation.update.mock.calls.some(([call]: any) => call.data.aiControlStatus === "human_controlled")).toBe(false);
  });
});

function retryHarness() {
  const at = new Date("2026-10-15T12:00:00Z");
  const row: any = { id: "reply", workspaceId: ids.workspace, conversationId: ids.conversation, agentId: ids.agent, sessionId: ids.session, lastMessageId: ids.message, status: "pending", attempts: 0, scheduledAt: at, prospectingGeneration: null };
  const updateMany = vi.fn(async ({ where, data }: any) => {
    if ((where.status && where.status !== row.status) || (where.claimToken && where.claimToken !== row.claimToken)) return { count: 0 };
    for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === "object" && "increment" in value ? row[key] + (value as any).increment : value;
    return { count: 1 };
  });
  const prisma: any = { conversation: { findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) }, workspaceMirror: { findUnique: vi.fn() }, aiAgentPendingReply: { upsert: vi.fn(), update: vi.fn(), updateMany, findMany: vi.fn(async ({ where }: any) => row.status === where.status && (!where.scheduledAt || row.scheduledAt <= where.scheduledAt.lte) ? [{ ...row }] : []) } };
  return { at, row, prisma };
}
describe("audit: bounded pending-reply retry", () => {
  it("retries only certified pre-dispatch failures with backoff and then hands off", async () => {
    const h = retryHarness();
    const runForMessage = vi.fn(async () => ({ status: "failed" as const, retryable: true, message: "generation HTTP 503" }));
    const handoffForReplyFailure = vi.fn(async () => undefined);
    const scheduler = createAgentReplyScheduler({ prisma: h.prisma, agentRuntime: { runForMessage, handoffForReplyFailure } as any });
    try {
      await scheduler.processDueReplies({ now: h.at });
      expect(h.row.status).toBe("pending");
      expect(h.row.scheduledAt.getTime()).toBeGreaterThan(h.at.getTime());
      await scheduler.processDueReplies({ now: h.at });
      expect(runForMessage).toHaveBeenCalledTimes(1);
      await scheduler.processDueReplies({ now: new Date(h.at.getTime() + 600_000) });
      expect(h.row.status).toBe("pending");
      await scheduler.processDueReplies({ now: new Date(h.at.getTime() + 1_200_000) });
      expect(h.row.status).toBe("failed");
      expect(runForMessage).toHaveBeenCalledTimes(3);
      expect(handoffForReplyFailure).toHaveBeenCalledTimes(1);
      await scheduler.processDueReplies({ now: new Date(h.at.getTime() + 2_400_000) });
      expect(runForMessage).toHaveBeenCalledTimes(3);
    } finally { scheduler.stop(); }
  });

  it("does not retry unknown or post-dispatch failures", async () => {
    const h = retryHarness();
    const runForMessage = vi.fn(async () => ({ status: "failed" as const, message: "delivery uncertain" }));
    const handoffForReplyFailure = vi.fn(async () => undefined);
    const scheduler = createAgentReplyScheduler({ prisma: h.prisma, agentRuntime: { runForMessage, handoffForReplyFailure } as any });
    try {
      await scheduler.processDueReplies({ now: h.at });
      await scheduler.processDueReplies({ now: new Date(h.at.getTime() + 600_000) });
      expect(h.row.status).toBe("failed");
      expect(runForMessage).toHaveBeenCalledTimes(1);
      expect(handoffForReplyFailure).toHaveBeenCalledTimes(1);
    } finally { scheduler.stop(); }
  });
});
