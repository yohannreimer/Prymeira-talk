import { historyDigest } from './history-memory-budget.js';
import type { WahaMessage, WahaRecoveryPage, WahaRecoveryQuery } from '../waha/waha.client.js';

/** Independent operator scan: never replaces or jumps the live recovery frontier. */
export type HistoryBackfillCursor = {
  from: number; to: number; offset: number; pages: string[]; previousPages: string[] | null;
  holdsByOffset: Record<string, number>; previousHoldsByOffset?: Record<string, number>;
  scanned: number; inserted: number; complete: boolean;
};
export function newHistoryBackfill(from: number, to: number): HistoryBackfillCursor {
  if (![from, to].every(Number.isSafeInteger) || from < 0 || to < from || to - from > 15 * 86400) throw new Error('BACKFILL_RANGE');
  return { from, to, offset: 0, pages: [], previousPages: null, holdsByOffset: {}, scanned: 0, inserted: 0, complete: false };
}
export async function stepHistoryBackfill(input: {
  session: string; cursor: HistoryBackfillCursor; maxPages?: number;
  read: (q: WahaRecoveryQuery) => Promise<WahaRecoveryPage>;
  persist: (messages: WahaMessage[]) => Promise<{ inserted: number; held: number }>;
  save: (cursor: HistoryBackfillCursor) => Promise<void>;
}) {
  const c = input.cursor, maxPages = input.maxPages ?? 2;
  newHistoryBackfill(c.from, c.to);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10 || !Number.isSafeInteger(c.offset)
    || c.offset < 0 || c.offset > 100_000 || c.pages.length > 2000) throw new Error('BACKFILL_BUDGET');
  if (c.complete) return c;
  for (let n = 0; n < maxPages; n++) {
    const q = { session: input.session, from: c.from, to: c.to, offset: c.offset, limit: 50 };
    const page = await input.read(q);
    if (!/^[a-f0-9]{64}$/.test(page.rawDigest) || !Number.isSafeInteger(page.rawCount) || page.rawCount < 0
      || page.rawCount > q.limit || page.nextOffset !== c.offset + page.rawCount || page.exhausted !== (page.rawCount === 0)
      || !Array.isArray(page.messages) || page.messages.length > page.rawCount) throw new Error('HISTORY_PAGINATION');
    const ids = new Set<string>();
    for (const m of page.messages) {
      if (!m.id || ids.has(m.id) || !Number.isSafeInteger(m.timestamp) || m.timestamp! < c.from || m.timestamp! > c.to) throw new Error('HISTORY_FILTER_IGNORED');
      ids.add(m.id);
    }
    if (page.exhausted) {
      if (c.previousPages !== null && JSON.stringify(c.pages) === JSON.stringify(c.previousPages)) {
        c.complete = true; await input.save(c); return c;
      }
      c.previousPages = c.pages; c.previousHoldsByOffset = c.holdsByOffset;
      c.pages = []; c.offset = 0; c.holdsByOffset = {};
      await input.save(c); continue;
    }
    const fingerprint = historyDigest({ rawDigest: page.rawDigest, rawCount: page.rawCount, messages: page.messages.map(m => [m.id, historyDigest(m)]) });
    // A byte-identical verified page with a successful prior canonical write needs
    // no repeated writes. Missing legacy proof or any hold must retry persistence.
    const verified = c.previousPages?.[c.pages.length] === fingerprint
      && c.previousHoldsByOffset?.[String(c.offset)] === 0;
    const result = verified ? { inserted: 0, held: 0 } : await input.persist(page.messages);
    c.holdsByOffset[String(c.offset)] = result.held;
    c.inserted += result.inserted; c.scanned += page.messages.length;
    c.pages.push(fingerprint); c.offset = page.nextOffset;
    if (c.offset > 100_000 || c.pages.length > 2000) throw new Error('BACKFILL_BUDGET');
    await input.save(c);
  }
  return c;
}
