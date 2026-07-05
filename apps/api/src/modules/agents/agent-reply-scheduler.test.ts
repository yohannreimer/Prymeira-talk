import { describe, expect, it, vi } from "vitest";
import { createAgentReplyScheduler } from "./agent-reply-scheduler.js";

const ids = {
  workspace: "workspace_a",
  agent: "00000000-0000-4000-8000-000000000101",
  session: "00000000-0000-4000-8000-000000000201",
  conversation: "00000000-0000-4000-8000-000000000301",
  firstMessage: "00000000-0000-4000-8000-000000000401",
  secondMessage: "00000000-0000-4000-8000-000000000402",
  pending: "00000000-0000-4000-8000-000000000501"
};

function buildConversation() {
  return {
    id: ids.conversation,
    workspaceId: ids.workspace,
    aiControlStatus: "agent_allowed",
    activeAgentSessionId: ids.session,
    activeAgentSession: {
      id: ids.session,
      agentId: ids.agent,
      status: "active",
      metadata: { instruction: "Responda como secretária comercial." }
    }
  };
}

function buildPrisma(overrides: Record<string, any> = {}) {
  return {
    conversation: {
      findUnique: overrides.conversation?.findUnique ?? vi.fn().mockResolvedValue(buildConversation())
    },
    aiAgentPendingReply: {
      upsert: overrides.aiAgentPendingReply?.upsert ?? vi.fn().mockResolvedValue({ id: ids.pending }),
      findMany: overrides.aiAgentPendingReply?.findMany ?? vi.fn().mockResolvedValue([]),
      update: overrides.aiAgentPendingReply?.update ?? vi.fn().mockResolvedValue({ id: ids.pending }),
      updateMany:
        overrides.aiAgentPendingReply?.updateMany ?? vi.fn().mockResolvedValue({ count: 1 })
    }
  };
}

describe("createAgentReplyScheduler", () => {
  it("debounces active agent replies by updating the pending reply window", async () => {
    const prisma = buildPrisma();
    const agentRuntime = {
      runForMessage: vi.fn()
    };
    const scheduler = createAgentReplyScheduler({
      prisma,
      agentRuntime,
      debounceMs: 40_000
    });

    await scheduler.scheduleActiveSessionForMessage({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.firstMessage,
      now: new Date("2026-07-05T12:00:00.000Z")
    });
    await scheduler.scheduleActiveSessionForMessage({
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      messageId: ids.secondMessage,
      now: new Date("2026-07-05T12:00:25.000Z")
    });

    expect(prisma.aiAgentPendingReply.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.aiAgentPendingReply.upsert).toHaveBeenLastCalledWith({
      where: {
        workspaceId_conversationId: {
          workspaceId: ids.workspace,
          conversationId: ids.conversation
        }
      },
      create: expect.objectContaining({
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
        agentId: ids.agent,
        sessionId: ids.session,
        lastMessageId: ids.secondMessage,
        instruction: "Responda como secretária comercial.",
        scheduledAt: new Date("2026-07-05T12:01:05.000Z"),
        status: "pending"
      }),
      update: expect.objectContaining({
        agentId: ids.agent,
        sessionId: ids.session,
        lastMessageId: ids.secondMessage,
        instruction: "Responda como secretária comercial.",
        scheduledAt: new Date("2026-07-05T12:01:05.000Z"),
        status: "pending",
        lastError: null
      })
    });
  });

  it("processes due pending replies with the latest grouped message", async () => {
    const prisma = buildPrisma({
      aiAgentPendingReply: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: ids.pending,
            workspaceId: ids.workspace,
            agentId: ids.agent,
            sessionId: ids.session,
            conversationId: ids.conversation,
            lastMessageId: ids.secondMessage,
            instruction: "Responda como secretária comercial.",
            attempts: 0
          }
        ]),
        update: vi.fn().mockResolvedValue({ id: ids.pending })
      }
    });
    const agentRuntime = {
      runForMessage: vi.fn().mockResolvedValue({ status: "completed", runId: "run_1" })
    };
    const scheduler = createAgentReplyScheduler({
      prisma,
      agentRuntime,
      debounceMs: 40_000
    });

    await scheduler.processDueReplies({ now: new Date("2026-07-05T12:01:06.000Z") });

    expect(agentRuntime.runForMessage).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      agentId: ids.agent,
      conversationId: ids.conversation,
      messageId: ids.secondMessage,
      trigger: "automation",
      instruction: "Responda como secretária comercial."
    });
    expect(prisma.aiAgentPendingReply.update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: ids.workspace, id: ids.pending } },
      data: expect.objectContaining({
        status: "processing",
        attempts: { increment: 1 }
      })
    });
    expect(prisma.aiAgentPendingReply.updateMany).toHaveBeenLastCalledWith({
      where: {
        workspaceId: ids.workspace,
        id: ids.pending,
        status: "processing",
        lockedAt: new Date("2026-07-05T12:01:06.000Z")
      },
      data: expect.objectContaining({
        status: "completed",
        lastError: null
      })
    });
  });

  it("does not complete a pending reply that was rescheduled while processing", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = buildPrisma({
      aiAgentPendingReply: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: ids.pending,
            workspaceId: ids.workspace,
            agentId: ids.agent,
            sessionId: ids.session,
            conversationId: ids.conversation,
            lastMessageId: ids.firstMessage,
            instruction: null,
            attempts: 0
          }
        ]),
        update: vi.fn().mockResolvedValue({ id: ids.pending }),
        updateMany
      }
    });
    const agentRuntime = {
      runForMessage: vi.fn().mockResolvedValue({ status: "completed", runId: "run_1" })
    };
    const scheduler = createAgentReplyScheduler({
      prisma,
      agentRuntime,
      debounceMs: 40_000
    });

    await scheduler.processDueReplies({ now: new Date("2026-07-05T12:01:06.000Z") });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: ids.workspace,
        id: ids.pending,
        status: "processing",
        lockedAt: new Date("2026-07-05T12:01:06.000Z")
      },
      data: expect.objectContaining({
        status: "completed",
        lastError: null
      })
    });
  });

  it("keeps failed agent runs visible on the pending reply record", async () => {
    const prisma = buildPrisma({
      aiAgentPendingReply: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: ids.pending,
            workspaceId: ids.workspace,
            agentId: ids.agent,
            sessionId: ids.session,
            conversationId: ids.conversation,
            lastMessageId: ids.secondMessage,
            instruction: null,
            attempts: 0
          }
        ]),
        update: vi.fn().mockResolvedValue({ id: ids.pending }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    });
    const agentRuntime = {
      runForMessage: vi.fn().mockResolvedValue({
        status: "failed",
        runId: "run_failed",
        message: "OpenAI-compatible provider returned an invalid response."
      })
    };
    const scheduler = createAgentReplyScheduler({
      prisma,
      agentRuntime,
      debounceMs: 40_000
    });

    const results = await scheduler.processDueReplies({ now: new Date("2026-07-05T12:01:06.000Z") });

    expect(results).toEqual([{ id: ids.pending, status: "failed", runId: "run_failed" }]);
    expect(prisma.aiAgentPendingReply.updateMany).toHaveBeenLastCalledWith({
      where: {
        workspaceId: ids.workspace,
        id: ids.pending,
        status: "processing",
        lockedAt: new Date("2026-07-05T12:01:06.000Z")
      },
      data: expect.objectContaining({
        status: "failed",
        lockedAt: null,
        lastError: "OpenAI-compatible provider returned an invalid response."
      })
    });
  });
});
