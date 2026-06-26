import { aiAgentAllowedActionSchema, type AiAgentAllowedAction } from "@prymeira-talk/shared";
import {
  executeAgentActions,
  type AgentToolExecutorPrismaLike
} from "./agent-tool-executor.js";
import {
  buildConversationContext,
  type ConversationContext,
  type ConversationContextBuilderPrismaLike
} from "./conversation-context-builder.js";
import type { AgentOutput, AgentProvider } from "./provider-gateway.js";

type JsonValue = unknown;
type AgentRunStatus = "completed" | "handoff_requested" | "failed" | "skipped";
type AgentRunTrigger = "automation" | "manual_test";

type AiAgentRecord = {
  id: string;
  workspaceId: string;
  model: string;
  systemPrompt: string;
  handoffConfig: JsonValue;
  allowedActions: JsonValue;
};

type ConversationRecord = {
  id: string;
  workspaceId: string;
  contactId: string;
  channelId?: string | null;
  aiControlStatus: string;
  activeAgentSessionId?: string | null;
  contact?: {
    id?: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    company?: string | null;
  } | null;
  channel?: {
    id?: string;
    provider?: string | null;
    providerKey?: string | null;
  } | null;
  tags?: Array<{ tag?: { id?: string; name?: string | null; color?: string | null } | null }>;
};

type MessageRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  direction?: string;
  type?: string;
  body?: string | null;
  createdAt?: Date | string;
};

type KnowledgeSourceRecord = {
  id: string;
  title: string;
  content: string | null;
};

type AgentSessionRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  conversationId: string;
};

type AgentRuntimePrismaLike = Omit<
  AgentToolExecutorPrismaLike,
  "conversation" | "aiAgentSession"
> & {
  aiAgent: {
    findFirst(args: unknown): Promise<AiAgentRecord | null>;
  };
  aiKnowledgeSource: {
    findMany(args: unknown): Promise<KnowledgeSourceRecord[]>;
  };
  aiAgentSession: AgentToolExecutorPrismaLike["aiAgentSession"] & {
    upsert(args: unknown): Promise<AgentSessionRecord>;
  };
  conversation: {
    findUnique(args: unknown): Promise<ConversationRecord | null>;
    update(args: unknown): Promise<unknown>;
  };
  message: {
    findFirst(args: unknown): Promise<MessageRecord | null>;
    findMany: ConversationContextBuilderPrismaLike["message"]["findMany"];
    create(args: unknown): Promise<unknown>;
  };
  aiAgentRun: {
    create(args: unknown): Promise<{ id: string; status: AgentRunStatus }>;
  };
};

export type AgentRuntimeResult = {
  status: AgentRunStatus;
  runId?: string;
};

