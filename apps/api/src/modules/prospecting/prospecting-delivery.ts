import { ownsAgentReplyClaim, withAgentReplyClaimLock, type AgentReplyClaim } from "../agents/agent-reply-claim.js";
import type { Prisma, PrismaClient } from '@prisma/client';
import { asRecord, autonomousAgentAllowed, findProspectingReservation } from './prospecting-policy.js';
type Store = PrismaClient | Prisma.TransactionClient;

/** Persist identity before network I/O. Webhooks reconcile this row, never classify
 * the provider echo as a human intervention or create a second outbound. */
export async function reserveProspectingOutbound(db: unknown, input: {
  workspaceId: string; conversationId: string; agentId: string; generation: string;
  type: 'text' | 'image' | 'file'; body: string; mediaUrl?: string | null; metadata?: Record<string, unknown>;
}) {
  const store = db as Store;
  if (!await autonomousAgentAllowed(store, { workspaceId: input.workspaceId, conversationId: input.conversationId,
    agentId: input.agentId, expectedGeneration: input.generation })) throw new Error('Prospecting authorization changed before delivery.');
  return store.message.create({ data: { workspaceId: input.workspaceId, conversationId: input.conversationId,
    direction: 'outbound', type: input.type, body: input.body, mediaUrl: input.mediaUrl,
    status: 'pending', sentByUserId: null, metadata: { ...input.metadata, source: 'ai_agent',
      agentId: input.agentId, prospectingGeneration: input.generation, prospectingDispatch: 'prepared' } as Prisma.InputJsonObject } });
}

export async function findProspectingOutboundEcho(db: unknown, input: {
  workspaceId: string; conversationId: string; direction: string; body?: string | null; mediaUrl?: string | null;
}) {
  if (input.direction !== 'outbound') return null;
  const store = db as Store;
  return store.message.findFirst({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId,
    direction: 'outbound', status: { in: ['pending', 'failed'] }, createdAt: { gte: new Date(Date.now() - 15 * 60_000) },
    AND: [{ metadata: { path: ['source'], equals: 'ai_agent' } },
      { OR: [{ metadata: { path: ['prospectingDispatch'], equals: 'sending' } }, { metadata: { path: ['prospectingDispatch'], equals: 'uncertain' } }] }],
    ...(input.mediaUrl ? { OR: [{ mediaUrl: input.mediaUrl }, { body: input.body ?? '', type: { in: ['image', 'file'] } }] } : { body: input.body ?? '', type: 'text' }) }, orderBy: { createdAt: 'desc' } });
}

export async function confirmProspectingOutbound(db: unknown, messageId: string, providerMessageId: string | null | undefined) {
  const store = db as Store;
  const message = await store.message.findUniqueOrThrow({ where: { id: messageId } });
  if (!providerMessageId) {
    await store.message.update({ where: { id: message.id }, data: { status: 'failed',
      metadata: { ...asRecord(message.metadata), prospectingDispatch: 'uncertain' } as Prisma.InputJsonObject } });
    throw new Error('Prospecting delivery was not confirmed; automatic retry is disabled.');
  }
  const metadata = asRecord(message.metadata);
  return store.message.update({ where: { id: message.id }, data: { providerMessageId, status: 'sent',
    metadata: { ...metadata, prospectingDispatch: 'confirmed',
      ...(typeof metadata.followupId !== 'string' && metadata.prospectingFollowupObservation !== 'observed'
        ? { prospectingFollowupObservation: 'pending' } : {}) } as Prisma.InputJsonObject } });
}

export async function cancelProspectingOutbound(db: unknown, messageId: string) {
  const store = db as Store;
  const message = await store.message.findUniqueOrThrow({ where: { id: messageId } });
  await store.message.update({ where: { id: messageId }, data: { status: 'failed',
    metadata: { ...asRecord(message.metadata), prospectingDispatch: 'cancelled' } as Prisma.InputJsonObject } });
}

