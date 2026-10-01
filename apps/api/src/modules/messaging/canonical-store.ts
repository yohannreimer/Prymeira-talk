import { createCanonicalReducers, type ActionEvent } from './canonical-reducers.js';
import { json, stable, equal, sha, scopeOf, nativeLookupTuple } from './canonical-values.js';
import { enrichPresentation, presentationMediaUrl, presentationMetadata } from './canonical-presentation.js';
import { Prisma, type PrismaClient, type CanonicalChat, type CanonicalMessageIdentity, type CanonicalNativeAlias } from '@prisma/client';
import type { NormalizedMessagingEvent, TrustedMessagingContext } from './normalized-event.js';
import { normalizeChatAddress, record, type WhatsAppMessageKey } from './whatsapp-identity.js';
import { buildPhoneLookupCandidates, normalizePhoneForStorage } from '../contacts/phone-normalization.js';

export interface CanonicalStoreOptions {
  /** Durable ingress key, required when the provider has no event ID. Never a message body/time key. */
  receiptKey: string;
  /** Certification from the persistent ingress frontier, not inferred from the mode's name. */
  recoveredLiveEligible?: boolean;
  /** Exact provider lookup supplied by a trusted caller. No body/time or global raw-ID adoption. */
  adoption?: { messageId: string; key: WhatsAppMessageKey; source: 'provider_exact_lookup' };
}
export interface CanonicalStoreResult {
  outcome: 'created' | 'duplicate' | 'enriched' | 'held'; observationId: string; messageId: string | null;
  conversationId: string | null; chatId: string | null; identityId: string | null;
  allowOperationalEffects: boolean; reconciliationReasons: string[]; changes: string[];
  conflictingMessageIds?: string[]; actionId?: string;
}
export type { CanonicalRevisionEvidence, CanonicalSnapshotEvidence } from './canonical-reducers.js';
type Tx = Prisma.TransactionClient;
type Scope = { workspaceId: string; channelId: string };
type MessageEvent = Extract<NormalizedMessagingEvent, { kind: 'message' }>;
/** One event per transaction. Every canonical writer acquires the workspace lock FIRST.
 * This deliberately serializes Contact creation across channels and late identity merges.
 * Call first inside a READ COMMITTED transaction; stronger snapshot isolation is rejected.
 * Do not wrap a history batch or network I/O in this transaction. Legacy writers are not
 * coordinated until 2a.3; this store is currently disconnected from runtime.
 */
