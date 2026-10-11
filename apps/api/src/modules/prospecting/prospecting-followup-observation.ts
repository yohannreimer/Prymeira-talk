import type { Prisma, PrismaClient } from "@prisma/client";
import type { ConversationFollowupsObserver } from "../followups/conversation-followups.service.js";
import { asRecord } from "./prospecting-policy.js";
type Store = PrismaClient | Prisma.TransactionClient;

/** The confirmed message is a durable observation outbox. Observation never sends
 * a message; a restart can restore scheduling even after its reply queue completed. */
export async function markProspectingFollowupObserved(db: unknown, messageId: string) {
  const store = db as Store;
  if (!store.campaignProspectingReservation) return;
  const mark = async (tx: Store) => {
    await tx.$queryRaw`SELECT id FROM messages WHERE id = ${messageId}::uuid FOR UPDATE`;
    const message = await tx.message.findUnique({ where: { id: messageId } });
    if (!message || asRecord(message.metadata).prospectingFollowupObservation !== "pending") return;
    await tx.message.update({ where: { id: messageId }, data: { metadata: {
      ...asRecord(message.metadata), prospectingFollowupObservation: "observed" } as Prisma.InputJsonObject } });
  };
  if ("$transaction" in store) await store.$transaction(mark); else await mark(store);
}

export async function replayProspectingFollowupObservations(db: unknown, observer: ConversationFollowupsObserver | undefined, batchSize: number) {
  const store = db as Store;
  if (!observer || !store.campaignProspectingReservation) return;
  const pending = await store.message.findMany({ where: { direction: "outbound", status: "sent", AND: [
    { metadata: { path: ["source"], equals: "ai_agent" } },
    { metadata: { path: ["prospectingDispatch"], equals: "confirmed" } },
    { metadata: { path: ["prospectingFollowupObservation"], equals: "pending" } }
  ] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: batchSize });
  for (const message of pending) {
    try {
      await observer.observeConversationActivity({ workspaceId: message.workspaceId, conversationId: message.conversationId,
        messageId: message.id, direction: "outbound", source: "agent" });
      await markProspectingFollowupObserved(store, message.id);
    } catch { /* Leave the durable outbox pending for the next scheduler poll. */ }
  }
}
