import type { Prisma, PrismaClient } from "@prisma/client";
type Store = PrismaClient | Prisma.TransactionClient;

/** All bound-conversation mutations lock conversation before reservation,
 * session, reply queue and delivery rows. No network work holds this lock. */
export async function lockProspectingConversation(db: unknown, workspaceId: string, conversationId: string) {
  const store = db as Store;
  if (!store.campaignProspectingReservation || typeof store.$queryRaw !== "function") return;
  await store.$queryRaw`SELECT id FROM conversations WHERE workspace_id = ${workspaceId} AND id = ${conversationId}::uuid FOR UPDATE`;
}
export async function lockProspectingConversations(db: unknown, targets: Array<{ workspaceId: string; conversationId: string }>) {
  const ordered = [...new Map(targets.map(target => [`${target.workspaceId}:${target.conversationId}`, target])).values()]
    .sort((a,b) => a.workspaceId.localeCompare(b.workspaceId) || a.conversationId.localeCompare(b.conversationId));
  for (const target of ordered) await lockProspectingConversation(db, target.workspaceId, target.conversationId);
}
