import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDto, MessageDto, RealtimeEvent } from '@prymeira-talk/shared';
import { TalkSession, type TalkAlert } from './talk-session';

const message = (overrides: Partial<MessageDto> = {}): MessageDto => ({ id: 'm1', conversationId: 'c1', workspaceId: 'w', providerMessageId: null, direction: 'inbound', type: 'text', body: 'oi', mediaUrl: null, status: 'sent', sentByUserId: null, createdAt: '2026-10-11T00:00:00Z', ...overrides });
const conversation = (overrides: Partial<ConversationDto> = {}): ConversationDto => ({ id: 'c1', workspaceId: 'w', channelId: 'channel', contactId: 'contact', contactName: 'Ana', status: 'open', assignedUserId: null, departmentId: null, lastMessageAt: '2026-10-11T00:00:00Z', lastMessagePreview: null, unreadCount: 0, priority: 'normal', ...overrides });
const event = (type: string, payload: unknown) => ({ type, workspaceId: 'w', payload }) as RealtimeEvent;
const sessions: TalkSession[] = [];
function listen() {
  const cache = new TalkSession('user:session:w', 'w'); sessions.push(cache);
  const alerts: TalkAlert[] = []; cache.subscribeAlerts(alert => alerts.push(alert));
  return { cache, alerts };
}
afterEach(() => { for (const value of sessions.splice(0)) value.clear(); vi.useRealTimers(); });

describe('session alerts', () => {
  it('raises a customer message with the conversation as the list knew it', () => {
    const { cache, alerts } = listen();
    cache.client.setQueryData(cache.key('conversations', 'all', 'all', ''), [conversation()]);
    cache.event(event('message.created', message()));
    expect(alerts).toEqual([{ kind: 'message', message: message(), conversation: conversation() }]);
  });
  it('waits for the update of a conversation that was not loaded, then alerts without it', () => {
    vi.useFakeTimers();
    const { cache, alerts } = listen();
    cache.event(event('message.created', message()));
    expect(alerts).toEqual([]);
    cache.event(event('conversation.updated', conversation({ unreadCount: 1 })));
    expect(alerts).toEqual([{ kind: 'message', message: message(), conversation: conversation({ unreadCount: 1 }) }]);
    cache.event(event('message.created', message({ id: 'm2', conversationId: 'c2' })));
    vi.advanceTimersByTime(1_500);
    expect(alerts.at(-1)).toEqual({ kind: 'message', message: message({ id: 'm2', conversationId: 'c2' }) });
  });
  it('ignores the team\'s own messages, reactions, notes and updates', () => {
    const { cache, alerts } = listen();
    cache.event(event('message.created', message({ direction: 'outbound' })));
    cache.event(event('message.created', message({ reaction: { targetWhatsappId: 'x', emoji: '👍' } })));
    cache.event(event('message.created', message({ type: 'internal_note' })));
    cache.event(event('message.updated', message()));
    expect(alerts).toEqual([]);
  });
  it('raises a handoff only when the conversation starts needing a person', () => {
    const { cache, alerts } = listen();
    const key = cache.key('conversations', 'all', 'all', '');
    cache.client.setQueryData(key, [conversation({ aiControlStatus: 'agent_allowed', activeAgentSessionStatus: 'active' })]);
    const handedOff = conversation({ aiControlStatus: 'human_controlled', handoffReason: 'Pediu orçamento', activeAgentSessionStatus: 'handoff_requested' });
    cache.event(event('conversation.updated', handedOff));
    cache.event(event('conversation.updated', { ...handedOff, unreadCount: 2 }));
    expect(alerts.map(alert => alert.kind)).toEqual(['handoff']);
  });
});
