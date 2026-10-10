import { buildProspectingInstructions } from "../prospecting/prospecting-instructions.js";
import { autonomousAgentAllowed, findProspectingReservation } from "../prospecting/prospecting-policy.js";
import { blocksAutonomousAgent } from "../assistant/assistant-policy.js";
import type { ConversationOutboundTextDelivery } from "../conversations/conversations.service.js";
import {
  buildConversationContext,
  type ConversationContextBuilderPrismaLike,
  type NormalizedConversationMessage
} from "./conversation-context-builder.js";
import { MAX_AUTOMATIC_FOLLOWUP_STEPS } from "../followups/conversation-followups.service.js";
import { calculateFollowupDueAt, resolveFollowupPlan } from "../followups/channel-followup-plan.js";
import type { FollowupBrain, FollowupBrainAnalysis } from "../followups/followup-brain.js";
import { saveAiFollowupAudience } from "../followups/followup-contact-audience.js";
import { nextBusinessStart } from "../followups/business-time.js";
import {
  publishPersistedConversationFollowup,
  type ConversationFollowupPublisher,
  type ConversationFollowupPublicRecord
} from "../followups/conversation-followup-events.js";
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
import {
  createOpenAiCompatibleAgentProvider,
  readAgentReasoningEffort,
  type AgentOutput,
  type AgentProvider
} from "./provider-gateway.js";
import { resolveFollowupStepInstruction } from "./followup-step-instruction.js";
import {
  resolveOpenAiCompatibleSettings,
  type AiProviderSettingsPrismaLike,
  type OpenAiCompatibleSettings
} from "./ai-provider-settings.js";

type AgentFollowupAgent = {
  id: string;
  workspaceId: string;
  status: string;
  model: string;
  systemPrompt: string;
  handoffConfig?: unknown;
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
    followupConfig?: unknown;
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

export type AgentFollowupRuntimePrismaLike = ConversationContextBuilderPrismaLike & AiProviderSettingsPrismaLike & {
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
    findFirst?(args: unknown): Promise<ConversationFollowupPublicRecord | null>;
    findMany?(args: unknown): Promise<Array<{ finalBody: string | null; sentAt: Date | string | null }>>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  contact?: Parameters<typeof saveAiFollowupAudience>[0]["contact"];
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
    claim: { lockedAt: Date };
    agentBehaviorConfig: unknown;
    finalBody: string;
    decision: unknown;
    sentMessageId?: string;
    sentMessageAt?: Date | string;
  }): Promise<CompleteAutomaticFollowupResult>;
  claimScheduledFollowup(input: {
    workspaceId: string;
    followupId: string;
  }): Promise<{ status: "claimed"; lockedAt: Date } | { status: "not_scheduled" }>;
  recoverClaimedFollowup(input: {
    workspaceId: string;
    followupId: string;
    claim: { lockedAt: Date };
    outcome: "retry" | "failed";
    reason: string;
    scheduledAt?: Date;
  }): Promise<{ status: "recovered" } | { status: "not_active" }>;
};

export type AgentFollowupRuntimeResult =
  | { status: "missing"; followupId: string }
  | { status: "cancelled"; followupId: string; reason: string }
  | { status: "skipped"; followupId: string }
  | { status: "review"; followupId: string }
  | { status: "deferred"; followupId: string }
  | { status: "sent"; followupId: string; nextFollowupId?: string }
  | { status: "failed"; followupId: string; message: string };

/**
 * Generates one already-scheduled follow-up. Scheduling and HTTP wiring stay
 * outside this factory so a future worker can inject this single action.
 */
