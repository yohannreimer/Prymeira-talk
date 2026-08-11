import {
  aiAgentAllowedActionSchema,
  type AiAgentAllowedAction,
  type ConversationPriority
} from "@prymeira-talk/shared";
import type { AgentOutput } from "./provider-gateway.js";

type AgentAction = AgentOutput["actions"][number];
type AgentActionType = AiAgentAllowedAction;
type AgentActionResultType = AgentActionType | "unsupported";

type AllowedAgentTag = {
  id: string;
  name: string;
  color?: string | null;
  useGuide?: string | null;
};

type ConversationRecord = {
  id: string;
  contactId: string;
  activeAgentSessionId?: string | null;
};

export type AgentToolExecutorTransactionLike = {
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
};

export interface AgentToolExecutorPrismaLike extends AgentToolExecutorTransactionLike {
  $transaction<T>(callback: (tx: AgentToolExecutorTransactionLike) => Promise<T>): Promise<T>;
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
  type: AgentActionResultType;
  status: "completed" | "skipped";
  code?: AgentToolExecutionErrorCode;
  reason?: string;
  rawType?: string;
  conversationId?: string;
  tagId?: string;
};

export async function executeAgentActions(
  prisma: AgentToolExecutorPrismaLike,
  input: {
    workspaceId: string;
    conversationId: string;
    allowedActions: readonly AiAgentAllowedAction[];
    allowedTags?: readonly AllowedAgentTag[];
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
    const parsedAction = parseActionType(action);

    if (!parsedAction.actionType) {
      results.push({
        type: "unsupported",
        status: "skipped",
        ...(parsedAction.rawType ? { rawType: parsedAction.rawType } : {}),
        reason: parsedAction.reason
      });
      continue;
    }

    const { actionType } = parsedAction;

    if (actionType === "send_message") {
      results.push({ type: actionType, status: "skipped" });
      continue;
    }

    const allowedReason = getAllowedFailureReason(input.allowedActions, actionType);
    if (allowedReason) {
      results.push({ type: actionType, status: "skipped", reason: allowedReason });
      continue;
    }

    try {
      const metadata = await executeNonSendAction(
        prisma,
        input,
        await loadConversation(),
        actionType,
        action
      );
      results.push({ type: actionType, status: "completed", ...metadata });
    } catch (error) {
      if (error instanceof AgentToolExecutionError && error.code !== "CONVERSATION_NOT_FOUND") {
        results.push({
          type: actionType,
          status: "skipped",
          code: error.code,
          reason: error.message
        });
        continue;
      }

      throw error;
    }
  }

  return results;
}

function getAllowedFailureReason(
  allowedActions: readonly AiAgentAllowedAction[],
  action: AiAgentAllowedAction
) {
  if (!allowedActions.includes(action)) {
    return `Agent action ${action} is not allowed.`;
  }

  return null;
}

async function executeNonSendAction(
  prisma: AgentToolExecutorPrismaLike,
  input: {
    workspaceId: string;
    conversationId: string;
    allowedTags?: readonly AllowedAgentTag[];
    actorUserId?: string | null;
  },
  conversation: ConversationRecord,
  actionType: AgentActionType,
  action: AgentAction
): Promise<Partial<AgentToolExecutionResult> | undefined> {
  switch (actionType) {
    case "add_tag":
      return addTag(prisma, input, action);
    case "remove_tag":
      await removeTag(prisma, input, action);
      return;
    case "change_priority":
      await changePriority(prisma, input, getFirstString(action, ["priority", "value"]));
      return;
    case "create_internal_note":
      await createInternalNote(prisma, input, conversation, action);
      return;
    case "assign_user":
      await assignUser(prisma, input, action);
      return;
    case "assign_department":
      await assignDepartment(prisma, input, action);
      return;
    case "request_handoff":
      await requestHandoff(prisma, input, conversation, action);
      return;
    case "send_message":
      throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "send_message is handled elsewhere.");
  }

  const _exhaustive: never = actionType;
  throw new AgentToolExecutionError("TOOL_INVALID_INPUT", `Unsupported agent action ${_exhaustive}.`);
}

async function addTag(
  prisma: AgentToolExecutorPrismaLike,
  input: {
    workspaceId: string;
    conversationId: string;
    allowedTags?: readonly AllowedAgentTag[];
  },
  action: AgentAction
) {
  const requestedTagId = getFirstString(action, ["tagId", "id"])?.trim();
  const requestedTagName = getFirstString(action, ["tagName", "name", "tag", "label"])?.trim();
  const requestedTag = requestedTagId || requestedTagName;
  if (!requestedTag) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Tag ID or name is required.");
  }

  const allowedTag = requestedTagId
    ? (input.allowedTags ?? []).find((tag) => tag.id === requestedTagId)
    : (input.allowedTags ?? []).find(
        (tag) => normalizeTagName(tag.name) === normalizeTagName(requestedTagName ?? "")
      );
  if (!allowedTag) {
    throw new AgentToolExecutionError(
      "TOOL_INVALID_INPUT",
      `Agent tag ${requestedTag} is not in this agent's allowed tag list.`
    );
  }

  await prisma.conversationTag.upsert({
    where: {
      workspaceId_conversationId_tagId: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        tagId: allowedTag.id
      }
    },
    create: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      tagId: allowedTag.id
    },
    update: {}
  });

  return {
    conversationId: input.conversationId,
    tagId: allowedTag.id
  };
}

