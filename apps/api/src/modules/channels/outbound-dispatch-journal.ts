import type { PrismaClient } from '@prisma/client';

/** Persistent record of every send routed through the outbound router. It exists for two things: knowing which
 * physical connection carried a message, and never losing track of a send whose outcome is uncertain. */

export type DispatchKind = 'text' | 'media' | 'audio' | 'contact' | 'template';
export type AttemptOutcome = 'accepted' | 'not_delivered' | 'uncertain';
export interface DispatchAttempt { connectionId: string; provider: string; outcome: AttemptOutcome; code: string | null; at: string }

type Db = Pick<PrismaClient, 'outboundDispatch' | '$executeRaw'>;

export function createOutboundDispatchJournal(db: Db, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const preview = (text: string | null | undefined) => text ? text.replace(/\s+/g, ' ').trim().slice(0, 120) || null : null;

  return {
    async begin(input: { workspaceId: string; channelId: string; kind: DispatchKind; destination: string; text?: string | null }) {
      const row = await db.outboundDispatch.create({ data: { workspaceId: input.workspaceId, channelId: input.channelId, kind: input.kind,
        destination: input.destination.slice(0, 120), preview: preview(input.text) }, select: { id: true } });
      return row.id;
    },
    async recordAttempt(id: string, attempt: Omit<DispatchAttempt, 'at'>) {
      const entry = JSON.stringify([{ ...attempt, at: now().toISOString() }]);
      await db.$executeRaw`UPDATE outbound_dispatches SET attempts = attempts || ${entry}::jsonb, connection_id = ${attempt.connectionId}::uuid, updated_at = ${now()} WHERE id = ${id}::uuid`;
    },
    async accept(id: string, input: { connectionId: string; providerMessageId: string | null }) {
      await db.outboundDispatch.updateMany({ where: { id, state: 'sending' }, data: { state: 'accepted', connectionId: input.connectionId, providerMessageId: input.providerMessageId, errorCode: null, updatedAt: now() } });
    },
    async fail(id: string, errorCode: string) {
      await db.outboundDispatch.updateMany({ where: { id, state: 'sending' }, data: { state: 'failed', errorCode, updatedAt: now() } });
    },
    async markUncertain(id: string, errorCode: string) {
      await db.outboundDispatch.updateMany({ where: { id, state: 'sending' }, data: { state: 'uncertain', errorCode, updatedAt: now() } });
    },
    /** Sends still `sending` after the process that owned them is gone cannot be assumed delivered or not. */
    async sweepStale(olderThanMs = 5 * 60_000) {
      const result = await db.outboundDispatch.updateMany({ where: { state: 'sending', updatedAt: { lt: new Date(now().getTime() - olderThanMs) } },
        data: { state: 'uncertain', errorCode: 'PROCESS_INTERRUPTED', updatedAt: now() } });
      return result.count;
    },
    listForReview(input: { workspaceId: string; channelId?: string; limit?: number }) {
      return db.outboundDispatch.findMany({ where: { workspaceId: input.workspaceId, ...(input.channelId ? { channelId: input.channelId } : {}), state: 'uncertain' },
        orderBy: { createdAt: 'desc' }, take: Math.min(input.limit ?? 50, 200) });
    },
    /** An operator checked WhatsApp and says whether the message reached the customer. Only uncertain sends. */
    async resolve(input: { workspaceId: string; id: string; delivered: boolean; by: string }) {
      const result = await db.outboundDispatch.updateMany({ where: { id: input.id, workspaceId: input.workspaceId, state: 'uncertain' },
        data: { state: input.delivered ? 'resolved_delivered' : 'resolved_not_delivered', resolvedAt: now(), resolvedBy: input.by.slice(0, 120), updatedAt: now() } });
      return result.count === 1;
    }
  };
}
export type OutboundDispatchJournal = ReturnType<typeof createOutboundDispatchJournal>;
