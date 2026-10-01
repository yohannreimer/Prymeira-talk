import { Prisma, type CanonicalObservation } from '@prisma/client';
import { enterCanonicalWorkspaceTransaction } from './canonical-boundary.js';
import { equal, json, nativeLookupTuple, sha, stable } from './canonical-values.js';
import type { TrustedMessagingContext } from './normalized-event.js';
import { completeProviderKey } from './provider-exact.js';
import { outboundChatRoot } from './outbound-authority.js';
import { record, type WhatsAppMessageKey } from './whatsapp-identity.js';
type Tx = Prisma.TransactionClient;
type Scope = {
    workspaceId: string;
    channelId: string;
};
export interface RegisteredCorrelationKey {
    source: TrustedMessagingContext;
    key: WhatsAppMessageKey;
    observationId: string;
}
export interface ProviderCorrelationCertificate extends Scope {
    messageId: string;
    conversationId: string;
    from: RegisteredCorrelationKey;
    to: RegisteredCorrelationKey;
}
export interface VerifiedCorrelationProof {
    certificate: ProviderCorrelationCertificate;
    digest: string;
    proofReference: string;
    authority: {
        chatId: string;
        conversationId: string;
        revision: number;
    };
}
export interface CorrelationRequest extends Scope {
    proofObservationId: string;
    messageId: string;
    conversationId: string;
    /** Verify a concrete authenticated certificate by reading it in this TX. A bare
     * boolean is insufficient; the returned links must equal the persisted payload. */
    verifyProof: (tx: Tx, observation: CanonicalObservation) => Promise<VerifiedCorrelationProof | null>;
    authorizeOrigin: (tx: Tx, origin: Scope & {
        messageId: string;
        conversationId: string;
    }) => Promise<boolean>;
}
const nativeSource = (s: TrustedMessagingContext) => [
    s.workspaceId, s.channelId, s.channelProvider, s.provider, s.connectionId, s.sessionName, s.provider === 'meta_official' ? s.phoneNumberId : null
];
const aliasTuple = (s: TrustedMessagingContext, k: WhatsAppMessageKey) => [
    k.identityFormat, s.provider, s.connectionId, s.sessionName, k.nativeId, k.rawId, k.nativeChatAddress, k.nativeSenderParticipant, k.chatAddress, k.direction, k.senderParticipant
];
/** Exact explicit namespace exception for established canonical readers. Today's
 * observation provenance still has to recertify the active generation separately. */
