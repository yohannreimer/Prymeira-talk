import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { normalizeWhatsappPhone } from './channel-connections.js';
import type { Prisma, PrismaClient } from '@prisma/client';

export type RecoveryWriteFence = { token: string; checkpoint: Date | null; anchor: string | null; verifiedPhoneNumber: string | null };
/** The deadline applies to pool acquisition, SQL (including row/advisory locks), and
 * the interactive transaction. Settings are LOCAL: live ingress retains its own wait policy. */
export async function recoveryTransaction<T>(db: PrismaClient, remainingMs: number, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const timeout = Math.max(1, Math.floor(remainingMs));
  if (!Number.isFinite(timeout) || remainingMs <= 0) throw new Error('HISTORY_DEADLINE');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(timeout)}, true), set_config('lock_timeout', ${String(Math.min(250, timeout))}, true)`;
    return work(tx);
  }, { isolationLevel: 'ReadCommitted', maxWait: Math.min(250, timeout), timeout });
}

/** Metadata obeys the same workspace → channel → connection lock order. The
 * captured anchor is checked even for empty/verification-only windows, where no
 * canonical message transaction would otherwise validate it. */
export function createRecoveryMetadataQuery(db: PrismaClient, connection: { workspaceId: string; channelId: string; verifiedPhoneNumber: string | null }, remaining: () => number) {
  let captured = false, anchor: string | null = null;
  const query = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => recoveryTransaction(db, Math.min(500, remaining()), async tx => {
    await enterCanonicalWorkspaceTransaction(tx, connection.workspaceId);
    const channels = await tx.$queryRaw<Array<{ anchor: string | null }>>`SELECT verified_messaging_phone_number AS anchor FROM channels WHERE workspace_id=${connection.workspaceId} AND id=${connection.channelId}::uuid FOR SHARE`;
    const current = channels[0];
    if (!current || (captured && current.anchor !== anchor)
      || (current.anchor && normalizeWhatsappPhone(current.anchor) !== normalizeWhatsappPhone(connection.verifiedPhoneNumber))) throw new Error('HISTORY_SOURCE_CHANGED');
    captured = true; anchor = current.anchor;
    return work(tx);
  });
  return { query, anchor: () => anchor };
}
