import { agentFollowupConfigSchema } from "@prymeira-talk/shared";
import { blocksAutonomousAgent } from "../assistant/assistant-policy.js";
import type { ConversationOutboundTextDelivery } from "../conversations/conversations.service.js";
import {
  buildConversationContext,
  type ConversationContextBuilderPrismaLike,
  type NormalizedConversationMessage
} from "./conversation-context-builder.js";
import type {
  ConversationFollowupRecord,
  CompleteAutomaticFollowupResult,
  RevalidateActiveFollowupResult
} from "../followups/conversation-followups.service.js";
import type { FollowupDecision, JevFollowupDecision } from "./jev-followup-decision.js";
import type { AgentReplyPreflight, AgentReplyPreflightPlan } from "./jev-reply-preflight.js";
import {
  selectRelevantKnowledge,
  type KnowledgeRetrievalSource,
  type SelectedKnowledgeSource
} from "./knowledge-retrieval.js";
import { readKnowledgeTaxonomy } from "./knowledge-taxonomy.js";
import { readAgentReasoningEffort, type AgentOutput, type AgentProvider } from "./provider-gateway.js";

type AgentFollowupAgent = {
  id: string;
  workspaceId: string;
  status: string;
  model: string;
  systemPrompt: string;
  behaviorConfig: unknown;
};

type FollowupConversation = {
  id: string;
  workspaceId: string;
  status: string;
  aiControlStatus: string;
  activeAgentSessionId?: string | null;
  contactId: string;
  contact?: {
    id?: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    company?: string | null;
  } | null;
  channel?: {
    id?: string | null;
    provider?: string | null;
    providerKey?: string | null;
    encryptedConfig?: unknown;
  } | null;
  tags?: Array<{ tag?: { name?: string | null } | null }>;
};

type KnowledgeSource = {
  id: string;
  title: string;
  content: string | null;
  metadata?: unknown;
  fileUrl?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
};

export type AgentFollowupRuntimePrismaLike = ConversationContextBuilderPrismaLike & {
  aiAgent: {
    findFirst(args: unknown): Promise<AgentFollowupAgent | null>;
  };
  conversation: {
    findUnique(args: unknown): Promise<FollowupConversation | null>;
  };
  aiKnowledgeSource: {
    findMany(args: unknown): Promise<KnowledgeSource[]>;
  };
  conversationFollowup: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
};

type FollowupLifecycle = {
  revalidateActiveFollowup(input: {
    workspaceId: string;
    followupId: string;
  }): Promise<RevalidateActiveFollowupResult>;
  completeAutomaticFollowup(input: {
    workspaceId: string;
    followupId: string;
    followup: ConversationFollowupRecord;
    agentBehaviorConfig: unknown;
    finalBody: string;
    decision: unknown;
  }): Promise<CompleteAutomaticFollowupResult>;
};

export type AgentFollowupRuntimeResult =
  | { status: "missing"; followupId: string }
  | { status: "cancelled"; followupId: string; reason: string }
  | { status: "skipped"; followupId: string }
  | { status: "review"; followupId: string }
  | { status: "sent"; followupId: string; nextFollowupId?: string }
  | { status: "failed"; followupId: string; message: string };

/**
 * Generates one already-scheduled follow-up. Scheduling and HTTP wiring stay
 * outside this factory so a future worker can inject this single action.
 */
