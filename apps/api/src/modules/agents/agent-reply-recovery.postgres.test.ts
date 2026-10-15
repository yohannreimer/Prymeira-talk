import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AGENT_REPLY_LEASE_MS, recoverStaleAgentReplyClaim } from './agent-reply-claim.js';
import { createAgentReplyScheduler } from './agent-reply-scheduler.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' || target.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || target.pathname !== '/messaging_test') throw Error('Owned local messaging fixture required');
}
describe.skipIf(!url)('stale reply recovery handoff with PostgreSQL', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid/unused' } } });
  const workspaces: string[] = [];
  afterAll(async () => {
    for (const workspaceId of workspaces) {
      await db.channel.deleteMany({ where: { workspaceId } });
      await db.contact.deleteMany({ where: { workspaceId } });
      await db.aiAgent.deleteMany({ where: { workspaceId } });
    }
    await db.$disconnect();
  });
  async function fixture() {
    const now = new Date(), workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const contact = await db.contact.create({ data: { workspaceId, phone: '15550009999' } });
    const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id } });
    const agent = await db.aiAgent.create({ data: { workspaceId, name: 'Recovery fixture', status: 'active', systemPrompt: 'Synthetic fixture' } });
    const session = await db.aiAgentSession.create({ data: { workspaceId, conversationId: conversation.id, agentId: agent.id } });
    await db.conversation.update({ where: { id: conversation.id }, data: { activeAgentSessionId: session.id } });
    const message = await db.message.create({ data: { workspaceId, conversationId: conversation.id, direction: 'inbound', type: 'text', body: 'Synthetic inbound', status: 'delivered' } });
    const reply = await db.aiAgentPendingReply.create({ data: { workspaceId, conversationId: conversation.id,
      agentId: agent.id, sessionId: session.id, lastMessageId: message.id, status: 'processing', claimToken: randomUUID(),
      lockedAt: new Date(now.getTime() - AGENT_REPLY_LEASE_MS - 1_000), scheduledAt: new Date(now.getTime() - 1_000) } });
    return { now, workspaceId, conversation, session, agent, message, reply };
  }

  it('hands off one expired ordinary claim across two workers without dispatch', async () => {
    const f = await fixture(), notifyReplyFailureHandoff = vi.fn(async () => undefined), runForMessage = vi.fn();
    const runtime = { runForMessage, notifyReplyFailureHandoff };
    await Promise.all([1, 2].map(() => createAgentReplyScheduler({ prisma: db, agentRuntime: runtime }).processDueReplies({ now: f.now })));
    expect(runForMessage).not.toHaveBeenCalled();
    expect(notifyReplyFailureHandoff).toHaveBeenCalledOnce();
    expect(await db.aiAgentPendingReply.findUniqueOrThrow({ where: { id: f.reply.id } })).toMatchObject({ status: 'failed', claimToken: null, lockedAt: null });
    expect(await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).toMatchObject({ aiControlStatus: 'human_controlled' });
    expect(await db.aiAgentSession.findUniqueOrThrow({ where: { id: f.session.id } })).toMatchObject({ status: 'handoff_requested' });
  });

  it.each(['rescheduled', 'renewed'] as const)('does not hand off a %s reply fetched before recovery', async change => {
    const f = await fixture();
    await db.aiAgentPendingReply.update({ where: { id: f.reply.id }, data: change === 'rescheduled'
      ? { status: 'pending', claimToken: null, lockedAt: null, lastMessageId: randomUUID() }
      : { lockedAt: f.now } });
    expect(await recoverStaleAgentReplyClaim(db, f.reply, f.now)).toBeUndefined();
    expect((await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).aiControlStatus).toBe('agent_allowed');
    expect((await db.aiAgentSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).toBe('active');
  });

  it('does not stop a newer active session when the old claim expires', async () => {
    const f = await fixture();
    const newer = await db.aiAgent.create({ data: { workspaceId: f.workspaceId, name: 'New agent', systemPrompt: 'New synthetic fixture' } });
    const newerSession = await db.aiAgentSession.create({ data: { workspaceId: f.workspaceId, conversationId: f.conversation.id, agentId: newer.id } });
    await db.conversation.update({ where: { id: f.conversation.id }, data: { activeAgentSessionId: newerSession.id } });
    expect(await recoverStaleAgentReplyClaim(db, f.reply, f.now)).toEqual({ status: 'failed' });
    expect((await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).aiControlStatus).toBe('agent_allowed');
    expect((await db.aiAgentSession.findUniqueOrThrow({ where: { id: newerSession.id } })).status).toBe('active');
  });

  it('does not hand off a hidden pre-reset anchor', async () => {
    const f = await fixture();
    await db.message.update({ where: { id: f.message.id }, data: { hiddenByReset: true } });
    expect(await recoverStaleAgentReplyClaim(db, f.reply, f.now)).toEqual({ status: 'failed' });
    expect((await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).aiControlStatus).toBe('agent_allowed');
  });

  it('rolls back the human handoff if terminal queue persistence fails', async () => {
    const f = await fixture();
    const faulty = { $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { isolationLevel: Prisma.TransactionIsolationLevel }) =>
      db.$transaction(tx => work(new Proxy(tx, { get(target, key) {
        if (key === 'aiAgentPendingReply') return new Proxy(target.aiAgentPendingReply, { get(delegate, method) {
          if (method === 'update') return async () => { throw Error('Synthetic terminal queue write failure'); };
          return Reflect.get(delegate, method);
        } });
        return Reflect.get(target, key);
      } })), options) };
    await expect(recoverStaleAgentReplyClaim(faulty, f.reply, f.now)).rejects.toThrow('Synthetic terminal queue write failure');
    expect((await db.aiAgentPendingReply.findUniqueOrThrow({ where: { id: f.reply.id } })).status).toBe('processing');
    expect((await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).aiControlStatus).toBe('agent_allowed');
    expect((await db.aiAgentSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).toBe('active');
    expect((await recoverStaleAgentReplyClaim(db, f.reply, f.now))?.handoff).toBeDefined();
  });
});
