import { describe, expect, it, vi } from 'vitest';
import { createEffectHandlers, type EffectServices } from './effect-handlers.js';
import type { ClaimedEffect } from './effect-runner.js';

vi.mock('../conversations/conversations.service.js', () => ({
  conversationDtoInclude: {},
  toConversationDto: (record: { id: string }) => ({ dto: 'conversation', id: record.id }),
  toMessageDto: (record: { id: string }) => ({ dto: 'message', id: record.id })
}));
vi.mock('../prospecting/prospecting-lifecycle.js', () => ({ observeProspectingInbound: vi.fn(async () => ({ reserved: true, activated: false, liveEligible: false })) }));

const ids = { workspaceId: 'w', conversationId: 'c', messageId: 'm' };
const effect = (kind: string, frozen: Record<string, unknown> = {}, over: Partial<ClaimedEffect> = {}): ClaimedEffect =>
  ({ id: 'e', workspaceId: 'w', channelId: 'ch', conversationId: 'c', messageId: 'm', kind, logicalKey: 'k', cause: {}, frozen, attempts: 1, ...over });
const signal = new AbortController().signal;

function setup(opts: { prospecting?: { state: string; result?: unknown } | null; messageType?: string; assisted?: boolean; extra?: Partial<EffectServices> } = {}) {
  const published: Array<{ type: string; payload?: any }> = [];
  const db: any = {
    ingressEffect: { findFirst: vi.fn(async () => opts.prospecting === undefined ? null : opts.prospecting) },
    message: { findFirst: vi.fn(async (args: any) => args.select?.type ? { type: opts.messageType ?? 'text' } : { id: 'm', direction: 'inbound', type: 'text', body: 'x', createdAt: new Date(), ingestedAt: null }) },
    conversation: { findUnique: vi.fn(async () => ({ id: 'c', channelId: 'ch', channel: { provider: 'evolution', providerKey: 'inst' }, contact: { phone: '5511' } })) },
    channelConnection: { findFirst: vi.fn(async () => ({ provider: 'evolution', sessionName: 'sess' })) },
    contact: { updateMany: vi.fn(async () => ({ count: 1 })) }
  };
  const services = {
    db, realtime: { publish: (event: any) => published.push(event) },
    assistantScheduler: { message: vi.fn(), control: vi.fn(), isAssisted: vi.fn(async () => opts.assisted === true) },
    agentRuntime: { prepareAudioMessage: vi.fn(async () => ({ status: 'completed' })) },
    agentReplyScheduler: { scheduleActiveSessionForMessage: vi.fn() },
    ...opts.extra
  } as unknown as EffectServices;
  return { handlers: createEffectHandlers(services), services: services as any, db, published };
}
const run = (handlers: ReturnType<typeof createEffectHandlers>, e: ClaimedEffect) => handlers[e.kind]!(e, { signal });

