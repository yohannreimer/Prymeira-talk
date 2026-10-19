import { randomUUID } from 'node:crypto';
import { Prisma, type ChannelConnection, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { WahaMessage, WahaRecoveryPage, WahaRecoveryQuery } from '../waha/waha.client.js';
import { createRecoveryMetadataQuery, recoveryTransaction, type RecoveryWriteFence } from './history-recovery-budget.js';
import { historyDigest, HistoryMemoryBudget } from './history-memory-budget.js';

const PAGE_SIZE = 50;
const WINDOW_MS = 5 * 60_000;
const OVERLAP_MS = 10 * 60_000;
const SETTLE_MS = 30_000;
const LEASE_MS = 120_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const cursorSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), generation: z.number().int().nonnegative(), checkpoint: z.string().datetime().nullable(),
  from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), offset: z.number().int().min(0).max(100_000),
  pages: z.array(digest).max(2000), previousPages: z.array(digest).max(2000).nullable(),
  partial: z.object({ fingerprint: digest, completed: z.number().int().min(0).max(100) }).optional(),
  changedPasses: z.number().int().nonnegative()
});
type Cursor = z.infer<typeof cursorSchema>;
type Dependencies = {
  read(input: WahaRecoveryQuery): Promise<WahaRecoveryPage>;
  /** Canonical persistence is idempotent. It MUST finish before the page cursor moves. */
  persist(messages: WahaMessage[], budget: { signal: AbortSignal; remaining: () => number; fence: RecoveryWriteFence }): Promise<{ inserted: number; held: number }>;
};
export type WahaRecoveryOptions = { now?: number; maxPages?: number; maxMs?: number; maxItems?: number; clock?: () => number; signal?: AbortSignal };
const failure = (code: string) => Object.assign(new Error(code), { code });

/** Fixed recent SQL intervals instead of full-history scans. Metadata is durable across process restarts;
 * only two identical exhausted passes can advance coverage. Every page is fenced on the physical generation,
 * original checkpoint and lease. The provider's RAW pagination metadata is essential: an empty visible page
 * can contain omitted protocol records and does NOT prove exhaustion. No provider I/O occurs in a SQL TX. */
