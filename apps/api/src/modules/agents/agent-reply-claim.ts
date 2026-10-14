import { lockProspectingConversation } from "../prospecting/prospecting-lock.js";
import type { PrismaClient, Prisma } from "@prisma/client";

import { asRecord } from "../prospecting/prospecting-policy.js";

export type AgentReplyClaim = { id: string; token: string };
export const AGENT_REPLY_LEASE_MS = 5 * 60_000;

/** A reschedule/cancellation replaces queue ownership even while a model is running. */
export async function ownsAgentReplyClaim(db: unknown, workspaceId: string, claim?: AgentReplyClaim) {
  if (!claim) return true;
  const store = db as PrismaClient | Prisma.TransactionClient;
  return !!await store.aiAgentPendingReply.findFirst({ where: { workspaceId, id: claim.id,
    status: "processing", claimToken: claim.token, lockedAt: { gt: new Date(Date.now() - AGENT_REPLY_LEASE_MS) } } });
}

export async function recoverStaleAgentReplyClaim(db: unknown, input: {
  id: string; workspaceId: string; conversationId: string; prospectingGeneration?: string | null;
  claimToken?: string | null; lockedAt?: Date | null;
}, now: Date) {
  const store = db as PrismaClient | Prisma.TransactionClient;
  const recover = async (tx: Prisma.TransactionClient) => {
    await lockProspectingConversation(tx, input.workspaceId, input.conversationId);
    await tx.$queryRaw`SELECT id FROM ai_agent_pending_replies WHERE id = ${input.id}::uuid FOR UPDATE`;
    const reply = await tx.aiAgentPendingReply.findUnique({ where: { id: input.id } });
    if (!reply || reply.workspaceId !== input.workspaceId || reply.status !== "processing" ||
        reply.claimToken !== (input.claimToken ?? null) || !reply.lockedAt || reply.lockedAt.getTime() > now.getTime() - AGENT_REPLY_LEASE_MS) return;
    const deliveries = reply.prospectingGeneration ? await tx.message.findMany({ where: {
      workspaceId: reply.workspaceId, conversationId: reply.conversationId, direction: "outbound",
      AND: [{ metadata: { path: ["source"], equals: "ai_agent" } },
        { metadata: { path: ["prospectingGeneration"], equals: reply.prospectingGeneration } },
        reply.claimToken ? { metadata: { path: ["replyClaimToken"], equals: reply.claimToken } }
          : { createdAt: { gte: reply.lockedAt } }] } }) : null;
    const dispatched = deliveries?.filter(row => ["sending", "uncertain", "confirmed"].includes(String(asRecord(row.metadata).prospectingDispatch))) ?? [];
    const uncertain = dispatched.some(row => asRecord(row.metadata).prospectingDispatch !== "confirmed");
    const status = deliveries === null || uncertain ? "failed" : dispatched.length ? "completed" : "pending";
    // Older confirmed claims predate the observation outbox. Restore it before
    // completing the queue so a second crash cannot lose followup observation.
    for (const delivery of dispatched) {
      const metadata = asRecord(delivery.metadata);
      if (metadata.prospectingDispatch === "confirmed" && typeof metadata.followupId !== "string" && metadata.prospectingFollowupObservation !== "observed") {
        await tx.message.update({ where: { id: delivery.id }, data: { metadata: {
          ...metadata, prospectingFollowupObservation: "pending" } as Prisma.InputJsonObject } });
      }
    }
    await tx.aiAgentPendingReply.update({ where: { id: reply.id }, data: { status, claimToken: null, lockedAt: null,
      lastError: status === "failed" ? "Delivery outcome is uncertain; automatic retry is disabled." : null } });
  };
  if ("$transaction" in store) await store.$transaction(recover);
  // Recovery needs a transactional store. Interface-only unit mocks exercise
  // normal claims and cannot authorize recovering a real delivery.
}

/** Serialize dispatch intent with crash recovery on the queue row. */
export async function withAgentReplyClaimLock<T>(db: unknown, workspaceId: string, claim: AgentReplyClaim | undefined,
  execute: (tx: PrismaClient | Prisma.TransactionClient) => Promise<T>, conversationId?: string): Promise<T> {
  const store = db as PrismaClient | Prisma.TransactionClient;
  const run = async (tx: PrismaClient | Prisma.TransactionClient) => {
    if (conversationId) await lockProspectingConversation(tx, workspaceId, conversationId);
    if (claim) {
      await tx.$queryRaw`SELECT id FROM ai_agent_pending_replies WHERE id = ${claim.id}::uuid FOR UPDATE`;
      if (!await ownsAgentReplyClaim(tx, workspaceId, claim)) throw new Error("Agent reply queue ownership changed before delivery.");
    }
    return execute(tx);
  };
  return "$transaction" in store ? store.$transaction(run) : run(store);
}
