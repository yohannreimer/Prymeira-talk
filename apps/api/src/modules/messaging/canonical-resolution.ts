import type { CanonicalMessageIdentity, CanonicalNativeAlias, Prisma } from '@prisma/client';
import { enterCanonicalTransaction } from './canonical-boundary.js';
import { StaleMessagingSourceError, type MessagingProvider } from './canonical-source.js';
import { equal, nativeLookupTuple, scopeOf, sha, stable } from './canonical-values.js';
import type { TrustedMessagingContext } from './normalized-event.js';
import type { WhatsAppMessageKey } from './whatsapp-identity.js';
type Tx = Prisma.TransactionClient;
export type NativeResolution = { kind: 'missing' | 'incomplete' | 'ambiguous' | 'review' | 'stale_source' | 'forbidden_origin' }
  | { kind: 'resolved'; identity: CanonicalMessageIdentity; originMessageId: string; originConversationId: string;
      authority: { chatId: string; conversationId: string; revision: number }; key: WhatsAppMessageKey; source: TrustedMessagingContext; aliasId: string };
const fields = ['identityFormat', 'nativeId', 'rawId', 'nativeChatAddress', 'nativeSenderParticipant', 'chatAddress', 'direction', 'senderParticipant'] as const;
/** Legacy object aliases lack session/physical proof. Never guess these from current configuration. */
export function decodeNativeAlias(alias: CanonicalNativeAlias): { key: WhatsAppMessageKey; sessionName: string } | null {
  const t = alias.fullTuple;
  if (!Array.isArray(t) || t.length !== 11 || t[1] !== alias.provider || t[2] !== alias.connectionId || typeof t[3] !== 'string') return null;
  if (!['whatsapp_stanza', 'provider_native'].includes(String(t[0])) || !t.slice(4).every(v => v === null || typeof v === 'string') || (t[9] !== null && t[9] !== 'inbound' && t[9] !== 'outbound')) return null;
  return { sessionName: t[3], key: { identityFormat: t[0] as WhatsAppMessageKey['identityFormat'], nativeId: t[4] as string | null,
    rawId: t[5] as string | null, nativeChatAddress: t[6] as string | null, nativeSenderParticipant: t[7] as string | null,
    chatAddress: t[8] as string | null, direction: t[9] as WhatsAppMessageKey['direction'], senderParticipant: t[10] as string | null } };
}
function complete(key: WhatsAppMessageKey) {
  return !!key.nativeId && !!key.nativeChatAddress && !!key.chatAddress && !!key.direction
    && (key.identityFormat === 'provider_native' || !!key.rawId)
    && (key.chatAddress.endsWith('@g.us') ? !!key.senderParticipant && !!key.nativeSenderParticipant : key.senderParticipant === '');
}
async function resolveEstablished(tx: Tx, alias: CanonicalNativeAlias, source: TrustedMessagingContext, key: WhatsAppMessageKey): Promise<NativeResolution> {
  if (alias.state === 'review') return { kind: 'review' };
  if (!alias.identityId || alias.state !== 'resolved' || !complete(key)) return { kind: 'incomplete' };
  const scope = scopeOf(source);
  const identity = await tx.canonicalMessageIdentity.findFirst({ where: { ...scope, id: alias.identityId } });
  if (!identity) return { kind: 'incomplete' };
  if (identity.state !== 'active' || identity.contentState === 'pending_reconciliation') return { kind: 'review' };
  const origin = await tx.message.findFirst({ where: { workspaceId: source.workspaceId, id: identity.messageId, conversationId: identity.conversationId,
    conversation: { workspaceId: source.workspaceId, channelId: source.channelId } } });
  if (!origin) return { kind: 'incomplete' };
  if (origin.direction !== identity.direction) return { kind: 'review' };
  const addresses = await tx.canonicalAddress.findMany({ where: scope });
  const byId = new Map(addresses.map(a => [a.id, a]));
  function root(id: string): string | null {
    const seen = new Set<string>();
    while (true) {
      const a = byId.get(id);
      if (!a || a.state === 'review' || seen.has(id)) return null;
      if (!a.redirectId) return id;
      seen.add(id); id = a.redirectId;
    }
  }
  const originChat = await tx.canonicalChat.findFirst({ where: { ...scope, id: identity.chatId } });
  if (!originChat) return { kind: 'incomplete' };
  const chatRoot = root(originChat.addressId);
  if (!chatRoot) return { kind: 'review' };
  const authority = await tx.canonicalChat.findFirst({ where: { ...scope, addressId: chatRoot } });
  if (!authority || authority.state !== 'active' || !authority.operationConversationId) return { kind: 'review' };
  const chatAlias = await tx.canonicalAddressAlias.findFirst({ where: { ...scope, address: key.chatAddress! } });
  const sender = key.senderParticipant ? await tx.canonicalAddressAlias.findFirst({ where: { ...scope, address: key.senderParticipant } }) : null;
  const senderRoot = identity.senderAddressId ? root(identity.senderAddressId) : '';
  if (!chatAlias || root(chatAlias.addressId) !== chatRoot || (key.chatAddress!.endsWith('@g.us') && (!sender || !senderRoot || root(sender.addressId) !== senderRoot))) return { kind: 'review' };
  const fullTuple = [source.workspaceId, source.channelId, authority.id, key.identityFormat, key.identityFormat === 'provider_native' ? source.provider : '',
    key.identityFormat === 'provider_native' ? key.nativeId : key.rawId, key.direction, senderRoot];
  if (!equal(identity.fullTuple, fullTuple) || identity.identityFormat !== key.identityFormat || identity.providerScope !== fullTuple[4] || identity.direction !== key.direction || identity.rawId !== fullTuple[5]) return { kind: 'review' };
  // Alias creation predates lifecycle binding; observations supply immutable provenance.
  // A freshly fetched exact key must be explicitly recertified/persisted by a writer.
  const provenance = await tx.canonicalObservation.findFirst({ where: { ...scope, aliasId: alias.id, identityId: identity.id,
    provider: source.provider, connectionId: source.connectionId, sessionName: source.sessionName, lifecycleGeneration: source.lifecycleGeneration, state: 'resolved' }, select: { mode: true, receivedAt: true } });
  if (!provenance) return { kind: 'stale_source' };
  return { kind: 'resolved', identity, originMessageId: identity.messageId, originConversationId: identity.conversationId,
    authority: { chatId: authority.id, conversationId: authority.operationConversationId, revision: authority.revision }, key, source: { ...source, mode: provenance.mode as TrustedMessagingContext['mode'], observedAt: provenance.receivedAt.toISOString() }, aliasId: alias.id };
}

