import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentRuntime } from './agent-runtime.js';
import { createMeetingReminderService } from './meeting-reminders.js';
import { measureInboxDatabase } from '../../plugins/inbox-timing.js';
import { createConversationsService, type PrismaLike } from '../conversations/conversations.service.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('agent reset fences with real PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => {
    const target = new URL(url!);
    if (target.hostname !== '127.0.0.1' || target.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || target.pathname !== '/messaging_test') throw Error('Owned local messaging_test on the explicit fixture port required');
    db = new PrismaClient({ datasources: { db: { url } } });
  });
  afterAll(async () => {
    for (const workspaceId of workspaces) {
      await db.channel.deleteMany({ where: { workspaceId } });
      await db.contact.deleteMany({ where: { workspaceId } });
      await db.aiAgent.deleteMany({ where: { workspaceId } });
      await db.auditLog.deleteMany({ where: { workspaceId } });
    }
    await db.$disconnect();
  });
  async function fixture() {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const contact = await db.contact.create({ data: { workspaceId, phone: '15550001111' } });
    const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id, aiControlStatus: 'agent_allowed' } });
    const agent = await db.aiAgent.create({ data: { workspaceId, name: 'Reset fixture', systemPrompt: 'Responda de forma breve.', status: 'active', model: 'fixture', allowedActions: ['send_message', 'create_internal_note'] } });
    const message = await db.message.create({ data: { workspaceId, conversationId: conversation.id, direction: 'inbound', type: 'text', body: 'Olá, pode me ajudar?', status: 'delivered' } });
    return { workspaceId, conversationId: conversation.id, agentId: agent.id, messageId: message.id };
  }
  const reset = (f: Awaited<ReturnType<typeof fixture>>) => createConversationsService(db as unknown as PrismaLike).resetConversation({ workspaceId: f.workspaceId, conversationId: f.conversationId, actorUserId: null });
  const output = () => ({ confidence: 1, reply: 'Olá! Como posso ajudar?', actions: [], handoff: { required: false, reason: null } });

  it('preserves human takeover committed during the first-message freshness lookup', async () => {
    const f = await fixture();
    await db.aiAgent.update({ where: { id: f.agentId }, data: { behaviorConfig: { onlyNewConversations: true } } });
    const runtime = createAgentRuntime({ prisma: db as never, provider: { generate: vi.fn() },
      chatHistory: { hasPriorMessages: vi.fn(async () => {
        await createConversationsService(db as unknown as PrismaLike).updateAiControl({ ...f, status: 'human_controlled' });
        return false;
      }) } });
    expect((await runtime.activateForMessage(f)).status).toBe('skipped');
    expect((await db.conversation.findUniqueOrThrow({ where: { id: f.conversationId } })).aiControlStatus).toBe('human_controlled');
    expect(await db.aiAgentSession.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });

  it('does not clear a replacement session when an older freshness lookup rejects activation', async () => {
    const f = await fixture();
    await db.aiAgent.update({ where: { id: f.agentId }, data: { behaviorConfig: { onlyNewConversations: true } } });
    let replacementId: string | undefined;
    const runtime = createAgentRuntime({ prisma: db as never, provider: { generate: vi.fn() },
      chatHistory: { hasPriorMessages: vi.fn(async () => {
        const replacement = await db.aiAgent.create({ data: { workspaceId: f.workspaceId, name: 'Replacement', systemPrompt: 'New owner' } });
        const session = await db.aiAgentSession.create({ data: { workspaceId: f.workspaceId, agentId: replacement.id, conversationId: f.conversationId } });
        replacementId = session.id;
        await db.conversation.update({ where: { id: f.conversationId }, data: { activeAgentSessionId: session.id } });
        return true;
      }) } });
    expect((await runtime.activateForMessage(f)).status).toBe('skipped');
    expect(await db.conversation.findUniqueOrThrow({ where: { id: f.conversationId } })).toMatchObject({ aiControlStatus: 'agent_allowed', activeAgentSessionId: replacementId });
  });

  it('does not restore an old queued agent after a replacement session was activated', async () => {
    const f = await fixture(), oldSession = await db.aiAgentSession.create({ data: { workspaceId: f.workspaceId, agentId: f.agentId, conversationId: f.conversationId } });
    const replacement = await db.aiAgent.create({ data: { workspaceId: f.workspaceId, name: 'Replacement', systemPrompt: 'New owner' } });
    const replacementSession = await db.aiAgentSession.create({ data: { workspaceId: f.workspaceId, agentId: replacement.id, conversationId: f.conversationId } });
    await db.conversation.update({ where: { id: f.conversationId }, data: { activeAgentSessionId: replacementSession.id } });
    const token = randomUUID(), queue = await db.aiAgentPendingReply.create({ data: { workspaceId: f.workspaceId, agentId: f.agentId,
      conversationId: f.conversationId, sessionId: oldSession.id, lastMessageId: f.messageId, status: 'processing', scheduledAt: new Date(), lockedAt: new Date(), claimToken: token } });
    const generate = vi.fn(), sendText = vi.fn();
    const runtime = createAgentRuntime({ prisma: db as never, provider: { generate }, evolution: { mode: 'real', client: { sendText } } });
    expect((await runtime.runForMessage({ ...f, sessionId: oldSession.id, replyClaim: { id: queue.id, token }, trigger: 'automation' })).status).toBe('skipped');
    expect(generate).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled();
    expect((await db.conversation.findUniqueOrThrow({ where: { id: f.conversationId } })).activeAgentSessionId).toBe(replacementSession.id);
  });

  it('stops a queued reply when the active agent is replaced during generation', async () => {
    const f = await fixture(), session = await db.aiAgentSession.create({ data: { workspaceId: f.workspaceId, agentId: f.agentId, conversationId: f.conversationId } });
    await db.conversation.update({ where: { id: f.conversationId }, data: { activeAgentSessionId: session.id } });
    const token = randomUUID(), queue = await db.aiAgentPendingReply.create({ data: { workspaceId: f.workspaceId, agentId: f.agentId,
      conversationId: f.conversationId, sessionId: session.id, lastMessageId: f.messageId, status: 'processing', scheduledAt: new Date(), lockedAt: new Date(), claimToken: token } });
    const sendText = vi.fn(); let replacementId: string | undefined;
    const generate = vi.fn(async () => {
      const replacement = await db.aiAgent.create({ data: { workspaceId: f.workspaceId, name: 'Replacement', systemPrompt: 'New owner' } });
      const next = await db.aiAgentSession.create({ data: { workspaceId: f.workspaceId, agentId: replacement.id, conversationId: f.conversationId } });
      replacementId = next.id;
      await db.conversation.update({ where: { id: f.conversationId }, data: { activeAgentSessionId: next.id } });
      return { ...output(), actions: [{ type: 'create_internal_note', body: 'Stale action' }] };
    });
    const runtime = createAgentRuntime({ prisma: db as never, provider: { generate }, evolution: { mode: 'real', client: { sendText } } });
    expect((await runtime.runForMessage({ ...f, sessionId: session.id, replyClaim: { id: queue.id, token }, trigger: 'automation' })).status).toBe('skipped');
    expect(generate).toHaveBeenCalledOnce(); expect(sendText).not.toHaveBeenCalled();
    expect(await db.contactNote.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: f.conversationId } })).activeAgentSessionId).toBe(replacementId);
  });

  it('answers a post-reset external form with the instrumented Prisma client used by the API', async () => {
    const f = await fixture(); await reset(f);
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: f.conversationId } });
    const fresh = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: f.conversationId,
      direction: 'inbound', type: 'system', body: 'Formulário recebido (Webhook externo)', status: 'delivered',
      metadata: { source: 'automation_webhook' }, createdAt: new Date(conversation.historyResetAt!.getTime() + 1) } });
    const instrumented = db.$extends({ query: { $allModels: {
      $allOperations({ args, query }) { return measureInboxDatabase(() => query(args)); }
    } } });
    const sendText = vi.fn().mockResolvedValue({ providerMessageId: 'external-form-reply' });
    const provider = { generate: vi.fn(async () => ({ ...output(), actions: [{ type: 'create_internal_note', body: 'Novo formulário recebido.' }] })) };
    const runtime = createAgentRuntime({ prisma: instrumented as never, provider, evolution: { mode: 'real', client: { sendText } } });
    expect((await runtime.activateForMessage({ ...f, messageId: fresh.id })).status).toBe('completed');
    const result = await runtime.runForMessage({ ...f, messageId: fresh.id, trigger: 'automation' });
    const runs = await db.aiAgentRun.findMany({ where: { workspaceId: f.workspaceId }, select: { status: true, errorMessage: true } });
    expect({ result, runs }).toMatchObject({ result: { status: 'completed' }, runs: [{ status: 'completed', errorMessage: null }] });
    expect(sendText).toHaveBeenCalledOnce();
    expect(await db.contactNote.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
  });

  it('stops a direct generation after reset without sending, actions, session or run resurrection', async () => {
    const f = await fixture();
    const sendText = vi.fn();
    const provider = { generate: vi.fn(async () => { await reset(f); return { ...output(), actions: [{ type: 'create_internal_note', body: 'Stale memory' }] }; }) };
    const result = await createAgentRuntime({ prisma: db as never, provider, evolution: { mode: 'real', client: { sendText } } }).runForMessage({ ...f, trigger: 'automation' });
    expect(result.status).toBe('skipped');
    expect(provider.generate).toHaveBeenCalledOnce();
    expect(sendText).not.toHaveBeenCalled();
    for (const count of await Promise.all([db.aiAgentSession.count({ where: { workspaceId: f.workspaceId } }), db.aiAgentRun.count({ where: { workspaceId: f.workspaceId } }), db.contactNote.count({ where: { workspaceId: f.workspaceId } }), db.message.count({ where: { workspaceId: f.workspaceId, direction: 'outbound' } })])) expect(count).toBe(0);
  });

  it('rejects hidden anchors but activates and answers a genuinely new post-reset message', async () => {
    const f = await fixture(); await reset(f);
    await db.aiAgent.update({ where: { id: f.agentId }, data: { behaviorConfig: { onlyNewConversations: true } } });
    const hasPriorMessages = vi.fn().mockResolvedValue(true);
    const provider = { generate: vi.fn(async () => output()) };
    const sendText = vi.fn().mockResolvedValue({ providerMessageId: 'fresh-provider-id' });
    const runtime = createAgentRuntime({ prisma: db as never, provider, chatHistory: { hasPriorMessages }, evolution: { mode: 'real', client: { sendText } } });
    expect((await runtime.activateForMessage(f)).status).toBe('failed');
    expect((await runtime.prepareAudioMessage({ workspaceId: f.workspaceId, messageId: f.messageId })).status).toBe('skipped');
    expect((await runtime.runForMessage({ ...f, trigger: 'automation' })).status).toBe('skipped');
    expect(await db.aiAgentRun.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: f.conversationId } });
    const fresh = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: f.conversationId, direction: 'inbound', type: 'text', body: 'Olá, pode me ajudar?', status: 'delivered', createdAt: new Date(conversation.historyResetAt!.getTime() + 1) } });
    expect((await runtime.activateForMessage({ ...f, messageId: fresh.id })).status).toBe('completed');
    expect(hasPriorMessages).not.toHaveBeenCalled();
    expect((await runtime.runForMessage({ ...f, messageId: fresh.id, trigger: 'automation' })).status).toBe('completed');
    expect(sendText).toHaveBeenCalledOnce();
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, direction: 'outbound', hiddenByReset: false } })).toBe(1);
  });

  it('retains cancellation of a claimed reminder when reset commits during calendar lookup', async () => {
    const f = await fixture();
    const now = new Date();
    const reminder = await db.meetingReminder.create({ data: { workspaceId: f.workspaceId, conversationId: f.conversationId, agentId: f.agentId, eventId: randomUUID(), meetingStartsAt: new Date(now.getTime() + 60_000), dueAt: now, minutesBefore: 1, messages: [{ text: 'Stale reminder' }] } });
    const sendText = vi.fn();
    const service = createMeetingReminderService({ prisma: db as never, timeZone: 'UTC', evolution: { mode: 'real', client: { sendText } }, meetingScheduler: { availability: vi.fn(async () => { await reset(f); return { timeZone: 'UTC', durationMinutes: 30, availableSlots: [], bookedMeeting: null }; }) } });
    await service.processDue(now);
    expect(sendText).not.toHaveBeenCalled();
    expect((await db.meetingReminder.findUniqueOrThrow({ where: { id: reminder.id } })).status).toBe('cancelled');
  });
});
