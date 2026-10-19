import { createHash } from 'node:crypto';
import { completeProviderKey, fullProviderKeyMatches, explicitAddressMatch, exactMediaLimit, type MediaPurpose } from '../messaging/provider-exact.js';
import { normalizeChatAddress, type WhatsAppMessageKey } from '../messaging/whatsapp-identity.js';
import { usableContactName } from '../contacts/contact-name.js';
import { stable } from '../messaging/canonical-values.js';
import { HistoryMemoryBudget, historyDigest } from '../channels/history-memory-budget.js';

export type HistoryRecord = {
  key: { id: string; remoteJid: string; remoteJidAlt?: string; participant?: string; participantAlt?: string; fromMe: boolean };
  messageTimestamp: number;
  message: Record<string, unknown>;
  participant?: string;
  messageType?: string;
  pushName?: string;
};
export type RecentEvolutionChat = { remoteJid: string; phoneJid: string; pushName: string | null; profilePicUrl: string | null };
export type RecentEvolutionChats = { chats: RecentEvolutionChat[]; unresolvedLids: number };
export type RecentEvolutionContact = { phoneJid: string; name: string | null; profilePicUrl: string | null };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const direct = (s: unknown): s is string => typeof s === 'string' && /^\d+@(s\.whatsapp\.net|lid)$/.test(s);
const historyAddress = (s: unknown): s is string => direct(s) || (typeof s === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(s));
const phoneJid = (s: unknown): s is string => typeof s === 'string' && /^\d+@s\.whatsapp\.net$/.test(s);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function activityTime(value: unknown): number | null {
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 1e11 ? number * 1000 : number;
}

