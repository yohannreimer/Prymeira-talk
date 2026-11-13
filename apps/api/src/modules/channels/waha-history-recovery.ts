import { randomUUID } from 'node:crypto';
import { Prisma, type ChannelConnection, type PrismaClient } from '@prisma/client';
import { recoveryCursorSchema as cursorSchema, recoveryLanes, dueRecoveryLane, nextRecoveryAttempt,
  RECENT_WINDOW_MS, RECOVERY_WINDOW_MS as WINDOW_MS, RECOVERY_OVERLAP_MS as OVERLAP_MS,
  type RecoveryLane, type RecoveryCursor } from './waha-recovery-lanes.js';
import type { WahaMessage, WahaRecoveryPage, WahaRecoveryQuery } from '../waha/waha.client.js';
import { historyDigest } from './history-memory-budget.js';

const PAGE_SIZE = 50;
const SETTLE_MS = 30_000;
const LEASE_MS = 120_000;
type Dependencies = {
  read(input: WahaRecoveryQuery): Promise<WahaRecoveryPage>;
  /** Canonical persistence is idempotent. It MUST finish before the page cursor moves. */
  persist(messages: WahaMessage[]): Promise<{ inserted: number; held: number }>;
};
export type WahaRecoveryOptions = { now?: number; maxPages?: number; maxMs?: number; clock?: () => number };
const failure = (code: string) => Object.assign(new Error(code), { code });

/** Fixed recent SQL intervals instead of full-history scans. Metadata is durable across process restarts;
 * only two identical exhausted passes can advance coverage. Every page is fenced on the physical generation,
 * original checkpoint and lease. The provider's RAW pagination metadata is essential: an empty visible page
 * can contain omitted protocol records and does NOT prove exhaustion. No provider I/O occurs in a SQL TX. */
