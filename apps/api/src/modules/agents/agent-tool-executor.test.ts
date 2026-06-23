import { describe, expect, it, vi } from "vitest";
import { AgentToolExecutionError, executeAgentActions } from "./agent-tool-executor.js";
import type { AgentToolExecutorPrismaLike } from "./agent-tool-executor.js";

function buildPrisma(overrides: Partial<AgentToolExecutorPrismaLike> = {}) {
  return {
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
  } satisfies AgentToolExecutorPrismaLike;
}

const baseInput = {
  workspaceId: "workspace_a",
  conversationId: "conv_1",
  allowedActions: [
    "add_tag",
    "change_priority",
    "create_internal_note",
    "request_handoff"
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
    expect(prisma.tag.upsert).toHaveBeenCalledWith({
      where: { workspaceId_name: { workspaceId: "workspace_a", name: "Atendido pela IA" } },
      create: {
        workspaceId: "workspace_a",
        name: "Atendido pela IA",
        color: "#24564a"
      },
      update: {}
    });
    expect(prisma.conversationTag.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_conversationId_tagId: {
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          tagId: "tag_1"
        }
      },
      create: {
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        tagId: "tag_1"
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

  it("rejects a non-send action before executing when it is not allowed", async () => {
    const prisma = buildPrisma();

    await expect(
      executeAgentActions(prisma, {
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        allowedActions: ["send_message"],
        actions: [{ type: "add_tag", tagName: "Atendido pela IA" }]
      })
    ).rejects.toMatchObject({
      code: "TOOL_NOT_ALLOWED"
    });
    await expect(
      executeAgentActions(prisma, {
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        allowedActions: ["send_message"],
        actions: [{ type: "add_tag", tagName: "Atendido pela IA" }]
      })
    ).rejects.toBeInstanceOf(AgentToolExecutionError);
    expect(prisma.tag.upsert).not.toHaveBeenCalled();
  });

  it("requests handoff by moving conversation and active session to human control", async () => {
    const prisma = buildPrisma();

    await executeAgentActions(prisma, {
      ...baseInput,
      actions: [{ type: "request_handoff", reason: "Baixa confianca" }]
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
        handoffReason: "Baixa confianca"
      })
    });
  });

  it("rejects missing required input defensively", async () => {
    const prisma = buildPrisma();

    await expect(
      executeAgentActions(prisma, {
        ...baseInput,
        actions: [{ type: "create_internal_note", body: "   " }]
      })
    ).rejects.toMatchObject({
      code: "TOOL_INVALID_INPUT"
    });
    expect(prisma.contactNote.create).not.toHaveBeenCalled();
  });

  it("skips send_message actions because message sending is handled elsewhere", async () => {
    const prisma = buildPrisma();

    const results = await executeAgentActions(prisma, {
      ...baseInput,
      allowedActions: ["send_message"],
      actions: [{ type: "send_message", body: "Ola!" }]
    });

    expect(results).toEqual([{ type: "send_message", status: "skipped" }]);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });

  it("accepts add_tag name as an alias for tagName", async () => {
    const prisma = buildPrisma();

    await executeAgentActions(prisma, {
      ...baseInput,
      actions: [{ type: "add_tag", name: "  Onboarding  " }]
    });

    expect(prisma.tag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_name: { workspaceId: "workspace_a", name: "Onboarding" } }
      })
    );
  });

  it("rejects actions missing type defensively", async () => {
    const prisma = buildPrisma();

    await expect(
      executeAgentActions(prisma, {
        ...baseInput,
        actions: [{ tagName: "Atendido pela IA" }]
      })
    ).rejects.toMatchObject({
      code: "TOOL_INVALID_INPUT"
    });
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });
});