export function createCanonicalStore({ hash = sha }: { hash?: (value: string) => string } = {}) {
  function digest(value: unknown) {
    const result = hash(stable(value));
    if (!/^[a-f0-9]{1,64}$/.test(result)) throw new Error('Invalid canonical hash');
    return result;
  }
  async function assertScope(tx: Tx, c: TrustedMessagingContext) {
    const channel = await tx.channel.findFirst({ where: { workspaceId: c.workspaceId, id: c.channelId } });
    if (!channel || channel.provider !== (c.channelProvider === 'meta' ? 'meta_cloud' : 'evolution')) throw new Error('Invalid channel scope');
    if (c.provider === 'waha' && (channel.provider !== 'evolution' || !c.connectionId)) throw new Error('Invalid WAHA scope');
    if (c.connectionId) {
      const physical = await tx.channelConnection.findFirst({ where: { ...scopeOf(c), id: c.connectionId, provider: c.provider } });
      if (!physical || channel.provider !== 'evolution') throw new Error('Invalid connection scope');
    }
    return channel.provider;
  }
  async function lockAndScope(tx: Tx, c: TrustedMessagingContext) {
    const isolation = await tx.$queryRaw<Array<{ isolation: string }>>`SELECT current_setting('transaction_isolation') AS isolation`;
    if (isolation[0]?.isolation !== 'read committed') throw new Error('Canonical store requires READ COMMITTED');
    // Advisory hash collisions only over-serialize. Logical identity hashes never replace full comparisons.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`canonical-messaging:${c.workspaceId}`}, 0))`;
    return assertScope(tx, c);
  }
  async function graph(tx: Tx, scope: Scope) {
    const rows = await tx.canonicalAddress.findMany({ where: scope });
    const parents = new Map(rows.map(r => [r.id, r.redirectId]));
    function root(id: string) {
      const seen = new Set<string>();
      while (parents.get(id)) {
        if (seen.has(id)) throw new Error('Canonical address redirect cycle');
        seen.add(id); id = parents.get(id)!;
      }
      if (!parents.has(id)) throw new Error('Invalid canonical address scope');
      return id;
    }
    return { root, family: (id: string) => rows.filter(r => root(r.id) === root(id)).map(r => r.id) };
  }
  async function address(tx: Tx, scope: Scope, value: string) {
    const normalized = normalizeChatAddress(value);
    if (!normalized) throw new Error('Invalid canonical address');
    const alias = await tx.canonicalAddressAlias.findUnique({ where: { workspaceId_channelId_address: { ...scope, address: normalized } } });
    if (alias) return (await graph(tx, scope)).root(alias.addressId);
    const created = await tx.canonicalAddress.create({ data: scope });
    await tx.canonicalAddressAlias.create({ data: { ...scope, addressId: created.id, address: normalized } });
    return created.id;
  }
  async function chat(tx: Tx, scope: Scope, addressId: string, createConversation: boolean, name: string | null = null): Promise<CanonicalChat> {
    const g = await graph(tx, scope), root = g.root(addressId), family = g.family(root);
    let result = await tx.canonicalChat.findUnique({ where: { workspaceId_channelId_addressId: { ...scope, addressId: root } } });
    if (!result) result = await tx.canonicalChat.create({ data: { ...scope, addressId: root } });
    const aliases = await tx.canonicalAddressAlias.findMany({ where: { ...scope, addressId: { in: family } } });
    const phones = [...new Set(aliases.flatMap(a => a.address.endsWith('@s.whatsapp.net') ? buildPhoneLookupCandidates(a.address.split('@')[0]!) : [a.address]))];
    const contacts = await tx.contact.findMany({ where: { workspaceId: scope.workspaceId, phone: { in: phones } }, orderBy: { id: 'asc' } });
    const existing = await tx.conversation.findMany({ where: { ...scope, contactId: { in: contacts.map(c => c.id) } } });
    const familyChats = await tx.canonicalChat.findMany({ where: { ...scope, addressId: { in: family } } });
    const members = await tx.canonicalChatMember.findMany({ where: { ...scope, chatId: { in: familyChats.map(c => c.id) } } });
    const ids = new Set([...existing.map(c => c.id), ...members.map(m => m.conversationId)]);
    if (ids.size === 0 && createConversation) {
      const preferred = aliases.find(a => a.address.endsWith('@s.whatsapp.net'))?.address ?? aliases[0]!.address;
      const phone = preferred.endsWith('@s.whatsapp.net') ? normalizePhoneForStorage(preferred.split('@')[0]!) : preferred;
      const contact = contacts.find(c => c.phone === phone) ?? contacts[0]
        ?? await tx.contact.create({ data: { workspaceId: scope.workspaceId, phone, name, isGroup: preferred.endsWith('@g.us') } });
      const conversation = await tx.conversation.create({ data: { ...scope, contactId: contact.id } });
      ids.add(conversation.id);
    }
    for (const conversationId of ids) {
      await tx.canonicalChatMember.upsert({ where: { workspaceId_channelId_chatId_conversationId: { ...scope, chatId: result.id, conversationId } },
        create: { ...scope, chatId: result.id, conversationId, source: 'demonstrated_contact_address' }, update: {} });
    }
    // Preserve all original members and message origin FKs; only the root gets authority.
    await tx.canonicalChat.updateMany({ where: { ...scope, id: { in: familyChats.filter(c => c.id !== result!.id).map(c => c.id) } },
      data: { state: 'redirected', operationConversationId: null, reviewReason: 'address_redirect' } });
    const state = ids.size > 1 ? 'review' : 'active';
    const operationConversationId = ids.size === 1 ? [...ids][0]! : null;
    if (result.state !== state || result.operationConversationId !== operationConversationId) {
      result = await tx.canonicalChat.update({ where: { id: result.id }, data: { state, operationConversationId,
        reviewReason: ids.size > 1 ? 'multiple_conversation_authorities' : null, revision: { increment: 1 } } });
    }
    return result;
  }
  function tuple(scope: Scope, chatId: string, key: WhatsAppMessageKey, senderId: string | null, provider: string) {
    return [scope.workspaceId, scope.channelId, chatId, key.identityFormat,
      key.identityFormat === 'provider_native' ? provider : '',
      key.identityFormat === 'provider_native' ? key.nativeId : key.rawId, key.direction, senderId ?? ''];
  }
  async function rekey(tx: Tx, scope: Scope, affectedAddressIds: string[]) {
    const g = await graph(tx, scope);
    const chats = await tx.canonicalChat.findMany({ where: scope });
    const chatById = new Map(chats.map(c => [c.id, c]));
    const rootChatByAddress = new Map(chats.map(c => [c.addressId, c]));
    const affectedChatIds = chats.filter(c => affectedAddressIds.includes(c.addressId)).map(c => c.id);
    const identities = await tx.canonicalMessageIdentity.findMany({ where: { ...scope, OR: [
      { chatId: { in: affectedChatIds } }, { senderAddressId: { in: affectedAddressIds } }
    ] } });
    for (const identity of identities) {
      const origin = chatById.get(identity.chatId)!;
      const rootChat = rootChatByAddress.get(g.root(origin.addressId))!;
      const fullTuple = [scope.workspaceId, scope.channelId, rootChat.id, identity.identityFormat,
        identity.providerScope, identity.rawId, identity.direction, identity.senderAddressId ? g.root(identity.senderAddressId) : ''];
      if (!equal(identity.fullTuple, fullTuple)) await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { fullTuple, tupleHash: digest(fullTuple) } });
    }
  }
  async function mappings(tx: Tx, event: NormalizedMessagingEvent, observationId: string) {
    const scope = scopeOf(event.context);
    const seen = new Set<string>();
    for (const evidence of event.addressMappings) {
      const proofKey = stable(evidence);
      if (seen.has(proofKey)) continue;
      seen.add(proofKey);
      const lid = normalizeChatAddress(evidence.lid), pn = normalizeChatAddress(evidence.pn);
      if (!lid?.endsWith('@lid') || !pn?.endsWith('@s.whatsapp.net')
        || (event.context.provider === 'waha' ? evidence.source !== 'waha.lid_lookup'
          : evidence.source !== (evidence.role === 'chat' ? 'evolution.remoteJidAlt' : 'evolution.participantAlt'))) throw new Error('Invalid mapping evidence');
      const a = await address(tx, scope, lid), b = await address(tx, scope, pn);
      await tx.canonicalAddressEvidence.create({ data: { ...scope, observationId, ...evidence, lid, pn } });
      const g = await graph(tx, scope);
      const familyIds = [...new Set([...g.family(a), ...g.family(b)])];
      const familyAliases = await tx.canonicalAddressAlias.findMany({ where: { ...scope, addressId: { in: familyIds } } });
      const pnAliases = new Set(familyAliases.filter(r => r.address.endsWith('@s.whatsapp.net')).map(r => r.address));
      const disputed = await tx.canonicalAddress.count({ where: { ...scope, id: { in: familyIds }, state: 'review' } });
      if (pnAliases.size > 1 || disputed) {
        await tx.canonicalAddress.updateMany({ where: { ...scope, id: { in: familyIds } }, data: { state: 'review', reviewReason: 'address_mapping_conflict' } });
        return 'address_mapping_conflict';
      }
      if (a !== b) {
        // The representative is only an identity root, never a conversation authority.
        const [root, other] = [a, b].sort();
        await tx.canonicalAddress.update({ where: { id: other! }, data: { redirectId: root! } });
        const family = (await graph(tx, scope)).family(root!);
        if (await tx.canonicalChat.count({ where: { ...scope, addressId: { in: family } } })) await chat(tx, scope, root!, false);
        await rekey(tx, scope, family);
      }
    }
  }
  async function nativeAlias(tx: Tx, event: NormalizedMessagingEvent, key: WhatsAppMessageKey, channelProvider: 'evolution' | 'meta_cloud') {
    const c = event.context, scope = scopeOf(c);
    const fullTuple = [key.identityFormat, c.provider, c.connectionId, c.sessionName, key.nativeId, key.rawId,
      key.nativeChatAddress, key.nativeSenderParticipant, key.chatAddress, key.direction, key.senderParticipant];
    const tupleHash = digest(fullTuple);
    const bucket = await tx.canonicalNativeAlias.findMany({ where: { ...scope, tupleHash } });
    const existing = bucket.find(a => equal(a.fullTuple, fullTuple));
    if (existing) return existing;
    return tx.canonicalNativeAlias.create({ data: { ...scope, channelProvider, provider: c.provider,
      connectionProvider: c.connectionId ? c.provider : null, connectionId: c.connectionId, lookupHash: digest(nativeLookupTuple(c, key)), tupleHash, fullTuple: json(fullTuple) } });
  }
  function complete(key: WhatsAppMessageKey) {
    return !!normalizeChatAddress(key.chatAddress) && !!key.direction
      && !!(key.identityFormat === 'provider_native' ? key.nativeId : key.rawId)
      && (key.chatAddress!.endsWith('@g.us') ? !!normalizeChatAddress(key.senderParticipant) && !key.senderParticipant!.endsWith('@g.us') : key.senderParticipant === '');
  }
  async function persistedGroupSenderMatches(tx: Tx, scope: Scope, senderAddressId: string,
    metadata: Prisma.JsonValue, legacyAliases: CanonicalNativeAlias[]) {
    // Both the live metadata and the backfilled snapshot are evidence. Neither may
    // silently override the other when the UUID is adopted into a canonical key.
    const knownSenders = [record(record(metadata).groupSender).jid,
      ...legacyAliases.map(alias => record(record(alias.fullTuple).groupSender).jid)];
    const g = await graph(tx, scope);
    for (const known of knownSenders) {
      // Incomplete history can still use the caller's explicit exact-lookup recovery.
      if (known === undefined || known === null || known === '') continue;
      const normalized = normalizeChatAddress(known);
      if (!normalized || normalized.endsWith('@g.us')) return false;
      const alias = await tx.canonicalAddressAlias.findUnique({ where: {
        workspaceId_channelId_address: { ...scope, address: normalized }
      } });
      // Normal PN variants share an address. PN/LID roots share an identity only
      // after accepted explicit mapping evidence; never infer a link from digits.
      if (!alias || g.root(alias.addressId) !== g.root(senderAddressId)) return false;
    }
    return true;
  }
  async function resolveActionTarget(tx: Tx, event: ActionEvent) {
    const scope = scopeOf(event.context), key = event.target;
    if (!complete(key)) {
      if (!key.nativeId || event.context.provider !== 'waha') return { reason: 'incomplete_target_identity' };
      const prefix = nativeLookupTuple(event.context, key);
      const aliases = await tx.canonicalNativeAlias.findMany({ where: { ...scope, lookupHash: digest(prefix), state: 'resolved', identityId: { not: null } } });
      const matched = aliases.filter(alias => {
        const t = alias.fullTuple;
        if (!Array.isArray(t) || !equal(t.slice(1, 5), prefix) || t[0] !== key.identityFormat) return false;
        const known = [key.rawId, key.nativeChatAddress, key.nativeSenderParticipant, key.chatAddress, key.direction, key.senderParticipant];
        return known.every((value, index) => value === null || value === t[index + 5]);
      });
      const ids = [...new Set(matched.map(alias => alias.identityId!))];
      if (ids.length !== 1) return { reason: ids.length ? 'multiple_message_identities' : 'incomplete_target_identity' };
      const identity = await tx.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: ids[0]! }, include: { chat: true } });
      const g = await graph(tx, scope);
      const canonicalChat = await chat(tx, scope, g.root(identity.chat.addressId), false);
      if (canonicalChat.state !== 'active' || !canonicalChat.operationConversationId) return { reason: 'multiple_conversation_authorities' };
      const involved = [g.root(identity.chat.addressId), ...(identity.senderAddressId ? [g.root(identity.senderAddressId)] : [])];
      if (await tx.canonicalAddress.count({ where: { ...scope, id: { in: involved }, state: 'review' } })) return { reason: 'address_mapping_conflict' };
      if (identity.state !== 'active') return { reason: 'identity_requires_review' };
      return { identity };
    }
    const chatAddress = await address(tx, scope, key.chatAddress!);
    const sender = key.chatAddress!.endsWith('@g.us') ? await address(tx, scope, key.senderParticipant!) : null;
    if (await tx.canonicalAddress.count({ where: { ...scope, id: { in: [chatAddress, ...(sender ? [sender] : [])] }, state: 'review' } })) return { reason: 'address_mapping_conflict' };
    const canonicalChat = await chat(tx, scope, chatAddress, false);
    if (canonicalChat.state !== 'active' || !canonicalChat.operationConversationId) return { reason: canonicalChat.state === 'review' ? 'multiple_conversation_authorities' : 'target_missing' };
    const fullTuple = tuple(scope, canonicalChat.id, key, sender, event.context.provider);
    const candidates = await tx.canonicalMessageIdentity.findMany({ where: { ...scope, tupleHash: digest(fullTuple) } });
    const matches = candidates.filter(row => equal(row.fullTuple, fullTuple));
    if (matches.length !== 1) return { reason: matches.length ? 'multiple_message_identities' : 'target_missing' };
    if (matches[0]!.state !== 'active') return { reason: 'identity_requires_review' };
    return { identity: matches[0]! };
  }
  /** Indexed candidate buckets are always intersected with complete target fields.
   * JSON predicates let recovery count an exact frontier without loading an unbounded
   * set of payloads. Incomplete targets require an already demonstrated native alias. */
  async function pendingTargetWhere(tx: Tx, identity: CanonicalMessageIdentity): Promise<Prisma.CanonicalActionWhereInput> {
    const scope = { workspaceId: identity.workspaceId, channelId: identity.channelId }, g = await graph(tx, scope);
    const origin = await tx.canonicalChat.findUniqueOrThrow({ where: { id: identity.chatId } });
    const addresses = await tx.canonicalAddressAlias.findMany({ where: { ...scope, addressId: { in: g.family(origin.addressId) } } });
    const senders = identity.senderAddressId ? await tx.canonicalAddressAlias.findMany({ where: { ...scope, addressId: { in: g.family(identity.senderAddressId) } } }) : [];
    const field = (name: string, value: Prisma.JsonValue): Prisma.CanonicalActionWhereInput => ({ target: { path: [name], equals: value === null ? Prisma.JsonNull : value } });
    const canonical: Prisma.CanonicalActionWhereInput = { targetHash: digest([identity.identityFormat, identity.providerScope, identity.rawId]), AND: [
      field('identityFormat', identity.identityFormat), field(identity.identityFormat === 'provider_native' ? 'nativeId' : 'rawId', identity.rawId),
      field('direction', identity.direction), { OR: addresses.map(a => field('chatAddress', a.address)) },
      identity.senderAddressId ? { OR: senders.map(a => field('senderParticipant', a.address)) } : field('senderParticipant', ''),
      ...(identity.identityFormat === 'provider_native' ? [{ observation: { provider: identity.providerScope } }] : [])
    ] };
    const aliases = await tx.canonicalNativeAlias.findMany({ where: { ...scope, identityId: identity.id, state: 'resolved', provider: 'waha' } });
    const native: Prisma.CanonicalActionWhereInput[] = [];
    for (const alias of aliases) {
      const t = alias.fullTuple;
      if (!Array.isArray(t) || t.length !== 11 || typeof t[3] !== 'string') continue; // legacy objects are never authority
      native.push({ nativeTargetHash: digest(t.slice(1, 5)), observation: { provider: 'waha', connectionId: alias.connectionId, sessionName: t[3] }, AND: [
        field('identityFormat', t[0]!), field('nativeId', t[4]!),
        ...['rawId', 'nativeChatAddress', 'nativeSenderParticipant', 'chatAddress', 'direction', 'senderParticipant'].map((name, index) => ({ OR: [field(name, null), field(name, t[index + 5]!)] }))
      ] });
    }
    return { ...scope, OR: [canonical, ...native] };
  }
  async function revisionTuple(tx: Tx, event: ActionEvent, identity: CanonicalMessageIdentity, key: WhatsAppMessageKey) {
    if (!complete(key)) return null;
    const scope = scopeOf(event.context), g = await graph(tx, scope);
    const canonicalChat = await tx.canonicalChat.findUniqueOrThrow({ where: { id: identity.chatId } });
    const chatAddress = await address(tx, scope, key.chatAddress!);
    const sender = key.senderParticipant ? await address(tx, scope, key.senderParticipant) : null;
    if (g.root(canonicalChat.addressId) !== (await graph(tx, scope)).root(chatAddress) || key.direction !== identity.direction
      || (identity.senderAddressId ? !sender || (await graph(tx, scope)).root(sender) !== g.root(identity.senderAddressId) : sender !== null)) return null;
    const rootChat = await chat(tx, scope, g.root(canonicalChat.addressId), false);
    return tuple(scope, rootChat.id, key, sender ? (await graph(tx, scope)).root(sender) : null, event.context.provider);
  }
  async function sameRevision(tx: Tx, identity: CanonicalMessageIdentity, event: MessageEvent) {
    if (equal(identity.currentRevision, event.currentRevision)) return true;
    if (!identity.currentRevision || !event.currentRevision) return false;
    const probe: ActionEvent = { ...event, kind: 'revoke', target: event.key, action: event.key };
    const stored = await revisionTuple(tx, probe, identity, identity.currentRevision as unknown as WhatsAppMessageKey);
    const incoming = await revisionTuple(tx, probe, identity, event.currentRevision);
    return stored !== null && incoming !== null && equal(stored, incoming);
  }
  const { reduceAction, recoverForMessage, reconcileRevisionInTransaction, reconcileSnapshotInTransaction, reconciliationFrontierInTransaction, recoverPendingInTransaction } = createCanonicalReducers({
    digest, lockAndScope, resolveActionTarget, revisionTuple, address, graph, pendingTargetWhere
  });
  async function persistInTransaction(tx: Tx, event: NormalizedMessagingEvent, options: CanonicalStoreOptions): Promise<CanonicalStoreResult> {
    const c = event.context, scope = scopeOf(c);
    if (!event.providerEventId && !options.receiptKey) throw new Error('Stable ingress receiptKey required');
    const channelProvider = await lockAndScope(tx, c);
    const receiptTuple = [c.provider, c.connectionId, c.sessionName, event.providerEventType,
      event.providerEventId ? 'provider_event_id' : 'ingress', event.providerEventId ?? options.receiptKey];
    const receiptHash = digest(receiptTuple);
    const receipts = await tx.canonicalObservation.findMany({ where: { ...scope, receiptHash } });
    const sameReceipts = receipts.filter(r => equal(r.receiptTuple, receiptTuple));
    // Context timing/mode is delivery provenance, never a reason to replay created.
    const envelope = (value: unknown) => { const { context: ignored, ...data } = record(value); return data; };
    const previous = sameReceipts.find(r => equal(envelope(r.payload), envelope(event)));
    const receiptConflict = sameReceipts.length > 0 && !previous;
    const result: CanonicalStoreResult = { outcome: 'held', observationId: '', messageId: null, conversationId: null, chatId: null, identityId: null,
      allowOperationalEffects: false, reconciliationReasons: [], changes: [] };
    if (previous) {
      result.observationId = previous.id;
      if (previous.identityId) {
        const identity = await tx.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: previous.identityId } });
        Object.assign(result, { identityId: identity.id, messageId: identity.messageId, conversationId: identity.conversationId, chatId: identity.chatId });
      }
      result.outcome = previous.state === 'held' ? 'held' : 'duplicate';
      if (previous.reason) result.reconciliationReasons.push(previous.reason);
      if (event.kind !== 'message' && event.kind !== 'control' && previous.reason !== 'receipt_key_conflict') return reduceAction(tx, event, previous.id);
      return result;
    }
    const observation = await tx.canonicalObservation.create({ data: { ...scope, channelProvider, provider: c.provider,
      connectionProvider: c.connectionId ? c.provider : null, connectionId: c.connectionId,
      receiptHash, receiptTuple: json(receiptTuple), providerEventId: event.providerEventId,
      kind: event.kind, eventType: event.providerEventType, mode: c.mode,
      source: event.kind === 'message' ? event.source : null, sessionName: c.sessionName, lifecycleGeneration: c.lifecycleGeneration,
      receivedAt: new Date(c.observedAt), sourceOrder: json('order' in event ? event.order : {}),
      currentRevision: event.kind === 'message' && event.currentRevision ? json(event.currentRevision) : Prisma.DbNull,
      payload: json(event), state: 'held' } });
    result.observationId = observation.id;
    async function hold(reason: string) {
      result.outcome = 'held'; result.allowOperationalEffects = false; result.reconciliationReasons.push(reason);
      await tx.canonicalObservation.update({ where: { id: observation.id }, data: { state: 'held', reason } });
      return result;
    }
    if (receiptConflict) {
      await tx.canonicalObservation.updateMany({ where: { id: { in: sameReceipts.map(r => r.id) } }, data: { state: 'held', reason: 'receipt_key_conflict' } });
      await tx.canonicalMessageIdentity.updateMany({ where: { id: { in: sameReceipts.flatMap(row => row.identityId ? [row.identityId] : []) }, contentState: { not: 'deleted' } }, data: { contentState: 'pending_reconciliation' } });
      return hold('receipt_key_conflict');
    }
    const mappingConflict = await mappings(tx, event, observation.id);
    if (mappingConflict) return hold(mappingConflict);
    if (event.kind === 'control') return hold('control_requires_ingress');
    const key = event.kind === 'message' ? event.key : event.target;
    const alias = await nativeAlias(tx, event, key, channelProvider);
    await tx.canonicalObservation.update({ where: { id: observation.id }, data: { aliasId: alias.id } });
    if (event.kind !== 'message') return reduceAction(tx, event, observation.id);
    if (!complete(key)) return hold('incomplete_message_identity');
    const chatAddress = await address(tx, scope, key.chatAddress!);
    const sender = key.chatAddress!.endsWith('@g.us') ? await address(tx, scope, key.senderParticipant!) : null;
    if (await tx.canonicalAddress.count({ where: { ...scope, id: { in: [chatAddress, ...(sender ? [sender] : [])] }, state: 'review' } })) return hold('address_mapping_conflict');
    let canonicalChat = await chat(tx, scope, chatAddress, false);
    result.chatId = canonicalChat.id;
    const fullTuple = tuple(scope, canonicalChat.id, key, sender, c.provider), tupleHash = digest(fullTuple);
    const bucket = await tx.canonicalMessageIdentity.findMany({ where: { ...scope, tupleHash } });
    const matches = bucket.filter(i => equal(i.fullTuple, fullTuple));
    if (matches.length > 1) {
      result.conflictingMessageIds = matches.map(i => i.messageId);
      await tx.canonicalMessageIdentity.updateMany({ where: { id: { in: matches.map(i => i.id) } }, data: { state: 'review' } });
      await tx.canonicalNativeAlias.update({ where: { id: alias.id }, data: { state: 'review' } });
      return hold('multiple_message_identities');
    }
    if (canonicalChat.state === 'review') return hold('multiple_conversation_authorities');
    let identity: CanonicalMessageIdentity | undefined = matches[0];
    let adoptionAliases: CanonicalNativeAlias[] = [];
    if (alias.identityId && alias.identityId !== identity?.id) return hold('native_alias_identity_conflict');
    if (!identity) {
      // Before any new contact/history, respect demonstrated existing authorities.
      canonicalChat = await chat(tx, scope, chatAddress, true, event.pushName);
      result.conversationId = canonicalChat.operationConversationId;
      if (!result.conversationId) return hold('missing_conversation_authority');
      let messageId: string;
      if (!options.adoption) {
        const nativeIds = [...new Set([key.nativeId, key.rawId].filter((id): id is string => id !== null))];
        const legacy = await tx.message.findFirst({ where: { workspaceId: c.workspaceId, conversationId: result.conversationId,
          direction: key.direction!, providerMessageId: { in: nativeIds } } });
        if (legacy) return hold('legacy_identity_requires_adoption');
      }
      if (options.adoption) {
        const adoption = options.adoption;
        if (adoption.source !== 'provider_exact_lookup' || !complete(adoption.key)) throw new Error('Incomplete adoption evidence');
        const adoptionChat = await address(tx, scope, adoption.key.chatAddress!);
        const adoptionSender = adoption.key.chatAddress!.endsWith('@g.us') ? await address(tx, scope, adoption.key.senderParticipant!) : null;
        const sameChat = (await graph(tx, scope)).root(adoptionChat) === (await graph(tx, scope)).root(chatAddress);
        if (!sameChat || !equal(tuple(scope, canonicalChat.id, adoption.key, adoptionSender, c.provider), fullTuple)) throw new Error('Invalid adoption identity scope');
        const legacy = await tx.message.findFirst({ where: { workspaceId: c.workspaceId, id: adoption.messageId, conversationId: result.conversationId, direction: key.direction! } });
        if (!legacy || (legacy.providerMessageId !== null && legacy.providerMessageId !== adoption.key.nativeId && legacy.providerMessageId !== adoption.key.rawId)) throw new Error('Invalid legacy adoption scope');
        if (!legacy.providerMessageId) return hold('legacy_native_identity_missing');
        if (legacy.providerEventId?.startsWith('meta:')) return hold('meta_bridge_correlation_required');
        if (key.identityFormat === 'provider_native' && c.provider !== 'evolution') return hold('provider_native_correlation_required');
        if (await tx.canonicalMessageIdentity.findUnique({ where: { messageId: legacy.id } })) return hold('legacy_message_already_bound');
        adoptionAliases = await tx.canonicalNativeAlias.findMany({ where: { ...scope,
          AND: [{ fullTuple: { path: ['origin'], equals: 'legacy' } }, { fullTuple: { path: ['messageId'], equals: legacy.id } }] } });
        if (sender && !await persistedGroupSenderMatches(tx, scope, sender, legacy.metadata, adoptionAliases)) {
          return hold('legacy_sender_identity_conflict');
        }
        messageId = legacy.id; result.outcome = 'enriched'; result.changes.push('legacy_message_adopted');
      } else {
        const message = await tx.message.create({ data: { workspaceId: c.workspaceId, conversationId: result.conversationId, direction: key.direction!,
          type: event.content.type, body: event.content.body, mediaUrl: presentationMediaUrl(event), status: key.direction === 'inbound' ? 'delivered' : 'sent',
          metadata: json(presentationMetadata(event)),
          ...(event.order.timestampMs === null ? {} : { createdAt: new Date(event.order.timestampMs) }) } });
        messageId = message.id; result.outcome = 'created'; result.changes.push('message_created');
        result.allowOperationalEffects = c.mode === 'live' || (c.mode === 'recovered_live' && options.recoveredLiveEligible === true);
      }
      identity = await tx.canonicalMessageIdentity.create({ data: { ...scope, chatId: canonicalChat.id, senderAddressId: sender,
        conversationId: result.conversationId, messageId, identityFormat: key.identityFormat,
        providerScope: key.identityFormat === 'provider_native' ? c.provider : '', rawId: (key.identityFormat === 'provider_native' ? key.nativeId : key.rawId)!,
        direction: key.direction!, tupleHash, fullTuple: json(fullTuple), initialMode: c.mode,
        currentRevision: event.currentRevision ? json(event.currentRevision) : Prisma.DbNull } });
    } else {
      result.outcome = 'duplicate';
      const stored = await tx.message.findUniqueOrThrow({ where: { id: identity.messageId } });
      const metadata = record(stored.metadata);
      const revisionMatches = await sameRevision(tx, identity, event);
      if (!metadata.deletedAt && (!metadata.editedAt || identity.currentRevision !== null) && revisionMatches && stored.type === event.content.type) {
        const { data, conflict } = enrichPresentation(stored, event, equal);
        if (conflict) {
          result.outcome = 'held'; result.reconciliationReasons.push('content_reconciliation_required');
          await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { contentState: 'pending_reconciliation' } });
        } else if (Object.keys(data).length) {
          await tx.message.update({ where: { id: stored.id }, data });
          result.outcome = 'enriched'; result.changes.push('missing_fields_enriched');
        }
      }
      if (!metadata.deletedAt && ((!revisionMatches && !(metadata.editedAt && event.currentRevision === null)) || (!metadata.editedAt && stored.type !== event.content.type))) {
        result.outcome = 'held';
        result.reconciliationReasons.push('revision_reconciliation_required');
        await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { contentState: 'pending_reconciliation' } });
      }
    }
    Object.assign(result, { identityId: identity.id, messageId: identity.messageId, conversationId: identity.conversationId });
    if (result.changes.includes('legacy_message_adopted')) {
      for (const legacyAlias of adoptionAliases) {
        const provenance = record(legacyAlias.fullTuple);
        if (provenance.conversationId === identity.conversationId && provenance.direction === key.direction
          && (provenance.nativeId === key.nativeId || provenance.nativeId === key.rawId)) {
          await tx.canonicalNativeAlias.update({ where: { id: legacyAlias.id }, data: { identityId: identity.id, state: 'resolved' } });
        }
      }
    }
    await tx.canonicalNativeAlias.update({ where: { id: alias.id }, data: { identityId: identity.id, state: 'resolved' } });
    await tx.canonicalObservation.update({ where: { id: observation.id }, data: { identityId: identity.id, state: result.outcome === 'held' ? 'held' : 'resolved', reason: result.reconciliationReasons[0] ?? null } });
    await recoverForMessage(tx, event, result);
    return result;
  }
  return { persistInTransaction, reconcileRevisionInTransaction, reconcileSnapshotInTransaction, reconciliationFrontierInTransaction, recoverPendingInTransaction,
    persist: (db: PrismaClient, event: NormalizedMessagingEvent, options: CanonicalStoreOptions) => db.$transaction(tx => persistInTransaction(tx, event, options), { isolationLevel: 'ReadCommitted' }) };
}
