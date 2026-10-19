import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Read-only health summary of the Evolution+WAHA integration for one workspace, for the staged rollout: an operator
 * pastes it to whoever is analysing. Counts, states, reasons and timings only: no message text, no full phone numbers.
 */
const num = (value: unknown) => typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : value === null || value === undefined ? null : Number(value);
const rows = <T extends Record<string, unknown>>(list: T[]) => list.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v])));
const masked = (phone: string | null) => phone ? `…${phone.slice(-4)}` : null;

export async function rolloutDiagnostics(db: PrismaClient, input: { workspaceId: string; hours?: number; now?: Date }) {
  const hours = Math.min(Math.max(input.hours ?? 24, 1), 24 * 14);
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - hours * 3_600_000);
  const ws = input.workspaceId;
  const channels = await db.channel.findMany({ where: { workspaceId: ws, provider: 'evolution' }, select: { id: true, displayName: true, redundancyEnabled: true, activeConnectionId: true, historyImportStatus: true } });
  const connections = await db.channelConnection.findMany({ where: { workspaceId: ws }, select: {
    channelId: true, id: true, provider: true, status: true, health: true, eligible: true, verifiedPhoneNumber: true,
    lastHealthyAt: true, lastError: true, lifecycleGeneration: true, recoveredThroughAt: true, historyImportedAt: true,
    historyRecoveryFailures: true, historyRecoveryLeaseUntil: true, historyRecoveryNextAttemptAt: true
  } }); // Never select the cursor payload, session name or credentials for diagnostics.
  const [receipts, progress, recertifications, backlog, latency, effects, failedEffects, dispatches, review, resolutions, held, modes, publishAttempts] = await Promise.all([
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT source->>'provider' AS provider, count(*) AS receipts FROM ingress_receipts WHERE workspace_id=${ws} AND created_at >= ${since} GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT p.state, coalesce(p.reason,'') AS reason, count(*) AS events FROM ingress_event_progress p JOIN ingress_receipts r ON r.id=p.receipt_id WHERE p.workspace_id=${ws} AND r.created_at >= ${since} GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT outcome, coalesce(reason,'') AS reason, count(*) AS events FROM ingress_event_recertifications WHERE workspace_id=${ws} AND certified_at >= ${since} GROUP BY 1,2 ORDER BY 3 DESC`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT d.state, count(*) AS deliveries, extract(epoch from (now() - min(r.created_at))) AS oldest_seconds FROM ingress_deliveries d JOIN ingress_receipts r ON r.id=d.receipt_id LEFT JOIN ingress_applications a ON a.receipt_id=d.receipt_id WHERE d.workspace_id=${ws} AND (a.receipt_id IS NULL OR d.state='dead_letter') GROUP BY 1`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT count(*) AS events,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (a.applied_at - r.created_at))) * 1000)::numeric) AS p50_ms,
        round((percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch from (a.applied_at - r.created_at))) * 1000)::numeric) AS p95_ms,
        round((max(extract(epoch from (a.applied_at - r.created_at))) * 1000)::numeric) AS max_ms
      FROM ingress_applications a JOIN ingress_receipts r ON r.id=a.receipt_id WHERE a.workspace_id=${ws} AND a.state='applied' AND r.created_at >= ${since}`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT kind, state, count(*) AS effects FROM ingress_effects WHERE workspace_id=${ws} AND created_at >= ${since} GROUP BY 1,2 ORDER BY 1,2`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT kind, coalesce(last_error_code,'') AS error, count(*) AS effects FROM ingress_effects WHERE workspace_id=${ws} AND created_at >= ${since} AND state IN ('failed','pending','running') AND created_at < now() - interval '2 minutes' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT d.state, coalesce(c.provider::text,'') AS connection, count(*) AS sends FROM outbound_dispatches d LEFT JOIN channel_connections c ON c.id=d.connection_id WHERE d.workspace_id=${ws} AND d.created_at >= ${since} GROUP BY 1,2 ORDER BY 1,2`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT count(*) AS chats FROM canonical_chats WHERE workspace_id=${ws} AND state='review'`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT CASE WHEN resolved_by LIKE 'system:%' THEN 'automatic' ELSE 'manual' END AS kind, count(*) AS chats FROM canonical_chat_authority_resolutions WHERE workspace_id=${ws} GROUP BY 1`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT kind, coalesce(reason,'') AS reason, count(*) AS observations FROM canonical_observations WHERE workspace_id=${ws} AND state='held' AND received_at >= ${since} GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT initial_mode AS mode, count(*) AS messages FROM canonical_message_identities i JOIN messages m ON m.id=i.message_id WHERE i.workspace_id=${ws} AND m.ingested_at >= ${since} GROUP BY 1`,
    db.$queryRaw<Array<Record<string, unknown>>>`SELECT outcome, destination, count(*) AS attempts FROM ingress_publish_attempts WHERE workspace_id=${ws} AND created_at >= ${since} GROUP BY 1,2 ORDER BY 1,2`
  ]);
  return {
    workspaceId: ws, generatedAt: now.toISOString(), windowHours: hours,
    channels: channels.map(channel => ({ id: channel.id, name: channel.displayName, redundancyEnabled: channel.redundancyEnabled, historyImport: channel.historyImportStatus,
      connections: connections.filter(c => c.channelId === channel.id).map(c => ({ provider: c.provider, status: c.status, health: c.health, eligible: c.eligible,
        number: masked(c.verifiedPhoneNumber), writing: c.id === channel.activeConnectionId, lastHealthyAt: c.lastHealthyAt?.toISOString() ?? null, lastError: c.lastError,
        lifecycleInProgress: c.lifecycleGeneration % 2 === 1, recoveredThroughAt: c.recoveredThroughAt?.toISOString() ?? null, historyImportedAt: c.historyImportedAt?.toISOString() ?? null,
        recovery: { evidence: 'persisted_metadata', coverageLagSeconds: c.recoveredThroughAt ? Math.max(0, Math.floor((now.getTime() - c.recoveredThroughAt.getTime()) / 1000)) : null,
          consecutiveFailures: c.historyRecoveryFailures, leaseUntil: c.historyRecoveryLeaseUntil?.toISOString() ?? null,
          leaseActive: !!c.historyRecoveryLeaseUntil && c.historyRecoveryLeaseUntil > now,
          nextAttemptAt: c.historyRecoveryNextAttemptAt?.toISOString() ?? null,
          backoffSeconds: c.historyRecoveryNextAttemptAt ? Math.max(0, Math.ceil((c.historyRecoveryNextAttemptAt.getTime() - now.getTime()) / 1000)) : 0 } })) })),
    ingress: { evidence: 'persisted_sql_state_and_windowed_attempts', brokerDeadReferences: 'unobserved', historicalPublishAttempts: rows(publishAttempts), receipts: rows(receipts), events: rows(progress), recertifications: rows(recertifications), notYetApplied: rows(backlog), acceptToAppliedMs: { ...(rows(latency)[0] ?? {}), unit: 'finalized_receipts', clock: 'application.appliedAt_minus_receipt.createdAt' } },
    effects: { byKind: rows(effects), stuckOrFailed: rows(failedEffects) },
    outbound: rows(dispatches),
    conversations: { duplicateChatsWaitingForDecision: num(review[0]?.chats) ?? 0, decisions: rows(resolutions), heldObservationsByKind: rows(held), heldMessages: rows(held).filter(row => row.kind === 'message') },
    messagesByOrigin: rows(modes)
  };
}
export type RolloutDiagnostics = Awaited<ReturnType<typeof rolloutDiagnostics>>;
void Prisma;