export function createAgentFollowupRuntime(input: {
  prisma: AgentFollowupRuntimePrismaLike;
  provider: AgentProvider;
  followups: FollowupLifecycle;
  jevFollowupDecision: Pick<JevFollowupDecision, "decide">;
  replyPreflight?: AgentReplyPreflight;
  outbound: ConversationOutboundTextDelivery;
}) {
  const { prisma } = input;

  async function markSkipped(followup: ConversationFollowupRecord, decision: unknown, reason: string) {
    await prisma.conversationFollowup.updateMany({
      where: { workspaceId: followup.workspaceId, id: followup.id, activeKey: "active" },
      data: {
        status: "skipped",
        activeKey: null,
        decision,
        reason
      }
    });
  }

  async function markCancelled(followup: ConversationFollowupRecord, decision: unknown, reason: string) {
    await prisma.conversationFollowup.updateMany({
      where: { workspaceId: followup.workspaceId, id: followup.id, activeKey: "active" },
      data: {
        status: "cancelled",
        activeKey: null,
        decision,
        reason,
        cancelledAt: new Date()
      }
    });
  }

  async function markReview(input: {
    followup: ConversationFollowupRecord;
    decision: unknown;
    reason: string;
    draftBody?: string;
  }) {
    await prisma.conversationFollowup.updateMany({
      where: { workspaceId: input.followup.workspaceId, id: input.followup.id, activeKey: "active" },
      data: {
        status: "review",
        decision: input.decision,
        reason: input.reason,
        ...(input.draftBody ? { draftBody: input.draftBody } : {})
      }
    });
  }

  return {
    async runFollowup(runInput: {
      workspaceId: string;
      followupId: string;
    }): Promise<AgentFollowupRuntimeResult> {
      const initial = await input.followups.revalidateActiveFollowup(runInput);
      if (initial.status === "missing") {
        return { status: "missing", followupId: runInput.followupId };
      }
      if (initial.status === "cancelled") {
        return { status: "cancelled", followupId: runInput.followupId, reason: initial.reason };
      }

      const { followup } = initial.context;
      const [agent, conversation] = await Promise.all([
        prisma.aiAgent.findFirst({
          where: { workspaceId: runInput.workspaceId, id: followup.agentId, status: "active" }
        }),
        loadConversation(prisma, runInput.workspaceId, followup.conversationId)
      ]);
      if (!agent || !conversation) {
        await markReview({
          followup,
          decision: { outcome: "unavailable" },
          reason: !agent ? "followup_agent_unavailable" : "followup_conversation_unavailable"
        });
        return { status: "review", followupId: followup.id };
      }

      const followupConfig = agentFollowupConfigSchema.safeParse(asRecord(agent.behaviorConfig)?.followup);
      const step = followupConfig.success ? followupConfig.data.steps[followup.stepIndex - 1] : undefined;
      if (!step) {
        await markSkipped(followup, { outcome: "skip", reason: "followup_step_unconfigured" }, "followup_step_unconfigured");
        return { status: "skipped", followupId: followup.id };
      }

      let conversationContext;
      let selectedKnowledge: SelectedKnowledgeSource[];
      try {
        const [context, knowledge] = await Promise.all([
          buildConversationContext(prisma, {
            workspaceId: runInput.workspaceId,
            conversationId: followup.conversationId,
            complete: true
          }),
          prisma.aiKnowledgeSource.findMany({
            where: {
              workspaceId: runInput.workspaceId,
              agentId: agent.id,
              status: "ready"
            },
            orderBy: [{ createdAt: "desc" }],
            take: 50
          })
        ]);
        conversationContext = context;
        selectedKnowledge = selectRelevantKnowledge({
          latestMessage: step.instruction,
          conversationHistory: context.formattedHistory,
          instruction: step.instruction,
          taxonomy: readKnowledgeTaxonomy(agent.behaviorConfig),
          sources: knowledge.filter(isConfirmedKnowledge).map(toRetrievalSource)
        }).selected;
      } catch (error) {
        if (isContextLimitError(error)) {
          await markReview({
            followup,
            decision: { outcome: "review", reason: "conversation_context_limit" },
            reason: "conversation_context_limit"
          });
          return { status: "review", followupId: followup.id };
        }
        return { status: "failed", followupId: followup.id, message: errorMessage(error) };
      }

      let decision: FollowupDecision;
      try {
        decision = await input.jevFollowupDecision.decide({
          conversationMessages: conversationContext.messages,
          selectedKnowledge: selectedKnowledge.map(toJevKnowledge),
          followupKind: followup.kind,
          step: followup.stepIndex,
          instruction: step.instruction,
          aiControlStatus: conversation.aiControlStatus === "agent_allowed" ? "agent_allowed" : "human_controlled",
          hasCompatibleActiveAgentSession: true
        });
      } catch (error) {
        await markReview({
          followup,
          decision: { outcome: "unavailable", reason: errorMessage(error) },
          reason: "jev_followup_decision_unavailable"
        });
        return { status: "review", followupId: followup.id };
      }

      if (decision.route === "cancel") {
        await markCancelled(followup, decision, "jev_cancel");
        return { status: "cancelled", followupId: followup.id, reason: "jev_cancel" };
      }
      if (decision.outcome === "skip" || decision.route === "wait") {
        await markSkipped(followup, decision, `jev_${decision.route}`);
        return { status: "skipped", followupId: followup.id };
      }

      if (decision.route === "automatic_send" && !isAutomaticallyEligible(decision, followup, conversation)) {
        await markReview({ followup, decision, reason: "automatic_delivery_not_allowed" });
        return { status: "review", followupId: followup.id };
      }

      let preflightPlan: AgentReplyPreflightPlan | undefined;
      if (input.replyPreflight) {
        try {
          const preflight = await input.replyPreflight.evaluate({
            currentMessage: toPreflightCurrentMessage(conversationContext.messages, followup, step.instruction),
            conversationMessages: conversationContext.messages,
            selectedKnowledge: selectedKnowledge.map(toJevKnowledge)
          });
          if (preflight.outcome === "silence") {
            await markSkipped(followup, { ...decision, preflight }, "preflight_social_closure");
            return { status: "skipped", followupId: followup.id };
          }
          preflightPlan = preflight.plan;
        } catch (error) {
          await markReview({
            followup,
            decision: { ...decision, preflight: { outcome: "unavailable", reason: errorMessage(error) } },
            reason: "reply_preflight_unavailable"
          });
          return { status: "review", followupId: followup.id };
        }
      }

      let output: AgentOutput;
      try {
        output = await input.provider.generate({
          reasoningEffort: readAgentReasoningEffort(agent.behaviorConfig),
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          userPrompt: buildFollowupUserPrompt(step.instruction, decision),
          context: buildFollowupContext({
            conversation,
            conversationMessages: conversationContext.messages,
            formattedHistory: conversationContext.formattedHistory,
            selectedKnowledge,
            stepInstruction: step.instruction,
            decision,
            preflightPlan
          })
        });
      } catch (error) {
        return { status: "failed", followupId: followup.id, message: errorMessage(error) };
      }

      const candidate = output.reply?.trim();
      if (!candidate || output.handoff.required) {
        await markReview({
          followup,
          decision: { ...decision, providerHandoff: output.handoff.required },
          reason: output.handoff.required ? "provider_handoff_required" : "provider_reply_missing",
          ...(candidate ? { draftBody: candidate } : {})
        });
        return { status: "review", followupId: followup.id };
      }

      if (input.replyPreflight?.audit && preflightPlan) {
        try {
          const audit = await input.replyPreflight.audit({
            currentMessage: toPreflightCurrentMessage(conversationContext.messages, followup, step.instruction),
            conversationMessages: conversationContext.messages,
            selectedKnowledge: selectedKnowledge.map(toJevKnowledge),
            candidateReply: candidate,
            plan: preflightPlan
          });
          if (audit.outcome === "suppress") {
            await markSkipped(followup, { ...decision, audit }, `audit_${audit.reason}`);
            return { status: "skipped", followupId: followup.id };
          }
          if (audit.outcome === "handoff") {
            await markReview({
              followup,
              decision: { ...decision, audit },
              reason: `audit_${audit.reason}`,
              draftBody: candidate
            });
            return { status: "review", followupId: followup.id };
          }
        } catch (error) {
          await markReview({
            followup,
            decision: { ...decision, audit: { outcome: "unavailable", reason: errorMessage(error) } },
            reason: "reply_audit_unavailable",
            draftBody: candidate
          });
          return { status: "review", followupId: followup.id };
        }
      }

      if (decision.route === "human_review") {
        await markReview({ followup, decision, reason: "jev_human_review", draftBody: candidate });
        return { status: "review", followupId: followup.id };
      }

      const beforeDelivery = await input.followups.revalidateActiveFollowup(runInput);
      if (beforeDelivery.status === "missing") {
        return { status: "missing", followupId: runInput.followupId };
      }
      if (beforeDelivery.status === "cancelled") {
        return { status: "cancelled", followupId: runInput.followupId, reason: beforeDelivery.reason };
      }

      const currentConversation = await loadConversation(prisma, runInput.workspaceId, beforeDelivery.context.followup.conversationId);
      if (!currentConversation || !isAutomaticallyEligible(decision, beforeDelivery.context.followup, currentConversation)) {
        await markReview({
          followup: beforeDelivery.context.followup,
          decision,
          reason: "automatic_delivery_not_allowed",
          draftBody: candidate
        });
        return { status: "review", followupId: beforeDelivery.context.followup.id };
      }

      let delivery;
      try {
        delivery = await input.outbound.createPendingOutboundMessage({
          workspaceId: runInput.workspaceId,
          conversationId: beforeDelivery.context.followup.conversationId,
          body: candidate,
          sentByUserId: null,
          metadata: {
            source: "ai_agent",
            agentId: agent.id,
            followupId: beforeDelivery.context.followup.id
          }
        });
      } catch (error) {
        return { status: "failed", followupId: beforeDelivery.context.followup.id, message: errorMessage(error) };
      }

      if (delivery.message.status !== "sent") {
        return {
          status: "failed",
          followupId: beforeDelivery.context.followup.id,
          message: "Outbound delivery was not confirmed."
        };
      }

      const completion = await input.followups.completeAutomaticFollowup({
        workspaceId: runInput.workspaceId,
        followupId: beforeDelivery.context.followup.id,
        followup: beforeDelivery.context.followup,
        agentBehaviorConfig: agent.behaviorConfig,
        finalBody: candidate,
        decision
      });
      return completion.status === "scheduled"
        ? { status: "sent", followupId: beforeDelivery.context.followup.id, nextFollowupId: completion.followupId }
        : { status: "sent", followupId: beforeDelivery.context.followup.id };
    }
  };
}

