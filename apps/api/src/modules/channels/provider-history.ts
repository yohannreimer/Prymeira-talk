import { stable } from '../messaging/canonical-values.js';
import { randomUUID } from 'node:crypto';
import type { ChannelConnection, PrismaClient } from '@prisma/client';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import type { EvolutionHistorySource, HistoryRecord } from '../evolution/evolution-history.js';
import { isWahaNotice, normalizeWahaEvent } from '../waha/waha-normalizer.js';
import type { WahaClient, WahaMessage } from '../waha/waha.client.js';
import type { LidMapping, WahaLidResolver } from '../waha/waha-lid-resolver.js';
import { normalizeChatAddress, parseWahaMessageKey, record, serialized } from '../messaging/whatsapp-identity.js';
import { normalizeWhatsappPhone } from './channel-connections.js';
import { fillContactDetails, persistProviderMessages, type AfterPersist, type CanonicalHistoryChannel, type ProviderMessageItem } from './channel-history-canonical.js';

/**
 * History and gap recovery read back from either provider. Evolution and WAHA expose history differently
 * (Evolution: its own database, filled by its sync; WAHA WPP: what the WhatsApp Web session has loaded), so both feed
 * the same canonical store and the store's exact identity keeps one message per WhatsApp message.
 */
export type ProviderChat = { remoteJid: string; chatAddress: string; name: string | null; avatarUrl: string | null; lastActivityMs: number | null; lidMappings?: LidMapping[] };
export type ProviderHistoryDeps = { evolution?: Pick<EvolutionHistorySource, 'recentChats' | 'recentMessages'> & Partial<Pick<EvolutionHistorySource, 'recoveryChats' | 'recoveryMessages'>> | null; waha?: Pick<WahaClient, 'getChats' | 'getMessages'> | null; wahaLids?: Pick<WahaLidResolver, 'lookup'> | null; after?: AfterPersist };

const HISTORY_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;
const RECOVERY_OVERLAP_MS = 10 * 60 * 1000;
/** Live webhooks normally land within seconds; recovery never races the newest moments. */
const RECOVERY_SETTLE_MS = 30 * 1000;
/** A connection without a checkpoint starts recovery from here; older context is the history import's job. */
const RECOVERY_FIRST_WINDOW_MS = 15 * 60 * 1000;

const seconds = (value: unknown) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
};

/** WAHA chats Talk can attribute on their own: phone chats and groups. A chat known only by a LID needs WAHA's own
 * LID→phone answer (see listWahaChats); without it, importing would create a second conversation for the person. */
export function wahaChatAddress(id: unknown): string | null {
  const address = normalizeChatAddress(serialized(id));
  return address && !address.endsWith('@lid') ? address : null;
}

