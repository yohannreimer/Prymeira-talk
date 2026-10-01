import type { Prisma } from '@prisma/client';
import { enterCanonicalTransaction, enterCanonicalWorkspaceTransaction } from './canonical-boundary.js';
import { equal, nativeLookupTuple, sha, stable } from './canonical-values.js';
import { outboundChatRoot } from './outbound-authority.js';
import type { TrustedMessagingContext } from './normalized-event.js';
import { normalizeChatAddress, type WhatsAppMessageKey } from './whatsapp-identity.js';
type Tx = Prisma.TransactionClient;
const ambiguous = ['dispatching', 'accepted_unbound', 'uncertain', 'review'];
export function createOutboundObservationGate({ hash = sha }: {
    hash?: (value: string) => string;
} = {}) {
    async function chatForKey(tx: Tx, source: TrustedMessagingContext, key: WhatsAppMessageKey) {
        const address = normalizeChatAddress(key.chatAddress);
        if (!address)
            return null;
        const alias = await tx.canonicalAddressAlias.findUnique({
            where: {
                workspaceId_channelId_address: { workspaceId: source.workspaceId, channelId: source.channelId, address }
            }
        });
        if (!alias)
            return null;
        const chat = await tx.canonicalChat.findFirst({
            where: { workspaceId: source.workspaceId, channelId: source.channelId, addressId: alias.addressId }
        });
        if (!chat)
            return null;
        return outboundChatRoot(tx, source, chat.id);
    }
    /** Internal inspection after the workspace boundary. It grants no effect and is
     * also usable for immutable held facts whose source has since become stale. */
    async function inspectOutboundObservationInTransaction(tx: Tx, source: TrustedMessagingContext, key: WhatsAppMessageKey) {
        await enterCanonicalWorkspaceTransaction(tx, source.workspaceId);
        const scope = { workspaceId: source.workspaceId, channelId: source.channelId };
        const aliasTuple = [
            key.identityFormat, source.provider, source.connectionId, source.sessionName, key.nativeId, key.rawId, key.nativeChatAddress, key.nativeSenderParticipant, key.chatAddress, key.direction, key.senderParticipant
        ];
        const aliases = await tx.canonicalNativeAlias.findMany({ where: { ...scope, lookupHash: hash(stable(nativeLookupTuple(source, key))) } });
        const exact = aliases.filter(a => equal(a.fullTuple, aliasTuple) && a.state === 'resolved' && a.identityId);
        if (exact.length === 1) {
            const identity = await tx.canonicalMessageIdentity.findFirst({ where: { ...scope, id: exact[0]!.identityId! } });
            if (identity?.state === 'active' && identity.contentState !== 'pending_reconciliation')
                return { kind: 'known' as const, identity, aliasId: exact[0]!.id };
        }
        const chat = await chatForKey(tx, source, key);
        if (chat && key.direction && key.chatAddress && ((key.identityFormat === 'provider_native' && key.nativeId) || (key.identityFormat === 'whatsapp_stanza' && key.rawId))) {
            let senderId = '';
            if (key.chatAddress.endsWith('@g.us')) {
                const sender = key.senderParticipant ? await tx.canonicalAddressAlias.findUnique({ where: { workspaceId_channelId_address: { ...scope, address: key.senderParticipant } } }) : null;
                if (sender) {
                    let address = await tx.canonicalAddress.findUniqueOrThrow({ where: { id: sender.addressId } });
                    const seen = new Set<string>();
                    while (address.redirectId && !seen.has(address.id)) {
                        seen.add(address.id);
                        address = await tx.canonicalAddress.findUniqueOrThrow({ where: { id: address.redirectId } });
                    }
                    if (address.state === 'active')
                        senderId = address.id;
                }
            }
            if (!key.chatAddress.endsWith('@g.us') || senderId) {
                const tuple = [
                    scope.workspaceId, scope.channelId, chat.id, key.identityFormat, key.identityFormat === 'provider_native' ? source.provider : '', key.identityFormat === 'provider_native' ? key.nativeId : key.rawId, key.direction, senderId
                ];
                const bucket = await tx.canonicalMessageIdentity.findMany({ where: { ...scope, tupleHash: hash(stable(tuple)) } });
                const known = bucket.filter(i => equal(i.fullTuple, tuple) && i.state === 'active' && i.contentState !== 'pending_reconciliation');
                if (known.length === 1)
                    return { kind: 'known' as const, identity: known[0]!, aliasId: null };
            }
        }
        if (key.direction !== 'outbound' || !chat)
            return { kind: 'unmatched' as const };
        const candidates = await tx.outboundIntent.findMany({ where: { ...scope, state: { in: ambiguous } } });
        const intentIds: string[] = [];
        for (const i of candidates) {
            const root = await outboundChatRoot(tx, scope, i.chatId);
            if (root?.id === chat.id)
                intentIds.push(i.id);
        }
        if (intentIds.length)
            return { kind: 'held' as const, reason: 'outbound_dispatch_ambiguity', intentIds, chatId: chat.id };
        return { kind: 'unmatched' as const };
    }
    async function classifyOutboundObservationInTransaction(tx: Tx, source: TrustedMessagingContext, key: WhatsAppMessageKey) { await enterCanonicalTransaction(tx, source); return inspectOutboundObservationInTransaction(tx, source, key); }
    async function outboundObservationGateInTransaction(tx: Tx, scope: {
        workspaceId: string;
        channelId: string;
    }, chatId: string) {
        await enterCanonicalWorkspaceTransaction(tx, scope.workspaceId);
        const root = await outboundChatRoot(tx, scope, chatId);
        if (!root)
            return { kind: 'blocked' as const, reason: 'authority_requires_review' };
        const held = await tx.canonicalObservation.findMany({ where: { ...scope, state: 'held', reason: 'outbound_dispatch_ambiguity' } });
        for (const observation of held) {
            const event = observation.payload as unknown as {
                context: TrustedMessagingContext;
                key: WhatsAppMessageKey;
            };
            const other = await chatForKey(tx, event.context, event.key);
            if (other?.id === root.id)
                return { kind: 'blocked' as const, reason: 'held_outbound_observations' };
        }
        return { kind: 'clear' as const };
    }
    return {
        classifyOutboundObservationInTransaction, inspectOutboundObservationInTransaction, outboundObservationGateInTransaction
    };
}
export const { classifyOutboundObservationInTransaction, outboundObservationGateInTransaction } = createOutboundObservationGate();
