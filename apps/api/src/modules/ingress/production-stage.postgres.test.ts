import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import amqp from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transportTopology } from './broker.js';

const databaseUrl = process.env.REHEARSAL_DATABASE_URL, brokerUrl = process.env.INGRESS_TEST_AMQP_URL;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SECRET = 'rehearsal-evolution-secret-123';
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); }
}

/** Rehearsal of the production stage with the compiled executables: real HTTP -> RabbitMQ -> worker -> PostgreSQL,
 * every workspace accepted, production guards active (no loopback or test-database shortcuts). */
describe.skipIf(!databaseUrl || !brokerUrl)('ingress in the production stage (rehearsal)', () => {
  let db: PrismaClient, root: string, evolutionApi: http.Server;
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const namespace = `talk.prod.rehearsal-${randomUUID().slice(0, 8)}`;
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  let workspaceId: string, instance: string;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/talk_rehearsal') throw new Error('Only the local rehearsal database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    root = await realpath(await mkdtemp(join(tmpdir(), 'talk-prod-rehearsal-')));
    evolutionApi = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ base64: PNG.toString('base64'), mimetype: 'image/png' })); }); });
    await new Promise<void>(resolve => evolutionApi.listen(0, '127.0.0.1', resolve));
    workspaceId = `rehearsal-${randomUUID()}`; instance = `inst-${randomUUID()}`;
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: instance, status: 'connected' } });
    await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: instance, status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '15550008888' } });
    const env = { ...process.env, DATABASE_URL: databaseUrl, INGRESS_TRANSPORT_STAGE: 'production', INGRESS_AMQP_URL: brokerUrl, INGRESS_NAMESPACE: namespace,
      INGRESS_PRIVATE_ROOT: join(root, 'ingress'), INGRESS_WORKSPACE_ALLOWLIST: '*', INGRESS_EVOLUTION_SECRET: SECRET, INGRESS_WAHA_SECRET: 'rehearsal-waha-secret-1234567', INGRESS_PORT: String(port),
      TALK_MEDIA_STORE_PATH: join(root, 'media'), EVOLUTION_API_BASE_URL: `http://127.0.0.1:${(evolutionApi.address() as { port: number }).port}`, EVOLUTION_API_KEY: 'test-only' };
    for (const entry of ['dist/ingress.js', 'dist/ingress-worker.js']) {
      const child = spawn(process.execPath, [entry], { cwd: process.cwd(), env, stdio: 'pipe' });
      children.push(child);
      child.stdout!.on('data', d => logs.push(`[${entry}] ${d}`)); child.stderr!.on('data', d => logs.push(`[${entry}!] ${d}`));
    }
    await until(async () => fetch(`http://127.0.0.1:${port}/health`).then(r => r.status).catch(() => 0), status => status === 200);
  }, 60_000);

  afterAll(async () => {
    if (process.env.DEBUG_REHEARSAL) console.log('LOGS', logs.join('').slice(0, 4000));
    for (const child of children) { if (child.exitCode === null) { child.kill('SIGTERM'); await until(async () => child.exitCode, v => v !== null).catch(() => child.kill('SIGKILL')); } }
    await new Promise<void>(resolve => evolutionApi.close(() => resolve()));
    const admin = await amqp.connect(brokerUrl!), ch = await admin.createChannel();
    const topology = transportTopology(namespace);
    for (const queue of [topology.incoming, topology.retry, topology.dead]) await ch.deleteQueue(queue).catch(() => undefined);
    await ch.deleteExchange(namespace).catch(() => undefined); await ch.close(); await admin.close();
    await db.ingressReceipt.deleteMany({ where: { workspaceId } });
    await db.channel.deleteMany({ where: { workspaceId } });
    await db.contact.deleteMany({ where: { workspaceId } });
    await db.$disconnect(); await rm(root, { recursive: true, force: true });
  }, 60_000);

  const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-prymeira-talk-secret': SECRET }) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const upsert = (id: string, message: unknown) => ({ event: 'MESSAGES_UPSERT', instance, data: { key: { id, remoteJid: '15550001111@s.whatsapp.net', fromMe: false }, message, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Maria' } });

  it('refuses a wrong secret, and reports an unknown source instead of guessing', async () => {
    expect((await post(`/webhooks/evolution/${workspaceId}`, upsert('x', { conversation: 'oi' }), { 'x-prymeira-talk-secret': 'wrong-secret-value' })).status).toBe(401);
    expect((await post(`/webhooks/evolution/${workspaceId}`, { ...upsert('y', { conversation: 'oi' }), instance: 'unknown-instance' })).status).toBe(409);
  });

  it('accepts a webhook the legacy 1 MiB limit rejected (413), applies the message and stores its media', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 7)]).toString('base64');
    const response = await post(`/webhooks/evolution/${workspaceId}`, upsert('PROD-MEDIA-1', { base64: big, imageMessage: { url: 'https://media.invalid/expired', mimetype: 'image/png', caption: 'foto grande' } }));
    expect(response.status).toBe(202);
    const message = await until(() => db.message.findFirst({ where: { workspaceId, body: 'foto grande' } }), v => !!v);
    expect(message).toMatchObject({ type: 'image', direction: 'inbound', body: 'foto grande' });
    const stored = await until(() => db.messageMedia.findUnique({ where: { messageId: message!.id } }), v => v?.state === 'stored');
    expect(stored).toMatchObject({ mimeType: 'image/png', sourceKind: expect.stringMatching(/inline|evolution/) });
    expect(await db.ingressApplication.count({ where: { workspaceId, state: 'applied' } })).toBeGreaterThan(0);
    expect(await db.conversation.findFirst({ where: { workspaceId } })).toMatchObject({ unreadCount: 1 });
  });

  it('keeps every effect of an applied message as a durable obligation for the API process', async () => {
    await post(`/webhooks/evolution/${workspaceId}`, upsert('PROD-TEXT-1', { conversation: 'preciso de 10 chapas' }));
    const message = await until(() => db.message.findFirst({ where: { workspaceId, body: 'preciso de 10 chapas' } }), v => !!v);
    const kinds = (await db.ingressEffect.findMany({ where: { workspaceId, messageId: message!.id } })).map(effect => effect.kind);
    expect(kinds).toEqual(expect.arrayContaining(['realtime.message', 'realtime.conversation', 'assistant.message', 'agent.debounce', 'followup.activity', 'prospecting.inbound']));
  });
});
