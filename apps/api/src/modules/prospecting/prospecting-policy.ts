import { lockProspectingConversation, lockProspectingConversations } from "./prospecting-lock.js";
import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from '@prisma/client';
import { blocksAutonomousAgent } from '../assistant/assistant-policy.js';

type Store = PrismaClient | Prisma.TransactionClient;
export function readWorkspaceModules(limits: unknown) {
  const root = asRecord(limits);
  return { campaignProspecting: asRecord(root.modules).campaignProspecting === true };
}
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export async function findProspectingReservation(db: unknown, workspaceId: string, conversationId: string) {
  const store = db as Store;
  if (!store.campaignProspectingReservation) return null; // Legacy isolated stores do not have this module.
  return store.campaignProspectingReservation.findUnique({ where: { workspaceId_conversationId: { workspaceId, conversationId } } });
}
export async function validateProspectingAgent(db: unknown, workspaceId: string, agentId: string | null | undefined, channelId?: string) {
  if (!agentId) return;
  const store = db as Store;
  const [workspace, agent, channel] = await Promise.all([
    store.workspaceMirror.findUnique({ where: { workspaceId }, select: { limits: true } }),
    store.aiAgent.findFirst({ where: { workspaceId, id: agentId, type: 'prospecting', status: 'active' } }),
    channelId ? store.channel.findFirst({ where: { workspaceId, id: channelId } }) : null
  ]);
  if (!readWorkspaceModules(workspace?.limits).campaignProspecting || !agent ||
      (typeof asRecord(agent.handoffConfig).prospectingGoal !== "string" || !String(asRecord(agent.handoffConfig).prospectingGoal).trim()) || (channelId && channel?.provider !== 'evolution')) {
    throw new Error('PROSPECTING_UNAVAILABLE: Habilite o módulo e escolha um agente de prospecção ativo em um canal Evolution.');
  }
}

/** One policy is re-evaluated at scheduling, generation and immediately before sends.
 * Campaign status is deliberately irrelevant once a recipient has responded. */
export async function autonomousAgentAllowed(db: unknown, input: {
  workspaceId: string; conversationId: string; agentId?: string; sessionId?: string | null;
  expectedGeneration?: string | null; channelConfig?: unknown; aiControlStatus?: string;
}) {
  const store = db as Store;
  const reservation = await findProspectingReservation(store, input.workspaceId, input.conversationId);
  if (!reservation) {
    if (input.agentId && store.aiAgent?.findFirst) {
      const agent = await store.aiAgent.findFirst({ where: { workspaceId: input.workspaceId, id: input.agentId } });
      if (!agent || agent.type === 'prospecting') return false;
    }
    return input.aiControlStatus !== 'human_controlled' && !blocksAutonomousAgent(input.channelConfig);
  }
  if (reservation.status !== 'confirmed' || !reservation.confirmedAt || !reservation.dispatchIntentAt ||
      (input.agentId && reservation.agentId !== input.agentId) ||
      (input.expectedGeneration && reservation.generation !== input.expectedGeneration)) return false;
  const [workspace, conversation, session, agent] = await Promise.all([
    store.workspaceMirror.findUnique({ where: { workspaceId: input.workspaceId }, select: { limits: true } }),
    store.conversation.findFirst({ where: { workspaceId: input.workspaceId, id: input.conversationId }, include: { contact: { select: { isGroup: true, phone: true } }, channel: { select: { provider: true } } } }),
    store.aiAgentSession.findFirst({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId,
      agentId: reservation.agentId, sourceRecipientId: reservation.recipientId, prospectingGeneration: reservation.generation } }),
    store.aiAgent.findFirst({ where: { workspaceId: input.workspaceId, id: reservation.agentId } })
  ]);
  return readWorkspaceModules(workspace?.limits).campaignProspecting && agent?.type === 'prospecting' && agent.status === 'active' &&
    conversation?.channel.provider === 'evolution' && !conversation.contact.isGroup && !conversation.contact.phone.endsWith('@g.us') &&
    conversation.status !== 'closed' && conversation?.aiControlStatus === 'agent_allowed' && !conversation?.assignedUserId &&
    !!session?.firstResponseMessageId && session.status === 'active' && conversation?.activeAgentSessionId === session.id &&
    (!input.sessionId || session.id === input.sessionId);
}

