import { lockProspectingConversation } from "./prospecting-lock.js";
import { readAgentBehaviorSettings } from "../settings/agent-behavior-settings.js";
import { isExplicitProspectingRefusal } from "./prospecting-refusal.js";
import type { Prisma, PrismaClient } from '@prisma/client';
import { asRecord, findProspectingReservation, readWorkspaceModules, stopProspectingConversation } from './prospecting-policy.js';
type Store = PrismaClient | Prisma.TransactionClient;

/** Only live, newly inserted customer messages pass this boundary. History import
 * intentionally never calls it. While send confirmation is pending, persist the
 * message rather than activating an agent against an unconfirmed outbound. */
export async function observeProspectingInbound(db: unknown, input: {
  workspaceId: string; conversationId: string; messageId: string;
  direction: string; type: string; body?: string | null; createdAt: Date; ingestedAt?: Date | null; isGroup?: boolean; historical?: boolean;
}): Promise<{ reserved: boolean; activated: boolean; liveEligible: boolean }> {
  const store = db as Store;
  if ("$transaction" in store) return store.$transaction(tx => observeProspectingInbound(tx, input));
  await lockProspectingConversation(store, input.workspaceId, input.conversationId);
  const reservation = await findProspectingReservation(store, input.workspaceId, input.conversationId);
  if (!reservation) return { reserved: false, activated: false, liveEligible: false };
  if (!reservation.dispatchIntentAt || input.direction !== 'inbound' || input.type === 'system' || input.isGroup || input.historical ||
      (input.ingestedAt ?? new Date()) < reservation.dispatchIntentAt || input.createdAt.getTime() < Math.floor(reservation.dispatchIntentAt.getTime() / 1000) * 1000 || !['sending', 'confirmed'].includes(reservation.status)) {
    return { reserved: true, activated: false, liveEligible: false };
  }
  if (isExplicitProspectingRefusal(input.body)) {
    await stopProspectingConversation(store, input.workspaceId, input.conversationId, 'prospecting_refusal');
    return { reserved: true, activated: false, liveEligible: false };
  }
  if (input.type === "audio") {
    const audio = await store.message.findUniqueOrThrow({ where: { id: input.messageId } });
    await store.message.update({ where: { id: audio.id }, data: { metadata: {
      ...asRecord(audio.metadata), prospectingLiveGeneration: reservation.generation } } });
  }
  const changed = await store.campaignProspectingReservation.updateMany({ where: { id: reservation.id,
    generation: reservation.generation, status: { in: ['sending', 'confirmed'] }, pendingInboundMessageId: null },
    data: { pendingInboundMessageId: input.messageId, pendingInboundAt: input.ingestedAt ?? new Date() } });
  await store.campaignProspectingReservation.updateMany({ where: { id: reservation.id, generation: reservation.generation,
    status: { in: ['sending', 'confirmed'] }, OR: [{ latestInboundAt: null }, { latestInboundAt: { lte: input.ingestedAt ?? new Date() } }] },
    data: { latestInboundMessageId: input.messageId, latestInboundAt: input.ingestedAt ?? new Date() } });
  // Future replies are already scheduled by the normal active-session scheduler.
  if (reservation.status !== 'confirmed') return { reserved: true, activated: false, liveEligible: true };
  await activateConfirmedProspecting(store, reservation.id);
  return { reserved: true, activated: changed.count > 0, liveEligible: true };
}