async function loadConversation(
  prisma: AgentFollowupRuntimePrismaLike,
  workspaceId: string,
  conversationId: string
) {
  return prisma.conversation.findUnique({
    where: { workspaceId_id: { workspaceId, id: conversationId } },
    include: { contact: true, channel: true, tags: { include: { tag: true } } }
  });
}

function isAutomaticallyEligible(
  decision: FollowupDecision,
  followup: ConversationFollowupRecord,
  conversation: FollowupConversation
) {
  return (
    followup.kind === "qualification" &&
    decision.outcome === "follow_up" &&
    decision.route === "automatic_send" &&
    decision.purpose === "missing_qualification" &&
    decision.stage === "qualification" &&
    decision.risk === "none" &&
    conversation.status !== "closed" &&
    conversation.aiControlStatus === "agent_allowed" &&
    !blocksAutonomousAgent(conversation.channel?.encryptedConfig)
  );
}

function buildFollowupUserPrompt(instruction: string, decision: FollowupDecision) {
  return [
    "Gere somente um follow-up para a conversa atual.",
    `Instrução desta etapa: ${instruction}`,
    `Propósito JEV: ${decision.purpose}. Rota JEV: ${decision.route}.`,
    "A orientação JEV define o fluxo; ela não é evidência comercial. Não afirme fatos comerciais sem fonte confirmada."
  ].join("\n\n");
}

