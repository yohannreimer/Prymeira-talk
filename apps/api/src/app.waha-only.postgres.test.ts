import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './test/build-app.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const PHONE = '5547999990000';
describe.skipIf(!databaseUrl)('a real WAHA-only installation', () => {
  let db: PrismaClient;
  let server: http.Server;
  let baseUrl: string;
  const workspaces: string[] = [];
  const sessions = new Map<string, { name: string; status: string; config: unknown }>();
  let sent = 0;
  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || target.pathname !== '/messaging_test') throw new Error('Owned local messaging_test database required');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const url = new URL(request.url!, 'http://localhost');
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        response.setHeader('content-type', 'application/json');
        const answer = (value: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(value)); };
        if (url.pathname === '/api/server/version') return answer({ version: '2026.9.1', engine: 'WPP' });
        if (url.pathname === '/api/sessions' && request.method === 'POST') {
          sessions.set(body.name, { name: body.name, config: body.config, status: 'STOPPED' });
          return answer(sessions.get(body.name), 201);
        }
        const session = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
        if (session) {
          const record = sessions.get(decodeURIComponent(session[1]!));
          if (!record) return answer({}, 404);
          if (session[2] === 'me') return answer({ id: `${PHONE}@c.us` });
          if (session[2] === 'start') { record.status = 'SCAN_QR_CODE'; return answer(record); }
          return answer({ ...record, engine: record.status === 'WORKING' ? { engine: 'WPP', state: 'CONNECTED' } : {} });
        }
        if (/\/auth\/qr$/.test(url.pathname)) return answer({ value: 'synthetic-owned-session-qr' });
        if (url.pathname === '/api/contacts/check-exists') return answer({ numberExists: true, chatId: `${url.searchParams.get('phone')}@c.us` });
        if (url.pathname === '/api/sendText') return answer({ id: `true_${body.chatId}_WAHA${++sent}`, timestamp: Date.now() });
        return answer({}, 404);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const workspaceId of workspaces) {
      await db.ingressReceipt.deleteMany({ where: { workspaceId } });
      await db.ingressEffect.deleteMany({ where: { workspaceId } });
      await db.outboundIntent.deleteMany({ where: { workspaceId } });
      await db.outboundDispatch.deleteMany({ where: { workspaceId } });
      await db.channel.deleteMany({ where: { workspaceId } });
      await db.campaign.deleteMany({ where: { workspaceId } });
      await db.contact.deleteMany({ where: { workspaceId } });
    }
    await db.$disconnect();
  });
  it.each([{ mode: 'real' as const, router: true }, { mode: 'simulated' as const, router: false }])('pairs WAHA and sends human replies/campaigns with Evolution mode=$mode router=$router', async ({ mode, router }) => {
    const workspaceId = `waha-only-${randomUUID()}`; workspaces.push(workspaceId);
    const app = await buildApp({ DATABASE_URL: databaseUrl!, PRYMEIRA_LOCAL_AUTH_BYPASS: true, PRYMEIRA_LOCAL_WORKSPACE_ID: workspaceId,
      EVOLUTION_MODE: mode, EVOLUTION_API_BASE_URL: undefined, EVOLUTION_API_KEY: undefined,
      WAHA_ENABLED: true, WAHA_API_BASE_URL: baseUrl, WAHA_API_KEY: 'owned-fixture', OUTBOUND_ROUTER_ENABLED: router,
      CHANNEL_WATCHDOG_ENABLED: false, CHANNEL_HEALTH_MONITOR_ENABLED: false, CONTACT_NAME_RECOVERY_ENABLED: false }, { prismaEnabled: true, authEnabled: true });
    const headers = { authorization: 'Bearer local-bypass-test' };
    try {
      const created = await app.inject({ method: 'POST', url: '/channels', headers, payload: { displayName: 'WAHA-only fixture' } });
      expect(created.statusCode, created.body).toBe(201);
      const channelId = created.json().id;
      const enabled = await app.inject({ method: 'PATCH', url: `/channels/${channelId}/redundancy`, headers, payload: { enabled: true } });
      expect(enabled.statusCode, enabled.body).toBe(200);
      const secondary = enabled.json().channel.connections.find((connection: any) => connection.provider === 'waha');
      const qr = await app.inject({ method: 'POST', url: `/channels/${channelId}/connections/${secondary.id}/qr`, headers });
      expect(qr.statusCode, qr.body).toBe(200);
      expect(qr.json()).toMatchObject({ mode: 'real', provider: 'waha', qrCode: 'synthetic-owned-session-qr' });
      sessions.get(secondary.sessionName)!.status = 'WORKING';
      const refreshed = await app.inject({ method: 'GET', url: `/channels/${channelId}/connections/${secondary.id}/state`, headers });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.json()).toMatchObject({ mode: 'real', channel: { status: 'connected', connectedCount: 1, phoneNumber: PHONE } });
      expect(await db.channel.findUniqueOrThrow({ where: { id: channelId } })).toMatchObject({ status: 'connected', verifiedMessagingPhoneNumber: PHONE });
      expect(await db.channelConnection.findFirstOrThrow({ where: { channelId, provider: 'evolution' } })).toMatchObject({ verifiedPhoneNumber: null, eligible: false });
      const blockedPrimary = await app.inject({ method: 'POST', url: `/channels/${channelId}/qr`, headers });
      expect(blockedPrimary.statusCode, blockedPrimary.body).toBe(503);
      expect(await db.channel.findUniqueOrThrow({ where: { id: channelId } })).toMatchObject({ status: 'connected', verifiedMessagingPhoneNumber: PHONE });
      const contact = await db.contact.create({ data: { workspaceId, phone: '5547888880000' } });
      const conversation = await db.conversation.create({ data: { workspaceId, channelId, contactId: contact.id } });
      const reply = await app.inject({ method: 'POST', url: `/conversations/${conversation.id}/messages`, headers, payload: { body: 'synthetic human reply' } });
      expect(reply.statusCode, reply.body).toBeLessThan(300);
      expect(await db.outboundDispatch.findFirst({ where: { workspaceId } })).toMatchObject({ state: 'accepted', connectionId: secondary.id });
      const campaign = await app.inject({ method: 'POST', url: '/inbox/quick-sends', headers, payload: { confirmation: true, idempotencyKey: randomUUID(), channelId, body: 'synthetic campaign', recipients: [{ phone: '5547777770000' }] } });
      expect(campaign.statusCode, campaign.body).toBe(201);
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && await db.campaignRecipient.count({ where: { workspaceId, status: 'sent' } }) === 0) await new Promise(resolve => setTimeout(resolve, 50));
      expect(await db.campaignRecipient.count({ where: { workspaceId, status: 'sent' } })).toBe(1);
      expect(await db.outboundDispatch.count({ where: { workspaceId, state: 'accepted', connectionId: secondary.id } })).toBe(2);
      const healthy = await app.inject({ method: 'GET', url: '/operations/health', headers });
      expect(healthy.statusCode, healthy.body).toBe(200);
      expect(healthy.json()).toMatchObject({ status: 'ok', channels: { status: 'available', withoutRedundancy: 1 }, broker: { status: 'unobserved' } });
      const stale = new Date(Date.now() - 5 * 60_000);
      const receipt = await db.ingressReceipt.create({ data: { id: randomUUID(), workspaceId, channelId, stageVersion: 1, transportNamespace: 'owned-test', source: {}, authentication: 'fixture', authenticatedDigest: '0'.repeat(64), rawRef: 'fixture', rawDigest: '0'.repeat(64), eventRef: 'fixture', eventDigest: '0'.repeat(64), eventCount: 2, createdAt: stale } });
      await db.ingressDelivery.create({ data: { receiptId: receipt.id, workspaceId, channelId, state: 'staged' } });
      await db.ingressApplication.create({ data: { receiptId: receipt.id, workspaceId, channelId, createdAt: stale } });
      await db.ingressFrontier.createMany({ data: [0, 1].map(eventIndex => ({ workspaceId, channelId, receiptId: receipt.id, eventIndex, kind: 'message' })) });
      await db.ingressEventProgress.create({ data: { workspaceId, channelId, receiptId: receipt.id, eventIndex: 0, state: 'applied', result: {} } });
      await db.ingressEffect.create({ data: { workspaceId, channelId, receiptId: receipt.id, eventIndex: 0, kind: 'owned-fixture-no-worker', logicalKey: randomUUID(), cause: {}, frozen: {}, state: 'pending', createdAt: stale } });
      await db.outboundDispatch.create({ data: { workspaceId, channelId, kind: 'text', destination: 'synthetic-private-destination', preview: 'synthetic-private-body', state: 'uncertain' } });
      const delayed = await app.inject({ method: 'GET', url: '/operations/health', headers });
      expect(delayed.statusCode, delayed.body).toBe(200);
      expect(delayed.json()).toMatchObject({ status: 'degraded', transport: { status: 'delayed', pending: 1 }, application: { status: 'delayed', pending: 1 }, effects: { status: 'delayed', pending: 1 }, outbound: { status: 'attention', uncertain: 1 }, channels: { status: 'available' } });
      expect(delayed.body).not.toContain('synthetic-private');
      expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);

    } finally { await app.close(); }
  }, 15_000);
});