export async function listWahaChats(client: Pick<WahaClient, 'getChats'>, session: string, input: { limit: number; sinceMs?: number; lids?: Pick<WahaLidResolver, 'lookup'> | null }): Promise<ProviderChat[]> {
  const chats: ProviderChat[] = [];
  for (let offset = 0; offset < 100_000 && chats.length < input.limit; offset += 100) {
    const page = await client.getChats({ session, limit: 100, offset }) as unknown[];
    if (!Array.isArray(page) || !page.length) break;
    for (const item of page) {
      const chat = record(item), remoteJid = serialized(chat.id);
      let chatAddress = wahaChatAddress(chat.id), lidMappings: LidMapping[] | undefined;
      const lid = normalizeChatAddress(remoteJid);
      if (!chatAddress && lid?.endsWith('@lid') && input.lids) {
        const pn = await input.lids.lookup(session, lid);
        if (pn) { chatAddress = pn; lidMappings = [{ lid, pn }]; }
      }
      if (!remoteJid || !chatAddress) continue;
      const lastActivityMs = seconds(chat.timestamp) ?? seconds(chat.conversationTimestamp) ?? seconds(record(chat.lastMessage).timestamp);
      if (input.sinceMs !== undefined && lastActivityMs !== null && lastActivityMs < input.sinceMs) continue;
      chats.push({ remoteJid, chatAddress, name: typeof chat.name === 'string' && chat.name.trim() ? chat.name.trim().slice(0, 120) : null,
        avatarUrl: typeof chat.picture === 'string' && /^https:\/\//.test(chat.picture) ? chat.picture : null, lastActivityMs, ...(lidMappings ? { lidMappings } : {}) });
      if (chats.length >= input.limit) break;
    }
    if (page.length < 100) break;
  }
  return chats;
}

export function wahaItems(session: string, messages: WahaMessage[], lidMappings: LidMapping[] = []): ProviderMessageItem[] {
  return messages.flatMap(message => {
    const id = serialized(message.id), timestampMs = seconds(message.timestamp), type = record(message._data).type;
    if (!id || timestampMs === null || isWahaNotice(record(message))) return [];
    return [{ receiptId: id, timestampMs, fingerprint: stable(message), originalType: typeof type === 'string' ? type : undefined,
      normalize: context => normalizeWahaEvent(context, { event: 'message.any', session, payload: message }, { verifiedLidMappings: lidMappings }) }];
  });
}

export function evolutionItems(instance: string, records: HistoryRecord[]): ProviderMessageItem[] {
  return records.map(item => ({ receiptId: item.key.id, fingerprint: stable(item), timestampMs: item.messageTimestamp * 1000, originalType: item.messageType,
    normalize: context => normalizeEvolutionWebhook(context, { event: 'messages.upsert', instance, data: item }) }));
}

async function chatsSince(deps: ProviderHistoryDeps, connection: ChannelConnection, sinceMs: number, limit: number): Promise<ProviderChat[]> {
  if (connection.provider === 'waha') {
    if (!deps.waha) throw new Error('HISTORY_PROVIDER_UNAVAILABLE');
    return listWahaChats(deps.waha, connection.sessionName, { limit, sinceMs, lids: deps.wahaLids });
  }
  if (!deps.evolution) throw new Error('HISTORY_PROVIDER_UNAVAILABLE');
  const { chats } = await deps.evolution.recentChats({ instanceName: connection.sessionName, limit: Math.min(limit, 1000), since: new Date(sinceMs) });
  return chats.flatMap(chat => {
    const chatAddress = normalizeChatAddress(chat.remoteJid);
    return chatAddress ? [{ remoteJid: chat.remoteJid, chatAddress, name: chat.pushName, avatarUrl: chat.profilePicUrl, lastActivityMs: null }] : [];
  });
}

async function chatItems(deps: ProviderHistoryDeps, connection: ChannelConnection, chat: ProviderChat, limit: number): Promise<ProviderMessageItem[]> {
  if (connection.provider === 'waha') {
    if (!deps.waha) throw new Error('HISTORY_PROVIDER_UNAVAILABLE');
    const messages = await deps.waha.getMessages({ session: connection.sessionName, chatId: chat.remoteJid, limit });
    return wahaItems(connection.sessionName, Array.isArray(messages) ? messages : [], chat.lidMappings);
  }
  if (!deps.evolution) throw new Error('HISTORY_PROVIDER_UNAVAILABLE');
  return evolutionItems(connection.sessionName, await deps.evolution.recentMessages({ instanceName: connection.sessionName, remoteJid: chat.remoteJid, limit }));
}

/** Offset APIs do not supply a snapshot token. Require two identical, exhausted scans; a
 * repeated page (ignored offset), changed tuple, unknown shape or safety ceiling is incomplete.
 * Even a short page is followed by another request: provider-side caps are not exhaustion. */
async function stableOffsetScan<T>(read: (offset: number) => Promise<T[]>, identity: (item: T) => string, signature: (item: T) => unknown = item => item): Promise<T[]> {
  let previous: string | undefined;
  for (let pass = 0; pass < 3; pass++) {
    const rows = new Map<string, T>();
    let exhausted = false;
    for (let offset = 0; offset < 100_000;) {
      const page = await read(offset);
      if (!Array.isArray(page)) throw new Error('HISTORY_SHAPE');
      if (!page.length) { exhausted = true; break; }
      for (const item of page) {
        const key = identity(item);
        if (!key || rows.has(key)) throw new Error('HISTORY_PAGINATION');
        rows.set(key, item);
      }
      offset += page.length;
    }
    if (!exhausted) throw new Error('HISTORY_PAGE_LIMIT');
    const sorted = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));
    const current = stable(sorted.map(([key, item]) => [key, signature(item)]));
    if (current === previous) return sorted.map(([, item]) => item);
    previous = current;
  }
  throw new Error('HISTORY_UNSTABLE');
}
async function recoveryChats(deps: ProviderHistoryDeps, connection: ChannelConnection, start: number, end: number): Promise<ProviderChat[]> {
  if (connection.provider === 'evolution') {
    if (!deps.evolution) throw new Error('HISTORY_PROVIDER_UNAVAILABLE');
    if (!deps.evolution.recoveryChats) throw new Error('HISTORY_COMPLETENESS_UNSUPPORTED');
    const { chats } = await deps.evolution.recoveryChats({ instanceName: connection.sessionName, from: new Date(start), to: new Date(end) });
    return chats.map(chat => ({ remoteJid: chat.remoteJid, chatAddress: normalizeChatAddress(chat.phoneJid)!, name: chat.pushName, avatarUrl: chat.profilePicUrl, lastActivityMs: null }));
  }
  if (!deps.waha) throw new Error('HISTORY_PROVIDER_UNAVAILABLE');
  const rows = await stableOffsetScan(offset => deps.waha!.getChats({ session: connection.sessionName, limit: 100, offset }) as Promise<unknown[]>, item => serialized(record(item).id) ?? '', item => serialized(record(item).id));
  // An unresolved address in the interval cannot certify that interval as reconciled.
  for (const item of rows) {
    const id = normalizeChatAddress(serialized(record(item).id));
    if (id?.endsWith('@lid') && !await deps.wahaLids?.lookup(connection.sessionName, id)) throw new Error('HISTORY_CHAT_IDENTITY_INCOMPLETE');
  }
  return listWahaChats({ getChats: async ({ offset = 0, limit = 100 }) => rows.slice(offset, offset + limit) } as never, connection.sessionName, { limit: rows.length, sinceMs: start, lids: deps.wahaLids });
}
async function recoveryItems(deps: ProviderHistoryDeps, connection: ChannelConnection, chat: ProviderChat, start: number, end: number, pageSize: number) {
  if (connection.provider === 'evolution') {
    if (!deps.evolution?.recoveryMessages) throw new Error('HISTORY_COMPLETENESS_UNSUPPORTED');
    return evolutionItems(connection.sessionName, await deps.evolution.recoveryMessages({ instanceName: connection.sessionName, remoteJid: chat.remoteJid, from: new Date(start), to: new Date(end) }));
  }
  const messages = await stableOffsetScan(offset => deps.waha!.getMessages({ session: connection.sessionName, chatId: chat.remoteJid, limit: pageSize, offset }), message => serialized(message.id) ?? '');
  // Malformed, non-notice rows must not disappear while advancing the checkpoint.
  if (messages.some(message => !isWahaNotice(record(message)) && (!serialized(message.id) || seconds(message.timestamp) === null))) throw new Error('HISTORY_RECORD');
  return wahaItems(connection.sessionName, messages, chat.lidMappings);
}