export async function recoverWahaWindow(db: PrismaClient, connection: ChannelConnection, deps: Dependencies, options: WahaRecoveryOptions = {}) {
  const clock = options.clock ?? Date.now, started = clock(), now = options.now ?? started;
  const maxPages = options.maxPages ?? 4, maxMs = options.maxMs ?? 5_000, maxItems = options.maxItems ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isFinite(maxMs) || maxMs < 1 || maxMs > 30_000 || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 5000) throw failure('HISTORY_BUDGET');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.ceil(maxMs))]) : AbortSignal.timeout(Math.ceil(maxMs));
  signal.throwIfAborted();
  const remaining = () => Math.max(0, maxMs - (clock() - started));
  const metadata = createRecoveryMetadataQuery(db, connection, remaining), query = metadata.query;
  // At most two short cleanup transactions after the work budget. Never race SQL in the background.
  const finish = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => recoveryTransaction(db, 250, work);
  if (connection.provider !== 'waha' || connection.lifecycleGeneration % 2 !== 0) throw failure('HISTORY_SOURCE_INVALID');
  const token = randomUUID(), checkpoint = connection.recoveredThroughAt?.toISOString() ?? null;
  const identity = { id: connection.id, workspaceId: connection.workspaceId, channelId: connection.channelId,
    sessionName: connection.sessionName, verifiedPhoneNumber: connection.verifiedPhoneNumber, lifecycleGeneration: connection.lifecycleGeneration, recoveredThroughAt: connection.recoveredThroughAt, status: 'connected' as const, eligible: true };
  const claimed = await query(tx => tx.channelConnection.updateMany({ where: { ...identity, AND: [
    { OR: [{ historyRecoveryLeaseUntil: null }, { historyRecoveryLeaseUntil: { lt: new Date(started) } }] },
    { OR: [{ historyRecoveryNextAttemptAt: null }, { historyRecoveryNextAttemptAt: { lte: new Date(started) } }] }
  ] }, data: { historyRecoveryLeaseToken: token, historyRecoveryLeaseUntil: new Date(started + LEASE_MS), historyRecoveryNextAttemptAt: new Date(started + 30_000) } }));
  if (!claimed.count) return { recovered: 0, chats: 0, advanced: false, pending: true };
  const fence = () => ({ ...identity, historyRecoveryLeaseToken: token, historyRecoveryLeaseUntil: { gt: new Date(clock()) } });
  let recovered = 0, applied = 0;
  try {
    const fresh = await query(tx => tx.channelConnection.findUniqueOrThrow({ where: { id: connection.id } }));
    const parsed = cursorSchema.safeParse(fresh.historyRecoveryCursor);
    if (fresh.historyRecoveryCursor !== null && !parsed.success) throw failure('HISTORY_CURSOR_UNSUPPORTED');
    if (parsed.success && (parsed.data.to < parsed.data.from || parsed.data.to - parsed.data.from > (OVERLAP_MS + WINDOW_MS) / 1000 + 1)) throw failure('HISTORY_CURSOR_UNSUPPORTED');
    let cursor: Cursor;
    if (parsed.success && parsed.data.generation === connection.lifecycleGeneration && parsed.data.checkpoint === checkpoint
      && parsed.data.to >= parsed.data.from && parsed.data.to - parsed.data.from <= OVERLAP_MS / 1000 + WINDOW_MS / 1000 + 1) cursor = parsed.data;
    else {
      const base = connection.recoveredThroughAt?.getTime() ?? now - 15 * 60_000;
      const end = Math.floor(Math.min(now - SETTLE_MS, base + WINDOW_MS) / 1000);
      if (end * 1000 <= base) {
        await query(tx => tx.channelConnection.updateMany({ where: fence(), data: { historyRecoveryCursor: Prisma.DbNull, historyRecoveryLeaseToken: null,
          historyRecoveryLeaseUntil: null, historyRecoveryNextAttemptAt: new Date(clock() + WINDOW_MS) } }));
        return { recovered, chats: 0, advanced: false, pending: false };
      }
      cursor = { version: 2, generation: connection.lifecycleGeneration, checkpoint,
        from: Math.max(0, Math.floor((base - OVERLAP_MS) / 1000)), to: end, offset: 0, pages: [], previousPages: null, changedPasses: 0 };
    }
    const save = async (cleanup = false) => {
      cursor.version = 2;
      const result = await (cleanup ? finish : query)(tx => tx.channelConnection.updateMany({ where: fence(), data: {
        historyRecoveryCursor: cursor as Prisma.InputJsonValue, historyRecoveryLeaseUntil: new Date(clock() + LEASE_MS)
      } }));
      if (result.count !== 1) throw failure('HISTORY_LEASE_LOST');
    };
    await save(); // Retain the fixed interval even if the first provider request fails.
    for (let requests = 0; requests < maxPages && remaining() > 0 && applied < maxItems; requests++) {
      const page = await deps.read({ session: connection.sessionName, from: cursor.from, to: cursor.to, offset: cursor.offset, limit: PAGE_SIZE, signal });
      if (!/^[a-f0-9]{64}$/.test(page.rawDigest) || !Array.isArray(page.messages) || !Number.isSafeInteger(page.rawCount) || page.rawCount < 0 || page.rawCount > PAGE_SIZE
        || page.messages.length > page.rawCount || page.nextOffset !== cursor.offset + page.rawCount || page.exhausted !== (page.rawCount === 0)) throw failure('HISTORY_PAGINATION');
      const budget = new HistoryMemoryBudget(); budget.reserve(cursor); budget.reserve(page);
      const ids = new Set<string>();
      for (const message of page.messages) {
        if (typeof message.id !== 'string' || !message.id || ids.has(message.id)) throw failure('HISTORY_PAGINATION');
        ids.add(message.id);
        if (!Number.isSafeInteger(message.timestamp) || message.timestamp! < cursor.from || message.timestamp! > cursor.to) throw failure('HISTORY_FILTER_IGNORED');
      }
      budget.reserve([...ids]);
      if (page.exhausted) {
        if (cursor.previousPages !== null && JSON.stringify(cursor.pages) === JSON.stringify(cursor.previousPages)) {
          const changed = await query(tx => tx.channelConnection.updateMany({ where: fence(), data: {
            recoveredThroughAt: new Date(cursor.to * 1000), historyRecoveryCursor: Prisma.DbNull,
            historyRecoveryLeaseToken: null, historyRecoveryLeaseUntil: null, historyRecoveryFailures: 0,
            historyRecoveryNextAttemptAt: new Date(clock() + (cursor.to < Math.floor((now - SETTLE_MS) / 1000) ? 30_000 : WINDOW_MS))
          } }));
          if (changed.count !== 1) throw failure('HISTORY_LEASE_LOST');
          return { recovered, chats: 0, advanced: true, pending: false };
        }
        if (cursor.previousPages !== null) cursor.changedPasses++;
        cursor.previousPages = cursor.pages; cursor.pages = []; cursor.offset = 0;
        await save();
        if (cursor.changedPasses >= 3) { cursor.changedPasses = 0; await save(); throw failure('HISTORY_UNSTABLE'); }
        continue;
      }
      const fingerprint = historyDigest({ rawDigest: page.rawDigest, rawCount: page.rawCount, messages: page.messages.map(m => [m.id, historyDigest(m)]) });
      if (cursor.pages.includes(fingerprint)) {
        // A late insertion can shift an already read row onto the next page. Restart only
        // this small window; never mistake duplicate offset results for certified coverage.
        cursor.offset = 0; cursor.pages = []; cursor.previousPages = null; cursor.changedPasses++;
        await save();
        if (cursor.changedPasses >= 3) { cursor.changedPasses = 0; await save(); throw failure('HISTORY_PAGINATION'); }
        continue;
      }
      page.messages.sort((a, b) => a.timestamp! - b.timestamp! || a.id.localeCompare(b.id));
      // A partial page is tied to its complete immutable fingerprint, not only its offset.
      // If rows shift, replay the new page from zero; canonical receipts make the overlap safe.
      if (cursor.partial && cursor.partial.fingerprint !== fingerprint) {
        delete cursor.partial; cursor.previousPages = null; cursor.changedPasses++;
        const unstable = cursor.changedPasses >= 3;
        if (unstable) cursor.changedPasses = 0;
        await save();
        if (unstable) throw failure('HISTORY_UNSTABLE');
      }
      if (page.messages.length && cursor.previousPages?.[cursor.pages.length] !== fingerprint) {
        cursor.partial ??= { fingerprint, completed: 0 };
        if (cursor.partial.completed > page.messages.length) throw failure('HISTORY_PAGINATION');
        await save();
        while (cursor.partial.completed < page.messages.length && remaining() > 0 && applied < maxItems) {
          signal.throwIfAborted();
          const result = await deps.persist([page.messages[cursor.partial.completed]], { signal, remaining, fence: { token, checkpoint: connection.recoveredThroughAt, anchor: metadata.anchor(), verifiedPhoneNumber: connection.verifiedPhoneNumber } });
          recovered += result.inserted; applied++;
          if (result.held) throw failure('HISTORY_CANONICAL_HOLD');
          cursor.partial.completed++;
          // A process death between canonical commit and this save replays at most one row.
          await save(remaining() <= 0);
        }
        if (cursor.partial.completed < page.messages.length) break;
      }
      delete cursor.partial;
      cursor.pages.push(fingerprint); cursor.offset = page.nextOffset;
      if (cursor.offset > 100_000 || cursor.pages.length > 2000) throw failure('HISTORY_SCAN_LIMIT');
      await save(remaining() <= 0);
    }
    const released = await finish(tx => tx.channelConnection.updateMany({ where: fence(), data: { historyRecoveryLeaseToken: null,
      historyRecoveryLeaseUntil: null, historyRecoveryFailures: 0, historyRecoveryNextAttemptAt: new Date(clock() + 30_000) } }));
    if (released.count !== 1) throw failure('HISTORY_LEASE_LOST');
    return { recovered, chats: 0, advanced: false, pending: true };
  } catch (error) {
    // A failed page stays at its previous cursor. This backoff survives a worker restart.
    await finish(async tx => {
      const current = await tx.channelConnection.findUnique({ where: { id: connection.id }, select: { historyRecoveryFailures: true } });
      const failures = (current?.historyRecoveryFailures ?? 0) + 1;
      await tx.channelConnection.updateMany({ where: { id: connection.id, workspaceId: connection.workspaceId, historyRecoveryLeaseToken: token }, data: {
        historyRecoveryLeaseToken: null, historyRecoveryLeaseUntil: null, historyRecoveryFailures: failures,
        historyRecoveryNextAttemptAt: new Date(clock() + Math.min(3600_000, 60_000 * 2 ** Math.min(failures - 1, 6)))
      } });
    }).catch(() => undefined);
    throw error;
  }
}
