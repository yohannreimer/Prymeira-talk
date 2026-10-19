import type { Prisma } from '@prisma/client';
import { enterCanonicalWorkspaceTransaction } from './canonical-boundary.js';
import { equal, stable, json, sha } from './canonical-values.js';
import type { AddressMappingEvidence, TrustedMessagingContext } from './normalized-event.js';
import { completeProviderKey, fullProviderKeyMatches } from './provider-exact.js';
import { record, type WhatsAppMessageKey } from './whatsapp-identity.js';
import { inspectSendIdentityEvidence, parseSendProof, sendIdentityClaimsConflict, type SendEvidence, type SendIdentityClaim } from './outbound-evidence.js';
/** A proof set is private transactional evidence, never a queue/UI DTO. Selection
 * identifies an accepted result; it never removes other facts from the attempt. */
export async function collectOutboundProofSetInTransaction(tx: Prisma.TransactionClient, input: {
    workspaceId: string;
    channelId: string;
    token: string;
    resultId?: string;
    lookupObservationId?: string;
}) {
    await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
    const scope = { workspaceId: input.workspaceId, channelId: input.channelId };
    const attempt = await tx.outboundAttempt.findFirst({ where: { ...scope, token: input.token }, include: { intent: true } });
    if (!attempt)
        return { kind: 'missing' as const };
    const source = attempt.source as unknown as TrustedMessagingContext;
    const destination = record(attempt.intent.request).destination;
    if (source.workspaceId !== scope.workspaceId || source.channelId !== scope.channelId || typeof destination !== 'string')
        throw new Error('Invalid persisted outbound proof scope');
    const accepted = await tx.outboundResult.findMany({ where: { ...scope, attemptId: attempt.id, outcome: 'accepted' }, orderBy: { id: 'asc' } });
    if (input.resultId && !accepted.some(result => result.id === input.resultId))
        return { kind: 'incomplete' as const };
    const bindings = await tx.outboundBinding.findMany({ where: { ...scope, attemptId: attempt.id }, orderBy: { id: 'asc' } });
    const claims: SendIdentityClaim[] = [];
    const candidates: Array<{
        key: WhatsAppMessageKey;
        source: TrustedMessagingContext;
        lookupObservationId: string | null;
    }> = [];
    const facts: Array<{
        kind: 'accepted_result' | 'exact_lookup';
        id: string;
        source: TrustedMessagingContext;
        addressMappings: AddressMappingEvidence[];
    }> = [];
    let conflicting = false, invalidLookup = false;
    function inspect(raw: unknown, context: TrustedMessagingContext, kind: 'accepted_result' | 'exact_lookup', id: string) {
        const inspected = inspectSendIdentityEvidence(context, destination as string, raw);
        conflicting ||= inspected.conflicting || record(raw)._evidenceIncomplete === true;
        claims.push(...inspected.claims);
        const proof = parseSendProof(context, destination as string, raw);
        facts.push({ kind, id, source: context, addressMappings: proof.addressMappings });
        return proof;
    }
    for (const result of accepted) {
        const proof = inspect((result.evidence as unknown as SendEvidence).raw, source, 'accepted_result', result.id);
        if (proof.key)
            candidates.push({ key: proof.key, source, lookupObservationId: null });
    }
    // A previous bind is conserved proof too. Its exact lookup keeps its full raw
    // claims, so a later incomplete acceptance cannot hide an earlier alternate.
    const lookupIds = new Set<string>();
    const previousSets = await tx.canonicalObservation.findMany({
        where: {
            ...scope, kind: 'outbound_dispatch_proof_set', source: 'local_dispatch',
            payload: { path: ['token'], equals: attempt.token }
        }
    });
    for (const previous of previousSets) {
        const ids = record(record(previous.payload).proofSet).lookupObservationIds;
        if (Array.isArray(ids))
            for (const id of ids)
                if (typeof id === 'string')
                    lookupIds.add(id);
    }
    for (const binding of bindings) {
        const proof = record(binding.proof), lookupId = proof.lookupObservationId;
        if (typeof lookupId === 'string')
            lookupIds.add(lookupId);
        const ids = record(proof.proofSet).lookupObservationIds;
        if (Array.isArray(ids))
            for (const id of ids)
                if (typeof id === 'string')
                    lookupIds.add(id);
        const key = binding.key as unknown as WhatsAppMessageKey;
        claims.push({ key });
        candidates.push({
            key, source: (proof.lookupSource ?? binding.source) as TrustedMessagingContext,
            lookupObservationId: typeof lookupId === 'string' ? lookupId : null
        });
    }
    if (input.lookupObservationId)
        lookupIds.add(input.lookupObservationId);
    const nativeIds = new Set(claims.map(claim => claim.key.nativeId).filter((id): id is string => typeof id === 'string'));
    const trustedLookupIds: string[] = [];
    for (const id of [...lookupIds].sort()) {
        const observation = await tx.canonicalObservation.findFirst({
            where: {
                ...scope, id, kind: 'provider_exact_lookup', state: 'certified',
                source: 'authenticated_exact_lookup', provider: source.provider, connectionId: source.connectionId, sessionName: source.sessionName
            }
        });
        const payload = record(observation?.payload), lookup = record(payload.lookup);
        const context = payload.context as TrustedMessagingContext | undefined, key = payload.key as WhatsAppMessageKey | undefined;
        if (!observation || !context || !key || !completeProviderKey(key) || !nativeIds.has(key.nativeId!)
            || context.workspaceId !== scope.workspaceId || context.channelId !== scope.channelId || context.provider !== source.provider
            || context.channelProvider !== source.channelProvider || context.connectionId !== source.connectionId || context.sessionName !== source.sessionName
            || context.lifecycleGeneration !== observation.lifecycleGeneration
            || (context.provider === 'meta_official' && (source.provider !== 'meta_official' || context.phoneNumberId !== source.phoneNumberId))
            || !equal(lookup.verifiedKey, key) || lookup.nativeId !== key.nativeId) {
            invalidLookup = true;
            continue;
        }
        trustedLookupIds.push(id);
        claims.push({ key });
        const proof = inspect(lookup.response, context, 'exact_lookup', id);
        // Compare raw claims even when contradiction makes the complete parser
        // refuse a key. Contradiction is a fact, never an absent field to replace.
        if (proof.key && !fullProviderKeyMatches(key, proof.key))
            invalidLookup = true;
        else if (proof.key) {
            candidates.push({ key, source: context, lookupObservationId: id });
        }
    }
    conflicting ||= sendIdentityClaimsConflict(claims);
    const addressMappings = [
        ...new Map(facts.flatMap(fact => fact.addressMappings).map(mapping => [stable(mapping), mapping])).values()
    ];
    const proofSet = {
        resultIds: accepted.map(result => result.id), lookupObservationIds: trustedLookupIds,
        bindingIds: bindings.map(binding => binding.id), facts
    };
    if (input.lookupObservationId && trustedLookupIds.includes(input.lookupObservationId)) {
        const receiptTuple = ['outbound_dispatch_proof_set', attempt.token, proofSet.resultIds, trustedLookupIds];
        const bucket = await tx.canonicalObservation.findMany({ where: { ...scope, receiptHash: sha(stable(receiptTuple)) } });
        if (!bucket.some(row => equal(row.receiptTuple, receiptTuple)))
            await tx.canonicalObservation.create({
                data: {
                    ...scope, channelProvider: source.channelProvider === 'meta' ? 'meta_cloud' : 'evolution', provider: source.provider,
                    connectionProvider: source.connectionId ? source.provider as 'evolution' | 'waha' : null, connectionId: source.connectionId,
                    receiptHash: sha(stable(receiptTuple)), receiptTuple: json(receiptTuple), kind: 'outbound_dispatch_proof_set', eventType: 'send_proof_set',
                    mode: source.mode, source: 'local_dispatch', sessionName: source.sessionName, lifecycleGeneration: source.lifecycleGeneration,
                    receivedAt: new Date(), sourceOrder: json({}), payload: json({ token: attempt.token, attemptId: attempt.id, proofSet }),
                    state: conflicting ? 'held' : 'certified', reason: conflicting ? 'contradictory_dispatch_proof_set' : null
                }
            });
    }
    if (conflicting)
        return { kind: 'review' as const, proofSet };
    if (invalidLookup)
        return { kind: 'incomplete' as const, proofSet };
    const candidate = candidates.find(candidate => candidate.lookupObservationId === input.lookupObservationId)
        ?? candidates.find(candidate => candidate.lookupObservationId !== null) ?? candidates[0];
    if (!candidate)
        return { kind: 'incomplete' as const, proofSet };
    return { kind: 'complete' as const, ...candidate, addressMappings, proofSet };
}