function normalizeTagName(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function removeTag(
  prisma: AgentToolExecutorPrismaLike,
  input: {
    workspaceId: string;
    conversationId: string;
    allowedTags?: readonly AllowedAgentTag[];
  },
  action: AgentAction
) {
  const requestedTagId = getFirstString(action, ["tagId", "id"])?.trim();
  const requestedTagName = getFirstString(action, ["tagName", "name", "tag", "label"])?.trim();
  const requestedTag = requestedTagId || requestedTagName;
  if (!requestedTag) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Tag ID or name is required.");
  }

  const allowedTag = requestedTagId
    ? (input.allowedTags ?? []).find((tag) => tag.id === requestedTagId)
    : (input.allowedTags ?? []).find(
        (tag) => normalizeTagName(tag.name) === normalizeTagName(requestedTagName ?? "")
      );
  if (!allowedTag) {
    throw new AgentToolExecutionError(
      "TOOL_INVALID_INPUT",
      `Agent tag ${requestedTag} is not in this agent's allowed tag list.`
    );
  }

  await prisma.conversationTag.deleteMany({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      tagId: allowedTag.id
    }
  });
}

async function changePriority(
  prisma: AgentToolExecutorPrismaLike,
  input: { workspaceId: string; conversationId: string },
  priority: string | undefined
) {
  if (!priority || !["low", "normal", "high"].includes(priority)) {
    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Valid priority is required.");
  }

  await prisma.conversation.update({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
    data: { priority: priority as ConversationPriority }
  });
}

async function createInternalNote(
  prisma: AgentToolExecutorPrismaLike,
  input: { workspaceId: string; conversationId: string; actorUserId?: string | null },
  conversation: ConversationRecord,
  action: AgentAction
) {
  const body = getFirstString(action, ["body", "note", "message", "content", "text"])?.trim();
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
  action: AgentAction
) {
  const userId = getFirstString(action, ["userId", "id"])?.trim();
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
  action: AgentAction
) {
  const departmentId = getFirstString(action, ["departmentId", "id"])?.trim();
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
  action: AgentAction
) {
  const handoffReason =
    getFirstString(action, ["reason", "message", "body", "note", "content"])?.trim() ||
    "Agent requested human handoff.";
  const aiControlUpdatedAt = new Date();

  await prisma.$transaction(async (tx: AgentToolExecutorTransactionLike) => {
    await tx.conversation.update({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
      data: {
        aiControlStatus: "human_controlled",
        aiControlUpdatedAt,
        aiControlUpdatedById: input.actorUserId ?? null
      }
    });

    if (conversation.activeAgentSessionId) {
      await tx.aiAgentSession.update({
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
  });
}

function parseActionType(action: AgentAction): {
  actionType: AgentActionType | null;
  rawType?: string;
  reason: string;
} {
  const actionType = action.type;
  if (typeof actionType !== "string") {
    return {
      actionType: null,
      reason: "Action type is required."
    };
  }

  const normalizedActionType = normalizeActionType(actionType);
  const parsedActionType = aiAgentAllowedActionSchema.safeParse(normalizedActionType);
  if (!parsedActionType.success) {
    return {
      actionType: null,
      rawType: actionType,
      reason: `Unsupported agent action ${actionType}.`
    };
  }

  return {
    actionType: parsedActionType.data,
    ...(normalizedActionType !== actionType ? { rawType: actionType } : {}),
    reason: ""
  };
}

function normalizeActionType(actionType: string) {
  const normalized = actionType.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "_");

  if (
    [
      "reply",
      "send_reply",
      "respond",
      "respond_message",
      "response",
      "answer",
      "message",
      "send_text",
      "send_whatsapp_message",
      "offer_handoff",
      "offer_handoff_to_sales",
      "offer_human_handoff",
      "offer_sales_contact"
    ].includes(normalized)
  ) {
    return "send_message";
  }

  if (
    [
      "request_handoff",
      "request_handoff_to_sales",
      "handoff",
      "handoff_to_sales",
      "human_handoff",
      "transfer_to_human",
      "transfer_to_sales",
      "escalate_to_human",
      "escalate_to_sales",
      "call_human",
      "chamar_humano"
    ].includes(normalized)
  ) {
    return "request_handoff";
  }

  if (["add_tag", "add_contact_tag", "tag_contact", "tag_conversation", "tag"].includes(normalized)) {
    return "add_tag";
  }

  if (["remove_tag", "remove_contact_tag", "untag", "delete_tag"].includes(normalized)) {
    return "remove_tag";
  }

  if (
    ["create_internal_note", "internal_note", "create_note", "add_note", "note"].includes(
      normalized
    )
  ) {
    return "create_internal_note";
  }

  if (["change_priority", "set_priority", "priority"].includes(normalized)) {
    return "change_priority";
  }

  if (["assign_user", "assign_to_user", "assign_agent"].includes(normalized)) {
    return "assign_user";
  }

  if (["assign_department", "assign_to_department", "assign_team"].includes(normalized)) {
    return "assign_department";
  }

  return actionType;
}

function getString(action: AgentAction, key: string) {
  const value = action[key];
  return typeof value === "string" ? value : undefined;
}

function getFirstString(action: AgentAction, keys: string[]) {
  for (const key of keys) {
    const value = getString(action, key);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}
