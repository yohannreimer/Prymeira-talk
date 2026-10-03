import type { ChannelConnection, PrismaClient } from '@prisma/client';
import { normalizePhoneForStorage } from '../contacts/phone-normalization.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { createCanonicalStore } from '../messaging/canonical-store.js';
import { record } from '../messaging/whatsapp-identity.js';
import type { WahaLidResolver } from '../waha/waha-lid-resolver.js';
import { autoResolveAuthority } from './conversation-authority.js';
import { pairedConnections } from './provider-history.js';

const store = createCanonicalStore();
/** A LID WAHA could not answer is asked again later, more rarely each time (right after pairing WAHA is still
 * learning the account's LIDs): 5 min, 15 min, 1 h, then every 6 h. An answer is permanent (it becomes a mapping).
 * Keyed by the pairing, so a new QR asks again at once. */
const RETRY_AFTER_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const asked = new Map<string, { at: number; attempts: number }>();

/** Chats Talk only knows by a LID (no phone in their address family) and that have a conversation. */
async function unresolvedLidChats(prisma: PrismaClient, scope: { workspaceId: string; channelId: string }) {
  const [addresses, aliases, chats] = await Promise.all([
    prisma.canonicalAddress.findMany({ where: scope, select: { id: true, redirectId: true } }),
    prisma.canonicalAddressAlias.findMany({ where: scope, select: { addressId: true, address: true } }),
    prisma.canonicalChat.findMany({ where: { ...scope, state: { in: ['active', 'review'] } }, select: { addressId: true } })]);
  const parent = new Map(addresses.map(a => [a.id, a.redirectId]));
  const root = (id: string) => { for (let i = 0; parent.get(id) && i < 1000; i++) id = parent.get(id)!; return id; };
  const families = new Map<string, string[]>();
  for (const alias of aliases) { const r = root(alias.addressId); families.set(r, [...(families.get(r) ?? []), alias.address]); }
  return [...new Set(chats.map(chat => root(chat.addressId)))].flatMap(r => {
    const family = families.get(r) ?? [];
    const lid = family.find(a => a.endsWith('@lid'));
    return lid && !family.some(a => a.endsWith('@s.whatsapp.net')) ? [lid] : [];
  });
}

/**
 * Conversations known only by a hidden WhatsApp id (LID), typically from Evolution history that had no phone for the
 * chat, are resolved through WAHA's own LID→phone table. The answer is recorded as a verified mapping: the
 * conversation now shows the phone number, and when a conversation for that phone already existed the two become
 * one (the phone-number conversation stays, the other's history is read with it). Only WAHA connections proven to be
 * the same number as Evolution are asked; a LID WAHA does not know stays as it is and is asked again later.
 */
export async function resolveLidConversationsSweep(prisma: PrismaClient, deps: { lids: Pick<WahaLidResolver, 'lookup'> }, input: { workspaceIds?: readonly string[]; perSweep?: number; now?: () => number; onError?: (error: unknown, connectionId: string) => void } = {}) {
  const now = input.now ?? Date.now;
  let budget = input.perSweep ?? 20, resolved = 0, merged = 0;
  for (const connection of (await pairedConnections(prisma, input)).filter(c => c.provider === 'waha')) {
    if (budget <= 0) break;
    try {
      for (const lid of await unresolvedLidChats(prisma, { workspaceId: connection.workspaceId, channelId: connection.channelId })) {
        if (budget <= 0) break;
        const key = `${connection.id}\n${connection.connectedAt?.getTime() ?? 0}\n${lid}`, previous = asked.get(key);
        if (previous && previous.at > now() - RETRY_AFTER_MS[Math.min(previous.attempts, RETRY_AFTER_MS.length) - 1]!) continue;
        budget--; asked.set(key, { at: now(), attempts: (previous?.attempts ?? 0) + 1 });
        const pn = await deps.lids.lookup(connection.sessionName, lid);
        if (!pn) continue;
        const outcome = await applyLidMapping(prisma, connection, lid, pn);
        if (!outcome) continue;
        resolved++; asked.delete(key);
        if (outcome.review && (await autoResolveAuthority(prisma, { workspaceId: connection.workspaceId, channelId: connection.channelId, chatId: outcome.chatId })).ok) merged++;
      }
    } catch (error) { input.onError?.(error, connection.id); }
  }
  return { resolved, merged };
}

async function applyLidMapping(prisma: PrismaClient, connection: ChannelConnection, lid: string, pn: string) {
  return prisma.$transaction(async tx => {
    const context = await deriveTrustedMessagingContext(tx, { workspaceId: connection.workspaceId, channelId: connection.channelId,
      authenticatedSource: { provider: 'waha', connectionId: connection.id }, mode: 'recovered_live', observedAt: new Date().toISOString() });
    const { reason, chatId } = await store.applyLidLookupMappingInTransaction(tx, context, { lid, pn });
    if (reason) return null;
    const chat = await tx.canonicalChat.findUniqueOrThrow({ where: { id: chatId } });
    // The conversation that only had the LID as its "phone" now shows the real number, unless another contact
    // already holds it (then that one is a claimant and the review above decides).
    const phone = normalizePhoneForStorage(pn.split('@')[0]!);
    const holder = await tx.contact.findFirst({ where: { workspaceId: connection.workspaceId, phone }, select: { id: true } });
    if (!holder && chat.operationConversationId) {
      const conversation = await tx.conversation.findFirst({ where: { workspaceId: connection.workspaceId, id: chat.operationConversationId }, include: { contact: true } });
      if (conversation && conversation.contact.phone === lid) {
        await tx.contact.update({ where: { id: conversation.contact.id }, data: { phone, customFields: { ...record(conversation.contact.customFields), evolutionLid: lid } } });
      }
    }
    return { chatId, review: chat.state === 'review' };
  }, { isolationLevel: 'ReadCommitted', timeout: 30_000 });
}