export async function recoverWahaWindow(db: PrismaClient, connection: ChannelConnection, deps: Dependencies, options: WahaRecoveryOptions = {}) {
  const clock = options.clock ?? Date.now, started = clock(), now = options.now ?? started;
  const maxPages = options.maxPages ?? 4, maxMs = options.maxMs ?? 5_000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isFinite(maxMs) || maxMs < 1) throw failure('HISTORY_BUDGET');
  const token = randomUUID(), checkpoint = connection.recoveredThroughAt?.toISOString() ?? null;
  const identity = { id: connection.id, workspaceId: connection.workspaceId, channelId: connection.channelId,
    lifecycleGeneration: connection.lifecycleGeneration, recoveredThroughAt: connection.recoveredThroughAt, status: 'connected' as const, eligible: true };
  const usesLanes = recoveryLanes(connection, now) !== null;
  const claimed = await db.channelConnection.updateMany({ where: { ...identity, sessionName: connection.sessionName, verifiedPhoneNumber: connection.verifiedPhoneNumber, AND: [
    { OR: [{ historyRecoveryLeaseUntil: null }, { historyRecoveryLeaseUntil: { lt: new Date(started) } }] },
    ...(usesLanes ? [] : [{ OR: [{ historyRecoveryNextAttemptAt: null }, { historyRecoveryNextAttemptAt: { lte: new Date(started) } }] }])
  ] }, data: { historyRecoveryLeaseToken: token, historyRecoveryLeaseUntil: new Date(started + LEASE_MS) } });
  if (!claimed.count) return { recovered: 0, chats: 0, advanced: false, pending: true };
  const fence = () => ({ ...identity, sessionName: connection.sessionName, verifiedPhoneNumber: connection.verifiedPhoneNumber, historyRecoveryLeaseToken: token, historyRecoveryLeaseUntil: { gt: new Date(clock()) } });
  let recovered = 0;
  let lanes: ReturnType<typeof recoveryLanes> = null, active: RecoveryLane | null = null;
  const heartbeat = setInterval(() => { void db.channelConnection.updateMany({ where: fence(), data: { historyRecoveryLeaseUntil: new Date(clock() + LEASE_MS) } }).catch(() => undefined); }, LEASE_MS / 3);
  try {
    const fresh = await db.channelConnection.findUniqueOrThrow({ where: { id: connection.id } });
    lanes = recoveryLanes(fresh, now); active = lanes ? dueRecoveryLane(lanes, started) : null;
    if (lanes && !active) {
      await db.channelConnection.updateMany({ where: fence(), data: { historyRecoveryLeaseToken: null, historyRecoveryLeaseUntil: null, historyRecoveryNextAttemptAt: nextRecoveryAttempt(lanes) } });
      return { recovered, chats: 0, advanced: false, pending: true };
    }
    const recent = active === 'recent';
    const laneCheckpoint = recent ? lanes!.recentThroughAt : checkpoint;
    const maxWindow = recent ? RECENT_WINDOW_MS : WINDOW_MS;
    const parsed = cursorSchema.safeParse(lanes && active ? lanes[active].cursor : fresh.historyRecoveryCursor);
    let cursor: RecoveryCursor;
    const stateData = () => lanes ? { historyRecoveryCursor: lanes as Prisma.InputJsonValue,
      historyRecoveryNextAttemptAt: nextRecoveryAttempt(lanes), historyRecoveryFailures: lanes.recent.failures + lanes.backlog.failures } : {};
    if (parsed.success && parsed.data.generation === connection.lifecycleGeneration && parsed.data.checkpoint === laneCheckpoint
      && parsed.data.to >= parsed.data.from && parsed.data.to - parsed.data.from <= OVERLAP_MS / 1000 + maxWindow / 1000 + 1) cursor = parsed.data;
    else {
      const recentBase = lanes?.recentThroughAt ? Date.parse(lanes.recentThroughAt) : lanes?.recentFromAt;
      const base = recent ? recentBase! : connection.recoveredThroughAt?.getTime() ?? now - 15 * 60_000;
      const end = Math.floor(Math.min(now - SETTLE_MS, base + maxWindow) / 1000);
      if (end * 1000 <= base) {
        if (lanes && active) { lanes[active].cursor = null; lanes[active].nextAttemptAt = clock() + WINDOW_MS; }
        await db.channelConnection.updateMany({ where: fence(), data: { historyRecoveryCursor: Prisma.DbNull, historyRecoveryLeaseToken: null,
          historyRecoveryLeaseUntil: null, historyRecoveryNextAttemptAt: new Date(clock() + WINDOW_MS), ...stateData() } });
        return { recovered, chats: 0, advanced: false, pending: false };
      }
      cursor = { version: 1, generation: connection.lifecycleGeneration, checkpoint: laneCheckpoint,
        from: Math.max(0, Math.floor((base - OVERLAP_MS) / 1000)), to: end, offset: 0, pages: [], previousPages: null, changedPasses: 0 };
    }
    const save = async () => {
      if (lanes && active) lanes[active].cursor = cursor;
      const result = await db.channelConnection.updateMany({ where: fence(), data: {
        historyRecoveryCursor: (lanes ?? cursor) as Prisma.InputJsonValue, historyRecoveryLeaseUntil: new Date(clock() + LEASE_MS)
      } });
      if (result.count !== 1) throw failure('HISTORY_LEASE_LOST');
    };
    await save(); // Retain the fixed interval even if the first provider request fails.
    for (let requests = 0; requests < maxPages && (requests === 0 || clock() - started < maxMs); requests++) {
      const page = await deps.read({ session: connection.sessionName, from: cursor.from, to: cursor.to, offset: cursor.offset, limit: PAGE_SIZE });
      if (!/^[a-f0-9]{64}$/.test(page.rawDigest) || !Array.isArray(page.messages) || !Number.isSafeInteger(page.rawCount) || page.rawCount < 0 || page.rawCount > PAGE_SIZE
        || page.messages.length > page.rawCount || page.nextOffset !== cursor.offset + page.rawCount || page.exhausted !== (page.rawCount === 0)) throw failure('HISTORY_PAGINATION');
      const ids = new Set<string>();
      for (const message of page.messages) {
        if (typeof message.id !== 'string' || !message.id || ids.has(message.id)) throw failure('HISTORY_PAGINATION');
        ids.add(message.id);
        if (!Number.isSafeInteger(message.timestamp) || message.timestamp! < cursor.from || message.timestamp! > cursor.to) throw failure('HISTORY_FILTER_IGNORED');
      }
      if (page.exhausted) {
        if (cursor.previousPages !== null && JSON.stringify(cursor.pages) === JSON.stringify(cursor.previousPages)) {
          if (lanes && active) {
            lanes[active].cursor = null; lanes[active].failures = 0;
            lanes[active].nextAttemptAt = clock() + (cursor.to < Math.floor((now - SETTLE_MS) / 1000) ? 30_000 : WINDOW_MS);
            if (recent) lanes.recentThroughAt = new Date(cursor.to * 1000).toISOString();
          }
          const changed = await db.channelConnection.updateMany({ where: fence(), data: {
            ...(recent ? {} : { recoveredThroughAt: new Date(cursor.to * 1000) }), historyRecoveryCursor: Prisma.DbNull,
            historyRecoveryLeaseToken: null, historyRecoveryLeaseUntil: null, historyRecoveryFailures: 0,
            historyRecoveryNextAttemptAt: new Date(clock() + (cursor.to < Math.floor((now - SETTLE_MS) / 1000) ? 30_000 : WINDOW_MS)), ...stateData()
          } });
          if (changed.count !== 1) throw failure('HISTORY_LEASE_LOST');
          return { recovered, chats: 0, advanced: true, pending: false, ...(active ? { lane: active } : {}) };
        }
        if (cursor.previousPages !== null) cursor.changedPasses++;
        cursor.previousPages = cursor.pages; cursor.pages = []; cursor.offset = 0;
        await save();
        if (cursor.changedPasses >= 3) { cursor.changedPasses = 0; await save(); throw failure('HISTORY_UNSTABLE'); }
        continue;
      }
      const fingerprint = historyDigest({ rawDigest: page.rawDigest, rawCount: page.rawCount, messages: page.messages.map(m => [m.id, historyDigest(m)]) });
      if (page.messages.length && cursor.pages.at(-1) === fingerprint) {
        // A late insertion can shift an already read row onto the next page. Restart only
        // this small window; never mistake duplicate offset results for certified coverage.
        cursor.offset = 0; cursor.pages = []; cursor.previousPages = null; cursor.changedPasses++;
        await save();
        if (cursor.changedPasses >= 3) { cursor.changedPasses = 0; await save(); throw failure('HISTORY_PAGINATION'); }
        continue;
      }
      // Identical verification pages are already durably canonical. Changed pages are applied again,
      // so late insertions/deletions and offset shifts cannot certify an unpersisted new message.
      if (page.messages.length && cursor.previousPages?.[cursor.pages.length] !== fingerprint) {
        await save(); // Reject a lost/replaced source before starting canonical writes.
        const result = await deps.persist(page.messages);
        recovered += result.inserted;
        if (result.held) throw failure('HISTORY_CANONICAL_HOLD');
      }
      cursor.pages.push(fingerprint); cursor.offset = page.nextOffset;
      if (cursor.offset > 100_000 || cursor.pages.length > 2000) throw failure('HISTORY_SCAN_LIMIT');
      await save();
    }
    if (lanes && active) { lanes[active].failures = 0; lanes[active].nextAttemptAt = clock() + 30_000; }
    const released = await db.channelConnection.updateMany({ where: fence(), data: { historyRecoveryLeaseToken: null,
      historyRecoveryLeaseUntil: null, historyRecoveryFailures: 0, historyRecoveryNextAttemptAt: new Date(clock() + 30_000), ...stateData() } });
    if (released.count !== 1) throw failure('HISTORY_LEASE_LOST');
    return { recovered, chats: 0, advanced: false, pending: true };
  } catch (error) {
    const current = await db.channelConnection.findUniqueOrThrow({ where: { id: connection.id } });
    if (current.lifecycleGeneration !== connection.lifecycleGeneration || current.sessionName !== connection.sessionName
      || current.verifiedPhoneNumber !== connection.verifiedPhoneNumber || current.status !== 'connected' || !current.eligible) {
      await db.channelConnection.updateMany({ where: { id: connection.id, historyRecoveryLeaseToken: token }, data: { historyRecoveryLeaseToken: null, historyRecoveryLeaseUntil: null } });
      throw error;
    }
    const failures = lanes && active ? ++lanes[active].failures : current.historyRecoveryFailures + 1;
    const next = new Date(clock() + Math.min(60 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 6)));
    if (lanes && active) lanes[active].nextAttemptAt = next.getTime();
    await db.channelConnection.updateMany({ where: fence(), data: {
      historyRecoveryLeaseToken: null, historyRecoveryLeaseUntil: null,
      historyRecoveryFailures: lanes ? lanes.recent.failures + lanes.backlog.failures : failures,
      historyRecoveryNextAttemptAt: lanes ? nextRecoveryAttempt(lanes) : next,
      ...(lanes ? { historyRecoveryCursor: lanes as Prisma.InputJsonValue } : {})
    } });
    throw error;
  } finally { clearInterval(heartbeat); }
}
