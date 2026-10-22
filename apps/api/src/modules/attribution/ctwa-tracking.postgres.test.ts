import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCtwaTrackingBridge, TRACKING_RETRY_MS } from './ctwa-tracking-bridge.js';
import { TRACKING_ENDPOINT } from './ctwa-tracking-config.js';
import { ctwaEventData, createCtwaService } from './ctwa-service.js';
import { hash } from './ctwa-payload.js';
const url = process.env.CTWA_TEST_DATABASE_URL;
if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'postgresql:' || parsed.hostname !== '127.0.0.1' || !parsed.port || !['/talk_ctwa_test', '/messaging_test'].includes(parsed.pathname))
        throw new Error('Refusing non-disposable CTWA test database');
}
describe.skipIf(!url)('CTWA Tracking bridge disposable PostgreSQL CAS and recovery', () => {
    const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused/unused' } } });
    const workspaceId = randomUUID();
    let channelId: string, conversationId: string, contactId: string;
    const secret = JSON.stringify({ [workspaceId]: { endpoint: TRACKING_ENDPOINT, signingKey: 'a'.repeat(64), enabled: true, autoForward: false } });
    beforeAll(async () => {
        const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
        channelId = channel.id;
        const contact = await db.contact.create({ data: { workspaceId, name: 'Owned PG contact', phone: '5547999990000' } });
        contactId = contact.id;
        const conversation = await db.conversation.create({ data: { workspaceId, channelId, contactId } });
        conversationId = conversation.id;
    });
    afterAll(async () => { await db.channel.deleteMany({ where: { workspaceId } }); await db.contact.deleteMany({ where: { workspaceId } }); await db.$disconnect(); });
    async function event() {
        const message = await db.message.create({ data: { workspaceId, conversationId, direction: 'inbound', type: 'text', body: 'Owned synthetic fixture' } });
        const click = `owned-${randomUUID()}`;
        const attr = await db.ctwaAttribution.create({ data: { workspaceId, channelId, conversationId, messageId: message.id, ctwaClid: click, clickHash: hash(click), adId: '123', sourceMode: 'live' } });
        return db.ctwaConversionEvent.create({ data: { ...ctwaEventData(attr, 'LeadSubmitted'), eventTime: new Date(Date.now() - 10000) } });
    }
    it('real SQL state+attempt claim allows one forwarding owner and scoped contact', async () => {
        const row = await event();
        const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => { const body = JSON.parse(String(options?.body)); expect(body.contact).toEqual({ name: 'Owned PG contact', phone: '5547999990000' }); expect(body.eventId).toBe(row.eventId); expect(body.eventTime).toBe(Math.floor(row.eventTime.getTime() / 1000)); return Response.json({ eventId: row.eventId, state: 'accepted', metaStatusCode: 200 }); });
        const bridge = createCtwaTrackingBridge(db, { secret, fetch });
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => bridge.forward(workspaceId, row.id, true)));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(await db.ctwaConversionEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: 'tracking_accepted', attemptCount: 1, eventsReceived: 1 });
        await expect(bridge.forward(randomUUID(), row.id, true)).rejects.toThrow('not_found');
    });
    it('lost acknowledgment and stale export retry SAME core and recover accepted without another central dispatch', async () => {
        const row = await event();
        let centralSends = 0;
        let storedCore: string | undefined;
        let firstContact: unknown;
        let lost = true;
        const bodies: any[] = [];
        const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => { const body = JSON.parse(String(options?.body)); bodies.push(body); const { contact, ...core } = body; const identity = JSON.stringify(core); if (storedCore === undefined) {
            storedCore = identity;
            firstContact = contact;
            centralSends++;
        }
        else
            expect(identity).toBe(storedCore); if (lost) {
            lost = false;
            throw new Error('lost central ack');
        } return Response.json({ eventId: row.eventId, state: 'accepted', metaStatusCode: 200 }); });
        const bridge = createCtwaTrackingBridge(db, { secret, fetch });
        expect((await bridge.forward(workspaceId, row.id, true)).state).toBe('tracking_retry');
        await db.contact.update({ where: { id: contactId }, data: { name: 'Renamed owned contact' } });
        await db.ctwaConversionEvent.update({ where: { id: row.id }, data: { state: 'tracking_forwarding', attemptedAt: new Date(Date.now() - TRACKING_RETRY_MS - 1000) } });
        await Promise.allSettled(Array.from({ length: 5 }, () => bridge.forward(workspaceId, row.id, true)));
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(centralSends).toBe(1);
        expect(firstContact).toMatchObject({ name: 'Owned PG contact' });
        expect(bodies[1].contact.name).toBe('Renamed owned contact');
        expect(await db.ctwaConversionEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: 'tracking_accepted', attemptCount: 2 });
    });
    it('a late stale owner cannot overwrite the newer accepted claim', async () => {
        const row = await event();
        let finish!: (value: Response) => void;
        const waiting = new Promise<Response>(resolve => { finish = resolve; });
        const first = createCtwaTrackingBridge(db, { secret, fetch: async () => waiting });
        const pending = first.forward(workspaceId, row.id, true);
        for (let index = 0; index < 50; index++) {
            if ((await db.ctwaConversionEvent.findUniqueOrThrow({ where: { id: row.id } })).state === 'tracking_forwarding')
                break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        await db.ctwaConversionEvent.update({ where: { id: row.id }, data: { attemptedAt: new Date(Date.now() - TRACKING_RETRY_MS - 1000) } });
        const recovery = createCtwaTrackingBridge(db, { secret, fetch: async () => Response.json({ eventId: row.eventId, state: 'accepted', metaStatusCode: 200 }) });
        await recovery.forward(workspaceId, row.id, true);
        finish(Response.json({ eventId: row.eventId, state: 'rejected', metaStatusCode: 400 }));
        await expect(pending).rejects.toThrow('tracking_claim_lost');
        expect((await db.ctwaConversionEvent.findUniqueOrThrow({ where: { id: row.id } })).state).toBe('tracking_accepted');
    });
    it('central Meta unknown is terminal for forwarding and direct dispatch', async () => {
        const row = await event();
        const fetch = vi.fn(async () => Response.json({ eventId: row.eventId, state: 'unknown', metaStatusCode: 503 }));
        const bridge = createCtwaTrackingBridge(db, { secret, fetch });
        await bridge.forward(workspaceId, row.id, true);
        await expect(bridge.forward(workspaceId, row.id, true)).rejects.toThrow('not_forwardable');
        expect(fetch).toHaveBeenCalledTimes(1);
        const direct = createCtwaService(db, { secret: JSON.stringify({ [workspaceId]: { datasetId: '123', whatsappBusinessAccountId: '456', accessToken: 'owned-test', enabled: true } }), fetch });
        await expect(direct.dispatch(workspaceId, row.id)).rejects.toThrow('tracking_owned');
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
