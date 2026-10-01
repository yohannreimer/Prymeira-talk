import { Prisma, type Message, type MessageType, type OutboundIntent } from '@prisma/client';
import { enterCanonicalTransaction, enterCanonicalWorkspaceTransaction } from './canonical-boundary.js';
import { StaleMessagingSourceError } from './canonical-source.js';
import { equal, json, nativeLookupTuple, sha, stable } from './canonical-values.js';
import type { TrustedMessagingContext } from './normalized-event.js';
import { normalizeChatAddress, record } from './whatsapp-identity.js';
import { buildPhoneLookupCandidates } from '../contacts/phone-normalization.js';
import { outboundChatRoot } from './outbound-authority.js';
import { createOutboundObservationGate } from './outbound-observation-gate.js';
import { createCanonicalStore } from './canonical-store.js';
import { verifyOutboundDomainInTransaction, compatiblePreparedRecertification, type OutboundDomainFence } from './outbound-fences.js';
export type { OutboundDomainFence } from './outbound-fences.js';
import { classifySendEvidence, sanitizeSendEvidence, type SendEvidence } from './outbound-evidence.js';
import { collectOutboundProofSetInTransaction } from './outbound-proof-set.js';
type Tx = Prisma.TransactionClient;
type Scope = {
    workspaceId: string;
    channelId: string;
};
type OriginKey = {
    originId: string;
    actionOrdinal: number;
    requestKey: string;
};
export type OutboundOrigin = OriginKey & ({
    kind: 'human';
} | {
    kind: 'agent_reply';
} | {
    kind: 'attachment_part';
    parentKind: 'human' | 'agent_reply';
    part: number;
} | {
    kind: 'automation_node';
    nodeId: string;
    occurrence: number;
    frozenNode: Prisma.InputJsonValue;
} | {
    kind: 'campaign_recipient';
} | {
    kind: 'prospecting_delivery';
} | {
    kind: 'assistant_send';
} | {
    kind: 'followup';
});
export interface PreparedMediaDescriptor {
    reference: string;
    digest: string;
    mimeType: string;
    sizeBytes: number;
    kind: 'audio' | 'image' | 'video' | 'document';
}
/** Concrete DB snapshots are defined in outbound-fences; no application booleans certify a domain. */
export interface OutboundRequest {
    conversationId: string;
    destination: string;
    origin: OutboundOrigin;
    actor: {
        kind: 'user' | 'agent' | 'automation';
        id: string;
    };
    existingMessageId?: string;
    message: {
        type: MessageType;
        body: string | null;
        mediaUrl: string | null;
        metadata: Prisma.InputJsonValue;
        createdAt?: string;
        ingestedAt?: string | null;
    };
    preparedMedia: PreparedMediaDescriptor[];
    domainFences: OutboundDomainFence[];
}
export type AuthorizeOutboundOrigin = (tx: Tx, origin: {
    workspaceId: string;
    channelId: string;
    conversationId: string;
    actor: OutboundRequest['actor'];
    origin: OutboundOrigin;
    messageId: string | null;
}) => Promise<boolean>;
const ambiguous = ['dispatching', 'accepted_unbound', 'uncertain', 'review'];
function scopeOf(c: Scope): Scope { return { workspaceId: c.workspaceId, channelId: c.channelId }; }
export function outboundRequest(intent: OutboundIntent): OutboundRequest { return intent.request as unknown as OutboundRequest; }
async function persistedAddress(tx: Tx, scope: Scope, value: string) {
    let alias = await tx.canonicalAddressAlias.findUnique({ where: { workspaceId_channelId_address: { ...scope, address: value } } });
    if (!alias) {
        const address = await tx.canonicalAddress.create({ data: scope });
        alias = await tx.canonicalAddressAlias.create({ data: { ...scope, addressId: address.id, address: value } });
    }
    let address = await tx.canonicalAddress.findFirstOrThrow({ where: { ...scope, id: alias.addressId } });
    const seen = new Set<string>();
    while (address.redirectId) {
        if (seen.has(address.id) || address.state === 'review')
            throw new Error('Review address');
        seen.add(address.id);
        address = await tx.canonicalAddress.findFirstOrThrow({ where: { ...scope, id: address.redirectId } });
    }
    return address;
}
async function reserveChat(tx: Tx, scope: Scope, conversationId: string, destination: string) {
    const address = await persistedAddress(tx, scope, destination);
    let chat = await tx.canonicalChat.findUnique({ where: { workspaceId_channelId_addressId: { ...scope, addressId: address.id } } });
    if (!chat)
        chat = await tx.canonicalChat.create({ data: { ...scope, addressId: address.id } });
    const aliases = await tx.canonicalAddressAlias.findMany({ where: scope });
    const familyAddresses = [];
    for (const a of aliases) {
        let node = await tx.canonicalAddress.findUniqueOrThrow({ where: { id: a.addressId } });
        const seen = new Set<string>();
        while (node.redirectId && !seen.has(node.id)) {
            seen.add(node.id);
            node = await tx.canonicalAddress.findUniqueOrThrow({ where: { id: node.redirectId } });
        }
        if (node.id === address.id)
            familyAddresses.push(a.address);
    }
    const phones = [
        ...new Set(familyAddresses.flatMap(a => a.endsWith('@s.whatsapp.net') ? buildPhoneLookupCandidates(a.split('@')[0]!) : [a]))
    ];
    const contacts = await tx.contact.findMany({ where: { workspaceId: scope.workspaceId, phone: { in: phones } } });
    const conversations = await tx.conversation.findMany({ where: { ...scope, contactId: { in: contacts.map(c => c.id) } } });
    const members = await tx.canonicalChatMember.findMany({ where: { ...scope, chatId: chat.id } });
    const ids = new Set([...conversations.map(c => c.id), ...members.map(m => m.conversationId), conversationId]);
    for (const id of ids)
        await tx.canonicalChatMember.upsert({
            where: { workspaceId_channelId_chatId_conversationId: { ...scope, chatId: chat.id, conversationId: id } }, create: { ...scope, chatId: chat.id, conversationId: id, source: 'persisted_outbound_destination' }, update: {}
        });
    const state = ids.size === 1 && address.state === 'active' ? 'active' : 'review', operationConversationId = state === 'active' ? conversationId : null;
    if (chat.state !== state || chat.operationConversationId !== operationConversationId)
        chat = await tx.canonicalChat.update({
            where: { id: chat.id }, data: {
                state, operationConversationId, reviewReason: state === 'review' ? 'multiple_conversation_authorities' : null, revision: { increment: 1 }
            }
        });
    return chat;
}
async function permission(tx: Tx, scope: Scope, request: OutboundRequest, messageId: string | null, authorize: AuthorizeOutboundOrigin) {
    const conversation = await tx.conversation.findFirst({ where: { ...scopeOf(scope), id: request.conversationId }, include: { contact: true } });
    if (!conversation)
        return null;
    const destination = normalizeChatAddress(conversation.contact.phone.includes('@') ? conversation.contact.phone : `${conversation.contact.phone}@s.whatsapp.net`);
    if (destination !== request.destination) {
        // Only established address evidence may authorize a different native address.
        const aliases = await tx.canonicalAddressAlias.findMany({ where: { ...scope, address: { in: [destination ?? '', request.destination] } } });
        if (aliases.length !== 2)
            return null;
        const roots = [];
        for (const a of aliases) {
            const chat = await tx.canonicalChat.findFirst({ where: { ...scope, addressId: a.addressId } });
            if (!chat)
                return null;
            roots.push(await outboundChatRoot(tx, scope, chat.id));
        }
        if (!roots[0] || roots[0].id !== roots[1]?.id)
            return null;
    }
    if (request.actor.kind === 'user' && !await tx.userProfile.findFirst({ where: { workspaceId: scope.workspaceId, id: request.actor.id } }))
        return null;
    if (request.actor.kind === 'agent' && !await tx.aiAgent.findFirst({ where: { workspaceId: scope.workspaceId, id: request.actor.id } }))
        return null;
    if (!await authorize(tx, {
        ...scope, conversationId: request.conversationId, actor: request.actor, origin: request.origin, messageId
    }))
        return null;
    return conversation;
}
async function locks(tx: Tx, scope: Scope, conversationId: string) { await tx.$queryRaw `SELECT id FROM conversations WHERE workspace_id=${scope.workspaceId} AND channel_id=${scope.channelId}::uuid AND id=${conversationId}::uuid FOR UPDATE`; }
/** Message status is transport presentation, never acceptance evidence. */
function matchesReservedMessage(message: Message | null, request: OutboundRequest): boolean {
    return message !== null
        && message.providerMessageId === null
        && message.providerEventId === null
        && message.type === request.message.type
        && message.body === request.message.body
        && message.mediaUrl === request.message.mediaUrl
        && equal(message.metadata, request.message.metadata)
        && message.sentByUserId === (request.actor.kind === 'user' ? request.actor.id : null);
}
function validate(request: OutboundRequest) {
    const o = request.origin;
    if (!o || ![
        'human', 'agent_reply', 'attachment_part', 'automation_node', 'campaign_recipient', 'prospecting_delivery', 'assistant_send', 'followup'
    ].includes(o.kind)
        || !o.originId || o.originId.length > 256 || !o.requestKey || o.requestKey.length > 256 || !Number.isSafeInteger(o.actionOrdinal) || o.actionOrdinal < 0
        || normalizeChatAddress(request.destination) !== request.destination
        || (o.kind === 'attachment_part' && (!['human', 'agent_reply'].includes(o.parentKind) || !Number.isSafeInteger(o.part) || o.part < 0))
        || (o.kind === 'automation_node' && (!o.nodeId || !Number.isSafeInteger(o.occurrence) || o.occurrence < 0)))
        throw Error('Invalid outbound request');
    if (request.preparedMedia.some(m => Object.keys(m).sort().join(',') !== 'digest,kind,mimeType,reference,sizeBytes' || !['audio', 'image', 'video', 'document'].includes(m.kind) || !m.reference || /^data:/.test(m.reference) || !/^([a-f0-9]{64})$/.test(m.digest) || !Number.isSafeInteger(m.sizeBytes) || m.sizeBytes < 0 || !m.mimeType))
        throw Error('Invalid prepared media descriptor');
    if (/^data:/.test(request.message.mediaUrl ?? '') || 'data' in request.message || 'binary' in request.message)
        throw Error('Binary media is forbidden');
}
export function createOutboundIntents({ hash = sha }: {
    hash?: (value: string) => string;
} = {}) {
    const observationGate = createOutboundObservationGate({ hash });
    const canonicalStore = createCanonicalStore({ hash });
    async function reserveLocalOutboundInTransaction(tx: Tx, source: TrustedMessagingContext, request: OutboundRequest, authorize: AuthorizeOutboundOrigin) {
        await enterCanonicalTransaction(tx, source);
        validate(request);
        const scope = scopeOf(source);
        await locks(tx, scope, request.conversationId);
        if (!await permission(tx, scope, request, request.existingMessageId ?? null, authorize))
            return { kind: 'forbidden_origin' as const };
        const key = {
            ...scope, originKind: request.origin.kind, originId: request.origin.originId, actionOrdinal: request.origin.actionOrdinal, requestKey: request.origin.requestKey
        };
        const previous = await tx.outboundIntent.findUnique({ where: { workspaceId_channelId_originKind_originId_actionOrdinal_requestKey: key } });
        if (previous)
            return equal(previous.request, json(request)) ? { kind: 'existing' as const, intent: previous } : { kind: 'request_conflict' as const, intentId: previous.id };
        const domain = await verifyOutboundDomainInTransaction(tx, scope, request);
        if (domain !== 'valid')
            return { kind: domain };
        const chat = await reserveChat(tx, scope, request.conversationId, request.destination);
        let message;
        if (request.existingMessageId) {
            message = await tx.message.findFirst({
                where: {
                    workspaceId: scope.workspaceId, conversationId: request.conversationId, id: request.existingMessageId, direction: 'outbound'
                }
            });
            if (!message || !matchesReservedMessage(message, request))
                return { kind: 'existing_message_conflict' as const };
        }
        else
            message = await tx.message.create({
                data: {
                    workspaceId: scope.workspaceId, conversationId: request.conversationId, direction: 'outbound', type: request.message.type, body: request.message.body, mediaUrl: request.message.mediaUrl, metadata: json(request.message.metadata), status: 'pending', sentByUserId: request.actor.kind === 'user' ? request.actor.id : null, ...(request.message.createdAt ? { createdAt: new Date(request.message.createdAt) } : {}), ...(request.message.ingestedAt === undefined ? {} : { ingestedAt: request.message.ingestedAt ? new Date(request.message.ingestedAt) : null })
                }
            });
        if (await tx.outboundIntent.findUnique({ where: { messageId: message.id } }))
            return { kind: 'existing_message_conflict' as const };
        const intent = await tx.outboundIntent.create({
            data: {
                ...key, conversationId: request.conversationId, messageId: message.id, chatId: chat.id, request: json(request), domainFences: json(request.domainFences), authorityRevision: chat.revision, state: chat.state === 'active' ? 'prepared' : 'review', reason: chat.reviewReason
            }
        });
        return { kind: 'reserved' as const, intent };
    }
    async function beginDispatchInTransaction(tx: Tx, source: TrustedMessagingContext, input: {
        intentId: string;
        authorizeOrigin: AuthorizeOutboundOrigin;
    }) {
        await enterCanonicalTransaction(tx, source);
        const scope = scopeOf(source);
        const intent = await tx.outboundIntent.findFirst({ where: { ...scope, id: input.intentId } });
        if (!intent)
            return { kind: 'missing' as const };
        if (intent.state === 'dispatching')
            return { kind: 'already_crossed_frontier' as const };
        if (intent.state !== 'prepared')
            return { kind: 'not_prepared' as const };
        await locks(tx, scope, intent.conversationId);
        const recertification = await tx.outboundRecertification.findFirst({ where: { ...scope, intentId: intent.id }, orderBy: { ordinal: 'desc' } });
        const request = {
            ...outboundRequest(intent), domainFences: (recertification?.domainFences ?? intent.domainFences) as unknown as OutboundDomainFence[]
        };
        if (recertification) {
            const frozen = recertification.source as unknown as TrustedMessagingContext;
            const sourceTuple = (c: TrustedMessagingContext) => [
                c.workspaceId, c.channelId, c.channelProvider, c.provider, c.connectionId, c.sessionName, c.lifecycleGeneration, c.provider === 'meta_official' ? c.phoneNumberId : null
            ];
            if (!equal(sourceTuple(frozen), sourceTuple(source)))
                return { kind: 'stale_prepared_source' as const };
        }
        if (!await permission(tx, scope, request, intent.messageId, input.authorizeOrigin))
            return { kind: 'forbidden_origin' as const };
        const message = await tx.message.findFirst({
            where: {
                workspaceId: scope.workspaceId, conversationId: intent.conversationId, id: intent.messageId, direction: 'outbound'
            }
        });
        if (!message || !matchesReservedMessage(message, request))
            return { kind: 'existing_message_conflict' as const };
        const domain = await verifyOutboundDomainInTransaction(tx, scope, request);
        if (domain !== 'valid')
            return { kind: domain };
        const chat = await outboundChatRoot(tx, scope, intent.chatId);
        if (!chat || chat.id !== (recertification?.chatId ?? intent.chatId) || chat.revision !== (recertification?.authorityRevision ?? intent.authorityRevision) || chat.state !== 'active' || chat.operationConversationId !== intent.conversationId)
            return { kind: 'stale_authority' as const };
        if ((await observationGate.outboundObservationGateInTransaction(tx, scope, chat.id)).kind === 'blocked')
            return { kind: 'held_observations' as const };
        const lane = await tx.outboundIntent.findMany({ where: { ...scope, state: { in: ['prepared', ...ambiguous] } } });
        for (const other of lane) {
            if (other.id === intent.id)
                continue;
            const root = await outboundChatRoot(tx, scope, other.chatId);
            if (root?.id === chat.id && (ambiguous.includes(other.state) || other.ordinal < intent.ordinal))
                return { kind: 'lane_blocked' as const };
        }
        const attempt = await tx.outboundAttempt.create({
            data: {
                ...scope, intentId: intent.id, source: json(source), domainFences: json(request.domainFences), chatId: chat.id, authorityRevision: chat.revision
            }
        });
        await tx.outboundIntent.update({ where: { id: intent.id }, data: { state: 'dispatching', reason: null } });
        // Only the attempt's operational fences may differ after recertification.
        // No caller request retry can rewrite the persisted immutable request.
        return { kind: 'dispatch' as const, attempt, messageId: intent.messageId, request };
    }
    /** Refresh only pre-I/O operational snapshots. The original request, actor,
     * destination, Message UUID and initial snapshots remain immutable evidence. */
    async function recertifyPreparedOutboundInTransaction(tx: Tx, source: TrustedMessagingContext, input: {
        intentId: string;
        domainFences: OutboundDomainFence[];
        authorizeOrigin: AuthorizeOutboundOrigin;
    }) {
        await enterCanonicalTransaction(tx, source);
        const scope = scopeOf(source);
        const intent = await tx.outboundIntent.findFirst({ where: { ...scope, id: input.intentId } });
        if (!intent)
            return { kind: 'missing' as const };
        if (intent.state !== 'prepared' || await tx.outboundAttempt.count({ where: { ...scope, intentId: intent.id } }))
            return { kind: 'not_prepared' as const };
        await locks(tx, scope, intent.conversationId);
        const prior = await tx.outboundRecertification.findFirst({ where: { ...scope, intentId: intent.id }, orderBy: { ordinal: 'desc' } });
        const previous = (prior?.domainFences ?? intent.domainFences) as unknown as OutboundDomainFence[];
        if (!compatiblePreparedRecertification(previous, input.domainFences))
            return { kind: 'stale_request_context' as const };
        const request = { ...outboundRequest(intent), domainFences: input.domainFences };
        if (!await permission(tx, scope, request, intent.messageId, input.authorizeOrigin))
            return { kind: 'forbidden_origin' as const };
        const message = await tx.message.findFirst({
            where: {
                workspaceId: scope.workspaceId, conversationId: intent.conversationId, id: intent.messageId, direction: 'outbound'
            }
        });
        if (!message || !matchesReservedMessage(message, request))
            return { kind: 'existing_message_conflict' as const };
        const domain = await verifyOutboundDomainInTransaction(tx, scope, request);
        if (domain !== 'valid')
            return { kind: domain };
        const chat = await outboundChatRoot(tx, scope, intent.chatId);
        if (!chat || chat.state !== 'active' || chat.operationConversationId !== intent.conversationId)
            return { kind: 'stale_authority' as const };
        const certificate = await tx.outboundRecertification.create({
            data: {
                ...scope, intentId: intent.id, chatId: chat.id, authorityRevision: chat.revision, source: json(source), domainFences: json(input.domainFences), proof: json({
                    kind: 'pre_io_recertification', previousCertificateId: prior?.id ?? null, request: intent.request, messageId: intent.messageId, origin: request.origin, authority: { chatId: chat.id, conversationId: chat.operationConversationId, revision: chat.revision }
                })
            }
        });
        return { kind: 'recertified' as const, certificateId: certificate.id, messageId: intent.messageId };
    }
    async function cancelPreparedInTransaction(tx: Tx, input: Scope & {
        intentId: string;
    }, authorize: AuthorizeOutboundOrigin) {
        await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
        const intent = await tx.outboundIntent.findFirst({ where: { ...scopeOf(input), id: input.intentId } });
        if (!intent)
            return { kind: 'missing' as const };
        await locks(tx, input, intent.conversationId);
        if (!await permission(tx, input, outboundRequest(intent), intent.messageId, authorize))
            return { kind: 'forbidden_origin' as const };
        if (intent.state !== 'prepared')
            return { kind: 'not_prepared' as const };
        await tx.outboundIntent.update({ where: { id: intent.id }, data: { state: 'canceled', reason: 'canceled_before_io' } });
        return { kind: 'canceled' as const };
    }
    async function recoverDispatchInTransaction(tx: Tx, input: Scope & {
        intentId: string;
    }) {
        await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
        const intent = await tx.outboundIntent.findFirst({ where: { ...scopeOf(input), id: input.intentId } });
        if (!intent)
            return { kind: 'missing' as const };
        if (intent.state !== 'dispatching')
            return { kind: 'unchanged' as const };
        await tx.outboundIntent.update({ where: { id: intent.id }, data: { state: 'uncertain', reason: 'crash_after_io_frontier' } });
        return { kind: 'uncertain' as const };
    }
    async function recordDispatchResultInTransaction(tx: Tx, input: Scope & {
        token: string;
        resultKey: string;
        evidence: SendEvidence;
        /** Absence conserves the result but grants no operational eligibility. */
        authorizeOrigin?: AuthorizeOutboundOrigin;
    }) {
        // Do NOT enter with an old source before saving a late fact. Workspace FIRST,
        // append evidence, then determine today's operational eligibility separately.
        await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
        const scope = scopeOf(input);
        const attempt = await tx.outboundAttempt.findFirst({ where: { ...scope, token: input.token }, include: { intent: true } });
        if (!attempt)
            return { kind: 'missing' as const };
        if (!input.resultKey || input.resultKey.length > 256)
            throw Error('Invalid result key');
        const evidence = sanitizeSendEvidence(input.evidence), outcome = classifySendEvidence(evidence);
        const prior = await tx.outboundResult.findUnique({
            where: {
                workspaceId_channelId_attemptId_resultKey: { ...scope, attemptId: attempt.id, resultKey: input.resultKey }
            }
        });
        if (prior && !equal(prior.evidence, json(evidence)))
            return { kind: 'result_conflict' as const };
        const result = prior ?? await tx.outboundResult.create({
            data: { ...scope, attemptId: attempt.id, resultKey: input.resultKey, outcome, evidence: json(evidence) }
        });
        const all = await tx.outboundResult.findMany({ where: { ...scope, attemptId: attempt.id } });
        const accepted = all.some(r => r.outcome === 'accepted'), uncertain = all.some(r => r.outcome === 'uncertain');
        const proofSet = await collectOutboundProofSetInTransaction(tx, { ...scope, token: attempt.token });
        const contradiction = proofSet.kind === 'review';
        if (contradiction)
            await tx.canonicalMessageIdentity.updateMany({ where: { messageId: attempt.intent.messageId }, data: { state: 'review' } });
        const state = contradiction ? 'review' : attempt.intent.state === 'bound' ? 'bound' : accepted ? 'accepted_unbound' : uncertain ? 'uncertain' : 'definitively_rejected';
        const intent = await tx.outboundIntent.update({
            where: { id: attempt.intent.id }, data: {
                state, ...(contradiction ? { reason: 'contradictory_dispatch_keys' } : {}), ...(attempt.intent.state === 'review' ? { state: 'review' } : {})
            }
        });
        await tx.outboundAttempt.update({
            where: { id: attempt.id }, data: { phase: accepted ? 'accepted' : uncertain ? 'uncertain' : 'definitively_rejected' }
        });
        let operationallyEligible = false;
        try {
            await enterCanonicalTransaction(tx, attempt.source as unknown as TrustedMessagingContext);
            const chat = await outboundChatRoot(tx, scope, intent.chatId);
            operationallyEligible = !!input.authorizeOrigin && !!await permission(tx, scope, outboundRequest(intent), intent.messageId, input.authorizeOrigin) && intent.state !== 'review' && !!chat && chat.state === 'active' && chat.id === attempt.chatId && chat.revision === attempt.authorityRevision && chat.operationConversationId === intent.conversationId && (await verifyOutboundDomainInTransaction(tx, scope, {
                ...outboundRequest(intent), domainFences: attempt.domainFences as unknown as OutboundDomainFence[]
            })) === 'valid';
        }
        catch (e) {
            if (!(e instanceof StaleMessagingSourceError))
                throw e;
        }
        return { kind: prior ? 'existing' as const : 'recorded' as const, result, intent, operationallyEligible };
    }
    async function bindLocalOutboundInTransaction(tx: Tx, input: Scope & {
        token: string;
        resultId: string;
        lookupObservationId?: string;
    }) {
        await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
        const scope = scopeOf(input);
        const attempt = await tx.outboundAttempt.findFirst({ where: { ...scope, token: input.token }, include: { intent: true } });
        if (!attempt)
            return { kind: 'missing' as const };
        if (attempt.intent.state === 'review')
            return { kind: 'review' as const };
        const result = await tx.outboundResult.findFirst({ where: { ...scope, id: input.resultId, attemptId: attempt.id } });
        if (!result || result.outcome !== 'accepted')
            return { kind: 'incomplete_proof' as const };
        const source = attempt.source as unknown as TrustedMessagingContext;
        const proof = await collectOutboundProofSetInTransaction(tx, {
            ...scope, token: attempt.token, resultId: result.id, lookupObservationId: input.lookupObservationId
        });
        if (proof.kind === 'review') {
            await tx.outboundIntent.update({
                where: { id: attempt.intent.id }, data: { state: 'review', reason: 'contradictory_dispatch_proof_set' }
            });
            await tx.canonicalMessageIdentity.updateMany({ where: { ...scope, messageId: attempt.intent.messageId }, data: { state: 'review' } });
            return { kind: 'review' as const };
        }
        if (proof.kind !== 'complete')
            return { kind: 'incomplete_proof' as const };
        const key = proof.key, bindingSource = proof.source;
        const mappingConflict = await canonicalStore.applyDispatchMappingsInTransaction(tx, {
            ...scope, resultId: result.id, token: attempt.token, lookupObservationId: input.lookupObservationId
        });
        if (mappingConflict) {
            await tx.outboundIntent.update({ where: { id: attempt.intent.id }, data: { state: 'review', reason: mappingConflict } });
            await tx.canonicalMessageIdentity.updateMany({ where: { ...scope, messageId: attempt.intent.messageId }, data: { state: 'review' } });
            return { kind: 'review' as const };
        }
        const chat = await outboundChatRoot(tx, scope, attempt.intent.chatId);
        if (!chat || chat.state !== 'active' || !chat.operationConversationId) {
            await tx.outboundIntent.update({
                where: { id: attempt.intent.id }, data: { state: 'review', reason: 'binding_authority_requires_review' }
            });
            return { kind: 'review' as const };
        }
        const sender = key.senderParticipant ? await persistedAddress(tx, scope, key.senderParticipant) : null;
        if (sender?.state === 'review')
            return { kind: 'review' as const };
        const fullTuple = [
            scope.workspaceId, scope.channelId, chat.id, key.identityFormat, key.identityFormat === 'provider_native' ? source.provider : '', key.identityFormat === 'provider_native' ? key.nativeId : key.rawId, 'outbound', sender?.id ?? ''
        ];
        const tupleHash = hash(stable(fullTuple));
        const identities = await tx.canonicalMessageIdentity.findMany({ where: { ...scope, tupleHash } });
        const matches = identities.filter(i => equal(i.fullTuple, fullTuple));
        const owned = await tx.canonicalMessageIdentity.findUnique({ where: { messageId: attempt.intent.messageId } });
        if (matches.some(i => i.messageId !== attempt.intent.messageId) || matches.length > 1 || (owned && !equal(owned.fullTuple, fullTuple))) {
            await tx.outboundIntent.update({ where: { id: attempt.intent.id }, data: { state: 'review', reason: 'local_binding_collision' } });
            await tx.canonicalMessageIdentity.updateMany({ where: { id: { in: matches.map(i => i.id) } }, data: { state: 'review' } });
            return { kind: 'review' as const, conflictingMessageIds: matches.map(i => i.messageId) };
        }
        const identity = owned ?? matches[0] ?? await tx.canonicalMessageIdentity.create({
            data: {
                ...scope, chatId: chat.id, senderAddressId: sender?.id ?? null, conversationId: attempt.intent.conversationId, messageId: attempt.intent.messageId, identityFormat: key.identityFormat, providerScope: key.identityFormat === 'provider_native' ? source.provider : '', rawId: (key.identityFormat === 'provider_native' ? key.nativeId : key.rawId)!, direction: 'outbound', tupleHash, fullTuple: json(fullTuple), initialMode: 'local_dispatch'
            }
        });
        const aliasTuple = [
            key.identityFormat, source.provider, source.connectionId, source.sessionName, key.nativeId, key.rawId, key.nativeChatAddress, key.nativeSenderParticipant, key.chatAddress, key.direction, key.senderParticipant
        ];
        const bucket = await tx.canonicalNativeAlias.findMany({ where: { ...scope, tupleHash: hash(stable(aliasTuple)) } });
        let alias = bucket.find(a => equal(a.fullTuple, aliasTuple));
        if (alias?.identityId && alias.identityId !== identity.id) {
            await tx.outboundIntent.update({ where: { id: attempt.intent.id }, data: { state: 'review', reason: 'local_alias_collision' } });
            return { kind: 'review' as const };
        }
        if (!alias)
            alias = await tx.canonicalNativeAlias.create({
                data: {
                    ...scope, channelProvider: source.channelProvider === 'meta' ? 'meta_cloud' : 'evolution', provider: source.provider, connectionProvider: source.connectionId ? source.provider as 'evolution' | 'waha' : null, connectionId: source.connectionId, identityId: identity.id, lookupHash: hash(stable(nativeLookupTuple(source, key))), tupleHash: hash(stable(aliasTuple)), fullTuple: json(aliasTuple), state: 'resolved'
                }
            });
        else if (!alias.identityId)
            alias = await tx.canonicalNativeAlias.update({ where: { id: alias.id }, data: { identityId: identity.id, state: 'resolved' } });
        const knownBindings = await tx.outboundBinding.findMany({ where: { ...scope, intentId: attempt.intent.id, resultId: result.id, aliasId: alias.id } });
        let binding = knownBindings.find(binding => {
            const refs = record(record(binding.proof).proofSet);
            return equal(refs.resultIds, proof.proofSet.resultIds) && equal(refs.lookupObservationIds, proof.proofSet.lookupObservationIds);
        });
        if (!binding) {
            binding = await tx.outboundBinding.create({
                data: {
                    ...scope, intentId: attempt.intent.id, attemptId: attempt.id, resultId: result.id, identityId: identity.id, aliasId: alias.id, source: json(source), key: json(key), proof: json({
                        kind: proof.lookupObservationId ? 'authenticated_exact_lookup' : 'authenticated_dispatch_response', lookupObservationId: proof.lookupObservationId, lookupSource: proof.lookupObservationId ? bindingSource : null, addressMappings: proof.addressMappings, proofSet: proof.proofSet, token: attempt.token, resultId: result.id, request: attempt.intent.request, domainFences: attempt.domainFences, authorityRevision: attempt.authorityRevision
                    })
                }
            });
            const receiptTuple = ['local_dispatch', attempt.token, result.id];
            const observation = await tx.canonicalObservation.create({
                data: {
                    ...scope, channelProvider: source.channelProvider === 'meta' ? 'meta_cloud' : 'evolution', provider: source.provider, connectionProvider: source.connectionId ? source.provider as 'evolution' | 'waha' : null, connectionId: source.connectionId, identityId: identity.id, aliasId: alias.id, receiptHash: hash(stable(receiptTuple)), receiptTuple: json(receiptTuple), kind: 'local_dispatch_binding', eventType: 'send_result', mode: source.mode, source: 'local_dispatch', sessionName: bindingSource.sessionName, lifecycleGeneration: bindingSource.lifecycleGeneration, receivedAt: result.createdAt, sourceOrder: json({}), resolutionEvidence: json({ bindingId: binding.id, resultId: result.id }), payload: json({ key, source: bindingSource, resultId: result.id }), state: 'resolved'
                }
            });
        }
        await tx.outboundIntent.update({ where: { id: attempt.intent.id }, data: { state: 'bound', reason: null } });
        return {
            kind: 'bound' as const, messageId: identity.messageId, identityId: identity.id, bindingId: binding.id
        };
    }
    return {
        recertifyPreparedOutboundInTransaction, reserveLocalOutboundInTransaction, beginDispatchInTransaction, recordDispatchResultInTransaction, bindLocalOutboundInTransaction, cancelPreparedInTransaction, recoverDispatchInTransaction
    };
}