const channelOf = async (prisma: PrismaClient, connection: ChannelConnection): Promise<CanonicalHistoryChannel & { historyImportStatus: string | null }> => {
  const channel = await prisma.channel.findUniqueOrThrow({ where: { id: connection.channelId } });
  return { id: channel.id, workspaceId: channel.workspaceId, providerKey: channel.providerKey, historyImportStatus: channel.historyImportStatus };
};

/** WAHA history after Evolution's: the same window and size as the first-connection import (15 days, 30 messages per
 * chat). Whatever Evolution already brought is found as a duplicate; only what it lacked is added. */
export async function importConnectionHistory(prisma: PrismaClient, deps: ProviderHistoryDeps, connection: ChannelConnection, options: { chatLimit?: number; perChat?: number; now?: number } = {}) {
  const channel = await channelOf(prisma, connection);
  const now = options.now ?? Date.now();
  const chats = await chatsSince(deps, connection, now - HISTORY_WINDOW_MS, options.chatLimit ?? 300);
  let inserted = 0, held = 0;
  for (const chat of chats) {
    const items = (await chatItems(deps, connection, chat, options.perChat ?? 30)).filter(item => item.timestampMs >= now - HISTORY_WINDOW_MS);
    if (!items.length) continue;
    const result = await persistProviderMessages({ prisma, channel, connection: { id: connection.id, provider: connection.provider }, mode: 'history', items, batchId: randomUUID(), after: deps.after });
    inserted += result.inserted; held += result.held;
    if (result.conversationId && !chat.chatAddress.endsWith('@g.us')) await fillContactDetails(prisma, channel.workspaceId, result.conversationId, { name: chat.name, avatarUrl: chat.avatarUrl });
  }
  return { chats: chats.length, inserted, held };
}

/**
 * Gap recovery for one connection: reads back what the provider has between the persistent checkpoint (minus an
 * overlap) and a moment slightly in the past, and reconciles it. Messages already received live are duplicates;
 * the rest enter as `recovered_live` (visible and unread, no agent or automation). The checkpoint only advances after
 * the whole window is reconciled, with a compare-and-set so two workers never move it past unreconciled messages.
 */
