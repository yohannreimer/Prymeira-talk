import type { PrismaClient } from '@prisma/client';
import { shouldReturnToPrimary, writerCandidates, type RoutableChannel, type RoutableConnection } from './outbound-routing.js';

/** Keeps a redundant channel honest every 15 seconds:
 *  1. probes both physical connections (the connection service applies the 3-consecutive-failures rule);
 *  2. detects a connection that is "connected" but no longer receives: three live messages that the other
 *     connection saw and this one did not, within two minutes (and older than a 10 s grace), mark it degraded;
 *     silence alone, or a merely delayed queue, is never evidence;
 *  3. moves the writer to the other connection when the active one cannot write (or stopped receiving), and
 *     returns to Evolution only after ten stable minutes with real, agreeing events from both connections.
 * Idempotent and fenced: the writer change only applies if nobody changed it in the meantime. */

type Db = Pick<PrismaClient, 'channel' | 'channelConnection' | '$queryRaw'>;
export type WriterChange = { workspaceId: string; channelId: string; from: string | null; to: string; reason: 'writer_unavailable' | 'receive_loss' | 'primary_recovered' };

export function createChannelHealthMonitor(options: {
  db: Db;
  /** `refresh` of the channel connections service: one probe of one connection. */
  probe: (scope: { workspaceId: string; channelId: string; connectionId: string }) => Promise<unknown>;
  intervalMs?: number;
  stableMs?: number;
  lossThreshold?: number;
  lossWindowMs?: number;
  graceMs?: number;
  agreementWindowMs?: number;
  now?: () => Date;
  onWriterChange?: (change: WriterChange) => void | Promise<void>;
  logger?: { warn(fields: Record<string, unknown>, message: string): void; info?(fields: Record<string, unknown>, message: string): void };
}) {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 15_000;
  const stableMs = options.stableMs ?? 10 * 60_000;
  const lossThreshold = options.lossThreshold ?? 3;
  const lossWindowMs = options.lossWindowMs ?? 2 * 60_000;
  const graceMs = options.graceMs ?? 10_000;
  const agreementWindowMs = options.agreementWindowMs ?? 10 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  /** When each connection's current unbroken healthy period began. In memory on purpose: a restart restarts the
   * ten-minute proof, which can only delay a return to the primary, never hasten it. */
  const healthySince = new Map<string, Date>();

  /** Timestamps of these tables are stored as naive UTC (that is how Prisma writes them), so every parameter is
   * converted explicitly instead of trusting the session time zone.
   * For each connection: live messages (older than the grace, inside the window) that another connection saw
   * and this one did not. A connection that joined after the window started is not judged on it. */
  async function missedMessages(channel: { workspaceId: string; id: string }) {
    const to = new Date(now().getTime() - graceMs), from = new Date(now().getTime() - lossWindowMs);
    const rows = await db.$queryRaw<Array<{ connection_id: string; missed: number }>>`
      WITH seen AS (
        SELECT identity_id, array_agg(DISTINCT connection_id) AS conns
        FROM canonical_observations
        WHERE workspace_id = ${channel.workspaceId} AND channel_id = ${channel.id}::uuid AND kind = 'message' AND mode = 'live'
          AND identity_id IS NOT NULL AND connection_id IS NOT NULL
          AND received_at >= (${from}::timestamptz AT TIME ZONE 'UTC') AND received_at <= (${to}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY identity_id)
      SELECT c.id AS connection_id, count(*)::int AS missed
      FROM channel_connections c JOIN seen s ON NOT (c.id = ANY(s.conns))
      WHERE c.workspace_id = ${channel.workspaceId} AND c.channel_id = ${channel.id}::uuid AND c.status = 'connected'
        AND c.connected_at IS NOT NULL AND c.connected_at <= (${from}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY c.id`;
    return new Map(rows.map(row => [row.connection_id, row.missed]));
  }

  /** Real events seen by both connections recently: the evidence that returning to the primary is safe. */
  async function agreeingMessages(channel: { workspaceId: string; id: string }) {
    const from = new Date(now().getTime() - agreementWindowMs);
    const rows = await db.$queryRaw<Array<{ agreed: number }>>`
      SELECT count(*)::int AS agreed FROM (
        SELECT identity_id FROM canonical_observations
        WHERE workspace_id = ${channel.workspaceId} AND channel_id = ${channel.id}::uuid AND kind = 'message' AND mode = 'live'
          AND identity_id IS NOT NULL AND connection_id IS NOT NULL AND received_at >= (${from}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY identity_id HAVING count(DISTINCT connection_id) >= 2) t`;
    return rows[0]?.agreed ?? 0;
  }

  async function load(channel: { workspaceId: string; id: string }) {
    const record = await db.channel.findFirst({ where: { workspaceId: channel.workspaceId, id: channel.id }, select: { id: true, workspaceId: true, redundancyEnabled: true, activeConnectionId: true } });
    if (!record) return null;
    const rows = await db.channelConnection.findMany({ where: { workspaceId: channel.workspaceId, channelId: channel.id } });
    const connections: Array<RoutableConnection & { lastError: string | null }> = rows.map(row => ({ id: row.id, provider: row.provider, status: row.status, health: row.health, eligible: row.eligible,
      verifiedPhoneNumber: row.verifiedPhoneNumber, lastHealthyAt: row.lastHealthyAt, lastError: row.lastError }));
    return { ...record, connections } satisfies RoutableChannel & { id: string; workspaceId: string };
  }

  async function changeWriter(channel: { workspaceId: string; id: string; activeConnectionId: string | null }, to: string, reason: WriterChange['reason']) {
    const changed = await db.channel.updateMany({ where: { workspaceId: channel.workspaceId, id: channel.id, redundancyEnabled: true, activeConnectionId: channel.activeConnectionId }, data: { activeConnectionId: to } });
    if (changed.count !== 1) return false;
    options.logger?.info?.({ channelId: channel.id, from: channel.activeConnectionId, to, reason }, 'Channel writer changed');
    try { await options.onWriterChange?.({ workspaceId: channel.workspaceId, channelId: channel.id, from: channel.activeConnectionId, to, reason }); }
    catch (error) { options.logger?.warn({ err: error }, 'Writer change listener failed'); }
    return true;
  }

  async function evaluate(channelRef: { workspaceId: string; id: string }) {
    const first = await load(channelRef);
    if (!first || !first.redundancyEnabled) return { changed: false };
    const missed = await missedMessages(channelRef);
    for (const connection of first.connections) {
      if ((missed.get(connection.id) ?? 0) >= lossThreshold && connection.status === 'connected' && connection.health !== 'unhealthy') {
        await db.channelConnection.updateMany({ where: { workspaceId: channelRef.workspaceId, id: connection.id, status: 'connected', health: { in: ['healthy', 'unknown', 'degraded'] } },
          data: { health: 'degraded', lastError: 'RECEIVE_LOSS' } });
      }
    }
    const channel = await load(channelRef);
    if (!channel) return { changed: false };
    for (const connection of channel.connections) {
      if (connection.status === 'connected' && connection.health === 'healthy') { if (!healthySince.has(connection.id)) healthySince.set(connection.id, now()); }
      else healthySince.delete(connection.id);
    }
    const active = channel.connections.find(connection => connection.id === channel.activeConnectionId) ?? null;
    const candidates = writerCandidates(channel);
    const activeUsable = !!active && candidates.some(candidate => candidate.id === active.id);
    const activeNotReceiving = active?.lastError === 'RECEIVE_LOSS' && active.health === 'degraded';
    const alternative = candidates.find(candidate => candidate.id !== active?.id && (candidate as { health: string }).health === 'healthy') ?? candidates.find(candidate => candidate.id !== active?.id);

    if (!activeUsable && candidates[0]) return { changed: await changeWriter(channel, candidates[0].id, 'writer_unavailable') };
    if (activeNotReceiving && alternative) return { changed: await changeWriter(channel, alternative.id, 'receive_loss') };
    const primary = channel.connections.find(connection => connection.provider === 'evolution');
    if (primary && active && active.id !== primary.id && candidates.some(candidate => candidate.id === primary.id)) {
      const agrees = (await agreeingMessages(channelRef)) >= 1 && (missed.get(primary.id) ?? 0) === 0;
      if (shouldReturnToPrimary({ primary, healthySince: healthySince.get(primary.id) ?? null, now: now(), stableMs, eventsAgree: agrees, activeConnectionId: channel.activeConnectionId })) {
        return { changed: await changeWriter(channel, primary.id, 'primary_recovered') };
      }
    }
    return { changed: false };
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const channels = await db.channel.findMany({ where: { provider: 'evolution', redundancyEnabled: true }, select: { id: true, workspaceId: true } });
      for (const channel of channels) {
        try {
          const connections = await db.channelConnection.findMany({ where: { workspaceId: channel.workspaceId, channelId: channel.id }, select: { id: true } });
          for (const connection of connections) {
            await options.probe({ workspaceId: channel.workspaceId, channelId: channel.id, connectionId: connection.id }).catch((error: unknown) => {
              options.logger?.warn({ err: error, channelId: channel.id, connectionId: connection.id }, 'Connection probe failed');
            });
          }
          await evaluate(channel);
        } catch (error) { options.logger?.warn({ err: error, channelId: channel.id }, 'Channel health evaluation failed'); }
      }
    } finally { running = false; }
  }

  return {
    tick, evaluate,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); } },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}
export type ChannelHealthMonitor = ReturnType<typeof createChannelHealthMonitor>;