export async function stopProspectingConversation(db: unknown, workspaceId: string, conversationId: string, reason: string): Promise<void> {
  const store = db as Store;
  if (!store.campaignProspectingReservation) return;
  if ("$transaction" in store) return store.$transaction(tx => stopProspectingConversation(tx, workspaceId, conversationId, reason));
  await lockProspectingConversation(store, workspaceId, conversationId);
  const reservation = await findProspectingReservation(store, workspaceId, conversationId);
  if (!reservation) return;
  await store.campaignProspectingReservation.updateMany({ where: { workspaceId, conversationId }, data: { status: 'stopped' } });
  await store.aiAgentSession.updateMany({ where: { workspaceId, conversationId, sourceRecipientId: reservation.recipientId, status: { not: "closed" } },
    data: { status: 'paused_by_human', handoffReason: reason } });
  await store.conversation.updateMany({ where: { workspaceId, id: conversationId }, data: { aiControlStatus: 'human_controlled' } });
  await store.aiAgentPendingReply.updateMany({ where: { workspaceId, conversationId, status: { in: ['pending', 'processing'] } },
    data: { status: 'cancelled', lockedAt: null } });
  await store.conversationFollowup.updateMany({ where: { workspaceId, conversationId, status: { in: ['evaluating', 'scheduled', 'processing', 'review'] } },
    data: { status: 'cancelled', activeKey: null, cancelledAt: new Date(), reason } });
}

/** Updating live agent rules fences pending jobs and work already generating. An
 * inactive/type-swapped agent transfers control permanently until a human acts. */
export async function fenceProspectingAgentChange(db: unknown, input: { workspaceId: string; agentId: string; stop: boolean }) {
  const store = db as Store;
  if (!store.campaignProspectingReservation) return;
  const reservations = await store.campaignProspectingReservation.findMany({ where: { workspaceId: input.workspaceId, agentId: input.agentId,
    status: { in: ['prepared', 'sending', 'confirmed'] } }, orderBy: { conversationId: 'asc' } });
  await lockProspectingConversations(store, reservations);
  for (const snapshot of reservations) {
    const reservation = await findProspectingReservation(store, input.workspaceId, snapshot.conversationId);
    if (!reservation || !['prepared','sending','confirmed'].includes(reservation.status)) continue;
    if (input.stop || reservation.status !== 'confirmed') {
      await stopProspectingConversation(store, input.workspaceId, reservation.conversationId, 'Agente de prospecção alterado ou desativado.');
      continue;
    }
    const generation = randomUUID();
    await store.campaignProspectingReservation.update({ where: { id: reservation.id }, data: { generation } });
    await store.aiAgentSession.updateMany({ where: { workspaceId: input.workspaceId, conversationId: reservation.conversationId,
      sourceRecipientId: reservation.recipientId, status: 'active' }, data: { prospectingGeneration: generation } });
    await store.aiAgentPendingReply.updateMany({ where: { workspaceId: input.workspaceId, conversationId: reservation.conversationId,
      status: { in: ['pending', 'processing'] } }, data: { status: 'cancelled', lockedAt: null } });
    await store.conversationFollowup.updateMany({ where: { workspaceId: input.workspaceId, conversationId: reservation.conversationId,
      status: { in: ['evaluating', 'scheduled', 'processing', 'review'] } }, data: { status: 'cancelled', activeKey: null,
      cancelledAt: new Date(), reason: 'prospecting_agent_changed' } });
  }
}

export async function releaseEndedProspectingBinding(db: unknown, input: { workspaceId: string; conversationId: string; actorUserId: string | null }) {
  const store = db as Store;
  await lockProspectingConversation(store, input.workspaceId, input.conversationId);
  const previous = await findProspectingReservation(db, input.workspaceId, input.conversationId);
  // A deliberate reset releases only a confirmed dispatch. Unknown provider
  // outcomes (even if subsequently stopped) remain permanently reserved.
  if (!previous?.confirmedAt || previous.status !== "stopped") return;
  await store.auditLog.create({ data: { workspaceId: input.workspaceId, actorUserId: input.actorUserId,
    action: "prospecting.binding_released", targetType: "conversation", targetId: input.conversationId,
    metadata: { sourceCampaignId: previous.campaignId, sourceRecipientId: previous.recipientId,
      generation: previous.generation, firstResponseMessageId: previous.pendingInboundMessageId } } });
  await store.campaignProspectingReservation.delete({ where: { id: previous.id } });
}

/** Serialize recovered observation against module, agent and human stops. */
export async function lockProspectingObservation(db: unknown, input: {
  workspaceId: string; conversationId: string; agentId: string; expectedGeneration?: string | null;
}) {
  const store = db as Store;
  await lockProspectingConversation(store, input.workspaceId, input.conversationId);
  const reservation = await findProspectingReservation(store, input.workspaceId, input.conversationId);
  if (!reservation) return false;
  const changed = await store.campaignProspectingReservation.updateMany({ where: { id: reservation.id, status: "confirmed",
    generation: input.expectedGeneration ?? reservation.generation }, data: { updatedAt: new Date() } });
  return changed.count > 0 && await autonomousAgentAllowed(store, input);
}

export async function lockProspectingAgentConversations(db: unknown, workspaceId: string, agentId: string) {
  const store = db as Store;
  if (!store.campaignProspectingReservation) return;
  const reservations = await store.campaignProspectingReservation.findMany({ where: { workspaceId, agentId,
    status: { in: ["prepared", "sending", "confirmed"] } }, orderBy: { conversationId: "asc" } });
  await lockProspectingConversations(store, reservations);
}
