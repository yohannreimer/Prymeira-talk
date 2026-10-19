import type { PrismaClient } from "@prisma/client";
import type { FollowupProfile } from "@prymeira-talk/shared";
import { buildConversationContext, type ConversationContextBuilderPrismaLike, type NormalizedConversationMessage } from "../agents/conversation-context-builder.js";
import { asRecord } from "../prospecting/prospecting-policy.js";
import { buildContextualFollowupProfile, isPersistedAutomationForm, type FollowupProfileContext } from "./contextual-followup-profiles.js";

export type ContextualFollowupStore = Pick<PrismaClient, "aiAgent" | "conversation" | "aiAgentSession" | "message" | "aiKnowledgeSource" | "conversationFollowup" | "meetingReminder" | "workspaceMirror" | "campaignProspectingReservation" | "messageMedia">;
export type ContextBudget = { maxCharacters: number; maxMessages: number; maxSources: number };
export const DEFAULT_CONTEXTUAL_FOLLOWUP_BUDGET: Readonly<ContextBudget> = Object.freeze({ maxCharacters: 180000, maxMessages: 2000, maxSources: 100 });
export type ContextualSource = { id: string; title: string; content: string | null; fileUrl: string | null };
export type ContextualFollowupContext = {
  workspaceId: string; conversationId: string; agentId: string; sessionId: string | null;
  anchorMessageId: string; now: string;
  instructions: { agentRules: string; stepInstruction: string; behavioralSources: ContextualSource[] };
  factualSources: ContextualSource[];
  messages: NormalizedConversationMessage[];
  profile: FollowupProfileContext;
  sentAttempts: Array<{ followupId: string; sentAt: string }>;
  coverage: { complete: true; anchorIncluded: true; messageIds: string[]; factualSourceIds: string[]; behavioralSourceIds: string[]; domainEvidenceIds: string[]; sentAttemptIds: string[]; serializedCharacters: number; budget: ContextBudget };
};
export type ContextualFollowupContextResult = { status: "ready"; context: ContextualFollowupContext }
  | { status: "unavailable"; reason: "context_limit" | "invalid_evidence" | "policy_changed" | "analysis_failed"; detail: string };
export type ContextualFollowupContextRequest = {
  workspaceId: string; conversationId: string; agentId: string; sessionId?: string | null;
  anchorMessageId: string; profile: FollowupProfile; stepInstruction: string; now: Date;
  expectedGeneration?: string | null;
  /** Lifecycle supplies the canonical sequence membership; count only persisted sent rows. */
  sequenceFollowupIds: string[];
  budget?: ContextBudget;
};

/** All context is query-backed and scoped. No session metadata/ficha is consumed.
 * Budgets measure the entire serialized object (UTF-16 characters, not model tokens).
 * Required content is never selected by truncation: overflow abstains as a whole. */
