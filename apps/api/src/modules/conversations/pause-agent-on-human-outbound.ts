import type { Prisma } from "@prisma/client";

type HumanOutboundDb = Pick<
  Prisma.TransactionClient,
  "conversation" | "aiAgentSession" | "aiAgentPendingReply"
>;

/** Stop autonomous work as soon as a human outbound message is accepted. */
export async function pauseAgentOnHumanOutbound(
  db: HumanOutboundDb,
  input: {
    workspaceId: string;
    conversationId: string;
    actorUserId?: string | null;
  }
) {
  const where = {
    workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId }
  };
  const conversation = await db.conversation.findUnique({
    where,
    select: { activeAgentSessionId: true }
  });
  if (!conversation) return false;

  const updated = await db.conversation.updateMany({
    where: {
      workspaceId: input.workspaceId,
      id: input.conversationId
    },
    data: {
      aiControlStatus: "human_controlled",
      aiControlUpdatedAt: new Date(),
      aiControlUpdatedById: input.actorUserId ?? null
    }
  });
  if (!updated.count) return false;

  if (conversation.activeAgentSessionId) {
    await db.aiAgentSession.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: conversation.activeAgentSessionId,
        status: "active"
      },
      data: { status: "paused_by_human" }
    });
  }

  await db.aiAgentPendingReply.updateMany({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      status: { in: ["pending", "processing"] }
    },
    data: { status: "cancelled", lockedAt: null, lastError: "human_outbound" }
  });
  return true;
}
