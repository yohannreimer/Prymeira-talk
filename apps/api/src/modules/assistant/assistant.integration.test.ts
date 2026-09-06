import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createAssistantRepository } from './assistant-repository.js';
import { loadAssistantContext } from './assistant-generation.js';
import { createAssistantSendService } from './assistant-send.service.js';
import { createAssistantScheduler } from './assistant-scheduler.js';
import Fastify from 'fastify';
import { assistantInboxRoutes } from './assistant-inbox.routes.js';
import { createEvolutionRuntime } from '../evolution/evolution-runtime.js';
import { createRealtimeHub } from '../realtime/realtime-hub.js';
import { createConversationsService, type PrismaLike } from '../conversations/conversations.service.js';

const url = process.env.ASSISTANT_TEST_DATABASE_URL;
// Explicit opt-in and local/disposable name required. Never use inherited DATABASE_URL.
if (url && (!/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/assistant_pilot_test(?:\?|$)/.test(url))) throw new Error('Refusing non-disposable assistant test database');
describe.skipIf(!url)('assistant PostgreSQL integration', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid/unused' } } });
  const workspaceId = `assistant-test-${randomUUID()}`;
  let userId: string, channelId: string, agentId: string, conversationId: string;
  const repository = createAssistantRepository(db);
  beforeAll(async () => {
    userId = (await db.userProfile.create({ data: { workspaceId, clerkUserId: 'test', displayName: 'Vendedor de teste' } })).id;
    agentId = (await db.aiAgent.create({ data: { workspaceId, name: 'Agente teste', systemPrompt: 'Qualifique.' } })).id;
    channelId = (await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: 'test', encryptedConfig: { assistant: { mode: 'automatic', agentId } } } })).id;
    const contact = await db.contact.create({ data: { workspaceId, phone: '5500000000000' } });
    conversationId = (await db.conversation.create({ data: { workspaceId, channelId, contactId: contact.id, assignedUserId: userId } })).id;
    await db.message.create({ data: { workspaceId, conversationId, direction: 'inbound', type: 'text', body: 'Preciso de 10 chapas 2 mm.' } });
  });
  afterAll(async () => {
    await db.assistantConversationState.updateMany({ where: { workspaceId }, data: { status: 'paused', scheduledAt: null, leaseToken: null, leaseUntil: null } });
    await db.$disconnect();
  });
  it('deduplicates inbound hooks and only one worker claims the revision', async () => {
    expect(await repository.schedule({ workspaceId, conversationId, trigger: 'inbound' })).toBe(true);
    expect(await repository.schedule({ workspaceId, conversationId, trigger: 'inbound' })).toBe(false);
    const state = await db.assistantConversationState.findUniqueOrThrow({ where: { workspaceId_conversationId: { workspaceId, conversationId } } });
    const leases = await Promise.all([repository.claim(state), repository.claim(state)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    await repository.invalidate(workspaceId, conversationId);
    expect(await repository.publish(state, leases.find(Boolean)!, { agentId, body: 'Antiga', contextKey: 'old', agentHash: 'old' }, async () => true)).toBe(false);
    expect(await db.assistantSuggestion.count({ where: { workspaceId } })).toBe(0);
    await repository.releaseLease(state, leases.find(Boolean)!);
  });
  it('discards a provider reply when a human takes over while generation is running', async () => {
    await repository.schedule({ workspaceId, conversationId, trigger: 'manual' });
    await db.assistantConversationState.updateMany({ where: { workspaceId }, data: { scheduledAt: new Date(0) } });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const scheduler = createAssistantScheduler(db, { generate: async context => { started(); await hold; return { body: 'Nunca publicar', agentId, agentHash: context.agentHash, contextKey: context.contextKey, warnings: [], proposedActions: {} }; } });
    const tick = scheduler.tick(); await ready;
    await db.conversation.update({ where: { id: conversationId }, data: { aiControlStatus: 'human_controlled', aiControlUpdatedAt: new Date() } });
    await scheduler.control(workspaceId, conversationId, true);
    release(); await tick;
    expect(await db.assistantSuggestion.count({ where: { workspaceId } })).toBe(0);
    expect(await db.message.count({ where: { workspaceId, direction: 'outbound' } })).toBe(0);
    await db.conversation.update({ where: { id: conversationId }, data: { aiControlStatus: 'agent_allowed' } });
  });
  it('recovers an expired lease and enforces the retry cap', async () => {
    await db.assistantConversationState.updateMany({ where: { workspaceId }, data: { status: 'generating', attempts: 1, leaseUntil: new Date(0) } });
    expect((await repository.due()).some(s => s.workspaceId === workspaceId)).toBe(true);
    await db.assistantConversationState.updateMany({ where: { workspaceId }, data: { status: 'generating', attempts: 2, leaseUntil: new Date(0) } });
    expect((await repository.due()).some(s => s.workspaceId === workspaceId)).toBe(false);
    expect((await db.assistantConversationState.findFirstOrThrow({ where: { workspaceId } })).status).toBe('failed');
  });
  it('keeps the active lease across new inputs so another worker cannot generate concurrently', async () => {
    await repository.schedule({ workspaceId, conversationId, trigger: 'manual' });
    const state = await db.assistantConversationState.findFirstOrThrow({ where: { workspaceId } });
    const lease = await repository.claim(state);
    expect(lease).toBeTruthy();
    await repository.schedule({ workspaceId, conversationId, trigger: 'manual', instruction: 'Mais direto.' });
    const newer = await db.assistantConversationState.findFirstOrThrow({ where: { workspaceId } });
    expect(newer.revision).toBeGreaterThan(state.revision);
    expect(await repository.claim(newer)).toBeNull();
    await repository.releaseLease(state, lease!);
    const nextLease = await repository.claim(newer);
    expect(nextLease).toBeTruthy();
    await repository.releaseLease(newer, nextLease!);
  });
  it('records exact edited text and actor; concurrent retries send once', async () => {
    const context = await loadAssistantContext(db, workspaceId, conversationId);
    const suggestion = await db.assistantSuggestion.create({ data: { workspaceId, conversationId, agentId, revision: 100, contextKey: context.contextKey, agentHash: context.agentHash, body: 'Qual a cidade?' } });
    const transport = vi.fn(async (input: { reservedMessageId: string }) => {
      const message = await db.message.update({ where: { id: input.reservedMessageId }, data: { status: 'sent' } });
      return { message: { ...message, createdAt: message.createdAt.toISOString() }, conversation: {} } as never;
    });
    const send = createAssistantSendService(db, transport);
    const actor = { workspaceId, userId, role: 'agent' as const };
    const input = { suggestionId: suggestion.id, requestKey: randomUUID(), body: 'Pode me passar a cidade de entrega?', reviewedContextKey: context.contextKey, edited: true };
    await Promise.all([send(actor, conversationId, input), send(actor, conversationId, input)]);
    expect(transport).toHaveBeenCalledTimes(1);
    const recorded = await db.assistantSuggestionSend.findFirstOrThrow({ where: { workspaceId } });
    expect(recorded.finalBody).toBe(input.body); expect(recorded.actorUserId).toBe(userId);
    expect(await db.message.count({ where: { workspaceId, direction: 'outbound' } })).toBe(1);
    await expect(send(actor, conversationId, { ...input, body: 'different' })).rejects.toMatchObject({ code: 'ASSISTANT_SEND_CONFLICT' });
  });
  it('keeps uncertain sends without retrying transport', async () => {
    const context = await loadAssistantContext(db, workspaceId, conversationId);
    const suggestion = await db.assistantSuggestion.create({ data: { workspaceId, conversationId, agentId, revision: 101, contextKey: context.contextKey, agentHash: context.agentHash, body: 'Mais alguma coisa?' } });
    await db.assistantConversationState.updateMany({ where: { workspaceId, conversationId }, data: { status: 'ready', revision: 101 } });
    const transport = vi.fn().mockRejectedValue(new Error('connection lost after acceptance'));
    const send = createAssistantSendService(db, transport);
    const actor = { workspaceId, userId, role: 'agent' as const };
    const input = { suggestionId: suggestion.id, requestKey: randomUUID(), body: suggestion.body, reviewedContextKey: context.contextKey };
    expect((await send(actor, conversationId, input)).status).toBe('uncertain');
    expect((await send(actor, conversationId, input)).status).toBe('uncertain');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('enforces workspace foreign keys', async () => {
    await expect(db.assistantSuggestion.create({ data: { workspaceId: 'other-workspace', conversationId, agentId, revision: 999, contextKey: 'x', agentHash: 'x', body: 'Forbidden' } })).rejects.toMatchObject({ code: 'P2003' });
  });
  it('uses arrival order when inbound provider timestamps precede a same-second human reply', async () => {
    const outbound = await db.message.create({ data: { workspaceId, conversationId, direction: 'outbound', type: 'text', body: 'Resposta humana', createdAt: new Date('2026-09-06T20:00:00.900Z'), ingestedAt: new Date('2026-09-06T20:00:01.000Z') } });
    const inbound = await db.message.create({ data: { workspaceId, conversationId, direction: 'inbound', type: 'text', body: 'Nova pergunta', createdAt: new Date('2026-09-06T20:00:00.000Z'), ingestedAt: new Date('2099-09-06T20:00:01.100Z') } });
    expect(inbound.createdAt.getTime()).toBeLessThan(outbound.createdAt.getTime());
    expect(await repository.schedule({ workspaceId, conversationId, trigger: 'inbound', messageId: inbound.id })).toBe(true);
    const context = await loadAssistantContext(db, workspaceId, conversationId);
    expect(context.messages.at(-1)?.id).toBe(inbound.id);
  });
  it('enforces HTTP authorization, sanitizes settings, and rejects foreign agents', async () => {
    let auth = { workspaceId, clerkUserId: 'test', role: 'agent' as 'agent' | 'owner' };
    const app = Fastify(); app.decorate('prisma', db); app.decorate('realtime', createRealtimeHub());
    app.addHook('onRequest', async request => { request.talk = auth; });
    await app.register(assistantInboxRoutes, { evolution: createEvolutionRuntime({ mode: 'simulated', publicTalkUrl: 'http://localhost', localTalkUrl: 'http://localhost', webhookSecret: 'local-only' }) });
    try {
      await db.channel.update({ where: { id: channelId }, data: { encryptedConfig: { providerSecret: 'never-expose', assistant: { mode: 'automatic', agentId } } } });
      const settingsPath = `/assistant/channels/${channelId}/settings`;
      const read = await app.inject({ url: settingsPath });
      expect(read.json()).toEqual({ mode: 'automatic', agentId }); expect(read.body).not.toContain('never-expose');
      expect((await app.inject({ method: 'PUT', url: settingsPath, payload: { mode: 'disabled', agentId: null } })).statusCode).toBe(403);
      auth = { ...auth, role: 'owner' };
      expect((await app.inject({ method: 'PUT', url: settingsPath, payload: { mode: 'automatic', agentId: randomUUID() } })).statusCode).toBe(422);
      expect((await app.inject({ method: 'PUT', url: settingsPath, payload: { mode: 'automatic', agentId } })).statusCode).toBe(200);
      expect((await db.channel.findUniqueOrThrow({ where: { id: channelId } })).encryptedConfig).toMatchObject({ providerSecret: 'never-expose' });
      auth = { ...auth, workspaceId: 'foreign-workspace' };
      expect((await app.inject({ url: `/assistant/conversations/${conversationId}` })).statusCode).toBe(422);
      auth = { workspaceId, clerkUserId: 'test', role: 'agent' };
      await db.conversation.update({ where: { id: conversationId }, data: { assignedUserId: null } });
      expect((await app.inject({ url: `/assistant/conversations/${conversationId}` })).statusCode).toBe(403);
      auth = { ...auth, role: 'owner' };
      expect((await app.inject({ url: `/assistant/conversations/${conversationId}` })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/assistant/conversations/${conversationId}/send`, payload: { userId, body: 'spoof' } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it('explicit conversation reset clears private revisions before deleting their message references', async () => {
    await createConversationsService(db as unknown as PrismaLike).resetConversation({ workspaceId, conversationId, actorUserId: userId });
    expect(await db.assistantSuggestion.count({ where: { workspaceId, conversationId } })).toBe(0);
    expect(await db.assistantConversationState.count({ where: { workspaceId, conversationId } })).toBe(0);
    expect(await db.message.count({ where: { workspaceId, conversationId } })).toBe(0);
  });
});