export function createCanonicalReads({ hash = sha }: { hash?: (value: string) => string } = {}) {
  async function lookupNativeInTransaction(tx: Tx, source: TrustedMessagingContext, key: WhatsAppMessageKey): Promise<NativeResolution> {
    try { await enterCanonicalTransaction(tx, source); } catch (error) { if (error instanceof StaleMessagingSourceError) return { kind: 'stale_source' }; throw error; }
    if (!key.nativeId && !key.rawId) return { kind: 'incomplete' };
    const rows = await tx.canonicalNativeAlias.findMany({ where: { ...scopeOf(source), provider: source.provider, connectionId: source.connectionId,
      ...(key.nativeId ? { lookupHash: hash(stable(nativeLookupTuple(source, key))) } : {}) } });
    const matches = rows.flatMap(alias => {
      const decoded = decodeNativeAlias(alias);
      if (!decoded || decoded.sessionName !== source.sessionName || alias.channelProvider !== (source.channelProvider === 'meta' ? 'meta_cloud' : 'evolution')) return [];
      if (!fields.every(field => key[field] === null || key[field] === decoded.key[field])) return [];
      return [{ alias, key: decoded.key }];
    });
    if (matches.length > 1) return { kind: 'ambiguous' };
    if (!matches.length) return { kind: 'missing' };
    return resolveEstablished(tx, matches[0]!.alias, source, matches[0]!.key);
  }
  return { lookupNativeInTransaction };
}
export const { lookupNativeInTransaction } = createCanonicalReads();

