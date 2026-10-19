import { randomUUID } from 'node:crypto';
import { Prisma, type ChannelConnection, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { EvolutionHistorySource, HistoryRecord } from '../evolution/evolution-history.js';
import { historyDigest, HistoryMemoryBudget } from './history-memory-budget.js';
import { createRecoveryMetadataQuery, recoveryTransaction, type RecoveryWriteFence } from './history-recovery-budget.js';

const WINDOW_MS = 300_000, OVERLAP_MS = 600_000, SETTLE_MS = 30_000, LEASE_MS = 120_000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const cursorSchema = z.object({
  version: z.literal(2), provider: z.literal('evolution'), generation: z.number().int().nonnegative(), checkpoint: z.string().datetime().nullable(),
  from: z.number().int().nonnegative(), to: z.number().int().nonnegative(),
  chatOffset: z.number().int().min(0).max(100_000), chats: z.array(z.object({ remoteJid: z.string(), phoneJid: z.string() })).max(100),
  chatIndex: z.number().int().min(0).max(100), messagePage: z.number().int().min(1).max(2),
  messagePages: z.number().int().min(0).max(1).nullable(), messageTotal: z.number().int().min(0).max(5000).nullable(),
  seenChats: z.array(hash).max(100_000), seenMessages: z.array(hash).max(5000),
  pages: z.array(hash).max(100_000), previousPages: z.array(hash).max(100_000).nullable(), changedPasses: z.number().int().min(0).max(3),
  partial: z.object({ fingerprint: hash, completed: z.number().int().min(0).max(5000) }).optional()
});
type Cursor = z.infer<typeof cursorSchema>;
type Budget = { signal: AbortSignal; remaining: () => number; fence: RecoveryWriteFence };
export type EvolutionRecoveryOptions = { now?: number; maxPages?: number; maxMs?: number; maxItems?: number; clock?: () => number; signal?: AbortSignal };
type Source = Pick<EvolutionHistorySource, 'recoveryChatPage' | 'recoveryMessagePage'>;
const failure = (code: string) => Object.assign(new Error(code), { code });

/** Each invocation performs a bounded number of raw requests. Chat and message cursors,
 * partial canonical progress and complete pass manifests survive a fresh process.
 * Every message in a timestamp-filtered batch participates in identity, duplication
 * and stability checks. Payloads are never retained in the cursor. */
export async function recoverEvolutionWindow(db: PrismaClient, connection: ChannelConnection, source: Source,
  persist: (rows: HistoryRecord[], budget: Budget) => Promise<{ inserted: number; held: number }>, options: EvolutionRecoveryOptions = {}) {
  const clock = options.clock ?? Date.now, started = clock(), now = options.now ?? started;
  const maxPages = options.maxPages ?? 4, maxMs = options.maxMs ?? 5000, maxItems = options.maxItems ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 5000 || !Number.isFinite(maxMs) || maxMs < 1 || maxMs > 30_000) throw failure('HISTORY_BUDGET');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.ceil(maxMs))]) : AbortSignal.timeout(Math.ceil(maxMs));
  signal.throwIfAborted();
  const remaining = () => Math.max(0, maxMs - (clock() - started));
  const metadata = createRecoveryMetadataQuery(db, connection, remaining), query = metadata.query;
  const finish = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => recoveryTransaction(db, 250, work);
  if (connection.provider !== 'evolution' || connection.lifecycleGeneration % 2 !== 0) throw failure('HISTORY_SOURCE_INVALID');
  const token = randomUUID(), checkpoint = connection.recoveredThroughAt?.toISOString() ?? null;
  const identity = { id: connection.id, workspaceId: connection.workspaceId, channelId: connection.channelId, sessionName: connection.sessionName,
    verifiedPhoneNumber: connection.verifiedPhoneNumber, lifecycleGeneration: connection.lifecycleGeneration, recoveredThroughAt: connection.recoveredThroughAt, status: 'connected' as const, eligible: true };
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
    // Never reinterpret an unknown provider/version, or a corrupt partial offset.
    if (fresh.historyRecoveryCursor !== null && !parsed.success) throw failure('HISTORY_CURSOR_UNSUPPORTED');
    let cursor: Cursor;
    if (parsed.success && parsed.data.generation === connection.lifecycleGeneration && parsed.data.checkpoint === checkpoint) cursor = parsed.data;
    else {
      const base = connection.recoveredThroughAt?.getTime() ?? now - 900_000;
      const end = Math.floor(Math.min(now - SETTLE_MS, base + WINDOW_MS) / 1000);
      if (end * 1000 <= base) {
        await query(tx => tx.channelConnection.updateMany({ where: fence(), data: { historyRecoveryCursor: Prisma.DbNull,
          historyRecoveryLeaseToken: null, historyRecoveryLeaseUntil: null, historyRecoveryNextAttemptAt: new Date(clock() + WINDOW_MS) } }));
        return { recovered, chats: 0, advanced: false, pending: false };
      }
      cursor = { version: 2, provider: 'evolution', generation: connection.lifecycleGeneration, checkpoint,
        from: Math.max(0, Math.floor((base - OVERLAP_MS) / 1000)), to: end, chatOffset: 0, chats: [], chatIndex: 0,
        messagePage: 1, messagePages: null, messageTotal: null, seenChats: [], seenMessages: [], pages: [], previousPages: null, changedPasses: 0 };
    }
    if (cursor.to < cursor.from || cursor.to - cursor.from > (OVERLAP_MS + WINDOW_MS) / 1000 + 1 || cursor.chatIndex > cursor.chats.length) throw failure('HISTORY_CURSOR_UNSUPPORTED');
    const save = async (cleanup = false) => {
      new HistoryMemoryBudget().reserve(cursor);
      const changed = await (cleanup ? finish : query)(tx => tx.channelConnection.updateMany({ where: fence(), data: {
        historyRecoveryCursor: cursor as Prisma.InputJsonValue, historyRecoveryLeaseUntil: new Date(clock() + LEASE_MS)
      } }));
      if (changed.count !== 1) throw failure('HISTORY_LEASE_LOST');
    };
    const restartPass = async (code: string) => {
      cursor.chatOffset = 0; cursor.chats = []; cursor.chatIndex = 0;
      cursor.messagePage = 1; cursor.messagePages = null; cursor.messageTotal = null;
      cursor.seenChats = []; cursor.seenMessages = []; cursor.pages = []; cursor.previousPages = null;
      delete cursor.partial; cursor.changedPasses++;
      if (cursor.changedPasses >= 3) { cursor.changedPasses = 0; await save(); throw failure(code); }
      await save();
    };
    await save();
    for (let requests = 0; requests < maxPages && remaining() > 0 && applied < maxItems; requests++) {
      signal.throwIfAborted();
      if (cursor.chatIndex >= cursor.chats.length) {
        const result = await source.recoveryChatPage({ instanceName: connection.sessionName, offset: cursor.chatOffset, signal });
        if (!Array.isArray(result.chats) || result.chats.length > 100) throw failure('HISTORY_CHATS_SHAPE');
        const budget = new HistoryMemoryBudget(); budget.reserve(cursor); budget.reserve(result); budget.reserveReferences(result.chats.length);
        if (!result.chats.length) {
          if (cursor.previousPages !== null && historyDigest(cursor.pages) === historyDigest(cursor.previousPages)) {
            const changed = await query(tx => tx.channelConnection.updateMany({ where: fence(), data: {
              recoveredThroughAt: new Date(cursor.to * 1000), historyRecoveryCursor: Prisma.DbNull,
              historyRecoveryLeaseToken: null, historyRecoveryLeaseUntil: null, historyRecoveryFailures: 0,
              historyRecoveryNextAttemptAt: new Date(clock() + (cursor.to < Math.floor((now - SETTLE_MS) / 1000) ? 30_000 : WINDOW_MS))
            } }));
            if (changed.count !== 1) throw failure('HISTORY_LEASE_LOST');
            return { recovered, chats: cursor.seenChats.length, advanced: true, pending: false };
          }
          if (cursor.previousPages !== null) cursor.changedPasses++;
          cursor.previousPages = cursor.pages; cursor.pages = []; cursor.chatOffset = 0; cursor.chats = []; cursor.chatIndex = 0;
          cursor.messagePage = 1; cursor.messagePages = null; cursor.messageTotal = null; cursor.seenChats = []; cursor.seenMessages = [];
          delete cursor.partial;
          const unstable = cursor.changedPasses >= 3;
          if (unstable) cursor.changedPasses = 0;
          await save();
          if (unstable) throw failure('HISTORY_UNSTABLE');
          continue;
        }
        const seen = new Set(cursor.seenChats), incoming: string[] = [];
        let drifted = false;
        for (const chat of result.chats) {
          const identity = historyDigest(chat.remoteJid);
          if (seen.has(identity)) { drifted = true; break; }
          seen.add(identity); incoming.push(identity);
        }
        if (drifted) { await restartPass('HISTORY_PAGINATION'); continue; }
        budget.reserve(incoming);
        cursor.seenChats.push(...incoming);
        cursor.pages.push(historyDigest({ chats: result.chats }));
        cursor.chats = result.chats; cursor.chatIndex = 0; cursor.chatOffset += result.chats.length;
        if (cursor.chatOffset >= 100_000) throw failure('HISTORY_PAGE_LIMIT');
        await save(); continue;
      }
      const chat = cursor.chats[cursor.chatIndex];
      const page = await source.recoveryMessagePage({ instanceName: connection.sessionName, remoteJid: chat.remoteJid, page: cursor.messagePage, from: new Date(cursor.from * 1000), to: new Date(cursor.to * 1000), signal });
      if (!Array.isArray(page.records) || page.records.length > 5000 || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > 5000
        || page.pages !== Math.ceil(page.total / 5000) || page.records.length !== Math.min(5000, Math.max(0, page.total - (cursor.messagePage - 1) * 5000))) throw failure('HISTORY_PAGINATION');
      if (cursor.messagePages !== null && (cursor.messagePages !== page.pages || cursor.messageTotal !== page.total)) {
        // A stable provider can change after a partial batch or between its data
        // and terminal reads. Rewind only this chat, retaining durable canonical
        // rows. Leaving the old total pinned would otherwise starve it forever.
        if (cursor.messagePage === 2) cursor.pages.pop();
        cursor.messagePage = 1; cursor.messagePages = null; cursor.messageTotal = null; cursor.seenMessages = [];
        delete cursor.partial; cursor.previousPages = null; cursor.changedPasses++;
        const unstable = cursor.changedPasses >= 3;
        if (unstable) cursor.changedPasses = 0;
        await save();
        if (unstable) throw failure('HISTORY_UNSTABLE');
        continue;
      }
      cursor.messagePages = page.pages; cursor.messageTotal = page.total;
      const budget = new HistoryMemoryBudget(); budget.reserve(cursor); budget.reserve(page);
      budget.reserveReferences(page.records.length);
      // This is one complete batch, not offset pagination. Timestamp ties can be
      // returned in any order; persistence and stability must use the same order.
      const ordered = [...page.records].sort((a, b) => a.messageTimestamp - b.messageTimestamp || historyDigest(a.key).localeCompare(historyDigest(b.key)));
      const identities = ordered.map(row => historyDigest(row.key));
      budget.reserve(identities);
      const seen = new Set(cursor.seenMessages);
      for (let index = 0; index < page.records.length; index++) {
        if (ordered[index].key.remoteJid !== chat.remoteJid || seen.has(identities[index])) throw failure('HISTORY_PAGINATION');
        seen.add(identities[index]);
      }
      const fingerprint = historyDigest({ chat, page: cursor.messagePage, pages: page.pages, total: page.total, records: ordered });
      if (cursor.partial && cursor.partial.fingerprint !== fingerprint) {
        delete cursor.partial; cursor.previousPages = null; cursor.changedPasses++;
        const unstable = cursor.changedPasses >= 3;
        if (unstable) cursor.changedPasses = 0;
        await save();
        if (unstable) throw failure('HISTORY_UNSTABLE');
      }
      if (cursor.previousPages?.[cursor.pages.length] !== fingerprint && ordered.length) {
        cursor.partial ??= { fingerprint, completed: 0 };
        if (cursor.partial.completed > ordered.length) throw failure('HISTORY_PAGINATION');
        await save();
        while (cursor.partial.completed < ordered.length && remaining() > 0 && applied < maxItems) {
          signal.throwIfAborted();
          const result = await persist([ordered[cursor.partial.completed]], { signal, remaining, fence: { token, checkpoint: connection.recoveredThroughAt, anchor: metadata.anchor(), verifiedPhoneNumber: connection.verifiedPhoneNumber } });
          recovered += result.inserted; applied++;
          if (result.held) throw failure('HISTORY_CANONICAL_HOLD');
          cursor.partial.completed++; await save(remaining() <= 0);
        }
        if (cursor.partial.completed < ordered.length) break;
      }
      delete cursor.partial; cursor.pages.push(fingerprint); cursor.seenMessages.push(...identities);
      if (cursor.messagePage === page.pages + 1 || page.pages === 0) {
        if (cursor.seenMessages.length !== page.total) throw failure('HISTORY_PAGINATION');
        cursor.chatIndex++; cursor.messagePage = 1; cursor.messagePages = null; cursor.messageTotal = null; cursor.seenMessages = [];
      } else cursor.messagePage++;
      await save(remaining() <= 0);
    }
    const released = await finish(tx => tx.channelConnection.updateMany({ where: fence(), data: { historyRecoveryLeaseToken: null,
      historyRecoveryLeaseUntil: null, historyRecoveryFailures: 0, historyRecoveryNextAttemptAt: new Date(clock() + 30_000) } }));
    if (released.count !== 1) throw failure('HISTORY_LEASE_LOST');
    return { recovered, chats: cursor.seenChats.length, advanced: false, pending: true };
  } catch (error) {
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