export function createContextualFollowupContextBuilder(db: ContextualFollowupStore) {
  return async (input: ContextualFollowupContextRequest): Promise<ContextualFollowupContextResult> => {
    const unavailable = (reason: "context_limit" | "invalid_evidence" | "policy_changed" | "analysis_failed", detail: string): ContextualFollowupContextResult => ({ status: "unavailable", reason, detail });
    const budget = input.budget ?? DEFAULT_CONTEXTUAL_FOLLOWUP_BUDGET;
    if (Object.values(budget).some(n => !Number.isSafeInteger(n) || n <= 0)) return unavailable("context_limit", "invalid_budget");
    if (!["attendance", "commercial", "prospecting"].includes(input.profile)) return unavailable("policy_changed", "invalid_profile");
    try {
      const [agent, conversation, session] = await Promise.all([
        db.aiAgent.findFirst({ where: { workspaceId: input.workspaceId, id: input.agentId, status: "active" } }),
        db.conversation.findFirst({ where: { workspaceId: input.workspaceId, id: input.conversationId }, include: { channel: true, contact: true } }),
        input.sessionId ? db.aiAgentSession.findFirst({ where: { workspaceId: input.workspaceId, id: input.sessionId, conversationId: input.conversationId, agentId: input.agentId } }) : null
      ]);
      if (!agent || agent.workspaceId !== input.workspaceId || agent.id !== input.agentId || agent.status !== "active"
        || !conversation || conversation.workspaceId !== input.workspaceId || conversation.id !== input.conversationId
        || (input.sessionId && (!session || session.workspaceId !== input.workspaceId || session.agentId !== input.agentId || session.conversationId !== input.conversationId || session.id !== input.sessionId))) return unavailable("invalid_evidence", "scope_mismatch");
      if (conversation.status === "closed" || conversation.aiControlStatus !== "agent_allowed" || conversation.assignedUserId
        || conversation.contact.isGroup || conversation.contact.phone.endsWith("@g.us")
        || (input.sessionId && (session?.status !== "active" || conversation.activeAgentSessionId !== input.sessionId))) return unavailable("policy_changed", "conversation_not_authorized");
      // Capture the same persisted rows used by the shared complete-history builder.
      let raw: Awaited<ReturnType<typeof db.message.findMany>> = [];
      // Unlike a best-effort history display, required evidence cannot silently lose retired conversations on a failed scope query.
      const retired = await db.conversation.findMany({ where: { workspaceId: input.workspaceId, retiredIntoConversationId: input.conversationId }, select: { id: true } });
      const allowedConversationIds = [input.conversationId, ...retired.map(c => c.id)];
      const historyDb = { message: { findMany: async (args: unknown) => {
        raw = await db.message.findMany(args as Parameters<typeof db.message.findMany>[0]);
        return raw;
      } } } satisfies ConversationContextBuilderPrismaLike;
      // Scope is already resolved; passing it through a tiny facade keeps the shared builder's reset/visibility guards.
      const history = await buildConversationContext({ ...historyDb, conversation: { findMany: async () => allowedConversationIds.filter(id => id !== input.conversationId).map(id => ({ id })) } } as ConversationContextBuilderPrismaLike,
        { workspaceId: input.workspaceId, conversationId: input.conversationId, complete: true, includeInternalNotes: true });
      if (raw.some(m => m.workspaceId !== input.workspaceId || !allowedConversationIds.includes(m.conversationId))) return unavailable("invalid_evidence", "message_scope_mismatch");
      if (!history.messages.some(m => m.id === input.anchorMessageId)) return unavailable("invalid_evidence", "missing_anchor");
      const visibleIds = new Set(history.messages.map(m => m.id));
      const visibleRaw = raw.filter(m => visibleIds.has(m.id));
      const mediaRows = await db.messageMedia.findMany({ where: { workspaceId: input.workspaceId, conversationId: { in: allowedConversationIds }, messageId: { in: [...visibleIds] } } });
      if (mediaRows.some(m => m.workspaceId !== input.workspaceId || !allowedConversationIds.includes(m.conversationId) || !visibleIds.has(m.messageId))) return unavailable("invalid_evidence", "media_scope_mismatch");
      if (visibleRaw.some(message => pendingMedia(message, mediaRows.find(m => m.messageId === message.id)?.transcriptionState))) return unavailable("invalid_evidence", "pending_media");
      const messages = history.messages.map(message => {
        const extractedText = asRecord(asRecord(visibleRaw.find(m => m.id === message.id)?.metadata).media).extractedText;
        return typeof extractedText === "string" && extractedText.trim() && !message.body?.includes(extractedText)
          ? { ...message, body: [message.body, extractedText].filter(Boolean).join("\n\n") } : message;
      });
      const [sources, attempts, bookings] = await Promise.all([
        db.aiKnowledgeSource.findMany({ where: { workspaceId: input.workspaceId, agentId: input.agentId, status: "ready" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
        db.conversationFollowup.findMany({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId, agentId: input.agentId, id: { in: input.sequenceFollowupIds }, status: "sent", sentAt: { not: null } }, orderBy: [{ sentAt: "asc" }, { id: "asc" }] }),
        db.meetingReminder.findMany({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId, agentId: input.agentId, status: { in: ["scheduled", "processing", "sent"] }, ...(conversation.historyResetAt ? { createdAt: { gte: conversation.historyResetAt } } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
      ]);
      if (sources.some(s => s.workspaceId !== input.workspaceId || s.agentId !== input.agentId)
        || attempts.some(a => a.workspaceId !== input.workspaceId || a.conversationId !== input.conversationId || a.agentId !== input.agentId || a.status !== "sent" || !a.sentAt || !input.sequenceFollowupIds.includes(a.id))
        || bookings.some(b => b.workspaceId !== input.workspaceId || b.conversationId !== input.conversationId || b.agentId !== input.agentId)) return unavailable("invalid_evidence", "domain_scope_mismatch");
      const sourceView = (s: typeof sources[number]): ContextualSource => ({ id: s.id, title: s.title, content: s.content, fileUrl: s.fileUrl ?? null });
      const readySources = sources.filter(s => s.status === "ready");
      const factualSources = readySources.filter(s => asRecord(s.metadata).approvalStatus === "confirmed").map(sourceView);
      const behavioralSources = readySources.filter(s => asRecord(s.metadata).approvalStatus === "behavioral"
        || (asRecord(s.metadata).source === "approved_agent_improvement" && asRecord(s.metadata).approvalStatus == null)).map(sourceView);
      const profile = await buildContextualFollowupProfile(db, {
        ...input, agent, channelConfig: conversation.channel.encryptedConfig, messages,
        formEvidenceMessageIds: visibleRaw.filter(isPersistedAutomationForm).map(m => m.id), factualSourceIds: factualSources.map(s => s.id),
        recordedBookings: bookings.filter(b => ["scheduled", "processing", "sent"].includes(b.status) && b.eventId && b.meetingStartsAt > input.now)
          .filter((b, index, all) => all.findIndex(other => other.eventId === b.eventId) === index)
          .map(b => ({ evidenceId: b.id, eventId: b.eventId, startsAt: b.meetingStartsAt.toISOString() }))
      });
      if (profile.status !== "ready") return profile;
      const context: ContextualFollowupContext = {
        workspaceId: input.workspaceId, conversationId: input.conversationId, agentId: input.agentId, sessionId: input.sessionId ?? null,
        anchorMessageId: input.anchorMessageId, now: input.now.toISOString(),
        instructions: { agentRules: agent.systemPrompt, stepInstruction: input.stepInstruction, behavioralSources },
        factualSources, messages, profile: profile.profile,
        sentAttempts: attempts.map(a => ({ followupId: a.id, sentAt: a.sentAt!.toISOString() })),
        coverage: { complete: true, anchorIncluded: true, messageIds: history.messages.map(m => m.id), factualSourceIds: factualSources.map(s => s.id), behavioralSourceIds: behavioralSources.map(s => s.id), domainEvidenceIds: profile.profile.meeting.recordedBookings.map(b => b.evidenceId), sentAttemptIds: attempts.map(a => a.id), serializedCharacters: 0, budget: { ...budget } }
      };
      // Two passes stabilize the number of digits contributed by the size field itself.
      for (let pass = 0; pass < 3; pass++) context.coverage.serializedCharacters = JSON.stringify(context).length;
      if (context.coverage.serializedCharacters > budget.maxCharacters || history.messages.length > budget.maxMessages
        || factualSources.length + behavioralSources.length > budget.maxSources) return unavailable("context_limit", "required_context_exceeds_budget");
      return { status: "ready", context };
    } catch (error) {
      return error instanceof Error && error.message.startsWith("CONVERSATION_CONTEXT_LIMIT")
        ? unavailable("context_limit", "complete_history_limit") : unavailable("analysis_failed", "context_load_failed");
    }
  };
}

function pendingMedia(message: { type: string; body: string | null; metadata: unknown }, transcriptionState?: string | null) {
  const metadata = asRecord(message.metadata);
  if (message.type === "audio") {
    return (transcriptionState != null && transcriptionState !== "completed")
      || (asRecord(metadata.transcription).status != null && asRecord(metadata.transcription).status !== "completed")
      || !message.body?.trim() || /^(Áudio recebido|Processando áudio\.{3}|\[áudio sem transcrição\])$/i.test(message.body.trim());
  }
  if (!["image", "document", "video", "file"].includes(message.type)) return false;
  const media = asRecord(metadata.media);
  return media.status !== "processed" || typeof media.extractedText !== "string" || !media.extractedText.trim();
}
