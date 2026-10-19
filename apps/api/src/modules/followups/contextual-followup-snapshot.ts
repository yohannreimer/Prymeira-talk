import { Prisma, type PrismaClient } from "@prisma/client";
import type { FollowupProfile } from "@prymeira-talk/shared";
import { enterCanonicalWorkspaceTransaction } from "../messaging/canonical-boundary.js";
import { sha, stable } from "../messaging/canonical-values.js";
import { asRecord } from "../prospecting/prospecting-policy.js";
import { resolveFollowupPlan } from "./channel-followup-plan.js";
import { createContextualFollowupContextBuilder, type ContextualFollowupPolicyInputs } from "./contextual-followup-context.js";
import { contextualSequenceIds } from "./contextual-followup-engine.js";
import type { ConversationFollowupRecord } from "./conversation-followups.service.js";

export function contextualPolicyRevision(inputs: ContextualFollowupPolicyInputs, plan: unknown, meeting: unknown) {
  const detached = JSON.parse(JSON.stringify(inputs)) as ContextualFollowupPolicyInputs;
  const adoption = asRecord(asRecord(detached.agent.behaviorConfig).contextualFollowup);
  delete adoption.enabled;
  detached.approvedSources = detached.approvedSources.map(source => {
    const { createdAt: _created, updatedAt: _updated, ...semantic } = source; return semantic;
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return sha(stable({ format: "contextual-policy-v1", inputs: detached, plan, meeting }));
}

/** Same short locked reader for generation and the final canonical frontier.
 * Strong parent lock serializes source inserts through FK; all children protect reclassification. */
export async function readContextualSnapshotInTransaction(tx: Prisma.TransactionClient, followup: Pick<ConversationFollowupRecord,
  "workspaceId" | "conversationId" | "agentId" | "sessionId" | "anchorMessageId" | "stepIndex" | "decision">, profile: FollowupProfile, now: Date) {
  const ws = followup.workspaceId;
  await enterCanonicalWorkspaceTransaction(tx, ws);
  const scopeConversation = await tx.conversation.findFirst({ where: { workspaceId: ws, id: followup.conversationId } });
  if (!scopeConversation) return { status: "unavailable" as const, reason: "policy_changed" as const, detail: "conversation_missing" };
  await tx.$queryRaw(Prisma.sql`SELECT id FROM channels WHERE workspace_id=${ws} AND id=${scopeConversation.channelId}::uuid FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM conversations WHERE workspace_id=${ws} AND id=${followup.conversationId}::uuid FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ai_agents WHERE workspace_id=${ws} AND id=${followup.agentId}::uuid FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ai_knowledge_sources WHERE workspace_id=${ws} AND agent_id=${followup.agentId}::uuid ORDER BY id FOR SHARE`);
  const conversation = await tx.conversation.findFirst({ where: { workspaceId: ws, id: followup.conversationId } });
  if (!conversation || conversation.channelId !== scopeConversation.channelId) return { status: "unavailable" as const, reason: "policy_changed" as const, detail: "conversation_missing_or_moved" };
  await tx.$queryRaw(Prisma.sql`SELECT id FROM contacts WHERE workspace_id=${ws} AND id=${conversation.contactId}::uuid FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM meeting_reminders WHERE workspace_id=${ws} AND conversation_id=${followup.conversationId}::uuid ORDER BY id FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT workspace_id FROM workspace_mirrors WHERE workspace_id=${ws} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ai_agent_sessions WHERE workspace_id=${ws} AND conversation_id=${followup.conversationId}::uuid ORDER BY id FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM campaign_prospecting_reservations WHERE workspace_id=${ws} AND conversation_id=${followup.conversationId}::uuid FOR SHARE`);
  const [agent, channel, session] = await Promise.all([
    tx.aiAgent.findFirst({ where: { workspaceId: ws, id: followup.agentId } }),
    tx.channel.findFirst({ where: { workspaceId: ws, id: conversation.channelId } }),
    followup.sessionId ? tx.aiAgentSession.findFirst({ where: { workspaceId: ws, id: followup.sessionId } }) : null
  ]);
  const plan = agent && channel ? resolveFollowupPlan(agent.behaviorConfig, channel.followupConfig) : null;
  const step = plan?.steps[followup.stepIndex - 1];
  if (!agent || !plan || !step) return { status: "unavailable" as const, reason: "policy_changed" as const, detail: "effective_plan_missing" };
  const result = await createContextualFollowupContextBuilder(tx)({ workspaceId: ws, conversationId: followup.conversationId,
    agentId: followup.agentId, sessionId: followup.sessionId, anchorMessageId: followup.anchorMessageId, profile,
    expectedGeneration: session?.prospectingGeneration, sequenceFollowupIds: contextualSequenceIds(followup.decision), stepInstruction: step.instruction, now });
  if (result.status !== "ready") return result;
  return { ...result, plan, policyRevision: contextualPolicyRevision(result.policyInputs, plan, result.context.profile.meeting) };
}

export function readContextualSnapshot(db: PrismaClient, followup: Parameters<typeof readContextualSnapshotInTransaction>[1], profile: FollowupProfile, now: Date) {
  return db.$transaction(tx => readContextualSnapshotInTransaction(tx, followup, profile, now), { timeout: 15_000 });
}

export async function contextualAnchorCurrent(tx: Prisma.TransactionClient, followup: Pick<ConversationFollowupRecord,
  "workspaceId" | "conversationId" | "anchorMessageId" | "anchorMessageAt" | "anchorIngestedAt">, ownMessageId?: string) {
  const anchor = await tx.message.findFirst({ where: { workspaceId: followup.workspaceId, conversationId: followup.conversationId, id: followup.anchorMessageId, hiddenByReset: false } });
  if (!anchor?.ingestedAt || anchor.createdAt.getTime() !== new Date(followup.anchorMessageAt).getTime()
    || anchor.ingestedAt.getTime() !== new Date(followup.anchorIngestedAt).getTime()) return false;
  return !await tx.message.findFirst({ where: { workspaceId: followup.workspaceId, conversationId: followup.conversationId,
    hiddenByReset: false, ...(ownMessageId ? { id: { not: ownMessageId } } : {}), ingestedAt: { gt: anchor.ingestedAt },
    OR: [{ direction: "inbound" }, { direction: "outbound", status: { notIn: ["pending", "failed"] } }] } });
}
