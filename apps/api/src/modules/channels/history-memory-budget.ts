import { sha, stable } from '../messaging/canonical-values.js';

export const HISTORY_SCAN_MAX_BYTES = 8 * 1024 * 1024;
export class HistoryScanLimitError extends Error {
  readonly code = 'HISTORY_SCAN_LIMIT';
  constructor() { super('HISTORY_SCAN_LIMIT'); this.name = 'HistoryScanLimitError'; }
}

/** Count JSON bytes without first allocating a serialized copy. Provider JSON is acyclic;
 * a depth ceiling also stops malformed adapters from exhausting the call stack. */
function jsonBytes(value: unknown, max: number) {
  let bytes = 0;
  const add = (size: number) => { bytes += size; if (bytes > max) throw new HistoryScanLimitError(); };
  function text(value: string) {
    add(Buffer.byteLength(value) + 2);
    for (const match of value.matchAll(/["\\\u0000-\u001f\ud800-\udfff]/g)) {
      const code = match[0].charCodeAt(0), index = match.index!;
      if (code >= 0xd800 && code <= 0xdfff) {
        const paired = code <= 0xdbff ? value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff
          : value.charCodeAt(index - 1) >= 0xd800 && value.charCodeAt(index - 1) <= 0xdbff;
        if (!paired) add(3); // JSON escapes a lone surrogate instead of UTF-8 replacement.
      } else add(code < 32 && ![8, 9, 10, 12, 13].includes(code) ? 5 : 1);
    }
  }
  function visit(value: unknown, depth: number) {
    if (depth > 64) throw new HistoryScanLimitError();
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) {
      add(2 + Math.max(0, value.length - 1));
      for (const item of value) visit(item, depth + 1);
    } else if (value !== null && typeof value === 'object') {
      add(2); let first = true;
      for (const [key, item] of Object.entries(value)) {
        add(first ? 1 : 2); first = false; text(key); visit(item, depth + 1);
      }
    } else add(JSON.stringify(value)?.length ?? 4);
  }
  visit(value, 0); return bytes;
}
export class HistoryMemoryBudget {
  private used = 0;
  reserve(value: unknown) { this.used += jsonBytes(value, HISTORY_SCAN_MAX_BYTES - this.used); }
  /** A sorted view shares payload objects; count its reference slots instead of
   * charging a second serialized copy of the entire provider payload. */
  reserveReferences(count: number) {
    if (!Number.isSafeInteger(count) || count < 0) throw new HistoryScanLimitError();
    this.used += 16 + count * 8;
    if (this.used > HISTORY_SCAN_MAX_BYTES) throw new HistoryScanLimitError();
  }
}
export function historyDigest(value: unknown) {
  jsonBytes(value, HISTORY_SCAN_MAX_BYTES); // Guard before stable() allocates its canonical string.
  return sha(stable(value));
}