export function createAgentRuntime(input: {
  prisma: AgentRuntimePrismaLike;
  provider: AgentProvider;
}) {
  const { prisma, provider } = input;

  return {
    async runForMessage(runInput: {
      workspaceId: string;
      agentId: string;
      conversationId: string;
      messageId: string;
      trigger: AgentRunTrigger;
      instruction?: string | null;
    }): Promise<AgentRuntimeResult> {
      const [activeAgent, conversation, message] = await Promise.all([
        prisma.aiAgent.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.agentId,
            status: "active"
          }
        }),
        prisma.conversation.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: runInput.workspaceId,
              id: runInput.conversationId
            }
          },
          include: {
            contact: true,
            channel: true,
            tags: { include: { tag: true } }
          }
        }),
        prisma.message.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.messageId
          }
        })
      ]);

      const agent =
        activeAgent ??
        (await prisma.aiAgent.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.agentId
          }
        }));

      if (!agent) {
        return { status: "failed" };
      }

      if (!activeAgent || !conversation || !message) {
        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          conversationId: conversation?.id ?? null,
          trigger: runInput.trigger,
          input: runInput,
          model: agent.model,
          status: "failed",
          errorMessage: "Agent, conversation, or message was not found."
        });
        return { status: "failed", runId: run.id };
      }

      if (message.conversationId !== conversation.id) {
        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          conversationId: conversation.id,
          trigger: runInput.trigger,
          input: runInput,
          model: agent.model,
          status: "failed",
          errorMessage: "Message does not belong to the conversation."
        });
        return { status: "failed", runId: run.id };
      }

      if (conversation.aiControlStatus === "human_controlled") {
        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          conversationId: conversation.id,
          trigger: runInput.trigger,
          input: runInput,
          model: agent.model,
          status: "skipped",
          errorMessage: "Conversation is controlled by a human."
        });
        return { status: "skipped", runId: run.id };
      }

      const runInputPayload = {
        workspaceId: runInput.workspaceId,
        agentId: agent.id,
        conversationId: conversation.id,
        messageId: message.id,
        trigger: runInput.trigger,
        instruction: runInput.instruction ?? null
      };
      let contextSummary: Record<string, unknown> = {
        contactId: conversation.contactId,
        contactName: conversation.contact?.name ?? null,
        channelId: conversation.channelId ?? conversation.channel?.id ?? null,
        tagCount:
          conversation.tags?.filter((item) => Boolean(item.tag?.name)).length ?? 0,
        knowledgeCount: 0
      };
      let knowledgeMatches: Array<Record<string, unknown>> = [];
      let providerOutput: AgentOutput | undefined;
      let actionResults: Awaited<ReturnType<typeof executeAgentActions>> = [];

      const session = await prisma.aiAgentSession.upsert({
        where: {
          workspaceId_agentId_conversationId: {
            workspaceId: runInput.workspaceId,
            agentId: agent.id,
            conversationId: conversation.id
          }
        },
        create: {
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          conversationId: conversation.id,
          status: "active",
          metadata: {}
        },
        update: {
          status: "active"
        }
      });

      try {
        if (conversation.activeAgentSessionId !== session.id) {
          await prisma.conversation.update({
            where: {
              workspaceId_id: {
                workspaceId: runInput.workspaceId,
                id: conversation.id
              }
            },
            data: {
              activeAgentSessionId: session.id
            }
          });
          conversation.activeAgentSessionId = session.id;
        }

        const [knowledge, conversationContext] = await Promise.all([
          prisma.aiKnowledgeSource.findMany({
            where: {
              workspaceId: runInput.workspaceId,
              agentId: agent.id,
              status: "ready"
            },
            orderBy: [{ createdAt: "asc" }],
            take: 8
          }),
          buildConversationContext(prisma, {
            workspaceId: runInput.workspaceId,
            conversationId: conversation.id
          })
        ]);

        const allowedActions = readAllowedActions(agent.allowedActions);
        const context = buildContext(conversation, message, knowledge, conversationContext);
        contextSummary = {
          contactId: conversation.contactId,
          contactName: conversation.contact?.name ?? null,
          channelId: conversation.channelId ?? conversation.channel?.id ?? null,
          tagCount: context.tags.length,
          knowledgeCount: knowledge.length,
          conversationMessageCount: conversationContext.messages.length
        };
        knowledgeMatches = knowledge.map((source) => ({ id: source.id, title: source.title }));

        providerOutput = await provider.generate({
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          userPrompt: buildUserPrompt(message.body, runInput.instruction),
          context
        });

        const confidenceThreshold = readConfidenceThreshold(agent.handoffConfig);
        const handoffReason = getHandoffReason(providerOutput, confidenceThreshold);
        const status: AgentRunStatus = handoffReason ? "handoff_requested" : "completed";

        actionResults = await executeAgentActions(prisma as AgentToolExecutorPrismaLike, {
          workspaceId: runInput.workspaceId,
          conversationId: conversation.id,
          allowedActions,
          actions: providerOutput.actions
        });

        if (!handoffReason && providerOutput.reply && allowedActions.includes("send_message")) {
          await prisma.message.create({
            data: {
              workspaceId: runInput.workspaceId,
              conversationId: conversation.id,
              direction: "outbound",
              type: "text",
              body: providerOutput.reply,
              status: "pending",
              sentByUserId: null,
              metadata: {
                source: "ai_agent",
                agentId: agent.id
              }
            }
          });
          await prisma.conversation.update({
            where: {
              workspaceId_id: {
                workspaceId: runInput.workspaceId,
                id: conversation.id
              }
            },
            data: {
              lastMessageAt: new Date(),
              lastMessagePreview: providerOutput.reply
            }
          });
        }

        await prisma.aiAgentSession.update({
          where: {
            workspaceId_id: {
              workspaceId: runInput.workspaceId,
              id: session.id
            }
          },
          data: {
            status: handoffReason ? "handoff_requested" : "active",
            handoffReason,
            lastRunAt: new Date(),
            messageCount: { increment: 1 }
          }
        });

        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          sessionId: session.id,
          conversationId: conversation.id,
          trigger: runInput.trigger,
          input: runInputPayload,
          contextSummary,
          knowledgeMatches,
          model: agent.model,
          output: providerOutput,
          actions: actionResults,
          confidence: providerOutput.confidence,
          status
        });

        return { status, runId: run.id };
      } catch (error) {
        const run = await createRun({
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          sessionId: session.id,
          conversationId: conversation.id,
          trigger: runInput.trigger,
          input: runInputPayload,
          contextSummary,
          knowledgeMatches,
          model: agent.model,
          output: providerOutput,
          actions: actionResults,
          confidence: providerOutput?.confidence,
          status: "failed",
          errorMessage: getErrorMessage(error)
        });

        return { status: "failed", runId: run.id };
      }
    }
  };

  async function createRun(input: {
    workspaceId: string;
    agentId: string;
    sessionId?: string | null;
    conversationId?: string | null;
    trigger: AgentRunTrigger;
    input: Record<string, unknown>;
    contextSummary?: Record<string, unknown>;
    knowledgeMatches?: Array<Record<string, unknown>>;
    model: string;
    output?: Record<string, unknown>;
    actions?: unknown[];
    status: AgentRunStatus;
    confidence?: number | null;
    errorMessage?: string | null;
  }) {
    return await prisma.aiAgentRun.create({
      data: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        sessionId: input.sessionId ?? null,
        conversationId: input.conversationId ?? null,
        trigger: input.trigger,
        input: input.input,
        contextSummary: input.contextSummary ?? {},
        knowledgeMatches: input.knowledgeMatches ?? [],
        output: input.output ?? {},
        actions: input.actions ?? [],
        status: input.status,
        model: input.model,
        confidence: input.confidence ?? null,
        costEstimate: {},
        errorMessage: input.errorMessage ?? null
      }
    });
  }
}

