import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createAutomationWebhookService, parseWebhookSubmission, type AutomationWebhookPrismaLike } from './automation-webhook.service.js';
import { createAutomationRunner, type AutomationRuleRecord, type AutomationRunnerPrisma } from './automation-runner.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
if (url) { const parsed = new URL(url); if (parsed.hostname !== '127.0.0.1' || parsed.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || parsed.pathname !== '/messaging_test') throw Error('Owned messaging fixture required'); }
describe.skipIf(!url)('durable form acceptance and process recovery', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid/unused' } } });
  const workspaces: string[] = [];
  afterAll(async () => {
    for (const workspaceId of workspaces) { await db.automationRule.deleteMany({ where: { workspaceId } }); await db.contact.deleteMany({ where: { workspaceId } }); await db.channel.deleteMany({ where: { workspaceId } }); }
    await db.$disconnect();
  });
  async function fixture() {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const rule = await db.automationRule.create({ data: { workspaceId, name: 'Synthetic form', status: 'enabled', trigger: 'webhook.received', actions: {
      version: 1, nodes: [
        { id: 'trigger', type: 'trigger_webhook', position: { x: 0, y: 0 }, data: { title: 'Form', config: { channelId: channel.id } } },
        { id: 'send', type: 'send_message', position: { x: 1, y: 0 }, data: { title: 'Reply', config: { message: 'Synthetic reply' } } }
      ], edges: [{ id: 'edge', source: 'trigger', target: 'send' }]
    } } });
    const submission = parseWebhookSubmission({ phone: '15550000001', name: 'Synthetic' });
    if (!submission.ok) throw Error('fixture payload');
    const sendText = vi.fn(async () => ({ providerMessageId: randomUUID() }));
    const runner = (database = db) => createAutomationRunner({ prisma: database as unknown as AutomationRunnerPrisma, evolution: { mode: 'real', client: { sendText } as never } });
    const service = (customRunner = runner(), database = db) => createAutomationWebhookService({ prisma: database as unknown as AutomationWebhookPrismaLike, runner: customRunner });
    const accepted = await service().claimSubmission({ rule: rule as AutomationRuleRecord, submission });
    if (!accepted.claimed) throw Error('fixture was duplicated');
    return { workspaceId, rule: rule as AutomationRuleRecord, submission, sendText, service, runner, eventKey: accepted.eventKey };
  }
  it('resumes a lost 202 wakeup on another process and fences concurrent workers', async () => {
    const f = await fixture();
    const queued = await db.automationRun.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    expect(queued).toMatchObject({ status: 'queued', input: { submission: { name: 'Synthetic', variables: { name: 'Synthetic' } } } });
    await Promise.all([f.service().processDueSubmissions({ workspaceIds: [f.workspaceId] }), f.service().processDueSubmissions({ workspaceIds: [f.workspaceId] })]);
    expect(f.sendText).toHaveBeenCalledTimes(1);
    const completed = await db.automationRun.findUniqueOrThrow({ where: { id: queued.id } });
    expect(completed.status).toBe('completed');
    expect((completed.input as Record<string, unknown>).messageId).toBeTypeOf('string');
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, type: 'system' } })).toBe(1);
    expect(await f.service().claimSubmission({ rule: f.rule, submission: f.submission })).toEqual({ claimed: false });
    expect(await f.service().processDueSubmissions({ workspaceIds: [f.workspaceId] })).toEqual({ processed: 0 });
    expect(f.sendText).toHaveBeenCalledTimes(1);
  });
  it('reuses the committed form anchor after interruption before the runner claim', async () => {
    const f = await fixture();
    const stopped = createAutomationWebhookService({ prisma: db as unknown as AutomationWebhookPrismaLike, runner: { runForWebhookEvent: async () => { throw Error('synthetic process interruption'); } } });
    await expect(stopped.processSubmission(f)).rejects.toThrow('synthetic process interruption');
    const before = await db.automationRun.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    const messageId = (before.input as Record<string, unknown>).messageId;
    expect(before.status).toBe('queued');
    await f.service().processDueSubmissions({ workspaceIds: [f.workspaceId] });
    const after = await db.automationRun.findUniqueOrThrow({ where: { id: before.id } });
    expect((after.input as Record<string, unknown>).messageId).toBe(messageId);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, type: 'system' } })).toBe(1);
    expect(f.sendText).toHaveBeenCalledTimes(1);
  });
  it('rolls back preparation when the anchor cannot be saved and later resumes once', async () => {
    const f = await fixture();
    const faulty = new Proxy(db, { get(target, property) {
      if (property === '$transaction') return (work: (tx: unknown) => Promise<unknown>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number }) => target.$transaction(tx => work(new Proxy(tx, { get(inner, key) {
        if (key === 'message') return { ...inner.message, create: async () => { throw Error('synthetic anchor storage failure'); } };
        return Reflect.get(inner, key);
      } })), options);
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const failed = createAutomationWebhookService({ prisma: faulty as unknown as AutomationWebhookPrismaLike, runner: f.runner() });
    await expect(failed.processSubmission(f)).rejects.toThrow('synthetic anchor storage failure');
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    expect(await f.service().processDueSubmissions({ workspaceIds: [f.workspaceId] })).toEqual({ processed: 1 });
    expect(f.sendText).toHaveBeenCalledTimes(1);
  });
  it('keeps an uncertain external send for review after restart without sending it again', async () => {
    const f = await fixture(); let sent = false;
    f.sendText.mockImplementation(async () => { sent = true; return { providerMessageId: randomUUID() }; });
    const faulty = new Proxy(db, { get(target, property) {
      if (property === 'automationRun') return new Proxy(target.automationRun, { get(delegate, key) {
        if (key === 'updateMany') return async (args: Parameters<typeof db.automationRun.updateMany>[0]) => { if (sent) throw Error('synthetic completion loss'); return delegate.updateMany(args); };
        return Reflect.get(delegate, key);
      } });
      return Reflect.get(target, property);
    } });
    await expect(f.service(f.runner(faulty)).processSubmission(f)).rejects.toThrow();
    const interrupted = await db.automationRun.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    expect(interrupted.status).toBe('running');
    await db.automationRun.update({ where: { id: interrupted.id }, data: { leaseUntil: new Date(0) } });
    await f.service().processDueSubmissions({ workspaceIds: [f.workspaceId] });
    expect(f.sendText).toHaveBeenCalledTimes(1);
    const reviewed = await db.automationRun.findUniqueOrThrow({ where: { id: interrupted.id } });
    expect(reviewed.status).toBe('failed');
    expect(JSON.stringify(reviewed.result)).toContain('outcome requires review');
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, type: 'system' } })).toBe(1);
  });
  it('surfaces stale legacy running claims without replaying and leaves fresh old-process work alone', async () => {
    const f = await fixture(), run = await db.automationRun.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    await db.automationRun.update({ where: { id: run.id }, data: { status: 'running', executionToken: null } });
    await f.service().processDueSubmissions({ workspaceIds: [f.workspaceId] });
    expect((await db.automationRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('running');
    await db.automationRun.update({ where: { id: run.id }, data: { updatedAt: new Date(0) } });
    await f.service().processDueSubmissions({ workspaceIds: [f.workspaceId] });
    expect(await db.automationRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', result: { needsReview: true } });
    expect(f.sendText).not.toHaveBeenCalled();
  });
});
