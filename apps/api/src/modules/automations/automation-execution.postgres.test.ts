import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createAutomationRunner, type AutomationRunnerPrisma } from './automation-runner.js';
import { claimAutomationExecution } from './automation-execution.js';
import { automationFlowSchema } from '@prymeira-talk/shared';

const url = process.env.MESSAGING_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || parsed.pathname !== '/messaging_test') throw new Error('Owned disposable messaging database required.');
}

describe.skipIf(!url)('durable automation claims with PostgreSQL', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid/unused' } } });
  const workspaces: string[] = [];
  afterAll(async () => {
    for (const workspaceId of workspaces) {
      await db.automationRule.deleteMany({ where: { workspaceId } });
      await db.contact.deleteMany({ where: { workspaceId } });
      await db.channel.deleteMany({ where: { workspaceId } });
      await db.tag.deleteMany({ where: { workspaceId } });
    }
    await db.$disconnect();
  });
  async function fixture() {
    const workspaceId = `automation-claim-${randomUUID()}`; workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const contact = await db.contact.create({ data: { workspaceId, phone: '15550000001' } });
    const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id } });
    const message = await db.message.create({ data: { workspaceId, conversationId: conversation.id, direction: 'inbound', type: 'text', body: 'synthetic fixture', status: 'delivered' } });
    const flow = automationFlowSchema.parse({ version: 1, nodes: [
      { id: 'trigger', type: 'trigger_first_message', position: { x: 0, y: 0 }, data: { title: 'Trigger', config: {} } },
      { id: 'send', type: 'send_message', position: { x: 1, y: 0 }, data: { title: 'Send', config: { message: 'Synthetic reply' } } },
      { id: 'tag', type: 'add_tag', position: { x: 2, y: 0 }, data: { title: 'Tag', config: { tagName: 'Synthetic tag' } } }
    ], edges: [{ id: 'a', source: 'trigger', target: 'send' }, { id: 'b', source: 'send', target: 'tag' }] });
    const rule = await db.automationRule.create({ data: { workspaceId, name: 'Synthetic automation', status: 'enabled', trigger: 'message.received', actions: JSON.parse(JSON.stringify(flow)) } });
    return { workspaceId, channel, conversation, message, rule, flow, event: { workspaceId, messageId: message.id, eventKey: `message.received:${message.id}` } };
  }

  it('commits one event claim across concurrent workers and replay', async () => {
    const f = await fixture();
    const sendText = vi.fn(async () => ({ providerMessageId: randomUUID() }));
    const runner = createAutomationRunner({ prisma: db as unknown as AutomationRunnerPrisma, evolution: { mode: 'real', client: { sendText } as never } });
    const results = await Promise.allSettled([runner.runForInboundMessage(f.event), runner.runForInboundMessage(f.event)]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    await runner.runForInboundMessage(f.event);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await db.automationRun.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    expect(await db.conversationTag.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
  });

  it('resumes after a process stops before the first action', async () => {
    const f = await fixture();
    const claim = await claimAutomationExecution(db as unknown as AutomationRunnerPrisma, { workspaceId: f.workspaceId,
      ruleId: f.rule.id, eventKey: f.event.eventKey, flow: f.flow,
      input: { source: 'evolution_webhook', messageId: f.message.id, conversationId: f.conversation.id } });
    expect(claim.claimed).toBe(true); if (!claim.claimed) throw new Error('claim');
    claim.close();
    await db.automationRun.update({ where: { id: claim.run.id }, data: { leaseUntil: new Date(0) } });
    const sendText = vi.fn(async () => ({ providerMessageId: randomUUID() }));
    const restarted = createAutomationRunner({ prisma: db as unknown as AutomationRunnerPrisma, evolution: { mode: 'real', client: { sendText } as never } });
    expect(await restarted.recoverDueRuns()).toContain(claim.run.id);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await db.automationRun.findUniqueOrThrow({ where: { id: claim.run.id } })).status).toBe('completed');
  });

  it.each(['invalid-step', 'invalid-version', 'legacy'] as const)('holds expired %s checkpoints once for review', async kind => {
    const f = await fixture();
    const claimed = await claimAutomationExecution(db as unknown as AutomationRunnerPrisma, { workspaceId: f.workspaceId, ruleId: f.rule.id, eventKey: f.event.eventKey, flow: f.flow, input: { source: 'evolution_webhook', messageId: f.message.id } });
    if (!claimed.claimed) throw new Error('claim'); claimed.close();
    await db.automationRun.update({ where: { id: claimed.run.id }, data: { updatedAt: new Date(0), leaseUntil: new Date(0),
      ...(kind === 'legacy' ? { executionToken: null } : { result: JSON.parse(JSON.stringify({ execution: { version: kind === 'invalid-version' ? 2 : 1, flow: f.flow, steps: [{ nodeId: 'send', state: 'completed', execution: { result: { status: 'fake' } } }] } })) }) } });
    const sendText = vi.fn(async () => ({ providerMessageId: randomUUID() }));
    const runner = createAutomationRunner({ prisma: db as unknown as AutomationRunnerPrisma, evolution: { mode: 'real', client: { sendText } as never } });
    await runner.recoverDueRuns(); await runner.recoverDueRuns();
    expect(sendText).not.toHaveBeenCalled();
    const held = await db.automationRun.findUniqueOrThrow({ where: { id: claimed.run.id } });
    expect(held).toMatchObject({ status: 'failed', executionToken: null, leaseUntil: null });
    expect(held.result).toMatchObject({ reviewRequired: true });
  });

  it('never repeats an accepted send when all completion writes were lost', async () => {
    const f = await fixture();
    let unavailable = false;
    const sendText = vi.fn(async () => { unavailable = true; return { providerMessageId: randomUUID() }; });
    const faulty = new Proxy(db, { get(target, key) {
      if (key === 'automationRun') return new Proxy(target.automationRun, { get(delegate, method) {
        if (method === 'updateMany') return async (args: Parameters<typeof db.automationRun.updateMany>[0]) => {
          if (unavailable) throw new Error('Synthetic persistence outage after provider acceptance');
          return delegate.updateMany(args);
        };
        return Reflect.get(delegate, method);
      } });
      return Reflect.get(target, key);
    } });
    await expect(createAutomationRunner({ prisma: faulty as unknown as AutomationRunnerPrisma,
      evolution: { mode: 'real', client: { sendText } as never } }).runForInboundMessage(f.event)).rejects.toThrow();
    const interrupted = await db.automationRun.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    expect(interrupted.status).toBe('running');
    await db.automationRun.update({ where: { id: interrupted.id }, data: { leaseUntil: new Date(0) } });
    const restarted = createAutomationRunner({ prisma: db as unknown as AutomationRunnerPrisma,
      evolution: { mode: 'real', client: { sendText } as never } });
    await restarted.recoverDueRuns();
    expect(sendText).toHaveBeenCalledTimes(1);
    const held = await db.automationRun.findUniqueOrThrow({ where: { id: interrupted.id } });
    expect(held.status).toBe('failed');
    expect(JSON.stringify(held.result)).toContain('outcome requires review');
    expect(await db.conversationTag.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });
});