export async function recoverConnectionGap(prisma: PrismaClient, deps: ProviderHistoryDeps, connection: ChannelConnection, options: { now?: number; chatLimit?: number; perChat?: number } = {}) {
  const now = options.now ?? Date.now();
  const end = now - RECOVERY_SETTLE_MS;
  const start = (connection.recoveredThroughAt?.getTime() ?? now - RECOVERY_FIRST_WINDOW_MS) - RECOVERY_OVERLAP_MS;
  if (end <= start) return { recovered: 0, chats: 0, advanced: false };
  const channel = await channelOf(prisma, connection);
  const chats = await recoveryChats(deps, connection, start, end);
  let recovered = 0, held = 0;
  const fingerprints: unknown[] = [];
  for (const chat of chats) {
    const items = (await recoveryItems(deps, connection, chat, start, end, Math.max(1, Math.min(100, options.perChat ?? 50)))).filter(item => item.timestampMs >= start && item.timestampMs <= end);
    fingerprints.push([chat.remoteJid, items.map(item => [item.receiptId, item.timestampMs, item.fingerprint])]);
    if (!items.length) continue;
    const result = await persistProviderMessages({ prisma, channel, connection: { id: connection.id, provider: connection.provider }, mode: 'recovered_live', items, batchId: randomUUID(), after: deps.after });
    recovered += result.inserted; held += result.held;
  }
  if (held) return { recovered, chats: chats.length, advanced: false, incomplete: 'canonical_hold' };
  // The provider may change while each chat is reconciled. Re-read the same fixed
  // interval before its checkpoint commits; a changed result remains retryable.
  const verifyChats = await recoveryChats(deps, connection, start, end), verified: unknown[] = [];
  for (const chat of verifyChats) {
    const items = (await recoveryItems(deps, connection, chat, start, end, Math.max(1, Math.min(100, options.perChat ?? 50)))).filter(item => item.timestampMs >= start && item.timestampMs <= end);
    verified.push([chat.remoteJid, items.map(item => [item.receiptId, item.timestampMs, item.fingerprint])]);
  }
  if (stable(fingerprints) !== stable(verified)) return { recovered, chats: chats.length, advanced: false, incomplete: 'provider_window_changed' };
  const advanced = await prisma.channelConnection.updateMany({ where: { id: connection.id, recoveredThroughAt: connection.recoveredThroughAt, lifecycleGeneration: connection.lifecycleGeneration },
    data: { recoveredThroughAt: new Date(end) } });
  return { recovered, chats: chats.length, advanced: advanced.count === 1 };
}

/** A WAHA connection may only read history for a channel when it is proven to be the same number as Evolution. */
export async function pairedConnections(prisma: PrismaClient, input: { workspaceIds?: readonly string[] }) {
  const connections = await prisma.channelConnection.findMany({ include: { channel: { select: { verifiedMessagingPhoneNumber: true } } }, where: { channel: { archivedAt: null }, OR: [{ status: 'connected' }, { provider: 'evolution', verifiedPhoneNumber: { not: null } }], ...(input.workspaceIds ? { workspaceId: { in: [...input.workspaceIds] } } : {}) } });
  const byChannel = new Map<string, ChannelConnection[]>();
  for (const connection of connections) byChannel.set(connection.channelId, [...(byChannel.get(connection.channelId) ?? []), connection]);
  return connections.filter(connection => {
    if (connection.status !== 'connected' || connection.lifecycleGeneration % 2 !== 0) return false; // A QR/logout operation is in flight.
    // A failed provider probe can retain the last connected status. Eligibility is
    // the current proof: do not keep polling history for an unavailable instance.
    if (connection.provider === 'evolution') return connection.eligible;
    // A WAHA session whose engine is not connected, or that stopped receiving, is not read: it would only time out.
    if (!connection.eligible) return false;
    const primary = byChannel.get(connection.channelId)?.find(c => c.provider === 'evolution');
    const a = normalizeWhatsappPhone(primary?.verifiedPhoneNumber), b = normalizeWhatsappPhone(connection.verifiedPhoneNumber);
    const anchor = normalizeWhatsappPhone(connection.channel?.verifiedMessagingPhoneNumber);
    if (anchor) return anchor === b && !!connection.lastHealthyAt && (!a || a === anchor);
    return !!a && a === b && !!connection.lastHealthyAt && !!primary;
  });
}

