// Local integration harness only. No real customer/provider endpoints or credentials.
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { readEnv } from '../src/env.js';

const databaseUrl = process.env.ASSISTANT_TEST_DATABASE_URL;
if (!databaseUrl || !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/assistant_pilot_test(?:\?|$)/.test(databaseUrl)) throw new Error('Use an explicit disposable local test database');
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const workspaceId = `assistant-browser-${randomUUID()}`;
const user = await db.userProfile.create({ data: { workspaceId, clerkUserId: 'demo_agent_marina', displayName: 'Marina · teste local', role: 'owner' } });
const agent = await db.aiAgent.create({ data: { workspaceId, name: 'Pré-atendimento Villefer · teste local', systemPrompt: 'Qualifique o pedido, sem inventar informações.', status: 'active', allowedActions: ['send_message'] } });
const channel = await db.channel.create({ data: { workspaceId, displayName: 'Villefer · ambiente local', provider: 'evolution', providerKey: 'pilot', status: 'connected', encryptedConfig: { assistant: { mode: 'automatic', agentId: agent.id } } } });
const contact = await db.contact.create({ data: { workspaceId, phone: '5500000000000', name: 'Marcos · cliente fictício', company: 'Metalúrgica de teste' } });
const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id, assignedUserId: user.id } });
let providerCalls = 0, sends = 0;
let providerDelay = 0;
const fake = Fastify();
fake.post('/v1/chat/completions', async () => {
  providerCalls++;
  if (providerDelay) await new Promise(resolve => setTimeout(resolve, providerDelay));
  return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply: 'Me passa as medidas da chapa e a cidade de entrega? Com isso, o vendedor já consegue preparar a proposta.', confidence: 1, actions: [], handoff: { required: false, reason: null } }) } }] };
});
fake.post('/message/sendText/pilot', async () => { sends++; return { key: { id: `local-send-${randomUUID()}` } }; });
await fake.listen({ host: '127.0.0.1', port: 56441 });
await db.integrationConfig.create({ data: { workspaceId, provider: 'openai_compatible', mode: 'real', status: 'configured', settings: { baseUrl: 'http://127.0.0.1:56441/v1', apiKey: 'local-test-only', chatModel: 'local-contract-test' } } });
const app = await createApp(readEnv({ DATABASE_URL: databaseUrl, PRYMEIRA_ACCOUNT_API_URL: 'http://127.0.0.1:56441', CLERK_SECRET_KEY: 'local-test-only', EVOLUTION_WEBHOOK_SECRET: 'local-test-only', EVOLUTION_MODE: 'real', EVOLUTION_API_BASE_URL: 'http://127.0.0.1:56441', EVOLUTION_API_KEY: 'local-test-only', CORS_ORIGINS: 'http://127.0.0.1:56306,http://localhost:56306', RATE_LIMIT_MAX: '30000' }), { logger: false, requireProductAccess: async () => ({ allowed: true, product_key: 'talk', status: 'active', reason: 'local test', workspace_id: workspaceId, workspace_role: 'owner' }) });
app.get('/__test/state', async () => ({ workspaceId, conversationId: conversation.id, channelId: channel.id, agentId: agent.id, providerCalls, sends }));
app.post('/__test/inbound', async request => {
  const body = request.body as { text?: string; delay?: number };
  providerDelay = body.delay ?? 0;
  const result = await app.inject({ method: 'POST', url: `/webhooks/evolution/${workspaceId}`, headers: { 'x-prymeira-talk-secret': 'local-test-only' }, payload: { event: 'messages.upsert', instance: 'pilot', data: { key: { id: randomUUID(), remoteJid: `${contact.phone}@s.whatsapp.net`, fromMe: false }, message: { conversation: body.text ?? 'Preciso de 10 chapas de 2 mm.' }, messageTimestamp: Math.floor(Date.now() / 1000) } } });
  return { status: result.statusCode, response: result.json() };
});
await app.listen({ host: '127.0.0.1', port: 56440 });
console.log(JSON.stringify({ localOnly: true, api: 'http://127.0.0.1:56440', workspaceId, conversationId: conversation.id }));
process.on('SIGINT', async () => { await app.close(); await fake.close(); await db.$disconnect(); process.exit(0); });
