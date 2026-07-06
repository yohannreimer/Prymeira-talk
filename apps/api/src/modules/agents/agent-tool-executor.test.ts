import { describe, expect, it, vi } from "vitest";
import { executeAgentActions } from "./agent-tool-executor.js";
import type {
  AgentToolExecutorPrismaLike,
  AgentToolExecutorTransactionLike
} from "./agent-tool-executor.js";
import type { AgentOutput } from "./provider-gateway.js";

function buildPrisma(overrides: Partial<AgentToolExecutorPrismaLike> = {}) {
  let prisma: AgentToolExecutorPrismaLike;
  let transactionClient: AgentToolExecutorTransactionLike;
  const transaction = vi.fn(
    <T,>(callback: Parameters<AgentToolExecutorPrismaLike["$transaction"]>[0]) =>
      callback(transactionClient)
  ) as AgentToolExecutorPrismaLike["$transaction"] & ReturnType<typeof vi.fn>;

  transactionClient = {
    conversation: {
      findUnique:
        overrides.conversation?.findUnique ??
        vi.fn().mockResolvedValue({
          id: "conv_1",
          contactId: "contact_1",
          activeAgentSessionId: "session_1"
        }),
      update: overrides.conversation?.update ?? vi.fn().mockResolvedValue({})
    },
    tag: {
      upsert:
        overrides.tag?.upsert ??
        vi.fn().mockResolvedValue({
          id: "tag_1",
          workspaceId: "workspace_a",
          name: "Atendido pela IA"
        })
    },
    conversationTag: {
      upsert: overrides.conversationTag?.upsert ?? vi.fn().mockResolvedValue({}),
      deleteMany: overrides.conversationTag?.deleteMany ?? vi.fn().mockResolvedValue({ count: 1 })
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

  prisma = {
    $transaction: overrides.$transaction ?? transaction,
    ...transactionClient
  } satisfies AgentToolExecutorPrismaLike;

  return prisma;
}

const baseInput = {
  workspaceId: "workspace_a",
  conversationId: "conv_1",
  allowedActions: [
    "add_tag",
    "change_priority",
    "create_internal_note",
    "request_handoff"
  ] as const,
  allowedTags: [
    {
      id: "tag_allowed_ai",
      name: "Atendido pela IA",
      color: "#24564a",
      useGuide: "Use quando a IA respondeu ao cliente."
    },
    {
      id: "tag_hot_lead",
      name: "Lead quente",
      color: "#f97316",
      useGuide: "Use quando o cliente demonstrar intenção clara de compra."
    }
  ] as const
};

describe("executeAgentActions", () => {
  it("executes allowed light actions", async () => {
    const prisma = buildPrisma();

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      actions: [
        { type: "add_tag", tagName: "  Atendido pela IA  " },
        { type: "change_priority", priority: "high" },
        { type: "create_internal_note", body: "Cliente quer retorno humano." }
      ]
    });

    expect(results).toEqual([
      { type: "add_tag", status: "completed" },
      { type: "change_priority", status: "completed" },
      { type: "create_internal_note", status: "completed" }
    ]);
    expect(prisma.tag.upsert).not.toHaveBeenCalled();
    expect(prisma.conversationTag.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_conversationId_tagId: {
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          tagId: "tag_allowed_ai"
        }
      },
      create: {
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        tagId: "tag_allowed_ai"
      },
      update: {}
    });
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
      data: { priority: "high" }
    });
    expect(prisma.contactNote.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_a",
        contactId: "contact_1",
        conversationId: "conv_1",
        body: "Cliente quer retorno humano.",
        createdById: null
      }
    });
  });

  it("skips a non-send action before executing when it is not allowed", async () => {
    const prisma = buildPrisma();

    const results = await executeAgentActions(prisma, {
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      allowedActions: ["send_message"],
      actions: [{ type: "add_tag", tagName: "Atendido pela IA" }]
    });

    expect(results).toEqual([
      {
        type: "add_tag",
        status: "skipped",
        reason: "Agent action add_tag is not allowed."
      }
    ]);
    expect(prisma.tag.upsert).not.toHaveBeenCalled();
  });

  it("requests handoff by moving conversation and active session to human control", async () => {
    const prisma = buildPrisma();

    await executeAgentActions(prisma, {
      ...baseInput,
      actions: [{ type: "request_handoff", reason: "Baixa confiança" }]
    });

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: "workspace_a", id: "conv_1" } },
      data: expect.objectContaining({
        aiControlStatus: "human_controlled",
        aiControlUpdatedById: null
      })
    });
    expect(prisma.aiAgentSession.update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: "workspace_a", id: "session_1" } },
      data: expect.objectContaining({
        status: "handoff_requested",
        handoffReason: "Baixa confiança"
      })
    });
  });

  it("uses one transaction when requesting handoff", async () => {
    const prisma = buildPrisma();

    await executeAgentActions(prisma, {
      ...baseInput,
      actions: [{ type: "request_handoff", reason: "Baixa confiança" }]
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("skips missing required input defensively", async () => {
    const prisma = buildPrisma();

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      actions: [{ type: "create_internal_note", body: "   " }]
    });

    expect(results).toEqual([
      {
        type: "create_internal_note",
        status: "skipped",
        reason: "Note body is required."
      }
    ]);
    expect(prisma.contactNote.create).not.toHaveBeenCalled();
  });

  it("skips send_message actions because message sending is handled elsewhere", async () => {
    const prisma = buildPrisma();

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      allowedActions: ["send_message"],
      actions: [{ type: "send_message", body: "Olá!" }]
    });

    expect(results).toEqual([{ type: "send_message", status: "skipped" }]);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it("skips reply actions because provider replies are sent from the reply field", async () => {
    const prisma = buildPrisma();

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      allowedActions: ["send_message"],
      actions: [{ type: "reply", message: "Olá, tudo certo?" }]
    });

    expect(results).toEqual([{ type: "send_message", status: "skipped" }]);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it("skips unsupported model-invented actions instead of failing the run", async () => {
    const prisma = buildPrisma();

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      allowedActions: ["send_message"],
      actions: [
        { type: "offer_magic_discount", reason: "unknown" },
        { type: "add_tag", tagName: "" }
      ]
    });

    expect(results).toEqual([
      {
        type: "unsupported",
        status: "skipped",
        rawType: "offer_magic_discount",
        reason: "Unsupported agent action offer_magic_discount."
      },
      {
        type: "add_tag",
        status: "skipped",
        reason: "Agent action add_tag is not allowed."
      }
    ]);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
    expect(prisma.tag.upsert).not.toHaveBeenCalled();
  });

  it("accepts add_tag name as an alias for tagName", async () => {
    const prisma = buildPrisma();

    await executeAgentActions(prisma, {
      ...baseInput,
      actions: [{ type: "add_tag", name: "  Atendido pela IA  " }]
    });

    expect(prisma.tag.upsert).not.toHaveBeenCalled();
    expect(prisma.conversationTag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId_conversationId_tagId: expect.objectContaining({
            tagId: "tag_allowed_ai"
          })
        })
      })
    );
  });

  it("matches allowed tag names ignoring case, accents, and extra spaces", async () => {
    const prisma = buildPrisma();

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      actions: [{ type: "add_tag", tagName: " lead quente " }]
    });

    expect(results).toEqual([{ type: "add_tag", status: "completed" }]);
    expect(prisma.tag.upsert).not.toHaveBeenCalled();
    expect(prisma.conversationTag.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_conversationId_tagId: {
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          tagId: "tag_hot_lead"
        }
      },
      create: {
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        tagId: "tag_hot_lead"
      },
      update: {}
    });
  });

  it("skips add_tag when the requested tag is outside the agent allowed tag list", async () => {
    const prisma = buildPrisma();

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      actions: [{ type: "add_tag", tagName: "VIP" }]
    });

    expect(results).toEqual([
      {
        type: "add_tag",
        status: "skipped",
        reason: "Agent tag VIP is not in this agent's allowed tag list."
      }
    ]);
    expect(prisma.tag.upsert).not.toHaveBeenCalled();
    expect(prisma.conversationTag.upsert).not.toHaveBeenCalled();
  });

  it("rejects actions missing type defensively", async () => {
    const prisma = buildPrisma();
    const malformedActions = [{ tagName: "Atendido pela IA" }] as unknown as AgentOutput["actions"];

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      actions: malformedActions
    });

    expect(results).toEqual([
      {
        type: "unsupported",
        status: "skipped",
        reason: "Action type is required."
      }
    ]);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it("skips unknown action types before updating conversation or session", async () => {
    const prisma = buildPrisma();
    const malformedActions = [
      { type: "escalate_to_moon", reason: "unknown action" }
    ] as unknown as AgentOutput["actions"];
    const malformedAllowedActions = [
      ...baseInput.allowedActions,
      "escalate_to_moon"
    ] as unknown as typeof baseInput.allowedActions;

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      allowedActions: malformedAllowedActions,
      actions: malformedActions
    });

    expect(results).toEqual([
      {
        type: "unsupported",
        status: "skipped",
        rawType: "escalate_to_moon",
        reason: "Unsupported agent action escalate_to_moon."
      }
    ]);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.aiAgentSession.update).not.toHaveBeenCalled();
  });
});
