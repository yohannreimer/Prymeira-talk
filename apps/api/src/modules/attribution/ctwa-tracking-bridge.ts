import { createHmac } from 'node:crypto';
import type { PrismaClient, CtwaConversionEvent, CtwaAttribution } from '@prisma/client';
import { CtwaOperationError } from './ctwa-service.js';
import { stableCtwaEventId } from './ctwa-payload.js';
import { automaticTrackingWorkspaces, resolveTrackingConfig } from './ctwa-tracking-config.js';
type Event = CtwaConversionEvent & {
    attribution: CtwaAttribution;
};
export const TRACKING_RETRY_MS = 60000;
const retryStates = ['tracking_retry', 'tracking_pending'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function eligible(event: Event, now: Date) {
    if (event.state === 'pending_validation')
        return event.attemptCount === 0;
    if (retryStates.includes(event.state) || event.state === 'tracking_forwarding')
        return !!event.attemptedAt && event.attemptedAt.getTime() <= now.getTime() - TRACKING_RETRY_MS;
    return false;
}
function envelope(event: Event, contact: {
    name: string | null;
    phone: string;
} | null) {
    const attr = event.attribution;
    if (event.eventName !== 'LeadSubmitted' || event.businessKey !== 'once' || event.eventId !== stableCtwaEventId(event.workspaceId, event.channelId, event.attributionId, 'LeadSubmitted')
        || ![event.workspaceId, event.channelId, event.conversationId, event.messageId, event.attributionId].every(value => uuid.test(value))
        || attr.workspaceId !== event.workspaceId || attr.channelId !== event.channelId || attr.conversationId !== event.conversationId || attr.messageId !== event.messageId || attr.id !== event.attributionId
        || !/^[\x21-\x7e]{1,2048}$/.test(attr.ctwaClid) || (attr.adId !== null && !/^\d{1,64}$/.test(attr.adId))
        || !Number.isFinite(event.eventTime.getTime()) || event.eventTime.getTime() <= 0)
        throw new CtwaOperationError('invalid_tracking_identity');
    const name = contact?.name?.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
    const phone = contact?.phone?.trim();
    return { version: 1, workspaceId: event.workspaceId, channelId: event.channelId, conversationId: event.conversationId, messageId: event.messageId,
        attributionId: event.attributionId, eventId: event.eventId, eventName: 'LeadSubmitted', eventTime: Math.floor(event.eventTime.getTime() / 1000), ctwaClid: attr.ctwaClid,
        ...(attr.adId ? { adId: attr.adId } : {}), contact: { ...(name ? { name } : {}), ...(phone && /^\+?[1-9]\d{7,14}$/.test(phone) ? { phone } : {}) } };
}
async function boundedJson(response: Response) {
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error('empty');
    let size = 0, text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > 65536) {
                await reader.cancel();
                throw new Error('oversize');
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text) as unknown;
    }
    finally {
        reader.releaseLock();
    }
}
export function createCtwaTrackingBridge(db: PrismaClient, options: {
    secret?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    now?: () => Date;
} = {}) {
    const transport = options.fetch ?? fetch;
    const now = options.now ?? (() => new Date());
    return {
        async forward(workspaceId: string, eventId: string, apply = false) {
            const config = resolveTrackingConfig(options.secret, workspaceId);
            const event = await db.ctwaConversionEvent.findFirst({ where: { workspaceId, id: eventId }, include: { attribution: true } });
            if (!event)
                throw new CtwaOperationError('not_found', 404);
            let identityValid = true;
            try { envelope(event, null); } catch { identityValid = false; }
            const ready = Boolean(config?.enabled && identityValid && eligible(event, now()));
            if (!apply)
                return { id: event.id, eventId: event.eventId, state: event.state, attemptCount: event.attemptCount, configured: !!config?.enabled, autoForward: !!config?.autoForward, ready };
            if (!config?.enabled)
                throw new CtwaOperationError('tracking_disabled');
            if (!identityValid)
                throw new CtwaOperationError('invalid_tracking_identity');
            if (!ready)
                throw new CtwaOperationError('not_forwardable');
            const conversation = await db.conversation.findFirst({ where: { workspaceId, channelId: event.channelId, id: event.conversationId }, select: { contact: { select: { workspaceId: true, name: true, phone: true, isGroup: true } } } });
            if (!conversation || conversation.contact.workspaceId !== workspaceId || conversation.contact.isGroup)
                throw new CtwaOperationError('scoped_contact_missing');
            const raw = JSON.stringify(envelope(event, conversation.contact));
            const claim = await db.ctwaConversionEvent.updateMany({ where: { workspaceId, id: event.id, state: event.state, attemptCount: event.attemptCount, attemptedAt: event.attemptedAt }, data: { state: 'tracking_forwarding', attemptCount: { increment: 1 }, attemptedAt: now(), completedAt: null, outcomeCode: 'tracking_forwarding', responseCode: null, eventsReceived: null } });
            if (claim.count !== 1)
                throw new CtwaOperationError('not_forwardable');
            // The immutable conversion core comes from scoped persisted rows. Contact is presentation only.
            // No canonical transaction spans HTTP; D1 owns the sole downstream Meta claim.
            const attempt = event.attemptCount + 1;
            const timestamp = String(Math.floor(now().getTime() / 1000));
            const signature = createHmac('sha256', Buffer.from(config.signingKey, 'hex')).update(`${timestamp}\n${raw}`).digest('hex');
            let state = 'tracking_retry', outcomeCode = 'tracking_transport_uncertain';
            let responseCode: number | null = null, eventsReceived: number | null = null;
            const abort = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const exchange = async () => {
                    const response = await transport(config.endpoint, { method: 'POST', redirect: 'error', signal: abort.signal, headers: { 'Content-Type': 'application/json', 'X-Talk-Workspace': workspaceId, 'X-Talk-Timestamp': timestamp, 'X-Talk-Signature': signature }, body: raw });
                    responseCode = response.status;
                    if (response.status >= 400 && response.status < 500) {
                        await response.body?.cancel();
                        return { ok: false, body: null };
                    }
                    const body = await boundedJson(response);
                    return { ok: response.ok, body };
                };
                const result = await Promise.race([exchange(), new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, options.timeoutMs ?? 10000); })]);
                const record = result.body && typeof result.body === 'object' && !Array.isArray(result.body) ? result.body as Record<string, unknown> : {};
                if (result.ok && record.eventId === event.eventId && typeof record.state === 'string' && ['pending', 'sending', 'accepted', 'rejected', 'unknown'].includes(String(record.state)) && Number.isInteger(record.metaStatusCode) && Number(record.metaStatusCode) >= 0 && Number(record.metaStatusCode) <= 599
                    && (record.state !== 'accepted' || (Number(record.metaStatusCode) >= 200 && Number(record.metaStatusCode) < 300))
                    && (record.state !== 'rejected' || (Number(record.metaStatusCode) >= 400 && Number(record.metaStatusCode) < 500))) {
                    responseCode = Number(record.metaStatusCode);
                    state = record.state === 'pending' || record.state === 'sending' ? 'tracking_pending' : `tracking_${String(record.state)}`;
                    outcomeCode = `central_${String(record.state)}`;
                    eventsReceived = record.state === 'accepted' ? 1 : null;
                }
                else if (responseCode !== null && responseCode >= 400 && responseCode < 500) {
                    state = 'tracking_blocked';
                    outcomeCode = 'tracking_request_rejected';
                }
            }
            catch { /* Never persist/log remote errors, bodies, clicks, signing keys or credentials. */ }
            finally {
                clearTimeout(timer);
            }
            const saved = await db.ctwaConversionEvent.updateMany({ where: { workspaceId, id: event.id, state: 'tracking_forwarding', attemptCount: attempt }, data: { state, outcomeCode, responseCode, eventsReceived, completedAt: now() } });
            if (saved.count !== 1)
                throw new CtwaOperationError('tracking_claim_lost');
            return { id: event.id, eventId: event.eventId, state, outcomeCode, responseCode, eventsReceived };
        }
    };
}
export function createCtwaTrackingWorker(db: PrismaClient, options: {
    secret?: string;
    fetch?: typeof fetch;
    intervalMs?: number;
} = {}) {
    const bridge = createCtwaTrackingBridge(db, options);
    let stopped = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    let running: Promise<void> | undefined;
    const tick = () => {
        if (stopped || running)
            return;
        running = (async () => {
            const cutoff = new Date(Date.now() - TRACKING_RETRY_MS);
            for (const workspaceId of automaticTrackingWorkspaces(options.secret)) {
                if (stopped)
                    break;
                const events = await db.ctwaConversionEvent.findMany({ where: { workspaceId, eventName: 'LeadSubmitted', OR: [{ state: 'pending_validation', attemptCount: 0 }, { state: { in: [...retryStates, 'tracking_forwarding'] }, attemptedAt: { lte: cutoff } }] }, select: { id: true }, orderBy: [{ eventTime: 'asc' }, { id: 'asc' }], take: 25 });
                for (const event of events) {
                    if (stopped)
                        break;
                    try {
                        await bridge.forward(workspaceId, event.id, true);
                    }
                    catch { /* Isolated optional delivery; state/attempt CAS prevents a second owner. */ }
                }
            }
        })().catch(() => { /* Optional worker failures never enter customer messaging. */ }).finally(() => { running = undefined; });
    };
    return {
        start() {
            if (!stopped) return;
            stopped = false;
            tick();
            timer = setInterval(tick, options.intervalMs ?? 15000);
            timer.unref();
        },
        async stop() {
            stopped = true;
            clearInterval(timer);
            await running;
        }
    };
}