export async function dispatchProspectingOutbound(db: unknown, message: Awaited<ReturnType<typeof reserveProspectingOutbound>>,
  send: () => Promise<{ providerMessageId: string | null } | null>) {
  const metadata = asRecord(message.metadata);
  if (!await autonomousAgentAllowed(db, { workspaceId: message.workspaceId, conversationId: message.conversationId,
    agentId: typeof metadata.agentId === 'string' ? metadata.agentId : undefined,
    expectedGeneration: typeof metadata.prospectingGeneration === 'string' ? metadata.prospectingGeneration : undefined })) {
    await cancelProspectingOutbound(db, message.id);
    throw new Error('Prospecting authorization changed before delivery.');
  }
  const claim: AgentReplyClaim | undefined = typeof metadata.replyClaimId === "string" && typeof metadata.replyClaimToken === "string"
    ? { id: metadata.replyClaimId, token: metadata.replyClaimToken } : undefined;
  if (!await ownsAgentReplyClaim(db, message.workspaceId, claim)) {
    await cancelProspectingOutbound(db, message.id);
    throw new Error("Agent reply queue ownership changed before delivery.");
  }
  // Commit dispatch intent before entering external I/O. A crash from this point
  // is uncertain, including the tiny intent-to-network gap, and cannot be retried.
  try {
    await withAgentReplyClaimLock(db, message.workspaceId, claim, async tx => {
      if (!await autonomousAgentAllowed(tx, { workspaceId: message.workspaceId, conversationId: message.conversationId,
        agentId: typeof metadata.agentId === "string" ? metadata.agentId : undefined,
        expectedGeneration: typeof metadata.prospectingGeneration === "string" ? metadata.prospectingGeneration : undefined })) {
        throw new Error("Prospecting authorization changed before delivery.");
      }
      await tx.message.update({ where: { id: message.id }, data: {
        metadata: { ...metadata, prospectingDispatch: "sending" } as Prisma.InputJsonObject } });
    }, message.conversationId);
  } catch (error) { await cancelProspectingOutbound(db, message.id); throw error; }
  // Recheck after persisting intent, so a cancelled/rescheduled queue cannot send.
  if (!await ownsAgentReplyClaim(db, message.workspaceId, claim)) {
    await cancelProspectingOutbound(db, message.id);
    throw new Error("Agent reply queue ownership changed before delivery.");
  }
  let sent;
  try { sent = await send(); }
  catch (error) { await confirmProspectingOutbound(db, message.id, null).catch(() => undefined); throw error; }
  return confirmProspectingOutbound(db, message.id, sent?.providerMessageId);
}

/** Adopt an explicitly reserved automatic delivery into the same durable boundary. */
export async function adoptProspectingOutbound(db: unknown, input: {
  workspaceId: string; conversationId: string; messageId: string; agentId: string; generation: string;
  body: string; type: "text" | "image" | "file"; mediaUrl?: string | null; metadata?: Record<string, unknown>;
}) {
  const store = db as Store;
  if (!await autonomousAgentAllowed(store, { ...input, expectedGeneration: input.generation })) throw new Error("Prospecting authorization changed before delivery.");
  const message = await store.message.findFirstOrThrow({ where: { id: input.messageId, workspaceId: input.workspaceId,
    conversationId: input.conversationId, direction: "outbound", status: "pending", providerMessageId: null } });
  const metadata = asRecord(message.metadata);
  if (["sending", "uncertain", "confirmed"].includes(String(metadata.prospectingDispatch))) throw new Error("Reserved delivery may already have been dispatched; automatic retry is disabled.");
  return store.message.update({ where: { id: message.id }, data: { body: input.body, type: input.type, mediaUrl: input.mediaUrl,
    metadata: { ...metadata, ...input.metadata, source: "ai_agent",
    agentId: input.agentId, prospectingGeneration: input.generation, prospectingDispatch: "prepared" } as Prisma.InputJsonObject } });
}