export async function recoverGapsSweep(prisma: PrismaClient, deps: ProviderHistoryDeps, input: { workspaceIds?: readonly string[]; deferWahaUntilImported?: boolean; onError?: (error: unknown, connectionId: string) => void } = {}) {
  let recovered = 0;
  for (const connection of await pairedConnections(prisma, input)) {
    if (input.deferWahaUntilImported && connection.provider === 'waha' && !connection.historyImportedAt) continue;
    try { recovered += (await recoverConnectionGap(prisma, deps, connection)).recovered; }
    catch (error) { input.onError?.(error, connection.id); }
  }
  return { recovered };
}

/** Complementary WAHA history: once per WAHA connection, after Evolution's first import has finished. */
export async function wahaHistorySweep(prisma: PrismaClient, deps: ProviderHistoryDeps, input: { workspaceIds?: readonly string[]; onError?: (error: unknown, connectionId: string) => void } = {}) {
  let imported = 0;
  for (const connection of (await pairedConnections(prisma, input)).filter(c => c.provider === 'waha' && !c.historyImportedAt)) {
    const channel = await prisma.channel.findUnique({ where: { id: connection.channelId }, select: { historyImportStatus: true } });
    if (channel?.historyImportStatus === 'pending' && deps.evolution) continue; // Evolution first when it is configured; WAHA-only must still progress.
    try {
      await importConnectionHistory(prisma, deps, connection);
      await prisma.channelConnection.updateMany({ where: { id: connection.id, historyImportedAt: null }, data: { historyImportedAt: new Date() } });
      imported++;
    } catch (error) { input.onError?.(error, connection.id); }
  }
  return { imported };
}

/** Exact message id both providers agree on: Evolution's stanza id, and WAHA's serialized id reduced to it. */
function stanzaOf(provider: 'evolution' | 'waha', item: ProviderMessageItem) {
  if (provider === 'evolution') return item.receiptId;
  const key = parseWahaMessageKey(item.receiptId);
  return key.rawId ?? key.nativeId ?? item.receiptId;
}

export type HistoryComparison = {
  chats: Array<{ chatAddress: string; evolution: number; waha: number; onlyEvolution: number; onlyWaha: number; both: number }>;
  skippedLidChats: number; totals: { evolution: number; waha: number; onlyEvolution: number; onlyWaha: number; both: number };
};

/** Read-only: for the most recent chats, what each provider returns, matched by exact message id. Writes nothing. */
export async function compareProviderHistories(deps: Required<ProviderHistoryDeps>, input: { evolutionSession: string; wahaSession: string; chatLimit?: number; perChat?: number }): Promise<HistoryComparison> {
  const perChat = input.perChat ?? 50;
  const { chats } = await deps.evolution!.recentChats({ instanceName: input.evolutionSession, limit: input.chatLimit ?? 20 });
  const wahaChats = await listWahaChats(deps.waha!, input.wahaSession, { limit: 500, lids: deps.wahaLids });
  const wahaByAddress = new Map(wahaChats.map(chat => [chat.chatAddress, chat]));
  const result: HistoryComparison = { chats: [], skippedLidChats: 0, totals: { evolution: 0, waha: 0, onlyEvolution: 0, onlyWaha: 0, both: 0 } };
  for (const chat of chats) {
    const chatAddress = normalizeChatAddress(chat.phoneJid) ?? normalizeChatAddress(chat.remoteJid);
    if (!chatAddress || chatAddress.endsWith('@lid')) { result.skippedLidChats++; continue; }
    const evolution = new Set(evolutionItems(input.evolutionSession, await deps.evolution!.recentMessages({ instanceName: input.evolutionSession, remoteJid: chat.remoteJid, limit: perChat })).map(item => stanzaOf('evolution', item)));
    const wahaChat = wahaByAddress.get(chatAddress);
    const waha = new Set(wahaChat ? wahaItems(input.wahaSession, await deps.waha!.getMessages({ session: input.wahaSession, chatId: wahaChat.remoteJid, limit: perChat }) as WahaMessage[]).map(item => stanzaOf('waha', item)) : []);
    const both = [...evolution].filter(id => waha.has(id)).length;
    const row = { chatAddress, evolution: evolution.size, waha: waha.size, onlyEvolution: evolution.size - both, onlyWaha: waha.size - both, both };
    result.chats.push(row);
    for (const key of ['evolution', 'waha', 'onlyEvolution', 'onlyWaha', 'both'] as const) result.totals[key] += row[key];
  }
  return result;
}
