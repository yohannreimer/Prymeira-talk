import type { IngressReceipt, Prisma } from '@prisma/client';
import { json } from '../messaging/canonical-values.js';

// One event produces a small, fixed set of obligations. Never buffer a receipt
// batch, history page, workspace or transaction spanning multiple applications.
export const RECEIPT_EFFECT_BATCH_LIMIT = 32;
type Receipt = Pick<IngressReceipt, 'id' | 'workspaceId' | 'channelId' | 'ordinal' | 'source'>;
type PendingEffect = { kind: string; logicalKey: string; messageId: string | null; conversationId: string | null;
  observationId: string | null; frozen: Prisma.InputJsonValue };
export type ReceiptEffectBatch = ReturnType<typeof createReceiptEffectBatch>;

/** Caller owns the canonical transaction. Nothing runs externally here. All
 * rows flush before application returns, so domain/progress/obligations commit
 * or roll back together. Existing obligations keep their original evidence,
 * frozen input and lifecycle: ON CONFLICT performs no UPDATE. */
export function createReceiptEffectBatch(tx: Prisma.TransactionClient, receipt: Receipt, eventIndex: number) {
  const pending = new Map<string, PendingEffect>();
  let closed = false;
  return {
    add(kind: string, logicalKey: string, messageId: string | null, conversationId: string | null, observationId: string | null, frozen: unknown) {
      if (closed) throw Error('Receipt effect batch already closed');
      const key = JSON.stringify([kind, logicalKey]);
      // Equivalent to sequential upsert(update:{}): first observation wins.
      if (pending.has(key)) return;
      if (pending.size >= RECEIPT_EFFECT_BATCH_LIMIT) {
        closed = true; pending.clear();
        throw Error('Receipt effect batch limit exceeded');
      }
      pending.set(key, { kind, logicalKey, messageId, conversationId, observationId, frozen: json(frozen) });
    },
    async flush() {
      if (closed) throw Error('Receipt effect batch already closed');
      closed = true;
      try {
        if (!pending.size) return;
        const frontier = await tx.ingressFrontier.findUniqueOrThrow({
          where: { receiptId_eventIndex: { receiptId: receipt.id, eventIndex } }, select: { id: true, workspaceId: true, channelId: true }
        });
        if (frontier.workspaceId !== receipt.workspaceId || frontier.channelId !== receipt.channelId) throw Error('Receipt effect frontier scope mismatch');
        const data = [...pending.values()].map(({ observationId, ...effect }) => ({
          workspaceId: receipt.workspaceId, channelId: receipt.channelId, receiptId: receipt.id, eventIndex, ...effect,
          cause: json({ receiptId: receipt.id, eventIndex, frontierId: String(frontier.id), receiptOrdinal: String(receipt.ordinal),
            observationId, messageId: effect.messageId, source: receipt.source, origin: 'authenticated_ingress' })
        }));
        const written = await tx.ingressEffect.createMany({ data, skipDuplicates: true });
        if (written.count < data.length) {
          // Prisma skips conflicts on ANY unique constraint. Only an existing
          // full logical key may stand in for a planned obligation; another
          // conflict must roll back the event rather than silently lose work.
          const existing = await tx.ingressEffect.findMany({
            where: { workspaceId: receipt.workspaceId, channelId: receipt.channelId,
              OR: data.map(({ kind, logicalKey }) => ({ kind, logicalKey })) }, select: { kind: true, logicalKey: true }
          });
          const keys = new Set(existing.map(e => JSON.stringify([e.kind, e.logicalKey])));
          if (data.some(e => !keys.has(JSON.stringify([e.kind, e.logicalKey])))) throw Error('Incomplete receipt effect batch');
        }
      } finally { pending.clear(); }
    }
  };
}
