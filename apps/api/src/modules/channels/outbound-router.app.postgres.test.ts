import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../test/build-app.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;

/** The real API app, the real conversation service and a loopback Evolution: a human reply must leave through the
 * router, with a journal row, exactly once, and an uncertain outcome must never be retried. */
describe.skipIf(!databaseUrl)('human sends travel through the outbound router in the real app', () => {
  let db: PrismaClient;
  let evolution: http.Server;
  let mode: 'ok' | 'fail500' | 'closed' = 'ok';
  const requests: string[] = [];
  const workspaces: string[] = [];
  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    evolution = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests.push(`${req.method} ${req.url}`);
        res.setHeader('content-type', 'application/json');
        if (!req.url?.startsWith('/message/sendText/')) { res.statusCode = 404; return res.end('{}'); }
        if (mode === 'fail500') { res.statusCode = 500; return res.end(JSON.stringify({ message: 'internal error' })); }
        if (mode === 'closed') { res.statusCode = 500; return res.end(JSON.stringify({ message: 'Connection Closed' })); }
        res.statusCode = 201; res.end(JSON.stringify({ key: { id: 'FAKE-EVO-ID', remoteJid: '5547888880000@s.whatsapp.net', fromMe: true } }));
      });
    });
    await new Promise<void>(resolve => evolution.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    await new Promise<void>(resolve => evolution.close(() => resolve()));
    for (const workspaceId of workspaces) {
      await db.outboundDispatch.deleteMany({ where: { workspaceId } });
      await db.message.deleteMany({ where: { workspaceId } }); await db.conversation.deleteMany({ where: { workspaceId } });
      await db.contact.deleteMany({ where: { workspaceId } }); await db.channelConnection.deleteMany({ where: { workspaceId } }); await db.channel.deleteMany({ where: { workspaceId } });
    }
    await db.$disconnect();
  });

  async function boot(routerEnabled: boolean) {
    const workspaceId = `router-app-${randomUUID()}`; workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `inst-${randomUUID()}`, status: 'connected' } });
    await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, status: 'connected', health: 'healthy', eligible: true } });
    const contact = await db.contact.create({ data: { workspaceId, phone: '5547888880000' } });
    const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id } });
    const app = await buildApp({ DATABASE_URL: databaseUrl!, NODE_ENV: 'test', PRYMEIRA_LOCAL_AUTH_BYPASS: true, PRYMEIRA_LOCAL_WORKSPACE_ID: workspaceId, PRYMEIRA_LOCAL_ROLE: 'owner',
      EVOLUTION_MODE: 'real', EVOLUTION_API_BASE_URL: `http://127.0.0.1:${(evolution.address() as { port: number }).port}`, EVOLUTION_API_KEY: 'test-key', OUTBOUND_ROUTER_ENABLED: routerEnabled },
    { prismaEnabled: true, authEnabled: true });
    return { app, workspaceId, conversationId: conversation.id };
  }
  const auth = { authorization: 'Bearer local-bypass-test' };
  const reply = (f: Awaited<ReturnType<typeof boot>>, body: string) => f.app.inject({ method: 'POST', url: `/conversations/${f.conversationId}/messages`, headers: auth, payload: { body } });
  const dispatches = (workspaceId: string) => db.outboundDispatch.findMany({ where: { workspaceId } });

  it('journals a human reply that left through the router, and the message keeps the provider id', async () => {
    mode = 'ok'; requests.length = 0;
    const f = await boot(true);
    try {
      const response = await reply(f, 'Bom dia! Segue o orçamento.');
      expect(response.statusCode, response.body).toBeLessThan(300);
      expect(requests.filter(r => r.startsWith('POST /message/sendText/'))).toHaveLength(1);
      expect(await dispatches(f.workspaceId)).toEqual([expect.objectContaining({ state: 'accepted', kind: 'text', providerMessageId: 'FAKE-EVO-ID', preview: 'Bom dia! Segue o orçamento.' })]);
      expect(await db.message.findFirst({ where: { workspaceId: f.workspaceId, direction: 'outbound' } })).toMatchObject({ providerMessageId: 'FAKE-EVO-ID' });
    } finally { await f.app.close(); }
  });

  it('holds an ambiguous failure for review and never retries it', async () => {
    mode = 'fail500'; requests.length = 0;
    const f = await boot(true);
    try {
      const response = await reply(f, 'Preciso confirmar o prazo.');
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(requests.filter(r => r.startsWith('POST /message/sendText/'))).toHaveLength(1);
      expect(await dispatches(f.workspaceId)).toEqual([expect.objectContaining({ state: 'uncertain', errorCode: 'HTTP_500' })]);
      const review = await f.app.inject({ method: 'GET', url: '/channels/outbound-review', headers: auth });
      expect(review.json().items).toEqual([expect.objectContaining({ preview: 'Preciso confirmar o prazo.', errorCode: 'HTTP_500' })]);
    } finally { await f.app.close(); }
  });

  it('records a provably unsent failure as failed (the session was closed)', async () => {
    mode = 'closed'; requests.length = 0;
    const f = await boot(true);
    try {
      expect((await reply(f, 'Olá!')).statusCode).toBeGreaterThanOrEqual(400);
      expect(await dispatches(f.workspaceId)).toEqual([expect.objectContaining({ state: 'failed', errorCode: 'HTTP_500' })]);
    } finally { await f.app.close(); }
  });

  it('changes nothing when the router is off: same send, no journal', async () => {
    mode = 'ok'; requests.length = 0;
    const f = await boot(false);
    try {
      expect((await reply(f, 'Sem roteador.')).statusCode).toBeLessThan(300);
      expect(await dispatches(f.workspaceId)).toEqual([]);
      expect(requests.filter(r => r.startsWith('POST /message/sendText/'))).toHaveLength(1);
    } finally { await f.app.close(); }
  });
});