function readAllowedActions(value: JsonValue): AiAgentAllowedAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const parsed = aiAgentAllowedActionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function readConfidenceThreshold(value: JsonValue) {
  if (!isRecord(value)) {
    return 0.55;
  }

  const threshold = value.confidenceThreshold;
  return typeof threshold === "number" && Number.isFinite(threshold) ? threshold : 0.55;
}

function buildUserPrompt(messageBody: string | null | undefined, instruction: string | null | undefined) {
  return [instruction?.trim(), messageBody?.trim()].filter(Boolean).join("\n\n");
}

function buildContext(
  conversation: ConversationRecord,
  message: MessageRecord,
  knowledge: KnowledgeSourceRecord[],
  conversationContext: ConversationContext
) {
  return {
    messageBody: message.body ?? "",
    conversationHistory: conversationContext.formattedHistory,
    conversationMessages: conversationContext.messages,
    message: {
      id: message.id,
      type: message.type ?? null,
      direction: message.direction ?? null,
      createdAt: message.createdAt ?? null
    },
    contact: {
      id: conversation.contact?.id ?? conversation.contactId,
      name: conversation.contact?.name ?? null,
      phone: conversation.contact?.phone ?? null,
      email: conversation.contact?.email ?? null,
      company: conversation.contact?.company ?? null
    },
    channel: {
      id: conversation.channel?.id ?? conversation.channelId ?? null,
      provider: conversation.channel?.provider ?? null,
      providerKey: conversation.channel?.providerKey ?? null
    },
    tags:
      conversation.tags
        ?.map((item) => item.tag?.name)
        .filter((name): name is string => Boolean(name)) ?? [],
    knowledge: knowledge.map((source) => ({
      title: source.title,
      content: source.content
    }))
  };
}

function getHandoffReason(output: AgentOutput, confidenceThreshold: number) {
  const requestHandoffAction = output.actions.find((action) => action.type === "request_handoff");
  const isHandoffRequired =
    output.handoff.required || output.confidence < confidenceThreshold || Boolean(requestHandoffAction);

  if (!isHandoffRequired) {
    return null;
  }

  const actionReason =
    requestHandoffAction && typeof requestHandoffAction.reason === "string"
      ? requestHandoffAction.reason.trim()
      : "";
  const providerReason = output.handoff.reason?.trim() ?? "";

  return actionReason || providerReason || "Agent requested human handoff.";
}

function isRecord(value: JsonValue): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "AI agent runtime failed.";
}