export async function activateConfirmedProspecting(store: Store, reservationId: string): Promise<{ workspaceId: string; conversationId: string; messageId: string } | null> {
  if ("$transaction" in store) return store.$transaction(tx => activateConfirmedProspecting(tx, reservationId));
  const identity = await store.campaignProspectingReservation.findUnique({ where: { id: reservationId } });
  if (!identity) return null;
  await lockProspectingConversation(store, identity.workspaceId, identity.conversationId);
  // Conversation-first locking fences module-off and human intervention.
  await store.campaignProspectingReservation.updateMany({ where: { id: reservationId, status: "confirmed" }, data: { updatedAt: new Date() } });
  const reservation = await store.campaignProspectingReservation.findUnique({ where: { id: reservationId } });
  if (!reservation || !reservation.dispatchIntentAt || reservation.status !== 'confirmed' || !reservation.pendingInboundMessageId) return null;
  const [workspace, agent, conversation] = await Promise.all([
    store.workspaceMirror.findUnique({ where: { workspaceId: reservation.workspaceId } }),
    store.aiAgent.findFirst({ where: { workspaceId: reservation.workspaceId, id: reservation.agentId, type: 'prospecting', status: 'active' } }),
    store.conversation.findFirst({ where: { workspaceId: reservation.workspaceId, id: reservation.conversationId } })
  ]);
  if (!readWorkspaceModules(workspace?.limits).campaignProspecting || !agent || !conversation ||
      conversation.aiControlStatus !== 'agent_allowed' || conversation.assignedUserId || conversation.status === 'closed') return null;
  const sessionKey = { workspaceId_agentId_conversationId: {
    workspaceId: reservation.workspaceId, agentId: reservation.agentId, conversationId: reservation.conversationId } };
  const provenance = { sourceCampaignId: reservation.campaignId, sourceRecipientId: reservation.recipientId,
    firstResponseMessageId: reservation.pendingInboundMessageId, firstResponseAt: reservation.pendingInboundAt,
    prospectingGeneration: reservation.generation, status: "active" as const };
  const previous = await store.aiAgentSession.findUnique({ where: sessionKey });
  // Only a new, explicitly released binding can initialize an ended session.
  // A stopped session belonging to the same generation must never resurrect.
  if (previous && previous.prospectingGeneration !== reservation.generation && previous.status !== "active" && !conversation.activeAgentSessionId) {
    await store.auditLog.create({ data: { workspaceId: reservation.workspaceId, action: "prospecting.session_rebound",
      targetType: "ai_agent_session", targetId: previous.id, metadata: { sourceCampaignId: previous.sourceCampaignId,
        sourceRecipientId: previous.sourceRecipientId, generation: previous.prospectingGeneration,
        firstResponseMessageId: previous.firstResponseMessageId, messageCount: previous.messageCount } } });
    await store.aiAgentSession.updateMany({ where: { id: previous.id, status: previous.status, prospectingGeneration: previous.prospectingGeneration },
      data: { ...provenance, messageCount: 0, lastRunAt: null, handoffReason: null, handoffActionCompletedAt: null, metadata: {} } });
  }
  const session = await store.aiAgentSession.upsert({ where: sessionKey,
    create: { workspaceId: reservation.workspaceId, agentId: reservation.agentId, conversationId: reservation.conversationId, ...provenance }, update: {} });
  if (session.status !== 'active' || session.prospectingGeneration !== reservation.generation) return null;
  const bound = await store.conversation.updateMany({ where: { workspaceId: reservation.workspaceId, id: reservation.conversationId,
    aiControlStatus: 'agent_allowed', assignedUserId: null, OR: [{ activeAgentSessionId: null }, { activeAgentSessionId: session.id }] },
    data: { activeAgentSessionId: session.id } });
  if (bound.count) {
    const messageId = reservation.latestInboundMessageId ?? reservation.pendingInboundMessageId;
    const where = { workspaceId_conversationId: { workspaceId: reservation.workspaceId, conversationId: reservation.conversationId } };
    const pending = await store.aiAgentPendingReply.findUnique({ where });
    // A durable queue entry closes the commit-to-callback crash window. A callback
    // may wake the scheduler, but authorizing the response never depends on it.
    if (pending?.lastMessageId !== messageId || pending.prospectingGeneration !== reservation.generation) {
      const scheduledAt = new Date(Date.now() + readAgentBehaviorSettings(workspace?.limits).agentReplyWaitSeconds * 1000);
      const data = { agentId: reservation.agentId, sessionId: session.id, lastMessageId: messageId,
        prospectingGeneration: reservation.generation, scheduledAt, status: 'pending', lockedAt: null, claimToken: null, lastError: null };
      await store.aiAgentPendingReply.upsert({ where,
        create: { workspaceId: reservation.workspaceId, conversationId: reservation.conversationId, ...data }, update: data });
    }
  }
  return bound.count ? { conversationId: reservation.conversationId, workspaceId: reservation.workspaceId,
    messageId: reservation.latestInboundMessageId ?? reservation.pendingInboundMessageId } : null;
}

/** Audio may be transcribed during dispatch without granting autonomous replies.
 * Only live inbound audio observed after this binding may stop it. */
export async function isLiveProspectingAudio(db: unknown, message: {
  workspaceId: string; conversationId: string; direction: string; type: string;
  createdAt: Date | string; ingestedAt?: Date | null; metadata?: unknown;
}) {
  const reservation = await findProspectingReservation(db, message.workspaceId, message.conversationId);
  if (!reservation?.dispatchIntentAt) return false;
  const metadata = message.metadata && typeof message.metadata === "object" ? message.metadata as Record<string, unknown> : {};
  return message.direction === "inbound" && message.type === "audio" && !metadata.historyImport && !metadata.historical && !metadata.isHistory &&
    metadata.prospectingLiveGeneration === reservation.generation && ["sending", "confirmed"].includes(reservation.status) &&
    (message.ingestedAt ?? new Date(message.createdAt)) >= reservation.dispatchIntentAt &&
    new Date(message.createdAt).getTime() >= Math.floor(reservation.dispatchIntentAt.getTime() / 1000) * 1000;
}
export async function observeProspectingAudioRefusal(db: unknown, message: Parameters<typeof isLiveProspectingAudio>[1], text: string) {
  if (isExplicitProspectingRefusal(text) && await isLiveProspectingAudio(db, message)) {
    await stopProspectingConversation(db, message.workspaceId, message.conversationId, "prospecting_refusal");
  }
}
