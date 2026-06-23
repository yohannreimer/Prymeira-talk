import type { AiAgentAllowedAction, ConversationPriority } from "@prymeira-talk/shared";
import type { AgentOutput } from "./provider-gateway.js";

type AgentAction = AgentOutput["actions"][number];
type NonSendAgentAction = Exclude<AgentAction, { action: "send_message" }>;

type ConversationRecord = {
  id: string;
  contactId: string;
  activeAgentSessionId?: string | null;
};

export interface AgentToolExecutorPrismaLike {
  conversation: {
    findUnique(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      select: { id: true; contactId: true; activeAgentSessionId: true };
    }): Promise<ConversationRecord | null>;
    update(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
  tag: {
    upsert(args: {
      where: { workspaceId_name: { workspaceId: string; name: string } };
      create: { workspaceId: string; name: string; color: string };
      update: Record<string, never>;
    }): Promise<{ id: string }>;
  };
  conversationTag: {
    upsert(args: {
      where: {
        workspaceId_conversationId_tagId: {
          workspaceId: string;
          conversationId: string;
          tagId: string;
        };
      };
      create: { workspaceId: string; conversationId: string; tagId: string };
      update: Record<string, never>;
    }): Promise<unknown>;
    deleteMany(args: {
      where: { workspaceId: string; conversationId: string; tagId: string };
    }): Promise<unknown>;
  };
  contactNote: {
    create(args: {
      data: {
        workspaceId: string;
        contactId: string;
        conversationId: string;
        body: string;
        createdById: string | null;
      };
    }): Promise<unknown>;
  };
  userProfile: {
    findUnique(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  department: {
    findUnique(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  aiAgentSession: {
    update(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

export type AgentToolExecutionErrorCode =
  | "TOOL_INVALID_INPUT"
  | "TOOL_NOT_ALLOWED"
  | "CONVERSATION_NOT_FOUND";

export class AgentToolExecutionError extends Error {
  constructor(
    public readonly code: AgentToolExecutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentToolExecutionError";
  }
}

export type AgentToolExecutionResult = {
  action: AgentAction["action"];
  status: "completed" | "skipped";
};

export async function executeAgentActions(
  prisma: AgentToolExecutorPrismaLike,
  input: {
    workspaceId: string;
    conversationId: string;
    allowedActions: readonly AiAgentAllowedAction[];
    actions: readonly AgentAction[];
    actorUserId?: string | null;
  }
): Promise<AgentToolExecutionResult[]> {
  const results: AgentToolExecutionResult[] = [];
  let conversation: ConversationRecord | null = null;

  async function loadConversation() {
    conversation ??= await prisma.conversation.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.conversationId
        }
      },
      select: {
        id: true,
        contactId: true,
        activeAgentSessionId: true
      }
    });

    if (!conversation) {
      throw new AgentToolExecutionError("CONVERSATION_NOT_FOUND", "Conversation not found.");
    }

    return conversation;
  }

  for (const action of input.actions) {
    if (action.action === "send_message") {
      results.push({ action: action.action, status: "skipped" });
      continue;
    }

    ensureAllowed(input.allowedActions, action.action);
    await executeNonSendAction(prisma, input, await loadConversation(), action);
    results.push({ action: action.action, status: "completed" });
  }

  return results;
}

function ensureAllowed(allowedActions: readonly AiAgentAllowedAction[], action: AiAgentAllowedAction) {
  if (!allowedActions.includes(action)) {
    throw new AgentToolExecutionError(
      "TOOL_NOT_ALLOWED",
      `Agent action ${action} is not allowed.`
    );
  }
}

async function executeNonSendAction(
  prisma: AgentToolExecutorPrismaLike,
  input: {
    workspaceId: string;
    conversationId: string;
    actorUserId?: string | null;
  },
  conversation: ConversationRecord,
  action: NonSendAgentAction
) {
  if (action.action === "add_tag") {
    await addTag(prisma, input, action);
    return;
  }

  if (action.action === "remove_tag") {
    await removeTag(prisma, input, action);
    return;
  }

  if (action.action === "change_priority") {
    await changePriority(prisma, input, action.priority);
    return;
  }

  if (action.action === "create_internal_note") {
    await createInternalNote(prisma, input, conversation, action);
    return;
  }

  if (action.action === "assign_user") {
    await assignUser(prisma, input, action);
    return;
  }

  if (action.action === "assign_department") {
    await assignDepartment(prisma, input, action);
    return;
  }

  await requestHandoff(prisma, input, conversation, action);
}

async function addTag(
  prisma: AgentToolExecutorPrismaLike,
  input: { workspaceId: string; conversationId: string },
  action: Extract<NonSendAgentAction, { action: "add_tag" }>
) {
  const name = action.name.trim();
  if (!name) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Tag name is required.");
  }

  const tag = await prisma.tag.upsert({
    where: {
      workspaceId_name: {
        workspaceId: input.workspaceId,
        name
      }
    },
    create: {
      workspaceId: input.workspaceId,
      name,
      color: "#24564a"
    },
    update: {}
  });

  await prisma.conversationTag.upsert({
    where: {
      workspaceId_conversationId_tagId: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        tagId: tag.id
      }
    },
    create: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      tagId: tag.id
    },
    update: {}
  });
}

async function removeTag(
  prisma: AgentToolExecutorPrismaLike,
  input: { workspaceId: string; conversationId: string },
  action: Extract<NonSendAgentAction, { action: "remove_tag" }>
) {
  const tagId = action.tagId?.trim();
  if (!tagId) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Tag ID is required.");
  }