// This adapter deliberately has no send, mark-read, webhook or instance mutation methods.
export function createEvolutionHistorySource(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch; exactLookupTimeoutMs?: number }) {
  const request = options.fetch ?? fetch;
  const exactLookupTimeoutMs = options.exactLookupTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(exactLookupTimeoutMs) || exactLookupTimeoutMs < 1 || exactLookupTimeoutMs > 30_000) throw new Error('HISTORY_DEADLINE_CONFIG');
  async function post(path: string, body: unknown, maxResponseBytes = 16 * 1024 * 1024, deadline?: AbortSignal) {
    const signal = deadline ? AbortSignal.any([deadline, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    signal.throwIfAborted();
    const response = await request(options.baseUrl.replace(/\/$/, '') + path, {
      method: 'POST', redirect: 'error', headers: { apikey: options.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal
    });
    if (!response.ok) throw new Error(`HISTORY_HTTP_${response.status}`);
    let text: string;
    if (response.body) {
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (signal.aborted) cancel();
        signal.throwIfAborted();
        for (;;) {
          const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
          size += part.value.byteLength;
          if (size > maxResponseBytes) { cancel(); throw new Error('HISTORY_RESPONSE_LIMIT'); }
          chunks.push(part.value);
        }
        text = Buffer.concat(chunks).toString('utf8');
      } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    } else text = await response.text();
    signal.throwIfAborted();
    if (Buffer.byteLength(text) > maxResponseBytes) throw new Error('HISTORY_RESPONSE_LIMIT');
    const parsed: unknown = JSON.parse(text); signal.throwIfAborted(); return parsed;
  }
  async function page(instance: string, key: Record<string, string | boolean>, index: number, deadline?: AbortSignal, capacity: 100 | 5000 = 100) {
    const data = await post(`/chat/findMessages/${encodeURIComponent(instance)}`, { where: { key }, page: index, offset: capacity }, undefined, deadline);
    if (!record(data) || !record(data.messages) || !Array.isArray(data.messages.records) || !Number.isInteger(data.messages.pages) || Number(data.messages.pages) < 0) throw new Error('HISTORY_SHAPE');
    const pages = Number(data.messages.pages);
    if (pages > 50 || data.messages.records.length > capacity) throw new Error('HISTORY_PAGE_LIMIT');
    const currentPage = Number.isInteger(data.messages.currentPage) ? Number(data.messages.currentPage) : null;
    if (data.messages.currentPage !== undefined && currentPage !== index) throw new Error('HISTORY_PAGINATION');
    return { pages, currentPage, records: data.messages.records, total: Number.isInteger(data.messages.total) && Number(data.messages.total) >= 0 ? Number(data.messages.total) : null };
  }
  function parse(value: unknown): HistoryRecord {
    if (!record(value) || !record(value.key) || typeof value.key.id !== 'string' || !value.key.id || !historyAddress(value.key.remoteJid) || typeof value.key.fromMe !== 'boolean' || !record(value.message)) throw new Error('HISTORY_RECORD');
    const timestamp = Number(value.messageTimestamp);
    if (value.messageTimestamp === null || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 1e11) throw new Error('HISTORY_RECORD');
    const pushName = typeof value.pushName === 'string' ? usableContactName(value.pushName) : null;
    return { key: { id: value.key.id, remoteJid: value.key.remoteJid, fromMe: value.key.fromMe,
      ...(direct(value.key.remoteJidAlt) ? { remoteJidAlt: value.key.remoteJidAlt } : {}),
      ...(direct(value.key.participant ?? value.participant) ? { participant: (value.key.participant ?? value.participant) as string } : {}),
      ...(direct(value.key.participantAlt) ? { participantAlt: value.key.participantAlt } : {}) }, messageTimestamp: timestamp, message: value.message,
      ...(direct(value.participant) ? { participant: value.participant } : {}),
      ...(typeof value.messageType === 'string' ? { messageType: value.messageType } : {}),
      ...(pushName ? { pushName } : {}) };
  }
  /** Broadcast-list envelopes share the recipient stanza ID but cannot identify
   * PN/LID/group media. Recognize only the observed complete native tuple; any
   * aliases, sender claims or malformed fields still go through strict parse(). */
  function numericBroadcastEnvelope(value: Record<string, unknown>, nativeId: string) {
    const key = value.key, timestamp = value.messageTimestamp;
    return record(key) && Object.keys(key).every(name => ['id', 'remoteJid', 'fromMe'].includes(name))
      && key.id === nativeId && typeof key.remoteJid === 'string' && /^\d+@broadcast$/.test(key.remoteJid)
      && typeof key.fromMe === 'boolean' && record(value.message)
      && !['remoteJid', 'remoteJidAlt', 'fromMe', 'author', 'participant', 'participantAlt'].some(name => Object.hasOwn(value, name))
      && typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 1e11;
  }
  function exactRecordKey(item: HistoryRecord): WhatsAppMessageKey {
    const k = item.key, chatAddress = normalizeChatAddress(k.remoteJid), providerNative = k.id.startsWith('wamid.');
    return { identityFormat: providerNative ? 'provider_native' : 'whatsapp_stanza', nativeId: k.id, rawId: providerNative ? null : k.id,
      nativeChatAddress: k.remoteJid, nativeSenderParticipant: k.participant ?? null, chatAddress,
      direction: k.fromMe ? 'outbound' : 'inbound', senderParticipant: chatAddress?.endsWith('@g.us') ? normalizeChatAddress(k.participant) : '' };
  }
  /** Exact APIs share one completeness/consistency check. Top-level sender
   * claims cannot contradict the native key. A distinct PN/LID spelling needs
   * the explicit participantAlt pair; unrelated phone numbers never correlate. */
  function exactRecordIdentity(item: HistoryRecord): { kind: 'consistent' | 'incomplete' | 'ambiguous'; key: WhatsAppMessageKey } {
    const key = exactRecordKey(item);
    if (!completeProviderKey(key)) return { kind: 'incomplete', key };
    if (item.participant && !explicitAddressMatch(normalizeChatAddress(item.participant), key.nativeSenderParticipant, item.key.participantAlt)) return { kind: 'ambiguous', key };
    return { kind: 'consistent', key };
  }
  /** A provider database may store the explicit PN/LID alias opposite to the
   * authenticated webhook. Rebind only this lookup's native fields, never the
   * stored source or the shared exact matcher. Raw IDs, direction and canonical
   * chat/sender remain checked by the full matcher after the local binding. */
  function exactRecordMatches(expected: WhatsAppMessageKey, actual: WhatsAppMessageKey, item: HistoryRecord) {
    const bound = { ...expected };
    const provenAlias = (requested: string | null, native: string | null, alternate?: string) => {
      const a = normalizeChatAddress(requested), b = normalizeChatAddress(native);
      const pair = a?.endsWith('@lid') && b?.endsWith('@s.whatsapp.net') || a?.endsWith('@s.whatsapp.net') && b?.endsWith('@lid');
      return !!pair && explicitAddressMatch(a, native, alternate);
    };
    if (expected.nativeChatAddress !== actual.nativeChatAddress) {
      if (!provenAlias(expected.nativeChatAddress, actual.nativeChatAddress, item.key.remoteJidAlt)) return false;
      bound.nativeChatAddress = actual.nativeChatAddress;
    }
    if (expected.nativeSenderParticipant !== actual.nativeSenderParticipant) {
      if (!expected.chatAddress?.endsWith('@g.us') || !actual.chatAddress?.endsWith('@g.us') ||
        !provenAlias(expected.nativeSenderParticipant, actual.nativeSenderParticipant, item.key.participantAlt)) return false;
      bound.nativeSenderParticipant = actual.nativeSenderParticipant;
    }
    return fullProviderKeyMatches(bound, actual, { chat: item.key.remoteJidAlt, sender: item.key.participantAlt });
  }
  async function lookupExact(input: { instanceName: string; key: WhatsAppMessageKey }, deadline: AbortSignal): Promise<
    { kind: 'resolved'; record: HistoryRecord } | { kind: 'missing' | 'incomplete' | 'ambiguous' }> {
    if (!input.instanceName || !completeProviderKey(input.key) || !normalizeChatAddress(input.key.nativeChatAddress)) return { kind: 'incomplete' };
    const incompleteCandidate = (item: HistoryRecord, identity: ReturnType<typeof exactRecordIdentity>) =>
      identity.kind === 'incomplete' && identity.key.nativeId === input.key.nativeId && identity.key.direction === input.key.direction
        && explicitAddressMatch(input.key.chatAddress, identity.key.nativeChatAddress, item.key.remoteJidAlt);
    let first: Awaited<ReturnType<typeof page>> | null = await page(input.instanceName, { id: input.key.nativeId! }, 1, deadline);
    // An ID may be reused by broadcasts. Even a singleton needs metadata,
    // terminal exhaustion and convergence before it can certify media identity.
    if (first.total === null || first.currentPage !== 1) return { kind: 'ambiguous' };
    const discoveredTotal = first.total;
    if (discoveredTotal > 5000) throw new Error('HISTORY_PAGE_LIMIT');
    if (first.pages !== Math.ceil(discoveredTotal / 100) || first.records.length !== Math.min(100, discoveredTotal)) throw new Error('HISTORY_PAGINATION');
    // The provider orders by timestamp without a unique tie-breaker: offset
    // pages can overlap. A bounded single batch avoids cross-page ordering;
    // it still needs exact counts, terminal exhaustion and two full manifests.
    const capacity = discoveredTotal > 100 ? 5000 : 100;
    if (capacity === 5000) first = null; // Discovery is never a completeness pass.
    let previous: string | undefined;
    for (let pass = 0; pass < 3; pass++) {
      const rows = new Map<string, string>(), budget = new HistoryMemoryBudget();
      let pages: number | undefined, total: number | null = null, candidate: HistoryRecord | null = null, candidateHash: string | null = null;
      for (let index = 1; index <= (pages ?? 1) + 1; index++) {
        deadline.throwIfAborted();
        const result = index === 1 && first ? first : await page(input.instanceName, { id: input.key.nativeId! }, index, deadline, capacity);
        first = null;
        if (result.total === null || result.currentPage !== index) return { kind: 'ambiguous' };
        if (result.total > 5000) throw new Error('HISTORY_PAGE_LIMIT');
        if (result.total !== discoveredTotal) throw new Error('HISTORY_UNSTABLE');
        if (pages !== undefined && (pages !== result.pages || total !== result.total)) throw new Error('HISTORY_UNSTABLE');
        pages = result.pages; total = result.total;
        if (pages !== Math.ceil(total / capacity) || result.records.length !== Math.min(capacity, Math.max(0, total - (index - 1) * capacity))) throw new Error('HISTORY_PAGINATION');
        for (const raw of result.records) {
          deadline.throwIfAborted();
          // Provider DB IDs prove physical pagination only; never message identity.
          if (!record(raw) || typeof raw.id !== 'string' || !raw.id) return { kind: 'ambiguous' };
          if (rows.has(raw.id)) throw new Error('HISTORY_PAGINATION');
          if (numericBroadcastEnvelope(raw, input.key.nativeId!)) {
            // Count and fingerprint the entire raw envelope, including metadata;
            // never omit it from physical exhaustion, duplicates or convergence.
            budget.reserve(raw);
            const hash = historyDigest(raw);
            budget.reserve([raw.id, hash]); rows.set(raw.id, hash);
            continue;
          }
          const item = parse(raw), identity = exactRecordIdentity(item), hash = historyDigest(item);
          budget.reserve([raw.id, hash]); rows.set(raw.id, hash);
          if (incompleteCandidate(item, identity)) return { kind: 'ambiguous' };
          if (!exactRecordMatches(input.key, identity.key, item)) continue;
          if (identity.kind !== 'consistent' || (candidateHash !== null && candidateHash !== hash)) return { kind: 'ambiguous' };
          if (!candidate) { budget.reserve(item); candidate = item; candidateHash = hash; }
        }
      }
      if (rows.size !== total) throw new Error('HISTORY_PAGINATION');
      const manifest = historyDigest([...rows].sort(([a], [b]) => a.localeCompare(b)));
      if (manifest === previous) return candidate ? { kind: 'resolved', record: candidate } : { kind: 'missing' };
      previous = manifest;
    }
    throw new Error('HISTORY_UNSTABLE');
  }
  async function findMessageExact(input: { instanceName: string; key: WhatsAppMessageKey }) {
    return lookupExact(input, AbortSignal.timeout(exactLookupTimeoutMs));
  }
  async function mediaData(instanceName: string, message: HistoryRecord, purpose: MediaPurpose, deadline?: AbortSignal) {
    const limit = exactMediaLimit(purpose);
    const data = await post(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`, { message, convertToMp4: false }, Math.ceil(limit * 4 / 3) + 65536, deadline);
    if (!record(data) || typeof data.base64 !== 'string' || typeof data.mimetype !== 'string') throw new Error('HISTORY_MEDIA_SHAPE');
    const mime = data.mimetype.split(';')[0]!.trim().toLowerCase();
    if (!/^(image\/(jpeg|png|webp)|audio\/(mpeg|mp3|mp4|m4a|x-m4a|wav|x-wav|ogg|opus|webm)|video\/(mp4|webm)|application\/pdf)$/.test(mime)) throw new Error('HISTORY_MEDIA_TYPE');
    const base64 = data.base64.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
    if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || Buffer.from(base64, 'base64').length > limit) throw new Error('HISTORY_MEDIA_LIMIT');
    return `data:${mime};base64,${base64}`;
  }
  /** A complete offset scan is repeated until the fixed result converges. Empty terminal
   * pages establish exhaustion even when an installation silently caps take. */
  async function recoveryChats(input: { instanceName: string; from: Date; to: Date }): Promise<RecentEvolutionChats> {
    let previous: string | undefined;
    for (let pass = 0; pass < 3; pass++) {
      const rows = new Map<string, RecentEvolutionChat>(), budget = new HistoryMemoryBudget(); let exhausted = false;
      for (let offset = 0; offset < 100_000;) {
        const data = await post(`/chat/findChats/${encodeURIComponent(input.instanceName)}`, { take: 100, skip: offset });
        const page = Array.isArray(data) ? data : record(data) && Array.isArray(data.chats) ? data.chats : null;
        if (!page) throw new Error('HISTORY_CHATS_SHAPE');
        if (!page.length) { exhausted = true; break; }
        for (const raw of page) {
          if (!record(raw) || !historyAddress(raw.remoteJid)) throw new Error('HISTORY_CHAT_IDENTITY_INCOMPLETE');
          if (rows.has(raw.remoteJid)) throw new Error('HISTORY_PAGINATION');
          const last = record(raw.lastMessage) ? raw.lastMessage : null;
          const alt = last && record(last.key) ? last.key.remoteJidAlt : null;
          const pn = phoneJid(raw.remoteJid) ? raw.remoteJid : phoneJid(raw.remoteJidAlt) ? raw.remoteJidAlt : phoneJid(alt) ? alt : null;
          if (!pn && raw.remoteJid.endsWith('@lid')) throw new Error('HISTORY_CHAT_IDENTITY_INCOMPLETE');
          const chat = { remoteJid: raw.remoteJid, phoneJid: pn ?? raw.remoteJid, pushName: typeof raw.pushName === 'string' ? usableContactName(raw.pushName) : null, profilePicUrl: typeof raw.profilePicUrl === 'string' && /^https:\/\//i.test(raw.profilePicUrl) ? raw.profilePicUrl : null };
          budget.reserve(chat); rows.set(raw.remoteJid, chat);
        }
        offset += page.length;
      }
      if (!exhausted) throw new Error('HISTORY_PAGE_LIMIT');
      const chats = [...rows.values()].sort((a, b) => a.remoteJid.localeCompare(b.remoteJid)), current = historyDigest(chats.map(chat => [chat.remoteJid, chat.phoneJid]));
      if (current === previous) return { chats, unresolvedLids: 0 };
      previous = current;
    }
    throw new Error('HISTORY_UNSTABLE');
  }
  async function recoveryMessages(input: { instanceName: string; remoteJid: string; from: Date; to: Date }): Promise<HistoryRecord[]> {
    if (!historyAddress(input.remoteJid) || !Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()) || input.from > input.to) throw new Error('HISTORY_WINDOW');
    let previous: string | undefined;
    for (let pass = 0; pass < 3; pass++) {
      const rows = new Map<string, HistoryRecord>(), seen = new Set<string>(), budget = new HistoryMemoryBudget(); let pageCount: number | undefined, total: number | null = null;
      for (let index = 1; index <= (pageCount ?? 1); index++) {
        const result = await page(input.instanceName, { remoteJid: input.remoteJid }, index);
        if (pageCount !== undefined && pageCount !== result.pages) throw new Error('HISTORY_UNSTABLE');
        pageCount = result.pages;
        if ((pageCount > 1 && !result.records.length) || (pageCount === 0 && result.records.length)) throw new Error('HISTORY_PAGINATION');
        if (total !== null && result.total !== total) throw new Error('HISTORY_UNSTABLE');
        total = result.total;
        for (const raw of result.records) {
          const item = parse(raw);
          if (item.key.remoteJid !== input.remoteJid) throw new Error('HISTORY_IDENTITY');
          const identity = exactRecordIdentity(item);
          if (identity.kind !== 'consistent') throw new Error('HISTORY_IDENTITY');
          const key = stable(identity.key);
          if (seen.has(key)) throw new Error('HISTORY_PAGINATION');
          budget.reserve(key); seen.add(key);
          // Exhaustion and exact identity cover every row. Retain payloads only
          // for the requested interval, so old history cannot exhaust the worker.
          if (item.messageTimestamp * 1000 >= input.from.getTime() && item.messageTimestamp * 1000 <= input.to.getTime()) {
            budget.reserve(item); rows.set(key, item);
          }
        }
      }
      if (total !== null && seen.size !== total) throw new Error('HISTORY_PAGINATION');
      const records = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
      const current = historyDigest(records);
      if (current === previous) return records.sort((a, b) => a.messageTimestamp - b.messageTimestamp || stable(a.key).localeCompare(stable(b.key)));
      previous = current;
    }
    throw new Error('HISTORY_UNSTABLE');
  }
  return {
    findMessageExact, recoveryChats, recoveryMessages,
    /** Raw single-request recovery primitives. The engine owns durable traversal and
     * two exhausted manifests; no timestamp predicate is assumed on this provider. */
    async recoveryChatPage(input: { instanceName: string; offset: number; signal: AbortSignal }) {
      if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset >= 100_000) throw new Error('HISTORY_PAGE_LIMIT');
      const data = await post(`/chat/findChats/${encodeURIComponent(input.instanceName)}`, { take: 100, skip: input.offset }, undefined, input.signal);
      const rows = Array.isArray(data) ? data : record(data) && Array.isArray(data.chats) ? data.chats : null;
      if (!rows || rows.length > 100) throw new Error('HISTORY_CHATS_SHAPE');
      const chats = rows.map(raw => {
        if (!record(raw) || !historyAddress(raw.remoteJid)) throw new Error('HISTORY_CHAT_IDENTITY_INCOMPLETE');
        const last = record(raw.lastMessage) ? raw.lastMessage : null;
        const alt = last && record(last.key) ? last.key.remoteJidAlt : null;
        const pn = phoneJid(raw.remoteJid) ? raw.remoteJid : phoneJid(raw.remoteJidAlt) ? raw.remoteJidAlt : phoneJid(alt) ? alt : null;
        if (!pn && raw.remoteJid.endsWith('@lid')) throw new Error('HISTORY_CHAT_IDENTITY_INCOMPLETE');
        return { remoteJid: raw.remoteJid, phoneJid: pn ?? raw.remoteJid };
      });
      historyDigest(chats);
      return { chats };
    },
    async recoveryMessagePage(input: { instanceName: string; remoteJid: string; page: number; from: Date; to: Date; signal: AbortSignal }) {
      if (!historyAddress(input.remoteJid) || !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 2
        || !Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()) || input.from > input.to) throw new Error('HISTORY_WINDOW');
      // Source contract: Evolution 5624bda fetchMessages accepts ISO gte/lte and
      // orders by timestamp DESC. A single bounded batch avoids offset tie ordering.
      // Capacity 5000 is also used by exact lookup; the existing 8MiB scan cap remains.
      const data = await post(`/chat/findMessages/${encodeURIComponent(input.instanceName)}`, {
        where: { key: { remoteJid: input.remoteJid }, messageTimestamp: { gte: input.from.toISOString(), lte: input.to.toISOString() } },
        page: input.page, offset: 5000
      }, undefined, input.signal);
      if (!record(data) || !record(data.messages) || !Array.isArray(data.messages.records)) throw new Error('HISTORY_SHAPE');
      const value = data.messages;
      if (!Array.isArray(value.records)) throw new Error('HISTORY_SHAPE');
      if (!Number.isSafeInteger(value.total) || Number(value.total) < 0 || Number(value.total) > 5000
        || value.currentPage !== input.page || value.pages !== Math.ceil(Number(value.total) / 5000)
        || value.records.length !== Math.min(5000, Math.max(0, Number(value.total) - (input.page - 1) * 5000))) throw new Error('HISTORY_PAGINATION');
      const records = value.records.map(raw => {
        const item = parse(raw);
        if (item.key.remoteJid !== input.remoteJid || exactRecordIdentity(item).kind !== 'consistent') throw new Error('HISTORY_IDENTITY');
        if (item.messageTimestamp * 1000 < input.from.getTime() || item.messageTimestamp * 1000 > input.to.getTime()) throw new Error('HISTORY_FILTER_IGNORED');
        return item;
      });
      historyDigest(records);
      return { records, pages: Number(value.pages), total: Number(value.total) };
    },
    /** Network-only API; use a proven canonical source/key outside the DB transaction. */
    async mediaExact(input: { instanceName: string; key: WhatsAppMessageKey; purpose: MediaPurpose }) {
      const deadline = AbortSignal.timeout(exactLookupTimeoutMs);
      const found = await lookupExact(input, deadline);
      if (found.kind !== 'resolved') return found;
      return { kind: 'resolved' as const, record: found.record, mediaUrl: await mediaData(input.instanceName, found.record, input.purpose, deadline) };
    },
    async loadExact(input: { instanceName: string; key: WhatsAppMessageKey; from: Date; to: Date }) {
      if (!Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()) || input.from > input.to) throw new Error('HISTORY_WINDOW');
      const anchor = await findMessageExact(input);
      if (anchor.kind !== 'resolved') return anchor;
      const identities = [...new Set([anchor.record.key.remoteJid, ...(anchor.record.key.remoteJidAlt && explicitAddressMatch(normalizeChatAddress(anchor.record.key.remoteJidAlt), anchor.record.key.remoteJid, anchor.record.key.remoteJidAlt) ? [anchor.record.key.remoteJidAlt] : [])])];
      let previous: string | undefined;
      for (let pass = 0; pass < 3; pass++) {
        const rows = new Map<string, HistoryRecord>();
        for (const jid of identities) {
          let pages = 1;
          for (let index = 1; index <= pages; index++) {
            const result = await page(input.instanceName, { remoteJid: jid }, index); pages = Math.max(pages, result.pages);
            for (const raw of result.records) {
              const item = parse(raw);
              if (!identities.includes(item.key.remoteJid)) throw new Error('HISTORY_IDENTITY');
              const identity = exactRecordIdentity(item);
              if (identity.kind !== 'consistent') return { kind: identity.kind };
              const ms = item.messageTimestamp * 1000;
              if (ms < input.from.getTime() || ms > input.to.getTime()) continue;
              const tuple = JSON.stringify(identity.key), prior = rows.get(tuple);
              if (prior && digest(prior) !== digest(item)) return { kind: 'ambiguous' as const };
              rows.set(tuple, item);
            }
          }
        }
        const records = [...rows.values()].sort((a, b) => a.messageTimestamp - b.messageTimestamp || JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
        const current = digest(records);
        if (current === previous) return { kind: 'resolved' as const, records };
        previous = current;
      }
      throw new Error('HISTORY_UNSTABLE');
    },
    async recentContacts(input: { instanceName: string }): Promise<RecentEvolutionContact[]> {
      const contacts = new Map<string, RecentEvolutionContact>();
      for (let offset = 0; offset < 100000; offset += 1000) {
        const data = await post(`/chat/findContacts/${encodeURIComponent(input.instanceName)}`, { take: 1000, skip: offset });
        const rows = Array.isArray(data) ? data : record(data) && Array.isArray(data.contacts) ? data.contacts : null;
        if (!rows) throw new Error('HISTORY_CONTACTS_SHAPE');
        for (const raw of rows) {
          if (!record(raw) || !direct(raw.remoteJid)) continue;
          const previous = contacts.get(raw.remoteJid);
          contacts.set(raw.remoteJid, {
            phoneJid: raw.remoteJid,
            name: (typeof raw.pushName === 'string' ? usableContactName(raw.pushName) : null) ?? previous?.name ?? null,
            profilePicUrl: typeof raw.profilePicUrl === 'string' && /^https:\/\//i.test(raw.profilePicUrl) ? raw.profilePicUrl : previous?.profilePicUrl ?? null
          });
        }
        if (rows.length < 1000) return [...contacts.values()];
      }
      throw new Error('HISTORY_CONTACT_LIMIT');
    },
    async recentChats(input: { instanceName: string; limit: number; since?: Date }): Promise<RecentEvolutionChats> {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error('HISTORY_CHAT_LIMIT');
      const chats: RecentEvolutionChat[] = [];
      const seen = new Set<string>();
      let unresolvedLids = 0;
      // Evolution's chat ordering can shift between requests. Read the largest
      // supported batch first so pagination does not skip contacts between pages.
      let pageSize = Math.max(100, input.limit);
      for (let offset = 0; offset < 10000 && chats.length < input.limit;) {
        const data = await post(`/chat/findChats/${encodeURIComponent(input.instanceName)}`, { take: pageSize, skip: offset });
        const rows = Array.isArray(data) ? data : record(data) && Array.isArray(data.chats) ? data.chats : null;
        if (!rows) throw new Error('HISTORY_CHATS_SHAPE');
        for (const raw of rows) {
          if (!record(raw) || !direct(raw.remoteJid)) continue;
          const last = record(raw.lastMessage) ? raw.lastMessage : null;
          const lastAt = activityTime(last?.messageTimestamp ?? raw.lastMessageAt ?? raw.messageTimestamp);
          if (input.since && lastAt !== null && lastAt < input.since.getTime()) continue;
          const alternate = record(raw.lastMessage) && record(raw.lastMessage.key) ? raw.lastMessage.key.remoteJidAlt : null;
          const resolvedPhoneJid = phoneJid(raw.remoteJid) ? raw.remoteJid : phoneJid(raw.remoteJidAlt) ? raw.remoteJidAlt : phoneJid(alternate) ? alternate : null;
          // A LID is an addressable WhatsApp identity, but never a telephone number.
          // Keep its suffix so it cannot collide with a real contact's phone.
          const identity = resolvedPhoneJid ?? raw.remoteJid;
          if (!resolvedPhoneJid) unresolvedLids++;
          if (seen.has(identity)) continue;
          seen.add(identity);
          chats.push({
            remoteJid: raw.remoteJid,
            phoneJid: identity,
            // The last message's pushName only names the contact when they sent it;
            // on our own messages it is this side's label (e.g. "Você").
            pushName: (typeof raw.pushName === 'string' ? usableContactName(raw.pushName) : null)
              ?? (last && record(last.key) && last.key.fromMe === false && typeof last.pushName === 'string' ? usableContactName(last.pushName) : null),
            profilePicUrl: typeof raw.profilePicUrl === 'string' && /^https:\/\//i.test(raw.profilePicUrl) ? raw.profilePicUrl : null
          });
          if (chats.length === input.limit) break;
        }
        if (rows.length < pageSize) {
          // Older Evolution installations may cap responses at 100 rows.
          if (pageSize > 100 && rows.length === 100) {
            offset += 100;
            pageSize = 100;
            continue;
          }
          break;
        }
        offset += pageSize;
      }
      return { chats, unresolvedLids };
    },
    async recentMessages(input: { instanceName: string; remoteJid: string; limit: number }): Promise<HistoryRecord[]> {
      if (!direct(input.remoteJid)) throw new Error('HISTORY_IDENTITY');
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new Error('HISTORY_MESSAGE_LIMIT');
      const rows: unknown[] = [];
      const pageSize = Math.min(input.limit, 100);
      for (let index = 1; rows.length < input.limit; index++) {
        const data = await post(`/chat/findMessages/${encodeURIComponent(input.instanceName)}`, {
          where: { key: { remoteJid: input.remoteJid } }, page: index, offset: pageSize
        });
        if (!record(data) || !record(data.messages) || !Array.isArray(data.messages.records)) throw new Error('HISTORY_SHAPE');
        rows.push(...data.messages.records.slice(0, input.limit - rows.length));
        const pages = Number(data.messages.pages);
        if (data.messages.records.length < pageSize || (Number.isInteger(pages) && index >= pages)) break;
      }
      const readable = rows.filter((raw) => record(raw) && record(raw.message));
      const records = readable.map(parse);
      if (records.some((item) => item.key.remoteJid !== input.remoteJid)) throw new Error('HISTORY_IDENTITY');
      return records.sort((a, b) => a.messageTimestamp - b.messageTimestamp || a.key.id.localeCompare(b.key.id));
    },
    /** Legacy ID-only API: callers remain legacy until explicit conversion. */
    async findMessage(input: { instanceName: string; id: string }): Promise<HistoryRecord | null> {
      if (!input.id) throw new Error('HISTORY_MESSAGE_ID');
      const data = await post(`/chat/findMessages/${encodeURIComponent(input.instanceName)}`, {
        where: { key: { id: input.id } }, page: 1, offset: 10
      });
      if (!record(data) || !record(data.messages) || !Array.isArray(data.messages.records)) throw new Error('HISTORY_SHAPE');
      const matches = data.messages.records.filter((item) => record(item) && record(item.key) && item.key.id === input.id).map(parse);
      // Evolution may return the same WhatsApp observation under multiple DB row
      // IDs. Only equivalent validated records collapse; another chat, direction,
      // participant, timestamp or content remains ambiguous and is never chosen.
      const unique = new Map(matches.map(item => [stable(item), item]));
      if (unique.size > 1) throw new Error('HISTORY_DUPLICATE_MESSAGE');
      return unique.values().next().value ?? null;
    },
    async hasPriorMessages(input: { instanceName: string; remoteJid: string; excludeMessageId?: string | null; before?: Date }): Promise<boolean> {
      if (!direct(input.remoteJid)) throw new Error('HISTORY_IDENTITY');
      const beforeSeconds = input.before ? Math.floor(input.before.getTime() / 1000) : null;
      if (beforeSeconds !== null && !Number.isFinite(beforeSeconds)) throw new Error('HISTORY_WINDOW');
      const data = await post(`/chat/findMessages/${encodeURIComponent(input.instanceName)}`, {
        where: { key: { remoteJid: input.remoteJid } }, page: 1, offset: 100
      });
      if (!record(data) || !record(data.messages) || !Array.isArray(data.messages.records)) throw new Error('HISTORY_SHAPE');
      return data.messages.records.some((raw) => {
        if (!record(raw) || !record(raw.key) || typeof raw.key.id !== 'string' || !raw.key.id) return true;
        if (raw.key.id === (input.excludeMessageId ?? null)) return false;
        if (beforeSeconds === null) return true;
        const timestamp = Number(raw.messageTimestamp);
        if (raw.messageTimestamp === null || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 1e11) return true;
        return timestamp < beforeSeconds;
      });
    },
    /** Legacy anchor API. Canonical callers must use loadExact. */
    async load(input: { instanceName: string; anchorId: string; from: Date; to: Date }): Promise<HistoryRecord[]> {
      if (!input.anchorId || !Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()) || input.from > input.to) throw new Error('HISTORY_WINDOW');
      const anchorPage = await page(input.instanceName, { id: input.anchorId }, 1);
      if (anchorPage.records.length !== 1 || !record(anchorPage.records[0]) || !record(anchorPage.records[0].key) || anchorPage.records[0].key.id !== input.anchorId) throw new Error('HISTORY_ANCHOR');
      const anchor = parse(anchorPage.records[0]);
      const identities = [...new Set([anchor.key.remoteJid, ...(anchor.key.remoteJidAlt ? [anchor.key.remoteJidAlt] : [])])];
      let previous: string | undefined;
      for (let pass = 0; pass < 3; pass++) {
        const records = new Map<string, HistoryRecord>();
        for (const jid of identities) {
          let pages = 1;
          for (let index = 1; index <= pages; index++) {
            const result = await page(input.instanceName, { remoteJid: jid }, index);
            pages = Math.max(pages, result.pages);
            for (const raw of result.records) {
              // A non-direct result is identity contamination, not a silently skipped group.
              if (!record(raw) || !record(raw.key) || !identities.includes(String(raw.key.remoteJid))) throw new Error('HISTORY_IDENTITY');
              const item = parse(raw);
              const ms = item.messageTimestamp * 1000;
              if (ms < input.from.getTime() || ms > input.to.getTime()) continue;
              const prior = records.get(item.key.id);
              if (prior && digest(prior) !== digest(item)) throw new Error('HISTORY_CONFLICT');
              records.set(item.key.id, item);
            }
          }
        }
        const sorted = [...records.values()].sort((a, b) => a.messageTimestamp - b.messageTimestamp || a.key.id.localeCompare(b.key.id));
        const current = digest(sorted);
        if (current === previous) return sorted;
        previous = current;
      }
      throw new Error('HISTORY_UNSTABLE');
    },
    /** Legacy media API. Canonical callers must use mediaExact. */
    async media(input: { instanceName: string; id: string }) {
      const data = await post(`/chat/getBase64FromMediaMessage/${encodeURIComponent(input.instanceName)}`, { message: { key: { id: input.id } }, convertToMp4: false });
      if (!record(data) || typeof data.base64 !== 'string' || typeof data.mimetype !== 'string') throw new Error('HISTORY_MEDIA_SHAPE');
      const mime = data.mimetype.split(';')[0].trim().toLowerCase();
      if (!/^(image\/(jpeg|png|webp)|audio\/(mpeg|mp3|mp4|m4a|x-m4a|wav|x-wav|ogg|opus|webm)|application\/pdf)$/.test(mime)) throw new Error('HISTORY_MEDIA_TYPE');
      const base64 = data.base64.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
      if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || Buffer.from(base64, 'base64').length > 8 * 1024 * 1024) throw new Error('HISTORY_MEDIA_LIMIT');
      return `data:${mime};base64,${base64}`;
    }
  };
}
export type EvolutionHistorySource = ReturnType<typeof createEvolutionHistorySource>;
