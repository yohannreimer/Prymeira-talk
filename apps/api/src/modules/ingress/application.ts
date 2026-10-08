import { refreshOwnedConversationPreviewInTransaction, selectConversationPreviewInTransaction } from '../messaging/conversation-preview.js';
import { wellFormedPresentation } from '../messaging/well-formed-presentation.js';
import { reportFailure } from '../../observability/glitchtip.js';
import { groupFallbackName } from '../evolution/evolution-normalizer.js';
import { validateEvolutionIdentityDeclarations, validateWahaIdentityDeclarations } from '../messaging/identity-declarations.js';
import { Prisma, type IngressReceipt } from '@prisma/client';
import { enterCanonicalTransaction, enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { deriveTrustedMessagingContext, StaleMessagingSourceError } from '../messaging/canonical-source.js';
import { createCanonicalStore, REPLAYABLE_HOLDS, type CanonicalStoreResult } from '../messaging/canonical-store.js';
import { equal, json, sha, stable } from '../messaging/canonical-values.js';
import type { NormalizedMessagingEvent, TrustedMessagingContext } from '../messaging/normalized-event.js';
import { record } from '../messaging/whatsapp-identity.js';
import { pauseAgentOnHumanOutbound } from '../conversations/pause-agent-on-human-outbound.js';
import { lockProspectingConversation } from '../prospecting/prospecting-lock.js';
import { applyInboundDepartmentRouting } from '../team/team-routing.service.js';
import { readAssistantSettings } from '../assistant/assistant-policy.js';
import { createAssistantRepository } from '../assistant/assistant-repository.js';
import { applyAuthenticatedConnectionObservation, normalizeWhatsappPhone } from '../channels/channel-connections.js';
import { autoResolveAuthority } from '../channels/conversation-authority.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import { normalizeWahaEvent } from '../waha/waha-normalizer.js';
import { IngressJournal } from './journal.js';
type Tx = Prisma.TransactionClient;
// Identity rules that may since have been corrected: the authenticated raw is read again under today's rules.
const IDENTITY_HOLD_REASONS = ['contradictory_sender_declarations', 'contradictory_chat_declarations', 'contradictory_direction_declarations', 'contradictory_stanza_declarations'];
// A WAHA message that arrived while its connection was not proven against the primary (e.g. 07/10: a WAHA reconnect
// cleared the proof and the probe that restores it was stuck). The raw is kept; once the same number is proven again
// on both connections it is applied as recovered traffic (no agent or automation runs). Another number never gets it.
const WAHA_AUTHORITY_HOLDS = ['waha_identity_unverified'];
// Held inside the canonical store until a later fact (a journaled Talk send, a message that arrives later): the same
// observation is replayed, never re-normalized into a second one (that would be a receipt-key conflict).
/** An event that is still invalid or still waiting for its source is retried after this, so it never blocks the queue. */
const RECERTIFY_BACKOFF_MS = 10 * 60_000;
type MessageEvent = Extract<NormalizedMessagingEvent, {
    kind: 'message';
}>;
/** Receipt UUID is the only authority input. No createApp, timers or effect handlers.
 * Private bytes are verified before TX; immutable SQL receipt is re-read after the
 * workspace boundary. A batch commits one event at a time and resumes its positions.
 */
export class IngressApplicationService {
    private readonly store = createCanonicalStore();
    private readonly assistant;
    constructor(readonly journal: IngressJournal) { this.assistant = createAssistantRepository(journal.db); }
    private readonly recertifyRetryAt = new Map<string, number>();
    async apply(receiptId: string) {
        const { receipt, payload } = await this.journal.readPayload(receiptId);
        const raw = JSON.parse((await this.journal.files.read(receipt.rawRef, receipt.rawDigest)).toString('utf8')) as unknown;
        const source = this.source(receipt);
        // Chats that two existing conversations claim: decided by the phone-number default once this receipt is stored.
        const contested = new Map<string, { workspaceId: string; channelId: string; chatId: string }>();
        for (const [eventIndex, item] of payload.events.entries()) {
            await this.journal.db.$transaction(async (tx) => {
                await enterCanonicalWorkspaceTransaction(tx, receipt.workspaceId);
                const persisted = await tx.ingressReceipt.findUniqueOrThrow({ where: { id: receiptId } });
                if (!equal(persisted.source, receipt.source) || persisted.eventDigest !== receipt.eventDigest || persisted.rawDigest !== receipt.rawDigest)
                    throw new Error('Receipt conservation changed');
                const previous = await tx.ingressEventProgress.findUnique({ where: { receiptId_eventIndex: { receiptId, eventIndex } } });
                if (previous)
                    return; // Held is conserved, never implicitly recertified by retry.
                const scope = { workspaceId: receipt.workspaceId, channelId: receipt.channelId, receiptId, eventIndex };
                let stale = false;
                try {
                    await enterCanonicalTransaction(tx, source);
                }
                catch (error) {
                    if (!(error instanceof StaleMessagingSourceError))
                        throw error;
                    stale = true;
                }
                if (stale) {
                    // The authenticated private receipt itself certifies conservation, not
                    // current domain authority. No public source check is bypassed.
                    await tx.ingressEventProgress.create({ data: { ...scope, state: 'pending_recertification', reason: 'stale_source', result: json({ kind: item.kind, source, certification: 'immutable_authenticated_receipt', reason: 'stale_source' }) } });
                    return;
                }
                // Revalidate conserved raw declarations as well as new adapter output.
                // Old queued receipts keep their original blobs/source; contradictions
                // cannot gain domain authority from a formerly preferred sender field.
                const contradiction = source.provider === 'evolution' ? validateEvolutionIdentityDeclarations(raw)
                    : source.provider === 'waha' ? validateWahaIdentityDeclarations(raw, item.kind === 'accepted' ? item.event.addressMappings : []) : null;
                if (contradiction) {
                    await tx.ingressEventProgress.create({ data: { ...scope, state: 'held', reason: contradiction, result: json({ kind: 'invalid', reason: contradiction, certification: 'immutable_authenticated_receipt' }) } });
                    return;
                }
                if (item.kind !== 'accepted') {
                    // Unsupported adapters are held, rather than understood or successful.
                    await tx.ingressEventProgress.create({ data: { ...scope, state: item.kind === 'ignored' && !item.reason.startsWith('unsupported') && !item.reason.includes('requires_') ? 'ignored' : 'held', reason: item.reason, result: json({ kind: item.kind, reason: item.reason }) } });
                    return;
                }
                // The digest-verified adapter payload supplies content/keys only. Immutable
                // authenticated source overwrites any embedded caller/context fields.
                const event = wellFormedPresentation({ ...item.event, context: source });
                if (event.kind === 'control') {
                    const result = await applyAuthenticatedConnectionObservation(tx, event);
                    await tx.ingressEventProgress.create({ data: { ...scope, state: result.applied ? 'applied' : 'held', reason: result.reason, result: json(result) } });
                    if (result.applied)
                        await this.effect(tx, receipt, eventIndex, 'realtime.connection', `control:${receiptId}:${eventIndex}`, null, null, null, { control: event.control, connectionId: source.connectionId, qr: event.control === 'qr' ? { privateReceiptId: receiptId, eventIndex } : null });
                    return;
                }
                if (source.provider === 'waha') {
                    const reason = await this.wahaIdentity(tx, receipt, source);
                    if (reason) {
                        await tx.ingressEventProgress.create({ data: { ...scope, state: reason === 'waha_pairing_changed' ? 'pending_recertification' : 'held', reason, result: json({ kind: event.kind, certification: 'immutable_authenticated_receipt', reason }) } });
                        return;
                    }
                }
                const result = await this.store.persistInTransaction(tx, event, { receiptKey: `${receiptId}:${eventIndex}` });
                await tx.ingressEventProgress.create({ data: { ...scope, state: result.outcome === 'held' ? 'held' : 'applied', reason: result.reconciliationReasons[0] ?? null,
                        observationId: result.observationId, actionId: result.actionId ?? null, messageId: result.messageId, conversationId: result.conversationId, result: json(result) } });
                if (result.outcome === 'held' && result.chatId && result.reconciliationReasons.includes('multiple_conversation_authorities'))
                    contested.set(result.chatId, { workspaceId: receipt.workspaceId, channelId: receipt.channelId, chatId: result.chatId });
                await this.afterPersist(tx, receipt, eventIndex, event, result, source);
            }, { isolationLevel: 'ReadCommitted', timeout: 15000 });
        }
        for (const chat of contested.values())
            await autoResolveAuthority(this.journal.db, chat).catch(() => undefined); // The sweep retries; a failure never fails the receipt.
        // No application completion at the start or at timer scheduling. Finalize only
        // after every conserved event position exists, including explicit held decisions.
        return this.journal.db.$transaction(async (tx) => {
            await enterCanonicalWorkspaceTransaction(tx, receipt.workspaceId);
            const rows = await tx.ingressEventProgress.findMany({ where: { receiptId } });
            if (rows.length !== receipt.eventCount || rows.some(r => r.eventIndex < 0 || r.eventIndex >= receipt.eventCount))
                throw new Error('Incomplete receipt application');
            const held = rows.some(r => r.state === 'held' || r.state === 'pending_recertification');
            const existing = await tx.ingressApplication.findUnique({ where: { receiptId } });
            const delivery = await tx.ingressDelivery.findUniqueOrThrow({ where: { receiptId } });
            const application = await tx.ingressApplication.upsert({ where: { receiptId }, create: { receiptId, workspaceId: receipt.workspaceId, channelId: receipt.channelId, state: held ? 'held' : 'applied', appliedAt: held ? null : new Date() }, update: { state: held ? 'held' : 'applied', appliedAt: held ? null : existing?.appliedAt ?? new Date() } });
            // Existing transport vocabulary: consumedAt + application/progress distinguish
            // canonical applied from conserved held. ACK may now follow this commit.
            await tx.ingressDelivery.update({ where: { receiptId }, data: { state: 'pending_application', consumedAt: delivery.consumedAt ?? new Date(), leaseToken: null, leaseUntil: null, lastError: held ? 'application_held' : null } });
            return application;
        }, { isolationLevel: 'ReadCommitted' });
    }
    /**
     * Certifies, under the connection's current source, an event that was held as `stale_source` because it arrived while
     * the connection was being paired or reset. The authenticated private receipt is unchanged and the progress row stays
     * an immutable fact; the outcome goes to `ingress_event_recertifications`. The message is kept (it is a real customer
     * message) but enters as recovered traffic: no agent, automation or follow-up fires for a message that may be minutes
     * old; people see it in the inbox as unread.
     */
    async recertify(receiptId: string, eventIndex: number) {
        const { receipt, payload } = await this.journal.readPayload(receiptId);
        let item = payload.events[eventIndex];
        if (!item)
            return { state: 'missing_event' as const };
        const raw = JSON.parse((await this.journal.files.read(receipt.rawRef, receipt.rawDigest)).toString('utf8')) as unknown;
        const original = this.source(receipt);
        if (original.connectionId === null)
            return { state: 'unsupported_source' as const };
        return this.journal.db.$transaction(async (tx) => {
            await enterCanonicalWorkspaceTransaction(tx, receipt.workspaceId);
            const progress = await tx.ingressEventProgress.findUnique({ where: { receiptId_eventIndex: { receiptId, eventIndex } } });
            const staleSource = progress?.state === 'pending_recertification' && progress.reason === 'stale_source';
            // Held by an identity rule that may since have been corrected (e.g. Evolution 2.4's empty participant).
            const identityHeld = progress?.state === 'held' && IDENTITY_HOLD_REASONS.includes(progress.reason ?? '');
            const storeHeld = progress?.state === 'held' && REPLAYABLE_HOLDS.includes(progress.reason ?? '') && Boolean(progress.observationId);
            const authorityHeld = progress?.state === 'held' && WAHA_AUTHORITY_HOLDS.includes(progress.reason ?? '') && original.provider === 'waha';
            if (!progress || (!staleSource && !identityHeld && !storeHeld && !authorityHeld))
                return { state: 'not_pending' as const };
            if (await tx.ingressEventRecertification.findUnique({ where: { receiptId_eventIndex: { receiptId, eventIndex } } }))
                return { state: 'already_certified' as const };
            const scope = { workspaceId: receipt.workspaceId, channelId: receipt.channelId, receiptId, eventIndex };
            if (storeHeld) {
                const replayed = await this.store.replayResolvableHeldInTransaction(tx, { workspaceId: receipt.workspaceId, channelId: receipt.channelId, observationId: progress.observationId! });
                // Not resolved yet (or no longer replayable): not recorded, so a later sweep can still recover it.
                if (!replayed || replayed.outcome === 'held')
                    return { state: 'still_invalid' as const, reason: replayed?.reconciliationReasons.at(-1) ?? 'not_replayable' };
                const observation = await tx.canonicalObservation.findUniqueOrThrow({ where: { id: replayed.observationId } });
                const event = observation.payload as unknown as Exclude<NormalizedMessagingEvent, { kind: 'control' }>;
                await this.afterPersist(tx, receipt, eventIndex, event, replayed, event.context);
                await tx.ingressEventRecertification.create({ data: { ...scope, outcome: 'applied', reason: null, observationId: replayed.observationId,
                    conversationId: replayed.conversationId, messageId: replayed.messageId, result: json(replayed) } });
                return { state: 'applied' as const };
            }
            let current: TrustedMessagingContext;
            try {
                current = await deriveTrustedMessagingContext(tx, { workspaceId: receipt.workspaceId, channelId: receipt.channelId,
                    authenticatedSource: { provider: original.provider as 'evolution' | 'waha', connectionId: original.connectionId },
                    mode: 'recovered_live', observedAt: new Date().toISOString() });
            }
            catch (error) {
                if (error instanceof StaleMessagingSourceError)
                    return { state: 'still_stale' as const }; // The connection is still being paired; try again later.
                throw error;
            }
            const record_ = async (outcome: 'applied' | 'held' | 'superseded', reason: string | null, extra: Partial<{ observationId: string | null; conversationId: string | null; messageId: string | null }>, result: unknown) => {
                await tx.ingressEventRecertification.create({ data: { ...scope, outcome, reason, ...extra, result: json(result) } });
                return { state: outcome } as const;
            };
            if (current.sessionName !== original.sessionName)
                return record_('held', 'session_changed', {}, { reason: 'session_changed' });
            // A reset can end with another phone paired. Only the same verified WhatsApp number may inherit the message.
            const acceptedNumber = normalizeWhatsappPhone(record(record(receipt.source).acceptedFacts).verifiedPhoneNumber as string | null | undefined);
            const physical = await tx.channelConnection.findUniqueOrThrow({ where: { id: original.connectionId } });
            const currentNumber = normalizeWhatsappPhone(physical.verifiedPhoneNumber);
            if (!acceptedNumber)
                return record_('held', 'number_unproven', {}, { reason: 'number_unproven' });
            if (!currentNumber || physical.status !== 'connected')
                return { state: 'still_stale' as const };
            if (currentNumber !== acceptedNumber)
                return record_('held', 'number_changed', {}, { reason: 'number_changed' });
            if (identityHeld) {
                // The stored adapter output is the old verdict: read the authenticated raw again with today's rules.
                const again = original.provider === 'evolution' ? validateEvolutionIdentityDeclarations(raw) : validateWahaIdentityDeclarations(raw, []);
                if (again)
                    return { state: 'still_invalid' as const, reason: again }; // Not recorded: a later correction can still recover it.
                item = original.provider === 'evolution' ? normalizeEvolutionWebhook(current, raw) : normalizeWahaEvent(current, raw);
            }
            if (item.kind !== 'accepted' || item.event.kind === 'control')
                return record_('superseded', 'obsolete_connection_event', {}, { kind: item.kind });
            const contradiction = original.provider === 'evolution' ? validateEvolutionIdentityDeclarations(raw) : validateWahaIdentityDeclarations(raw, item.event.addressMappings);
            if (contradiction)
                return record_('held', contradiction, {}, { reason: contradiction });
            if (original.provider === 'waha') {
                // Receive authority for the second connection requires the same verified number on both connections now.
                const primary = await tx.channelConnection.findFirst({ where: { workspaceId: receipt.workspaceId, channelId: receipt.channelId, provider: 'evolution' } });
                const secondary = await tx.channelConnection.findUnique({ where: { id: original.connectionId } });
                const a = normalizeWhatsappPhone(primary?.verifiedPhoneNumber), b = normalizeWhatsappPhone(secondary?.verifiedPhoneNumber);
                if (!a || !b || a !== b || !secondary?.lastHealthyAt || !primary || primary.lifecycleGeneration % 2 !== 0)
                    return { state: 'still_stale' as const };
            }
            const event = wellFormedPresentation({ ...item.event, context: current });
            const result = await this.store.persistInTransaction(tx, event, { receiptKey: `${receiptId}:${eventIndex}` });
            if (result.outcome === 'held')
                return record_('held', result.reconciliationReasons[0] ?? 'held', { observationId: result.observationId }, result);
            await this.afterPersist(tx, receipt, eventIndex, event, result, current);
            if (event.kind === 'message' && result.outcome === 'created' && result.messageId && result.conversationId) {
                const message = await tx.message.findUniqueOrThrow({ where: { id: result.messageId } });
                if (message.direction === 'inbound')
                    await tx.conversation.update({ where: { workspaceId_id: { workspaceId: receipt.workspaceId, id: result.conversationId } }, data: { unreadCount: { increment: 1 }, hiddenUntilReply: false } });
                await selectConversationPreviewInTransaction(tx, current, { conversationId: result.conversationId, messageId: message.id, preview: event.content.preview, selection: 'new_message' });
                await tx.conversation.updateMany({ where: { workspaceId: receipt.workspaceId, id: result.conversationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: message.createdAt } }] }, data: { lastMessageAt: message.createdAt } });
            }
            return record_('applied', null, { observationId: result.observationId, conversationId: result.conversationId, messageId: result.messageId }, result);
        }, { isolationLevel: 'ReadCommitted', timeout: 30000 });
    }
    /** Certifies every event waiting for a current source on this workspace scope. Returns how many were applied. */
    async recertifyPending(input: { workspaceIds?: readonly string[]; limit?: number }) {
        const scope = input.workspaceIds ? { workspaceId: { in: [...input.workspaceIds] } } : {};
        const select = { receiptId: true, eventIndex: true } as const;
        const [main, authority] = await Promise.all([
            this.journal.db.ingressEventProgress.findMany({ where: { recertification: { is: null },
                OR: [{ state: 'pending_recertification', reason: 'stale_source' }, { state: 'held', reason: { in: [...IDENTITY_HOLD_REASONS, ...REPLAYABLE_HOLDS] } }],
                ...scope }, orderBy: { committedAt: 'asc' }, take: 1000, select }),
            // Their own queue: thousands of holds that never resolve (contradictory declarations) would otherwise fill the
            // 1000 oldest places and these would never be reached.
            this.journal.db.ingressEventProgress.findMany({ where: { recertification: { is: null }, state: 'held', reason: { in: WAHA_AUTHORITY_HOLDS }, ...scope },
                orderBy: { committedAt: 'asc' }, take: 1000, select })
        ]);
        // Interleaved, so each sweep reaches both queues.
        const rows: typeof main = [];
        for (let index = 0; index < Math.max(main.length, authority.length); index++) {
            if (authority[index]) rows.push(authority[index]!);
            if (main[index]) rows.push(main[index]!);
        }
        // Oldest first, but an event that stays invalid (not recorded, so it would be read again) waits its backoff
        // instead of holding the first places of the queue forever.
        const limit = input.limit ?? 50, now = Date.now();
        let applied = 0, examined = 0;
        for (const row of rows) {
            const key = `${row.receiptId}:${row.eventIndex}`;
            if ((this.recertifyRetryAt.get(key) ?? 0) > now) continue;
            if (examined >= limit) break;
            examined++;
            try {
                const outcome = await this.recertify(row.receiptId, row.eventIndex);
                if (outcome.state === 'applied') applied++;
                if (outcome.state === 'still_invalid' || outcome.state === 'still_stale') this.recertifyRetryAt.set(key, now + RECERTIFY_BACKOFF_MS);
                else this.recertifyRetryAt.delete(key);
            } catch (error) {
                // The per-event transaction rolled back; keep the immutable receipt pending.
                reportFailure('recertification_event', error);
                // Back off this event so one malformed message cannot abort/starve the sweep.
                this.recertifyRetryAt.set(key, now + RECERTIFY_BACKOFF_MS);
                const code = record(error).code;
                console.warn('Recertification event failed', { receiptId: row.receiptId, eventIndex: row.eventIndex,
                    code: typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'recertification_error' });
            }
        }
        return { examined, applied };
    }
    /** Everything that follows a successful canonical persist. Shared by first application and recertification. */
    private async afterPersist(tx: Tx, receipt: IngressReceipt, eventIndex: number, event: Exclude<NormalizedMessagingEvent, { kind: 'control' }>, result: CanonicalStoreResult, source: TrustedMessagingContext) {
        event = wellFormedPresentation(event);
        if (result.conversationId)
            await lockProspectingConversation(tx, source.workspaceId, result.conversationId);
        if (event.kind === 'message' && result.messageId && result.conversationId && result.outcome !== 'held')
            await this.contactAnnotations(tx, receipt, eventIndex, event, result);
        if (event.kind === 'message' && result.outcome !== 'held' && result.messageId && result.conversationId)
            await this.preparePresentationMedia(tx, receipt, eventIndex, event, result);
        if (event.kind === 'message') {
            if (result.allowOperationalEffects && result.outcome === 'created')
                await this.messageHooks(tx, receipt, eventIndex, event, result);
            else if (result.messageId && result.conversationId) {
                if (result.outcome !== 'held' && source.mode === 'live')
                    await this.exactEcho(tx, receipt, eventIndex, event, result);
                if (result.changes.length) {
                    const current = await tx.message.findUniqueOrThrow({ where: { id: result.messageId } });
                    await this.invalidate(tx, receipt, eventIndex, result, `content:${result.messageId}:${sha(stable([current.body, current.mediaUrl, current.metadata, current.status]))}`);
                }
            }
        }
        else if (result.messageId && result.conversationId && result.changes.length) {
            const current = await tx.message.findUniqueOrThrow({ where: { id: result.messageId } });
            if (event.kind === 'edit' || event.kind === 'revoke')
                await refreshOwnedConversationPreviewInTransaction(tx, source, { conversationId: result.conversationId, messageId: current.id, preview: current.body });
            await this.invalidate(tx, receipt, eventIndex, result, `action:${result.messageId}:${sha(stable([event.kind, event.target, 'action' in event ? event.action : null, 'order' in event ? event.order : null, 'patch' in event ? event.patch : null, 'status' in event ? event.status : null, 'recipient' in event ? event.recipient : null]))}`);
            if (event.kind === 'edit' || event.kind === 'encrypted_edit' || event.kind === 'revoke') {
                await this.effect(tx, receipt, eventIndex, 'content.reconcile', `action:${result.actionId}`, result.messageId, result.conversationId, result.observationId, { kind: event.kind, actionId: result.actionId });
            }
        }
    }
    private source(receipt: IngressReceipt): TrustedMessagingContext {
        const { acceptedFacts: _facts, ...source } = record(receipt.source);
        if (source.workspaceId !== receipt.workspaceId || source.channelId !== receipt.channelId || !['evolution', 'waha', 'meta_official'].includes(String(source.provider)) || !['live', 'history', 'recovered_live'].includes(String(source.mode)) || typeof source.observedAt !== 'string' || !Number.isFinite(new Date(source.observedAt).getTime()))
            throw new Error('Invalid authenticated receipt source');
        return source as unknown as TrustedMessagingContext;
    }
    private async wahaIdentity(tx: Tx, receipt: IngressReceipt, source: TrustedMessagingContext) {
        await tx.$queryRaw `SELECT id FROM channel_connections WHERE workspace_id=${source.workspaceId} AND channel_id=${source.channelId}::uuid AND provider='evolution' FOR SHARE`;
        const primary = await tx.channelConnection.findFirst({ where: { workspaceId: source.workspaceId, channelId: source.channelId, provider: 'evolution' } });
        const secondary = await tx.channelConnection.findUniqueOrThrow({ where: { id: source.connectionId! } });
        const accepted = record(record(receipt.source).acceptedFacts), pairing = record(accepted.pairing);
        if (!Object.keys(pairing).length)
            return 'waha_pairing_changed'; // Older accepted receipts require explicit recertification.
        const primaryPhone = normalizeWhatsappPhone(primary?.verifiedPhoneNumber), secondaryPhone = normalizeWhatsappPhone(secondary.verifiedPhoneNumber);
        if (pairing.primaryConnectionId !== primary?.id || pairing.primaryLifecycleGeneration !== primary?.lifecycleGeneration || pairing.primaryPhoneNumber !== primaryPhone || pairing.secondaryPhoneNumber !== secondaryPhone)
            return 'waha_pairing_changed';
        if (!primaryPhone || !secondaryPhone || !pairing.pairedAt || !secondary.lastHealthyAt || !primary || primary.lifecycleGeneration % 2 !== 0)
            return 'waha_identity_unverified';
        if (primaryPhone !== secondaryPhone)
            return 'waha_identity_mismatch';
        return null; // Health/eligible/status is deliberately not receive authority.
    }
    private async effect(tx: Tx, receipt: IngressReceipt, eventIndex: number, kind: string, logicalKey: string, messageId: string | null, conversationId: string | null, observationId: string | null, frozen: unknown) {
        const frontier = await tx.ingressFrontier.findUniqueOrThrow({ where: { receiptId_eventIndex: { receiptId: receipt.id, eventIndex } } });
        const scope = { workspaceId: receipt.workspaceId, channelId: receipt.channelId };
        await tx.ingressEffect.upsert({ where: { workspaceId_channelId_logicalKey_kind: { ...scope, logicalKey, kind } }, update: {}, create: { ...scope, receiptId: receipt.id, eventIndex, messageId, conversationId, kind, logicalKey,
                cause: json({ receiptId: receipt.id, eventIndex, frontierId: String(frontier.id), receiptOrdinal: String(receipt.ordinal), observationId, messageId, source: receipt.source, origin: 'authenticated_ingress' }), frozen: json(frozen) } });
    }
    private async invalidate(tx: Tx, receipt: IngressReceipt, index: number, result: CanonicalStoreResult, key: string) {
        for (const kind of ['realtime.message', 'realtime.conversation'])
            await this.effect(tx, receipt, index, kind, key, result.messageId, result.conversationId, result.observationId, { changes: result.changes, outcome: result.outcome });
    }
    private async preparePresentationMedia(tx: Tx, receipt: IngressReceipt, index: number, event: MessageEvent, result: CanonicalStoreResult) {
        if (!event.media?.hasMedia)
            return;
        const message = await tx.message.findUniqueOrThrow({ where: { id: result.messageId! } });
        if (record(message.metadata).deletedAt || !['audio', 'image', 'file'].includes(message.type))
            return;
        // Talk's own prepared attachments retain their UUID and owned asset. An
        // echo does not reacquire a provider copy or replace the prepared result.
        if (await tx.outboundIntent.findUnique({ where: { messageId: message.id } }))
            return;
        await this.effect(tx, receipt, index, 'media.prepare', `message:${message.id}`, message.id, result.conversationId, result.observationId, {
            presentationOnly: true, privateReceiptId: receipt.id, eventIndex: index, mediaKind: event.media.kind, type: message.type,
            mode: event.context.mode, isGroup: event.key.chatAddress?.endsWith('@g.us') === true, dependsOn: [],
            // Identifiers only (no content): lets any process fetch the bytes from the provider that received
            // the message without access to the private receipt store.
            mediaSource: { provider: event.context.provider, channelProvider: event.context.channelProvider, sessionName: event.context.sessionName,
                key: event.key, mimeType: event.attachment.mimeType ?? null }
        });
    }
    private async contactAnnotations(tx: Tx, receipt: IngressReceipt, index: number, event: MessageEvent, result: CanonicalStoreResult) {
        const conversationId = result.conversationId!;
        const workspaceId = event.context.workspaceId;
        const conversation = await tx.conversation.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: conversationId } }, include: { contact: true } });
        const isGroup = event.key.chatAddress?.endsWith('@g.us') === true;
        if (isGroup && !conversation.contact.isGroup)
            await tx.contact.updateMany({ where: { workspaceId, id: conversation.contactId, isGroup: false }, data: { isGroup: true } });
        if (!isGroup && !conversation.contact.name?.trim() && event.key.direction === 'inbound' && event.pushName?.trim())
            await tx.contact.updateMany({ where: { workspaceId, id: conversation.contactId, name: conversation.contact.name }, data: { name: event.pushName.trim().slice(0, 120) } });
        if (isGroup && (!conversation.contact.name?.trim() || conversation.contact.name === groupFallbackName(event.key.chatAddress!)))
            await this.effect(tx, receipt, index, 'contact.group_metadata', `contact:${conversation.contactId}:group_metadata`, result.messageId, conversationId, result.observationId, {
                contactId: conversation.contactId, chatId: result.chatId, chatAddress: event.key.chatAddress, nativeChatAddress: event.key.nativeChatAddress,
                originalName: conversation.contact.name, provider: event.context.provider, mode: event.context.mode, presentationOnly: true, dependsOn: []
            });
        const lid = event.addressMappings.find(e => e.role === 'chat')?.lid;
        if (lid)
            await tx.contact.update({ where: { workspaceId_id: { workspaceId, id: conversation.contactId } }, data: { customFields: json({ ...record(conversation.contact.customFields), evolutionLid: lid }) } });
    }
    private async exactEcho(tx: Tx, receipt: IngressReceipt, index: number, event: MessageEvent, result: CanonicalStoreResult) {
        if (event.key.direction !== 'outbound' || event.key.chatAddress?.endsWith('@g.us'))
            return;
        const { workspaceId, channelId } = event.context;
        const intent = await tx.outboundIntent.findUnique({ where: { messageId: result.messageId! } });
        if (!intent || intent.originKind !== 'campaign_recipient')
            return;
        const binding = await tx.outboundBinding.findFirst({ where: { workspaceId, channelId, intentId: intent.id, identityId: result.identityId! } });
        if (!binding)
            return;
        const campaign = await tx.campaignRecipient.findFirst({ where: { workspaceId, channelId, id: intent.originId, campaign: { is: { hideFromInboxUntilReply: true } } }, select: { id: true } });
        if (!campaign)
            return;
        const key = `campaign_echo:${intent.messageId}`;
        if (await tx.ingressEffect.findUnique({ where: { workspaceId_channelId_logicalKey_kind: { workspaceId, channelId, logicalKey: key, kind: 'realtime.conversation' } } }))
            return;
        const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: result.conversationId! } });
        const message = await tx.message.findUniqueOrThrow({ where: { id: result.messageId! } });
        // Exact hidden campaign on a new inbox lane. Existing visible conversations
        // remain visible; an old echo cannot conceal a customer reply.
        const inbound = await tx.message.count({ where: { workspaceId, conversationId: conversation.id, direction: 'inbound' } });
        if (!inbound && !conversation.lastMessageAt)
            await tx.conversation.update({ where: { id: conversation.id }, data: { hiddenUntilReply: true } });
        await selectConversationPreviewInTransaction(tx, event.context, { conversationId: conversation.id, messageId: message.id, preview: event.content.preview, selection: 'echo' });
        await this.effect(tx, receipt, index, 'realtime.conversation', key, message.id, conversation.id, result.observationId, { talkEcho: true, hiddenCampaign: true, intentId: intent.id, bindingId: binding.id });
    }
    private async messageHooks(tx: Tx, receipt: IngressReceipt, index: number, event: MessageEvent, result: CanonicalStoreResult) {
        if (!result.messageId || !result.conversationId)
            throw new Error('Created message lacks domain scope');
        const { workspaceId, channelId } = event.context, conversationId = result.conversationId;
        const message = await tx.message.findUniqueOrThrow({ where: { id: result.messageId } });
        const conversation = await tx.conversation.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: conversationId } }, include: { contact: true, channel: true } });
        const isGroup = event.key.chatAddress?.endsWith('@g.us') === true;
        const unresolvedLid = conversation.contact.phone.endsWith('@lid');
        if (isGroup || unresolvedLid)
            await tx.conversation.update({ where: { id: conversationId }, data: { aiControlStatus: 'human_controlled' } });
        // Only a native binding/intent may classify Talk's own echo or hide campaigns.
        // Body, time, recipient similarity and provider IDs globally are never evidence.
        const intent = await tx.outboundIntent.findUnique({ where: { messageId: message.id } });
        const binding = intent ? await tx.outboundBinding.findFirst({ where: { workspaceId, channelId, intentId: intent.id, identityId: result.identityId! } }) : null;
        const talkEcho = !!binding;
        const campaign = intent?.originKind === 'campaign_recipient' && talkEcho ? await tx.campaignRecipient.findFirst({ where: { workspaceId, channelId, id: intent.originId, campaign: { is: { hideFromInboxUntilReply: true } } }, select: { id: true } }) : null;
        const human = message.direction === 'outbound' && !talkEcho && !isGroup;
        const humanTookControl = human ? await pauseAgentOnHumanOutbound(tx, { workspaceId, conversationId }) : false;
        // We answered from the phone (not an echo of Talk's own send): whatever was waiting has been seen.
        if (message.direction === 'outbound' && !talkEcho)
            await tx.conversation.updateMany({ where: { workspaceId, id: conversationId, unreadCount: { gt: 0 } }, data: { unreadCount: 0 } });
        // A reaction is shown on the message it reacts to; like WhatsApp, it is not an unread message.
        const isReaction = event.kind === 'message' && !!event.content.reaction;
        if (message.direction === 'inbound' && !isReaction) {
            await tx.conversation.update({ where: { workspaceId_id: { workspaceId, id: conversationId } }, data: { unreadCount: { increment: 1 }, hiddenUntilReply: false } });
            if (event.context.channelProvider === 'meta') {
                const expires = new Date(message.createdAt.getTime() + 24 * 60 * 60 * 1000);
                await tx.conversation.updateMany({ where: { workspaceId, id: conversationId, OR: [{ customerServiceWindowExpiresAt: null }, { customerServiceWindowExpiresAt: { lt: expires } }] }, data: { customerServiceWindowExpiresAt: expires } });
            }
            if (!isGroup)
                await applyInboundDepartmentRouting(tx, { workspaceId, channelId, conversationId });
        }
        if (campaign && !conversation.lastMessageAt)
            await tx.conversation.update({ where: { id: conversationId }, data: { hiddenUntilReply: true } });
        // Preview and visibility have separate monotonic clocks; a delayed event cannot
        // move either backwards. A hidden campaign doesn't advance inbox visibility.
        await selectConversationPreviewInTransaction(tx, event.context, { conversationId, messageId: message.id, preview: result.changes.includes('message_edited') ? message.body : event.content.preview, selection: 'new_message' });
        if (!campaign)
            await tx.conversation.updateMany({ where: { workspaceId, id: conversationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: message.createdAt } }] }, data: { lastMessageAt: message.createdAt } });
        if (!isGroup && message.type !== 'system' && !unresolvedLid) {
            if (humanTookControl)
                await tx.assistantConversationState.updateMany({ where: { workspaceId, conversationId }, data: { status: 'stale', revision: { increment: 1 }, scheduledAt: null, lastMessageId: null, lastError: null } });
            else if (message.direction === 'inbound')
                await this.assistant.schedule({ workspaceId, conversationId, messageId: message.id, trigger: 'inbound' }, tx);
        }
        const prospecting = await tx.campaignProspectingReservation.findUnique({ where: { workspaceId_conversationId: { workspaceId, conversationId } }, select: { id: true, status: true, generation: true, campaignId: true, recipientId: true, agentId: true, dispatchIntentAt: true, confirmedAt: true } });
        const frozen = { direction: message.direction, type: message.type, isGroup, unresolvedLid, talkEcho, humanTookControl, hiddenCampaign: !!campaign, live: true, mode: event.context.mode,
            observedAt: event.context.observedAt, messageCreatedAt: message.createdAt.toISOString(), ingestedAt: message.ingestedAt?.toISOString() ?? null, prospecting,
            control: humanTookControl ? 'human_controlled' : conversation.aiControlStatus, activeAgentSessionId: conversation.activeAgentSessionId,
            requiresContentReady: !!event.media?.hasMedia, assistantSettings: readAssistantSettings(conversation.channel.encryptedConfig) };
        const key = `message:${message.id}`;
        await this.invalidate(tx, receipt, index, result, key);
        const obligation = async (kind: string, extra: unknown = {}) => this.effect(tx, receipt, index, kind, key, message.id, conversationId, result.observationId, { ...frozen, dependsOn: ['assistant.message', 'agent.debounce', 'automation.occurrence', 'triage.message', 'handoff.brief'].includes(kind) && message.direction === 'inbound' ? [...(kind === 'handoff.brief' || kind === 'triage.message' ? [] : ['prospecting.inbound']), ...(event.media?.hasMedia ? ['media.prepare'] : [])] : [], ...record(extra) });
        if (isGroup || message.type === 'system')
            return;
        if (humanTookControl)
            await obligation('assistant.control');
        else if (!talkEcho && !unresolvedLid)
            await obligation('assistant.message');
        await obligation('handoff.brief');
        if (!talkEcho)
            await obligation('triage.message');
        if (message.direction === 'inbound') {
            await obligation('prospecting.inbound');
            await obligation('history.backfill', { chatAddress: event.key.chatAddress, pushName: event.pushName });
            await obligation('followup.activity', { source: 'customer' });
            if (!unresolvedLid) {
                const flows = await tx.automationRule.findMany({ where: { workspaceId, status: 'enabled', trigger: 'message.received' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, trigger: true, conditions: true, actions: true, updatedAt: true } });
                await obligation('automation.occurrence', { eventKey: `message.received:${message.id}`, frozenFlows: flows });
                await obligation('agent.debounce');
            }
        }
        else if (humanTookControl) {
            await obligation('followup.activity', { source: 'human' });
            await obligation('human_reply.improvement');
        }
    }
}