function buildFollowupContext(input: {
  conversation: FollowupConversation;
  conversationMessages: NormalizedConversationMessage[];
  formattedHistory: string;
  selectedKnowledge: SelectedKnowledgeSource[];
  stepInstruction: string;
  decision: FollowupDecision;
  preflightPlan?: AgentReplyPreflightPlan;
}) {
  return {
    messageBody: input.stepInstruction,
    conversationHistory: input.formattedHistory,
    conversationMessages: input.conversationMessages,
    contact: {
      id: input.conversation.contact?.id ?? input.conversation.contactId,
      name: input.conversation.contact?.name ?? null,
      phone: input.conversation.contact?.phone ?? null,
      email: input.conversation.contact?.email ?? null,
      company: input.conversation.contact?.company ?? null
    },
    channel: {
      id: input.conversation.channel?.id ?? null,
      provider: input.conversation.channel?.provider ?? null,
      providerKey: input.conversation.channel?.providerKey ?? null
    },
    tags: input.conversation.tags
      ?.map((entry) => entry.tag?.name)
      .filter((name): name is string => Boolean(name)) ?? [],
    knowledge: input.selectedKnowledge.map((source) => ({
      title: source.title,
      content: source.content,
      ...(source.fileUrl ? { fileUrl: source.fileUrl } : {})
    })),
    followupGuidance: {
      stepInstruction: input.stepInstruction,
      purpose: input.decision.purpose,
      route: input.decision.route,
      stage: input.decision.stage,
      risk: input.decision.risk,
      commercialEvidence: "JEV guidance is not commercial evidence."
    },
    ...(input.preflightPlan ? { agentPreflight: input.preflightPlan } : {})
  };
}

function toPreflightCurrentMessage(
  messages: NormalizedConversationMessage[],
  followup: ConversationFollowupRecord,
  instruction: string
) {
  const latest = messages.at(-1);
  return {
    id: latest?.id ?? followup.anchorMessageId,
    body: latest?.body?.trim() || instruction,
    type: latest?.type ?? "text"
  };
}

function isConfirmedKnowledge(source: KnowledgeSource) {
  return asRecord(source.metadata)?.approvalStatus === "confirmed";
}

function toRetrievalSource(source: KnowledgeSource): KnowledgeRetrievalSource {
  return {
    id: source.id,
    title: source.title,
    content: source.content,
    metadata: asRecord(source.metadata),
    fileUrl: source.fileUrl ?? null,
    fileName: source.fileName ?? null,
    mimeType: source.mimeType ?? null
  };
}

function toJevKnowledge(source: Pick<SelectedKnowledgeSource, "title" | "content">) {
  return { title: source.title, content: source.content };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isContextLimitError(error: unknown) {
  return error instanceof Error && error.message.startsWith("CONVERSATION_CONTEXT_LIMIT:");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected follow-up runtime error.";
}