export async function certifiedCorrelationKeyInTransaction(tx: Tx, scope: Scope, messageId: string, source: TrustedMessagingContext, key: WhatsAppMessageKey) {
    const rows = await tx.outboundCorrelation.findMany({
        where: { workspaceId: scope.workspaceId, channelId: scope.channelId, messageId, state: 'certified' }
    });
    return rows.some(row => { const proof = record(row.proof), certificate = record(proof.certificate); return [certificate.from, certificate.to].some(v => { const endpoint = record(v); return endpoint.source !== null && typeof endpoint.source === "object" && equal(nativeSource(endpoint.source as TrustedMessagingContext), nativeSource(source)) && equal(endpoint.key, key); }); });
}
export async function correlateProviderKeysInTransaction(tx: Tx, input: CorrelationRequest) {
    await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
    const scope = { workspaceId: input.workspaceId, channelId: input.channelId };
    await tx.$queryRaw `SELECT id FROM channels WHERE workspace_id=${input.workspaceId} AND id=${input.channelId}::uuid FOR UPDATE`;
    const observation = await tx.canonicalObservation.findFirst({
        where: {
            ...scope, id: input.proofObservationId, kind: 'provider_key_correlation', state: 'certified', source: 'authenticated_provider_mapping'
        }
    });
    if (!observation)
        return { kind: 'unverified' as const };
    const verified = await input.verifyProof(tx, observation);
    if (!verified)
        return { kind: 'unverified' as const };
    const persisted = record(observation.payload).certificate;
    if (!equal(verified.certificate, persisted) || verified.proofReference !== observation.id || verified.digest !== sha(stable(observation.payload)) || record(observation.resolutionEvidence).digest !== verified.digest)
        return { kind: 'unverified' as const };
    const cert = verified.certificate;
    if (cert.workspaceId !== scope.workspaceId || cert.channelId !== scope.channelId || cert.messageId !== input.messageId || cert.conversationId !== input.conversationId)
        return { kind: 'unverified' as const };
    const endpoints = [cert.from, cert.to];
    if (!endpoints.every(e => e.source.workspaceId === scope.workspaceId && e.source.channelId === scope.channelId && e.source.channelProvider === 'meta' && e.source.connectionId === null && completeProviderKey(e.key) && e.key.direction === 'outbound'))
        return { kind: 'unverified' as const };
    if (!endpoints.some(e => e.source.provider === 'meta_official' && e.key.identityFormat === 'provider_native' && !!e.source.phoneNumberId) || !endpoints.some(e => e.source.provider === 'evolution'))
        return { kind: 'unverified' as const };
    const registered = [];
    for (const endpoint of endpoints) {
        const o = await tx.canonicalObservation.findFirst({
            where: {
                ...scope, id: endpoint.observationId, provider: endpoint.source.provider, connectionId: endpoint.source.connectionId, sessionName: endpoint.source.sessionName, lifecycleGeneration: endpoint.source.lifecycleGeneration
            }
        });
        if (!o || !equal(record(o.payload).key, endpoint.key) || !equal(record(o.payload).context ?? record(o.payload).source, endpoint.source))
            return { kind: 'unverified' as const };
        registered.push(o);
    }
    await tx.$queryRaw `SELECT id FROM conversations WHERE workspace_id=${scope.workspaceId} AND channel_id=${scope.channelId}::uuid AND id=${input.conversationId}::uuid FOR UPDATE`;
    const message = await tx.message.findFirst({
        where: {
            workspaceId: scope.workspaceId, id: input.messageId, conversationId: input.conversationId, conversation: { channelId: scope.channelId }
        }
    });
    if (!message || !await input.authorizeOrigin(tx, { ...scope, messageId: input.messageId, conversationId: input.conversationId }))
        return { kind: 'forbidden_origin' as const };
    const identity = await tx.canonicalMessageIdentity.findFirst({ where: { ...scope, messageId: message.id } });
    if (!identity)
        return { kind: 'unverified' as const };
    const authority = await outboundChatRoot(tx, scope, identity.chatId);
    if (!authority || authority.state !== 'active' || authority.operationConversationId !== verified.authority.conversationId || authority.id !== verified.authority.chatId || authority.revision !== verified.authority.revision)
        return { kind: 'stale_authority' as const };
    const aliases = [];
    for (const endpoint of endpoints) {
        const tuple = aliasTuple(endpoint.source, endpoint.key);
        const bucket = await tx.canonicalNativeAlias.findMany({ where: { ...scope, tupleHash: sha(stable(tuple)) } });
        aliases.push(bucket.find(a => equal(a.fullTuple, tuple)) ?? null);
    }
    const conflicting = new Set<string>();
    for (const o of registered) {
        if (o.identityId) {
            const i = await tx.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: o.identityId } });
            if (i.messageId !== message.id)
                conflicting.add(i.messageId);
        }
    }
    for (const alias of aliases) {
        if (alias?.identityId && alias.identityId !== identity.id) {
            const i = await tx.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: alias.identityId } });
            conflicting.add(i.messageId);
        }
    }
    const fullTuple = [cert.from.source, cert.from.key, cert.to.source, cert.to.key, message.id, message.conversationId], tupleHash = sha(stable(fullTuple));
    const bucket = await tx.outboundCorrelation.findMany({ where: { ...scope, tupleHash } });
    let correlation = bucket.find(row => equal(row.fullTuple, fullTuple));
    if (!correlation)
        correlation = await tx.outboundCorrelation.create({
            data: {
                ...scope, messageId: message.id, conversationId: message.conversationId, tupleHash, fullTuple: json(fullTuple), proof: json({
                    kind: 'authenticated_provider_mapping', proofObservationId: observation.id, proofReference: verified.proofReference, digest: verified.digest, certificate: cert, authority: verified.authority
                }), state: conflicting.size ? 'review' : 'certified'
            }
        });
    if (conflicting.size) {
        await tx.canonicalMessageIdentity.updateMany({ where: { ...scope, messageId: { in: [message.id, ...conflicting] } }, data: { state: 'review' } });
        return {
            kind: 'review' as const, correlationId: correlation.id, conflictingMessageIds: [message.id, ...conflicting]
        };
    }
    if (correlation.state !== 'certified')
        return { kind: 'review' as const, correlationId: correlation.id };
    // The proof and full tuples were persisted before any new alias. Origin UUIDs,
    // old native keys and their original observation payloads never move or change.
    for (let index = 0; index < endpoints.length; index++) {
        const e = endpoints[index]!, tuple = aliasTuple(e.source, e.key);
        let alias = aliases[index];
        if (!alias)
            alias = await tx.canonicalNativeAlias.create({
                data: {
                    ...scope, channelProvider: 'meta_cloud', provider: e.source.provider, connectionId: null, identityId: identity.id, lookupHash: sha(stable(nativeLookupTuple(e.source, e.key))), tupleHash: sha(stable(tuple)), fullTuple: json(tuple), state: 'resolved'
                }
            });
        else if (!alias.identityId)
            alias = await tx.canonicalNativeAlias.update({ where: { id: alias.id }, data: { identityId: identity.id, state: 'resolved' } });
        const receipt = ['provider_key_correlation', correlation.id, e.observationId];
        const exists = await tx.canonicalObservation.findFirst({ where: { ...scope, receiptHash: sha(stable(receipt)), receiptTuple: { equals: json(receipt) } } });
        if (!exists)
            await tx.canonicalObservation.create({
                data: {
                    ...scope, channelProvider: 'meta_cloud', provider: e.source.provider, connectionId: null, identityId: identity.id, aliasId: alias.id, receiptHash: sha(stable(receipt)), receiptTuple: json(receipt), kind: 'provider_correlation_binding', eventType: 'certified_mapping', mode: e.source.mode, source: 'authenticated_provider_mapping', sessionName: e.source.sessionName, lifecycleGeneration: e.source.lifecycleGeneration, receivedAt: observation.receivedAt, sourceOrder: json({}), payload: json({ key: e.key, context: e.source, correlationId: correlation.id }), resolutionEvidence: json({ correlationId: correlation.id, proofObservationId: observation.id }), state: 'resolved'
                }
            });
    }
    return { kind: 'correlated' as const, messageId: message.id, correlationId: correlation.id };
}
