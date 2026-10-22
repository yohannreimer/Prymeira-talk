import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createCtwaTrackingBridge, createCtwaTrackingWorker, TRACKING_RETRY_MS } from './ctwa-tracking-bridge.js';
import { TRACKING_ENDPOINT, resolveTrackingConfig } from './ctwa-tracking-config.js';
import { stableCtwaEventId } from './ctwa-payload.js';
import { createCtwaService } from './ctwa-service.js';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = uuid(1), channelId = uuid(2), conversationId = uuid(3), messageId = uuid(4), attributionId = uuid(5), id = uuid(6);
const config = { endpoint: TRACKING_ENDPOINT, signingKey: 'a'.repeat(64), enabled: true, autoForward: false };
const secret = JSON.stringify({ [workspaceId]: config });
const eventId = stableCtwaEventId(workspaceId, channelId, attributionId, 'LeadSubmitted');
const now = new Date('2026-10-22T12:00:00Z');
function fixture(response: () => Promise<Response> = async () => Response.json({ eventId, state: 'accepted', metaStatusCode: 200 })) {
    let row: any = { id, workspaceId, channelId, conversationId, messageId, attributionId, eventId, eventName: 'LeadSubmitted', businessKey: 'once', eventTime: new Date('2026-10-19T12:00:00Z'), state: 'pending_validation', attemptCount: 0, attemptedAt: null, attribution: { id: attributionId, workspaceId, channelId, conversationId, messageId, ctwaClid: 'synthetic-click', adId: '123' } };
    let contact = { workspaceId, name: 'Owned Contact', phone: '5547999990000', isGroup: false };
    const db = { ctwaConversionEvent: { findFirst: vi.fn(async ({ where }) => where.workspaceId === workspaceId && where.id === id ? structuredClone(row) : null), findMany: vi.fn(async () => [{ id }]), updateMany: vi.fn(async ({ where, data }) => {
                if (where.workspaceId !== workspaceId || where.id !== id || where.state !== row.state || where.attemptCount !== row.attemptCount)
                    return { count: 0 };
                if (Object.hasOwn(where, 'attemptedAt') && (where.attemptedAt?.getTime() ?? null) !== (row.attemptedAt?.getTime() ?? null))
                    return { count: 0 };
                row = { ...row, ...data, attemptCount: data.attemptCount?.increment ? row.attemptCount + data.attemptCount.increment : row.attemptCount };
                return { count: 1 };
            }) }, conversation: { findFirst: vi.fn(async ({ where }) => where.workspaceId === workspaceId && where.channelId === channelId && where.id === conversationId ? { contact } : null) } };
    const fetch = vi.fn(response);
    const bridge = createCtwaTrackingBridge(db as unknown as PrismaClient, { secret, fetch, now: () => now, timeoutMs: 20 });
    return { db, fetch, bridge, get row() { return row; }, set row(value) { row = value; }, get contact() { return contact; }, set contact(value) { contact = value; } };
}
describe('Tracking bridge scope and single ownership', () => {
    it('dry-run has no claims, contact reads, transport or secrets', async () => { const f = fixture(); const result = await f.bridge.forward(workspaceId, id); expect(result).toMatchObject({ ready: true, configured: true, autoForward: false, attemptCount: 0 }); expect(f.db.ctwaConversionEvent.updateMany).not.toHaveBeenCalled(); expect(f.db.conversation.findFirst).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toMatch(/synthetic-click|Owned Contact|signingKey/); });
    it('exact valid config only; no arbitrary URL, secret fallback, or typo fields', () => {
        expect(resolveTrackingConfig(secret, workspaceId)).toEqual(config);
        for (const bad of [{ ...config, endpoint: 'http://localhost/test' }, { ...config, endpoint: TRACKING_ENDPOINT + '?secret=x' }, { ...config, signingKey: 'short' }, { ...config, enabled: 'true' }, { ...config, extra: true }])
            expect(resolveTrackingConfig(JSON.stringify({ [workspaceId]: bad }), workspaceId)).toBeNull();
        expect(resolveTrackingConfig(secret, uuid(99))).toBeNull();
        expect(resolveTrackingConfig('[]', workspaceId)).toBeNull();
    });
    it('only one concurrent CAS exports immutable core with signed raw bytes and scoped contact', async () => {
        const f = fixture();
        const results = await Promise.allSettled([f.bridge.forward(workspaceId, id, true), f.bridge.forward(workspaceId, id, true)]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(f.fetch).toHaveBeenCalledTimes(1);
        const [url, options] = f.fetch.mock.calls[0] as unknown as [
            string,
            RequestInit
        ];
        expect(url).toBe(TRACKING_ENDPOINT);
        expect(options.redirect).toBe('error');
        const raw = String(options.body);
        const body = JSON.parse(raw);
        expect(body).toMatchObject({ eventId, eventTime: 1792411200, ctwaClid: 'synthetic-click', contact: { name: 'Owned Contact', phone: '5547999990000' } });
        const headers = options.headers as Record<string, string>;
        expect(headers['X-Talk-Signature']).toBe(createHmac('sha256', Buffer.from(config.signingKey, 'hex')).update(`${headers['X-Talk-Timestamp']}\n${raw}`).digest('hex'));
        expect(f.row.state).toBe('tracking_accepted');
        expect(f.row.attemptCount).toBe(1);
        await expect(f.bridge.forward(workspaceId, id, true)).rejects.toThrow('not_forwardable');
    });
    it('wrong workspace and mismatched contact or attribution cannot claim/export', async () => {
        const f = fixture();
        await expect(f.bridge.forward(uuid(99), id, true)).rejects.toThrow('not_found');
        f.contact = { ...f.contact, workspaceId: uuid(99) };
        await expect(f.bridge.forward(workspaceId, id, true)).rejects.toThrow('scoped_contact_missing');
        expect(f.fetch).not.toHaveBeenCalled();
        f.contact = { ...f.contact, workspaceId };
        f.row = { ...f.row, attribution: { ...f.row.attribution, messageId: uuid(99) } };
        await expect(f.bridge.forward(workspaceId, id, true)).rejects.toThrow('invalid_tracking_identity');
        expect(f.db.ctwaConversionEvent.updateMany).not.toHaveBeenCalled();
    });
    it.each(['accepted', 'failed', 'unknown', 'sending', 'tracking_accepted', 'tracking_rejected', 'tracking_unknown', 'tracking_blocked'])('does not take previously owned %s', async (state) => { const f = fixture(); f.row = { ...f.row, state }; await expect(f.bridge.forward(workspaceId, id, true)).rejects.toThrow('not_forwardable'); expect(f.fetch).not.toHaveBeenCalled(); });
    it('pending_validation with prior attempts and other business events cannot be auto adopted', async () => { const f = fixture(); f.row = { ...f.row, attemptCount: 1 }; await expect(f.bridge.forward(workspaceId, id, true)).rejects.toThrow('not_forwardable'); f.row = { ...f.row, attemptCount: 0, eventName: 'Purchase' }; expect((await f.bridge.forward(workspaceId, id)).ready).toBe(false); await expect(f.bridge.forward(workspaceId, id, true)).rejects.toThrow('invalid_tracking_identity'); });
});
describe('central state, uncertainty and stale claim recovery', () => {
    it.each([['accepted', 200, 'tracking_accepted'], ['rejected', 400, 'tracking_rejected'], ['unknown', 0, 'tracking_unknown'], ['pending', 0, 'tracking_pending'], ['sending', 0, 'tracking_pending']])('mirrors %s without any direct Meta call', async (state, metaStatusCode, localState) => { const f = fixture(async () => Response.json({ eventId, state, metaStatusCode })); expect((await f.bridge.forward(workspaceId, id, true)).state).toBe(localState); expect(f.fetch).toHaveBeenCalledTimes(1); });
    it('lost response retries only same frozen core, tolerates contact rename without overwriting centrally', async () => {
        const f = fixture(async () => { throw new Error('secret remote body'); });
        await f.bridge.forward(workspaceId, id, true);
        expect(f.row.state).toBe('tracking_retry');
        await expect(f.bridge.forward(workspaceId, id, true)).rejects.toThrow('not_forwardable');
        const first = JSON.parse(String((f.fetch.mock.calls[0] as unknown as [
            string,
            RequestInit
        ])[1].body));
        f.row = { ...f.row, attemptedAt: new Date(now.getTime() - TRACKING_RETRY_MS - 1) };
        f.contact = { ...f.contact, name: 'Renamed' };
        f.fetch.mockImplementation(async () => Response.json({ eventId, state: 'accepted', metaStatusCode: 200 }));
        await f.bridge.forward(workspaceId, id, true);
        const second = JSON.parse(String((f.fetch.mock.calls[1] as unknown as [
            string,
            RequestInit
        ])[1].body));
        delete first.contact;
        delete second.contact;
        expect(second).toEqual(first);
        expect(f.row.state).toBe('tracking_accepted');
    });
    it('recertifies stale forwarding with one state+attempt+time owner', async () => { const f = fixture(); f.row = { ...f.row, state: 'tracking_forwarding', attemptCount: 1, attemptedAt: new Date(now.getTime() - TRACKING_RETRY_MS - 1) }; await Promise.allSettled([f.bridge.forward(workspaceId, id, true), f.bridge.forward(workspaceId, id, true)]); expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.row.attemptCount).toBe(2); });
    it.each([async () => new Response('x'.repeat(65537)), async () => new Response('malformed'), async () => Response.json({ eventId: 'wrong', state: 'accepted', metaStatusCode: 200 }), async () => Response.json({ eventId, state: 'accepted', metaStatusCode: 0 }), async () => new Promise<Response>(() => { })])('transport/malformed uncertainty stays export-retryable and never calls Meta', async (response) => { const f = fixture(response); const result = await f.bridge.forward(workspaceId, id, true); expect(result.state).toBe('tracking_retry'); expect(JSON.stringify(result)).not.toMatch(/malformed|secret/); });
    it('definite bridge HTTP4xx blocks automatic forwarding without raw body', async () => { const f = fixture(async () => new Response('secret remote error', { status: 401 })); const result = await f.bridge.forward(workspaceId, id, true); expect(result.state).toBe('tracking_blocked'); expect(JSON.stringify(result)).not.toContain('secret'); });
    it('direct dispatcher refuses configured ownership and persisted tracking state', async () => { const f = fixture(); const directConfig = JSON.stringify({ [workspaceId]: { datasetId: '123', whatsappBusinessAccountId: '456', accessToken: 'synthetic', enabled: true } }); await expect(createCtwaService(f.db as unknown as PrismaClient, { secret: directConfig, trackingSecret: secret, fetch: f.fetch }).dispatch(workspaceId, id)).rejects.toThrow('tracking_owned'); f.row = { ...f.row, state: 'tracking_retry' }; await expect(createCtwaService(f.db as unknown as PrismaClient, { secret: directConfig, fetch: f.fetch }).dispatch(workspaceId, id)).rejects.toThrow('tracking_owned'); expect(f.fetch).not.toHaveBeenCalled(); });
    it('worker default manual mode neither scans nor forwards; enabled auto mode scans exact workspace only', async () => { const f = fixture(); const manual = createCtwaTrackingWorker(f.db as unknown as PrismaClient, { secret, fetch: f.fetch }); manual.start(); await manual.stop(); expect(f.db.ctwaConversionEvent.findMany).not.toHaveBeenCalled(); const auto = createCtwaTrackingWorker(f.db as unknown as PrismaClient, { secret: JSON.stringify({ [workspaceId]: { ...config, autoForward: true } }), fetch: f.fetch }); auto.start(); await new Promise(resolve => setTimeout(resolve, 5)); await auto.stop(); expect(f.db.ctwaConversionEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId, eventName: 'LeadSubmitted' }) })); expect(f.fetch).toHaveBeenCalledTimes(1); });
});
