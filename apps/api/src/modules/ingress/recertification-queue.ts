import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

export const IDENTITY_HOLDS = ['contradictory_sender_declarations', 'contradictory_chat_declarations', 'contradictory_direction_declarations', 'contradictory_stanza_declarations'];
const storeHolds = ['legacy_identity_requires_adoption', 'target_missing'];
export type RecertificationCandidate = { workspaceId: string; channelId: string; receiptId: string; eventIndex: number };

/** Due filters are in SQL, before LIMIT. New events precede previous attempts; a deferred old head cannot hide them. */
export async function selectRecertificationCandidates(db: PrismaClient, workspaceIds: readonly string[] | undefined, limit: number, now = new Date()) {
  const scope = workspaceIds ? (workspaceIds.length ? Prisma.sql`AND p.workspace_id IN (${Prisma.join([...workspaceIds])})` : Prisma.sql`AND false`) : Prisma.empty;
  const selectQueue = (authority: boolean) => db.$queryRaw<RecertificationCandidate[]>(Prisma.sql`
    SELECT p.workspace_id AS "workspaceId", p.channel_id AS "channelId", p.receipt_id AS "receiptId", p.event_index AS "eventIndex"
    FROM ingress_event_progress p
    JOIN channels h ON h.id = p.channel_id AND h.workspace_id = p.workspace_id AND h.archived_at IS NULL
    LEFT JOIN ingress_recertification_retries t ON t.receipt_id = p.receipt_id AND t.event_index = p.event_index
    LEFT JOIN ingress_event_recertifications c ON c.receipt_id = p.receipt_id AND c.event_index = p.event_index
    LEFT JOIN canonical_observations o ON o.id = p.observation_id AND o.workspace_id = p.workspace_id AND o.channel_id = p.channel_id
    WHERE c.receipt_id IS NULL AND (t.receipt_id IS NULL OR t.next_attempt_at <= ${now})
      AND (o.id IS NULL OR o.state <> 'resolved') ${scope}
      AND ${authority ? Prisma.sql`p.state = 'held' AND p.reason = 'waha_identity_unverified'` : Prisma.sql`(
        (p.state = 'pending_recertification' AND p.reason IN ('stale_source', 'waha_pairing_changed'))
        OR (p.state = 'held' AND p.reason IN (${Prisma.join([...IDENTITY_HOLDS, ...storeHolds])})))`}
    ORDER BY t.next_attempt_at ASC NULLS FIRST, p.committed_at ASC, p.receipt_id ASC, p.event_index ASC LIMIT ${limit}`);
  const [main, authority] = await Promise.all([selectQueue(false), selectQueue(true)]);
  const rows: RecertificationCandidate[] = [];
  for (let index = 0; index < Math.max(main.length, authority.length); index++) {
    if (authority[index]) rows.push(authority[index]!);
    if (main[index]) rows.push(main[index]!);
  }
  return rows;
}

/** Claim immediately before work. ON CONFLICT is atomic across processes and restarts. */
export async function claimRecertification(db: PrismaClient, row: RecertificationCandidate, now = new Date()) {
  const token = randomUUID(), until = new Date(now.getTime() + 120_000);
  const claims = await db.$queryRaw<Array<{ attempts: number }>>`
    INSERT INTO ingress_recertification_retries (workspace_id, channel_id, receipt_id, event_index, next_attempt_at, lease_token, attempts, updated_at)
    VALUES (${row.workspaceId}, ${row.channelId}::uuid, ${row.receiptId}::uuid, ${row.eventIndex}, ${until}, ${token}::uuid, 1, ${now})
    ON CONFLICT (receipt_id, event_index) DO UPDATE SET next_attempt_at = ${until}, lease_token = ${token}::uuid,
      attempts = ingress_recertification_retries.attempts + 1, updated_at = ${now}
    WHERE ingress_recertification_retries.next_attempt_at <= ${now}
      AND ingress_recertification_retries.workspace_id = ${row.workspaceId}
      AND ingress_recertification_retries.channel_id = ${row.channelId}::uuid
    RETURNING attempts`;
  return claims[0] ? { token, attempts: claims[0].attempts } : null;
}

export function recertificationBackoff(state: string, attempts: number) {
  // A source that is pairing is transient; contradictions/error retries grow without permanently discarding the fact.
  if (state === 'still_stale') return 10 * 60_000;
  if (state === 'still_invalid' || state === 'error') return [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000][Math.min(3, Math.max(0, attempts - 1))]!;
  // Terminal/non-pending facts must not become a hot loop if their disposition has no recertification row.
  return 24 * 60 * 60_000;
}

export async function finishRecertification(db: PrismaClient, row: RecertificationCandidate, claim: { token: string; attempts: number }, state: string, now = new Date()) {
  return db.ingressRecertificationRetry.updateMany({ where: { workspaceId: row.workspaceId, channelId: row.channelId, receiptId: row.receiptId, eventIndex: row.eventIndex, leaseToken: claim.token },
    data: { leaseToken: null, lastOutcome: state, nextAttemptAt: new Date(now.getTime() + recertificationBackoff(state, claim.attempts)), updatedAt: now } });
}