export interface ProviderReferenceRequest {
  workspaceId: string; channelId: string; originConversationId: string; messageId: string; requestedProvider: MessagingProvider;
  /** Mandatory even on cache hits; use DB/local authorization, no network I/O.
   * Authority membership never authorizes another origin. */
  authorizeOrigin: (origin: { workspaceId: string; channelId: string; conversationId: string; messageId: string }) => Promise<boolean>;
}
/** Permission-first, read-only resolution. No cache is trusted over origin authorization.
 * Source is recovered from immutable observations, never upgraded from today's session. */
export async function resolveProviderReferenceInTransaction(tx: Tx, request: ProviderReferenceRequest): Promise<NativeResolution> {
  const { workspaceId, channelId, originConversationId, messageId, requestedProvider } = request;
  const origin = await tx.message.findFirst({ where: { workspaceId, id: messageId, conversationId: originConversationId,
    conversation: { workspaceId, channelId, id: originConversationId } } });
  if (!origin || !await request.authorizeOrigin({ workspaceId, channelId, conversationId: originConversationId, messageId })) return { kind: 'forbidden_origin' };
  const identity = await tx.canonicalMessageIdentity.findFirst({ where: { workspaceId, channelId, messageId, conversationId: originConversationId } });
  if (!identity) return { kind: 'incomplete' };
  const aliases = await tx.canonicalNativeAlias.findMany({ where: { workspaceId, channelId, identityId: identity.id, provider: requestedProvider } });
  if (!aliases.length) return { kind: 'missing' };
  const candidates: NativeResolution[] = [];
  for (const alias of aliases) {
    const decoded = decodeNativeAlias(alias);
    if (!decoded) { candidates.push({ kind: 'incomplete' }); continue; }
    const observations = await tx.canonicalObservation.findMany({ where: { workspaceId, channelId, aliasId: alias.id, identityId: identity.id, provider: requestedProvider,
      connectionId: alias.connectionId, sessionName: decoded.sessionName, state: 'resolved' }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      select: { sessionName: true, lifecycleGeneration: true, mode: true, receivedAt: true }, distinct: ['lifecycleGeneration'] });
    if (!observations.length) { candidates.push({ kind: 'incomplete' }); continue; }
    let result: NativeResolution = { kind: 'stale_source' };
    for (const observation of observations) {
      const base = { workspaceId, channelId, sessionName: observation.sessionName, lifecycleGeneration: observation.lifecycleGeneration,
        mode: observation.mode as TrustedMessagingContext['mode'], observedAt: observation.receivedAt.toISOString() };
      let source: TrustedMessagingContext;
      if (requestedProvider === 'meta_official') {
        source = { ...base, provider: 'meta_official', channelProvider: 'meta', connectionId: null, phoneNumberId: observation.sessionName };
      } else if (alias.connectionId !== null) source = { ...base, provider: requestedProvider, channelProvider: 'evolution', connectionId: alias.connectionId };
      else if (requestedProvider === 'evolution') source = { ...base, provider: 'evolution', channelProvider: 'meta', connectionId: null };
      else continue;
      try {
        await enterCanonicalTransaction(tx, source);
        if (alias.channelProvider !== (source.channelProvider === 'meta' ? 'meta_cloud' : 'evolution')) { result = { kind: 'incomplete' }; break; }
        result = await resolveEstablished(tx, alias, source, decoded.key);
      } catch (error) {
        if (!(error instanceof StaleMessagingSourceError)) throw error;
        result = { kind: 'stale_source' };
      }
      if (result.kind === 'resolved' && (result.originMessageId !== messageId || result.originConversationId !== originConversationId)) return { kind: 'forbidden_origin' };
      if (result.kind !== 'stale_source') break;
    }
    candidates.push(result);
  }
  const resolved = candidates.filter((c): c is Extract<NativeResolution, { kind: 'resolved' }> => c.kind === 'resolved');
  if (resolved.length > 1) return { kind: 'ambiguous' };
  if (resolved.length === 1) return resolved[0]!;
  return candidates.find(c => c.kind === 'review') ?? candidates.find(c => c.kind === 'stale_source') ?? candidates[0] ?? { kind: 'missing' };
}
