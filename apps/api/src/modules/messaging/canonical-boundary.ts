import type { Prisma, PrismaClient } from '@prisma/client';
import type { TrustedMessagingContext } from './normalized-event.js';
import { assertCurrentMessagingSource } from './canonical-source.js';

/** Lock order: workspace advisory FIRST, Channel row, physical connection/config,
 * then caller domain/conversation locks. Enter before any domain reads or writes.
 * READ COMMITTED is essential: a waiter must see lifecycle commits made while it
 * waited. Channel→connection also coordinates existing lifecycle transactions,
 * which do not yet acquire our advisory lock. Physical events compare only their
 * own generation (odd=I/O, even=idle), never the other provider's channel token.
 * No network I/O or history batches belong inside this transaction. */
/** Acquire before ANY domain read, permission callback or reference lookup,
 * including readers that do not know their trusted provider source yet. */
export async function enterCanonicalWorkspaceTransaction(tx: Prisma.TransactionClient, workspaceId: string) {
  const isolation = await tx.$queryRaw<Array<{ isolation: string }>>`SELECT current_setting('transaction_isolation') AS isolation`;
  if (isolation[0]?.isolation !== 'read committed') throw new Error('Canonical boundary requires READ COMMITTED');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`canonical-messaging:${workspaceId}`}, 0))`;
}
export async function enterCanonicalTransaction(tx: Prisma.TransactionClient, source: TrustedMessagingContext) {
  await enterCanonicalWorkspaceTransaction(tx, source.workspaceId);
  await tx.$queryRaw`SELECT id FROM channels WHERE workspace_id=${source.workspaceId} AND id=${source.channelId}::uuid FOR UPDATE`;
  if (source.connectionId !== null) {
    await tx.$queryRaw`SELECT id FROM channel_connections WHERE workspace_id=${source.workspaceId} AND channel_id=${source.channelId}::uuid AND id=${source.connectionId}::uuid FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT id FROM integration_configs WHERE workspace_id=${source.workspaceId} AND provider='meta_cloud' FOR SHARE`;
  }
  return assertCurrentMessagingSource(tx, source);
}
export function canonicalTransaction<T>(db: PrismaClient, source: TrustedMessagingContext, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => { await enterCanonicalTransaction(tx, source); return work(tx); }, { isolationLevel: 'ReadCommitted' });
}