export function createAgentFollowupRuntime(input: {
  prisma: AgentFollowupRuntimePrismaLike;
  provider: AgentProvider;
  providerFactory?: (settings: Extract<OpenAiCompatibleSettings, { active: true }>) => AgentProvider;
  allowFallbackProvider?: boolean;
  followups: FollowupLifecycle;
  jevFollowupDecision: Pick<JevFollowupDecision, "decide">;
  replyPreflight?: AgentReplyPreflight;
  outbound: ConversationOutboundTextDelivery;
  publisher?: ConversationFollowupPublisher;
  /** Single-call analysis for follow-ups created in brain mode (decision.mode === "brain"). */
  followupBrain?: FollowupBrain;
  now?: () => Date;
}) {
  const { prisma } = input;
  const clock = input.now ?? (() => new Date());

  async function publish(followup: ConversationFollowupRecord) {
    if (!input.publisher || !prisma.conversationFollowup.findFirst) return;
    await publishPersistedConversationFollowup({
      store: { findFirst: prisma.conversationFollowup.findFirst.bind(prisma.conversationFollowup) },
      publisher: input.publisher,
      workspaceId: followup.workspaceId,
      followupId: followup.id
    });
  }

  async function markSkipped(followup: ConversationFollowupRecord, decision: unknown, reason: string) {
    const updated = await prisma.conversationFollowup.updateMany({
      where: { workspaceId: followup.workspaceId, id: followup.id, activeKey: "active" },
      data: {
        status: "skipped",
        activeKey: null,
        decision,
        reason
      }
    });
    if (updated.count === 1) await publish(followup);
  }

  async function markCancelled(followup: ConversationFollowupRecord, decision: unknown, reason: string) {
    const updated = await prisma.conversationFollowup.updateMany({
      where: { workspaceId: followup.workspaceId, id: followup.id, activeKey: "active" },
      data: {
        status: "cancelled",
        activeKey: null,
        decision,
        reason,
        cancelledAt: new Date()
      }
    });
    if (updated.count === 1) await publish(followup);
  }

  async function markReview(input: {
    followup: ConversationFollowupRecord;
    decision: unknown;
    reason: string;
    draftBody?: string;
  }) {
    const updated = await prisma.conversationFollowup.updateMany({
      where: { workspaceId: input.followup.workspaceId, id: input.followup.id, activeKey: "active" },
      data: {
        status: "review",
        decision: input.decision,
        reason: input.reason,
        ...(input.draftBody ? { draftBody: input.draftBody } : {})
      }
    });
    if (updated.count === 1) await publish(input.followup);
  }

  /**
   * Brain mode: one AI reads the end of the quiet conversation and says what is open.
   * The first run happens after the quiet wait; a customer follow-up then waits for the
   * channel cadence, a company-owned step becomes a reminder for the seller right away.
   */
  async function runBrainFollowup(d: {
    runInput: { workspaceId: string; followupId: string };
    followup: ConversationFollowupRecord;
    agent: AgentFollowupAgent;
    conversation: FollowupConversation;
    prospecting: Awaited<ReturnType<typeof findProspectingReservation>>;
    claimToken: { lockedAt: Date };
    plan: NonNullable<ReturnType<typeof resolveFollowupPlan>>;
    onConfirmed: () => void;
  }): Promise<AgentFollowupRuntimeResult> {
    const { runInput, followup, agent, conversation, claimToken } = d;
    const now = clock();
    const stored = readBrainDecision(followup.decision);
    let analysis: FollowupBrainAnalysis;
    // A scheduled step keeps the analysis made for it: any new message would have replaced this follow-up.
    if (stored?.brain && stored.brain.step === followup.stepIndex && followup.reason !== BRAIN_QUIET_REASON) {
      analysis = stored.brain;
    } else {
      if (!input.followupBrain) {
        await markReview({ followup, decision: { mode: "brain" }, reason: "followup_brain_unavailable" });
        return { status: "review", followupId: followup.id };
      }
      try {
        const context = await buildConversationContext(prisma, {
          workspaceId: runInput.workspaceId, conversationId: followup.conversationId, limit: 60
        });
        const lastCustomerAt = context.messages.filter((message) => message.label === "cliente").at(-1)?.createdAt;
        const previous = prisma.conversationFollowup.findMany
          ? await prisma.conversationFollowup.findMany({
              where: {
                workspaceId: runInput.workspaceId,
                conversationId: followup.conversationId,
                status: "sent",
                ...(lastCustomerAt ? { sentAt: { gt: new Date(lastCustomerAt) } } : {})
              },
              orderBy: { sentAt: "asc" },
              take: 5,
              select: { finalBody: true, sentAt: true }
            })
          : [];
        analysis = await input.followupBrain.analyze({
          workspaceId: runInput.workspaceId,
          conversationId: followup.conversationId,
          conversationMessages: context.messages,
          previousAttempts: previous.flatMap((attempt) => attempt.finalBody && attempt.sentAt
            ? [{ body: attempt.finalBody, sentAt: new Date(attempt.sentAt).toISOString() }] : []),
          agentRules: agent.systemPrompt,
          contactName: conversation.contact?.name ?? null,
          now
        });
      } catch (error) {
        const message = errorMessage(error);
        await input.followups.recoverClaimedFollowup({
          workspaceId: runInput.workspaceId,
          followupId: followup.id,
          claim: claimToken,
          outcome: "retry",
          reason: `followup_brain_failed: ${message}`
        });
        return { status: "failed", followupId: followup.id, message };
      }
      if (prisma.contact) {
        await saveAiFollowupAudience({ contact: prisma.contact }, {
          workspaceId: runInput.workspaceId,
          contactId: conversation.contactId,
          kind: analysis.contactType,
          confidence: analysis.confidence,
          reason: analysis.rationale
        }).catch(() => false);
      }
    }
    const decision = { mode: "brain", brain: { ...analysis, step: followup.stepIndex, analyzedAt: now.toISOString() } };

    if (analysis.situation === "closed" || analysis.situation === "no_pending") {
      const reason = analysis.contactType === "internal_personal"
        ? "brain_internal_contact" : analysis.situation === "closed" ? "brain_closed" : "brain_no_pending";
      await markSkipped(followup, decision, reason);
      return { status: "skipped", followupId: followup.id };
    }
    if (analysis.situation === "waiting_company") {
      const updated = await prisma.conversationFollowup.updateMany({
        where: { workspaceId: followup.workspaceId, id: followup.id, activeKey: "active" },
        data: { kind: "seller_reminder", status: "review", lockedAt: null, decision, reason: "seller_reminder", draftBody: null }
      });
      if (updated.count === 1) await publish(followup);
      return { status: "review", followupId: followup.id };
    }

    const candidate = analysis.suggestedMessage?.trim();
    if (followup.reason === BRAIN_QUIET_REASON) {
      const firstStep = d.plan.steps[followup.stepIndex - 1];
      const dueAt = firstStep ? calculateFollowupDueAt(new Date(followup.anchorMessageAt), firstStep.afterMinutes, d.plan) : now;
      if (dueAt > now) {
        const updated = await prisma.conversationFollowup.updateMany({
          where: { workspaceId: followup.workspaceId, id: followup.id, activeKey: "active", status: "processing", lockedAt: claimToken.lockedAt },
          data: { status: "scheduled", lockedAt: null, scheduledAt: dueAt, decision, reason: "brain_waiting_customer", draftBody: candidate ?? null }
        });
        if (updated.count === 1) await publish(followup);
        return { status: "deferred", followupId: followup.id };
      }
    }
    const automatic = d.plan.humanCommercialDelivery === "automatic" && analysis.risk === "none" &&
      analysis.confidence >= BRAIN_AUTOMATIC_MIN_CONFIDENCE && followup.kind === "human_commercial";
    if (!candidate || !automatic) {
      await markReview({ followup, decision, reason: "brain_review", ...(candidate ? { draftBody: candidate } : {}) });
      return { status: "review", followupId: followup.id };
    }
    return deliverAutomatically({
      runInput, followup, agent, prospecting: d.prospecting, claimToken, candidate, decision,
      eligible: (current, currentConversation, delivery) =>
        delivery === "automatic" && current.kind === "human_commercial" && currentConversation.status !== "closed",
      onConfirmed: d.onConfirmed
    });
  }

  /** Sends an approved follow-up through the normal outbound path, inside business hours, and schedules the next step. */
  async function deliverAutomatically(d: {
    runInput: { workspaceId: string; followupId: string };
    followup: ConversationFollowupRecord;
    agent: AgentFollowupAgent;
    prospecting: Awaited<ReturnType<typeof findProspectingReservation>>;
    claimToken: { lockedAt: Date };
    candidate: string;
    decision: unknown;
    eligible: (followup: ConversationFollowupRecord, conversation: FollowupConversation, delivery: "review" | "automatic" | undefined) => boolean;
    onConfirmed: () => void;
  }): Promise<AgentFollowupRuntimeResult> {
    const { runInput, followup, agent, prospecting, claimToken, candidate, decision } = d;
    const beforeDelivery = await input.followups.revalidateActiveFollowup(runInput);
    if (beforeDelivery.status === "missing") {
      return { status: "missing", followupId: runInput.followupId };
    }
    if (beforeDelivery.status === "cancelled") {
      return { status: "cancelled", followupId: runInput.followupId, reason: beforeDelivery.reason };
    }

    const currentConversation = await loadConversation(prisma, runInput.workspaceId, beforeDelivery.context.followup.conversationId);
    const currentFollowupConfig = currentConversation
      ? resolveFollowupPlan(agent.behaviorConfig, currentConversation.channel?.followupConfig, !!prospecting)
      : null;
    if (!currentConversation || !currentFollowupConfig ||
      !d.eligible(beforeDelivery.context.followup, currentConversation, currentFollowupConfig.humanCommercialDelivery)) {
      await markReview({
        followup: beforeDelivery.context.followup,
        decision,
        reason: "automatic_delivery_not_allowed",
        draftBody: candidate
      });
      return { status: "review", followupId: beforeDelivery.context.followup.id };
    }

    const attemptedAt = (input.now ?? (() => new Date()))();
    const permittedAt = nextBusinessStart({
      from: attemptedAt,
      timeZone: currentFollowupConfig.timeZone,
      businessDays: currentFollowupConfig.businessDays,
      businessHours: currentFollowupConfig.businessHours
    });
    if (permittedAt > attemptedAt) {
      await input.followups.recoverClaimedFollowup({
        workspaceId: runInput.workspaceId,
        followupId: beforeDelivery.context.followup.id,
        claim: claimToken,
        outcome: "retry",
        reason: "outside_business_hours",
        scheduledAt: permittedAt
      });
      return { status: "deferred", followupId: beforeDelivery.context.followup.id };
    }

    if (prospecting && !await autonomousAgentAllowed(prisma, { workspaceId: runInput.workspaceId, conversationId: followup.conversationId, agentId: agent.id, sessionId: followup.sessionId, expectedGeneration: prospecting.generation })) { await markSkipped(followup, { outcome: "skip" }, "prospecting_stopped"); return { status: "cancelled", followupId: followup.id, reason: "prospecting_stopped" }; }
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
          ...(prospecting ? { prospectingGeneration: prospecting.generation } : {}),
          followupId: beforeDelivery.context.followup.id
        }
      });
    } catch (error) {
      const message = errorMessage(error);
      await input.followups.recoverClaimedFollowup({
        workspaceId: runInput.workspaceId,
        followupId: beforeDelivery.context.followup.id,
        claim: claimToken,
        outcome: "failed",
        reason: `outbound_delivery_failed: ${message}`
      });
      return { status: "failed", followupId: beforeDelivery.context.followup.id, message };
    }

    if (delivery.message.status !== "sent") {
      await input.followups.recoverClaimedFollowup({
        workspaceId: runInput.workspaceId,
        followupId: beforeDelivery.context.followup.id,
        claim: claimToken,
        outcome: "failed",
        reason: "outbound_delivery_unconfirmed"
      });
      return {
        status: "failed",
        followupId: beforeDelivery.context.followup.id,
        message: "Outbound delivery was not confirmed."
      };
    }
    d.onConfirmed();

    const completion = await input.followups.completeAutomaticFollowup({
      workspaceId: runInput.workspaceId,
      followupId: beforeDelivery.context.followup.id,
      followup: beforeDelivery.context.followup,
      claim: claimToken,
      agentBehaviorConfig: agent.behaviorConfig,
      finalBody: candidate,
      decision,
      sentMessageId: delivery.message.id,
      sentMessageAt: delivery.message.createdAt
    });
    if (completion.status === "not_active") {
      return { status: "skipped", followupId: beforeDelivery.context.followup.id };
    }
    return completion.status === "scheduled"
      ? { status: "sent", followupId: beforeDelivery.context.followup.id, nextFollowupId: completion.followupId }
      : { status: "sent", followupId: beforeDelivery.context.followup.id };
  }

  return {
    async runFollowup(runInput: {
      workspaceId: string;
      followupId: string;
    }): Promise<AgentFollowupRuntimeResult> {
      const claim = await input.followups.claimScheduledFollowup(runInput);
      if (claim.status !== "claimed") {
        return { status: "skipped", followupId: runInput.followupId };
      }
      const claimToken = { lockedAt: claim.lockedAt };
      let deliveryConfirmed = false;

      try {
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

      const prospecting = await findProspectingReservation(prisma, runInput.workspaceId, followup.conversationId);
      if (prospecting && !await autonomousAgentAllowed(prisma, { workspaceId: runInput.workspaceId, conversationId: followup.conversationId, agentId: agent.id, sessionId: followup.sessionId, expectedGeneration: prospecting.generation })) { await markSkipped(followup, { outcome: "skip" }, "prospecting_stopped"); return { status: "cancelled", followupId: followup.id, reason: "prospecting_stopped" }; }
      const followupConfig = resolveFollowupPlan(agent.behaviorConfig, conversation.channel?.followupConfig, !!prospecting);
      if (followup.stepIndex > MAX_AUTOMATIC_FOLLOWUP_STEPS || followup.stepIndex > (followupConfig?.steps.length ?? 0)) {
        await markSkipped(followup, { outcome: "skip", reason: "followup_step_limit" }, "followup_step_limit");
        return { status: "skipped", followupId: followup.id };
      }
      const step = followupConfig?.steps[followup.stepIndex - 1];
      if (!step) {
        await markSkipped(followup, { outcome: "skip", reason: "followup_step_unconfigured" }, "followup_step_unconfigured");
        return { status: "skipped", followupId: followup.id };
      }
      if (isBrainFollowup(followup)) {
        return await runBrainFollowup({ runInput, followup, agent, conversation, prospecting, claimToken,
          plan: followupConfig!, onConfirmed: () => { deliveryConfirmed = true; } });
      }
      const campaign = prospecting ? await (prisma as unknown as import('@prisma/client').PrismaClient).campaign.findFirst({ where: { workspaceId: runInput.workspaceId, id: prospecting.campaignId } }) : null;
      const effectiveSystemPrompt = prospecting ? buildProspectingInstructions(agent.systemPrompt, asRecord(agent.handoffConfig)?.prospectingGoal, campaign?.prospectingContext) : agent.systemPrompt;
      const stepInstruction = resolveFollowupStepInstruction({
        kind: followup.kind,
        configuredInstruction: step.instruction
      });

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
            orderBy: [{ createdAt: "desc" }]
          })
        ]);
        conversationContext = context;
        selectedKnowledge = selectRelevantKnowledge({
          latestMessage: stepInstruction,
          conversationHistory: context.formattedHistory,
          instruction: stepInstruction,
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
        const message = errorMessage(error);
        await input.followups.recoverClaimedFollowup({
          workspaceId: runInput.workspaceId,
          followupId: followup.id,
          claim: claimToken,
          outcome: "retry",
          reason: `followup_context_or_knowledge_load_failed: ${message}`
        });
        return { status: "failed", followupId: followup.id, message };
      }

      const jevMessages = conversationContext.messages
        .filter((entry) => entry.label === "cliente" || entry.label === "atendente")
        .slice(-20);
      const jevReplyKnowledge = selectedKnowledge.map((source) => ({
        id: source.id,
        title: source.title,
        content: source.content
      }));

      let decision: FollowupDecision;
      try {
        decision = await input.jevFollowupDecision.decide({
          conversationMessages: conversationContext.messages,
          selectedKnowledge: selectedKnowledge.map(toJevKnowledge),
          followupKind: followup.kind === "seller_reminder" ? "human_commercial" : followup.kind,
          step: followup.stepIndex,
          instruction: stepInstruction,
          aiControlStatus: conversation.aiControlStatus === "agent_allowed" ? "agent_allowed" : "human_controlled",
          hasCompatibleActiveAgentSession: Boolean(initial.context.session),
          hasConfiguredHumanAgent: followup.kind === "human_commercial" && !initial.context.session,
          allowAutomaticSend: !!prospecting || followupConfig?.humanCommercialDelivery === "automatic"
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

      const automaticDeliveryBlocked = decision.route === "automatic_send" &&
        !isAutomaticallyEligible(decision, followup, conversation, followupConfig?.humanCommercialDelivery, !!prospecting);
      if (automaticDeliveryBlocked) decision = { ...decision, route: "human_review" };

      let preflightPlan: AgentReplyPreflightPlan | undefined;
      if (input.replyPreflight) {
        try {
          const preflight = await input.replyPreflight.evaluate({
            agentRules: effectiveSystemPrompt,
            followupPurpose: decision.purpose === "none" ? undefined : decision.purpose,
            currentMessage: toPreflightCurrentMessage(conversationContext.messages, followup, stepInstruction),
            conversationMessages: jevMessages,
            selectedKnowledge: jevReplyKnowledge
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

      let providerSettings: OpenAiCompatibleSettings;
      try {
        providerSettings = await resolveOpenAiCompatibleSettings(prisma, {
          workspaceId: runInput.workspaceId
        });
      } catch (error) {
        const message = errorMessage(error);
        await input.followups.recoverClaimedFollowup({
          workspaceId: runInput.workspaceId,
          followupId: followup.id,
          claim: claimToken,
          outcome: "retry",
          reason: `followup_provider_settings_load_failed: ${message}`
        });
        return { status: "failed", followupId: followup.id, message };
      }
      if (!providerSettings.active && input.allowFallbackProvider === false) {
        await markReview({
          followup,
          decision,
          reason: "followup_provider_unavailable"
        });
        return { status: "review", followupId: followup.id };
      }
      const runProvider = providerSettings.active
        ? (input.providerFactory ?? createOpenAiCompatibleAgentProvider)(providerSettings)
        : input.provider;
      const runModel = providerSettings.active ? providerSettings.chatModel : agent.model;

      let output: AgentOutput;
      try {
        output = await runProvider.generate({
          reasoningEffort: readAgentReasoningEffort(agent.behaviorConfig),
          model: runModel,
          systemPrompt: effectiveSystemPrompt,
          userPrompt: buildFollowupUserPrompt(stepInstruction, decision),
          context: buildFollowupContext({
            conversation,
            conversationMessages: conversationContext.messages,
            formattedHistory: conversationContext.formattedHistory,
            selectedKnowledge,
            stepInstruction,
            decision,
            preflightPlan
          })
        });
      } catch (error) {
        const message = errorMessage(error);
        await input.followups.recoverClaimedFollowup({
          workspaceId: runInput.workspaceId,
          followupId: followup.id,
          claim: claimToken,
          outcome: "retry",
          reason: `provider_generation_failed: ${message}`
        });
        return { status: "failed", followupId: followup.id, message };
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
            agentRules: effectiveSystemPrompt,
            followupPurpose: decision.purpose === "none" ? undefined : decision.purpose,
            currentMessage: toPreflightCurrentMessage(conversationContext.messages, followup, stepInstruction),
            conversationMessages: jevMessages,
            selectedKnowledge: jevReplyKnowledge,
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
        await markReview({ followup, decision, reason: automaticDeliveryBlocked ? "automatic_delivery_not_allowed" : "jev_human_review", draftBody: candidate });
        return { status: "review", followupId: followup.id };
      }

      return await deliverAutomatically({
        runInput, followup, agent, prospecting, claimToken, candidate, decision,
        eligible: (current, currentConversation, delivery) =>
          isAutomaticallyEligible(decision, current, currentConversation, delivery, !!prospecting),
        onConfirmed: () => { deliveryConfirmed = true; }
      });
      } catch (error) {
        const message = errorMessage(error);
        try {
          await input.followups.recoverClaimedFollowup({
            workspaceId: runInput.workspaceId,
            followupId: runInput.followupId,
            claim: claimToken,
            outcome: deliveryConfirmed ? "failed" : "retry",
            reason: deliveryConfirmed
              ? `followup_completion_failed_after_delivery: ${message}`
              : `followup_runtime_unexpected: ${message}`
          });
        } catch {
          // A recovery write can fail only when the backing store is unavailable.
        }
        return { status: "failed", followupId: runInput.followupId, message };
      }
    }
  };
}

const BRAIN_QUIET_REASON = "brain_quiet_wait";
/** Automatic sending needs this much certainty; anything less goes to the seller for review. */
const BRAIN_AUTOMATIC_MIN_CONFIDENCE = 0.8;

function isBrainFollowup(followup: ConversationFollowupRecord) {
  return asRecord(followup.decision)?.mode === "brain";
}

function readBrainDecision(decision: unknown) {
  const record = asRecord(decision);
  const brain = asRecord(record?.brain);
  return brain ? { brain: brain as FollowupBrainAnalysis & { step?: number } } : null;
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
  conversation: FollowupConversation,
  automaticDelivery: "review" | "automatic" | undefined,
  campaignProspecting = false
) {
  const qualificationEligible =
    followup.kind === "qualification" &&
    ["missing_qualification", "confirm_active"].includes(decision.purpose) &&
    decision.stage === "qualification" &&
    conversation.aiControlStatus === "agent_allowed";
  const commercialEligible =
    followup.kind === "human_commercial" &&
    ["proposal_checkin", "objection_help", "confirm_active"].includes(decision.purpose) &&
    ["post_proposal", "seller_owned"].includes(decision.stage);
  return (
    (campaignProspecting || automaticDelivery === "automatic") &&
    (qualificationEligible || commercialEligible) &&
    decision.outcome === "follow_up" &&
    decision.route === "automatic_send" &&
    decision.risk === "none" &&
    conversation.status !== "closed" &&
    (!qualificationEligible || campaignProspecting || !blocksAutonomousAgent(conversation.channel?.encryptedConfig))
  );
}

function buildFollowupUserPrompt(instruction: string, decision: FollowupDecision) {
  return [
    "Gere somente um follow-up para a conversa atual.",
    `Instrução desta etapa: ${instruction}`,
    `Propósito JEV: ${decision.purpose}. Rota JEV: ${decision.route}.`,
    ...(decision.stage === "qualification" && decision.purpose === "confirm_active"
      ? ["Esta é uma retomada da qualificação, não uma cadência pós-proposta. Se o cliente pediu e recebeu um catálogo, pergunte brevemente se conseguiu consultá-lo e se quer seguir com o pedido. Não diga que houve proposta ou cotação enviada."]
      : []),
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
  const latest = [...messages].reverse().find((message) => message.label === "cliente");
  return {
    id: latest?.id ?? followup.anchorMessageId,
    body: latest?.body?.trim() || instruction,
    type: latest?.type ?? "text"
  };
}

function isConfirmedKnowledge(source: KnowledgeSource) {
  const metadata = asRecord(source.metadata);
  return metadata?.approvalStatus === "confirmed" || metadata?.source === "approved_agent_improvement";
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