describe('agent.debounce', () => {
  it('does nothing for a prospecting-reserved conversation that is not live eligible', async () => {
    const { handlers, services } = setup({ prospecting: { state: 'done', result: { reserved: true, liveEligible: false } }, messageType: 'audio' });
    expect(await run(handlers, effect('agent.debounce'))).toEqual({ status: 'done', result: { skipped: 'prospecting_reserved' } });
    expect(services.agentRuntime.prepareAudioMessage).not.toHaveBeenCalled();
    expect(services.agentReplyScheduler.scheduleActiveSessionForMessage).not.toHaveBeenCalled();
  });

  it('fails visibly, without waking the agent, when the prospecting observation itself failed', async () => {
    const { handlers, services } = setup({ prospecting: { state: 'failed' } });
    expect(await run(handlers, effect('agent.debounce'))).toEqual({ status: 'failed', errorCode: 'PROSPECTING_STATE_UNKNOWN' });
    expect(services.agentReplyScheduler.scheduleActiveSessionForMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['plain audio, not assisted', { reserved: false, liveEligible: false }, false, true],
    ['audio of a conversation the assistant handles', { reserved: false, liveEligible: false }, true, false],
    ['audio of a live-eligible prospecting conversation, even if assisted', { reserved: true, liveEligible: true }, true, true]
  ])('%s -> transcribes: %s', async (_name, prospecting, assisted, transcribes) => {
    const { handlers, services } = setup({ prospecting: { state: 'done', result: prospecting }, messageType: 'audio', assisted });
    expect(await run(handlers, effect('agent.debounce'))).toEqual({ status: 'done' });
    expect(services.agentRuntime.prepareAudioMessage).toHaveBeenCalledTimes(transcribes ? 1 : 0);
    expect(services.agentReplyScheduler.scheduleActiveSessionForMessage).toHaveBeenCalledWith(ids);
  });

  it('treats a message with no prospecting effect (group, history) as not reserved', async () => {
    const { handlers, services } = setup({ prospecting: null, messageType: 'text' });
    await run(handlers, effect('agent.debounce'));
    expect(services.agentReplyScheduler.scheduleActiveSessionForMessage).toHaveBeenCalledTimes(1);
  });
});

describe('realtime and reconcile', () => {
  it('announces a created message and an enriched one differently', async () => {
    const { handlers, published } = setup();
    await run(handlers, effect('realtime.message', { outcome: 'created' }));
    await run(handlers, effect('realtime.message', { outcome: 'enriched' }));
    expect(published.map(event => event.type)).toEqual(['message.created', 'message.updated']);
  });

  it('refreshes the conversation after an edit only when the edited message is the latest', async () => {
    const latest = setup(); latest.db.message.findFirst = vi.fn(async (args: any) => args.select ? { id: 'm' } : { id: 'm' });
    await run(latest.handlers, effect('content.reconcile', { kind: 'edit' }));
    expect(latest.published.map(event => event.type)).toEqual(['message.updated', 'conversation.updated']);
    const older = setup(); older.db.message.findFirst = vi.fn(async (args: any) => args.select ? { id: 'newer' } : { id: 'm' });
    await run(older.handlers, effect('content.reconcile', { kind: 'revoke' }));
    expect(older.published.map(event => event.type)).toEqual(['message.updated']);
  });

  it('skips a deleted message instead of failing the obligation', async () => {
    const { handlers, db } = setup();
    db.message.findFirst = vi.fn(async () => null);
    expect(await run(handlers, effect('realtime.message', { outcome: 'created' }))).toEqual({ status: 'done', result: { skipped: 'message_missing' } });
  });
});

describe('optional collaborators', () => {
  it('records a skip, never an error, when a service is not wired in this process', async () => {
    const handlers = createEffectHandlers({ db: {} as never, realtime: { publish: vi.fn() } });
    for (const kind of ['assistant.control', 'assistant.message', 'handoff.brief', 'triage.message', 'followup.activity', 'human_reply.improvement', 'history.backfill', 'automation.occurrence']) {
      expect(await handlers[kind]!(effect(kind), { signal }), kind).toMatchObject({ status: 'done', result: { skipped: expect.any(String) } });
    }
    expect(handlers['realtime.connection']).toBeUndefined();
  });
});

describe('contact.group_metadata', () => {
  const frozen = { contactId: 'ct', chatAddress: '123-456@g.us', originalName: null, provider: 'evolution' };
  it('names the group with a compare-and-set and announces the conversation', async () => {
    const { handlers, db, published } = setup({ extra: { groupSubject: vi.fn(async () => '  Compras Aço  ') } });
    expect(await run(handlers, effect('contact.group_metadata', frozen))).toEqual({ status: 'done', result: { updated: 1 } });
    expect(db.contact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Compras Aço' }, where: expect.objectContaining({ workspaceId: 'w', id: 'ct', OR: expect.any(Array) }) }));
    expect(published.map(event => event.type)).toEqual(['conversation.updated']);
  });

  it('does not announce anything when somebody renamed the contact meanwhile', async () => {
    const { handlers, db, published } = setup({ extra: { groupSubject: vi.fn(async () => 'Novo') } });
    db.contact.updateMany = vi.fn(async () => ({ count: 0 }));
    expect(await run(handlers, effect('contact.group_metadata', frozen))).toEqual({ status: 'done', result: { updated: 0 } });
    expect(published).toEqual([]);
  });

  it('lets a transient lookup failure retry instead of swallowing it', async () => {
    const { handlers } = setup({ extra: { groupSubject: vi.fn(async () => { throw new Error('provider timeout'); }) } });
    await expect(run(handlers, effect('contact.group_metadata', frozen))).rejects.toThrow('provider timeout');
  });
});