  await prisma.conversationTag.deleteMany({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      tagId
    }
  });
}

async function changePriority(
  prisma: AgentToolExecutorPrismaLike,
  input: { workspaceId: string; conversationId: string },
  priority: ConversationPriority
) {
  if (!["low", "normal", "high"].includes(priority)) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Valid priority is required.");
  }

  await prisma.conversation.update({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
    data: { priority }
  });
}

async function createInternalNote(
  prisma: AgentToolExecutorPrismaLike,
  input: { workspaceId: string; conversationId: string; actorUserId?: string | null },
  conversation: ConversationRecord,
  action: Extract<NonSendAgentAction, { action: "create_internal_note" }>
) {
  const body = action.body.trim();
  if (!body) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Note body is required.");
  }

  await prisma.contactNote.create({
    data: {
      workspaceId: input.workspaceId,
      contactId: conversation.contactId,
      conversationId: input.conversationId,
      body,
      createdById: input.actorUserId ?? null
    }
  });
}

async function assignUser(
  prisma: AgentToolExecutorPrismaLike,
  input: { workspaceId: string; conversationId: string },
  action: Extract<NonSendAgentAction, { action: "assign_user" }>
) {
  const userId = action.userId.trim();
  if (!userId) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "User ID is required.");
  }

  const user = await prisma.userProfile.findUnique({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: userId } },
    select: { id: true }
  });
  if (!user) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "User not found.");
  }

  await prisma.conversation.update({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
    data: { assignedUserId: user.id }
  });
}

async function assignDepartment(
  prisma: AgentToolExecutorPrismaLike,
  input: { workspaceId: string; conversationId: string },
  action: Extract<NonSendAgentAction, { action: "assign_department" }>
) {
  const departmentId = action.departmentId.trim();
  if (!departmentId) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Department ID is required.");
  }

  const department = await prisma.department.findUnique({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: departmentId } },
    select: { id: true }
  });
  if (!department) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Department not found.");
  }

  await prisma.conversation.update({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
    data: { departmentId: department.id }
  });
}

async function requestHandoff(
  prisma: AgentToolExecutorPrismaLike,
  input: { workspaceId: string; conversationId: string; actorUserId?: string | null },
  conversation: ConversationRecord,
  action: Extract<NonSendAgentAction, { action: "request_handoff" }>
) {
  const handoffReason = action.reason?.trim() || "Agent requested human handoff.";
  const aiControlUpdatedAt = new Date();

  await prisma.conversation.update({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
    data: {
      aiControlStatus: "human_controlled",
      aiControlUpdatedAt,
      aiControlUpdatedById: input.actorUserId ?? null
    }
  });

  if (conversation.activeAgentSessionId) {
    await prisma.aiAgentSession.update({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: conversation.activeAgentSessionId
        }
      },
      data: {
        status: "handoff_requested",
        handoffReason
      }
    });
  }
}
