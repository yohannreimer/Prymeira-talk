import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDto, MessageDto, RealtimeEvent } from '@prymeira-talk/shared';
import { TalkSession, conversationMatches, patchConversations } from './talk-session';

const message = (id: string, conversationId = 'c1', body = id): MessageDto => ({ id, conversationId, workspaceId: 'w', providerMessageId: null, direction: 'inbound', type: 'text', body, mediaUrl: null, status: 'sent', sentByUserId: null, createdAt: '2026-09-30T00:00:00Z' });
const conversation = (id: string, overrides: Partial<ConversationDto> = {}): ConversationDto => ({ id, workspaceId: 'w', channelId: 'channel', contactId: `contact-${id}`, status: 'open', assignedUserId: null, departmentId: null, lastMessageAt: '2026-09-30T00:00:00Z', lastMessagePreview: null, unreadCount: 0, priority: 'normal', ...overrides });
const event = (type: string, payload: unknown, workspaceId = 'w') => ({ type, workspaceId, payload }) as RealtimeEvent;
const sessions: TalkSession[] = [];
const session = () => { const value = new TalkSession('user:session:w', 'w'); sessions.push(value); return value; };
afterEach(() => { for (const value of sessions.splice(0)) value.clear(); vi.useRealTimers(); });

describe('session query cache', () => {
  it('replays create/edit/delete/receipt frames arriving during HTTP without timestamp reordering', async () => {
    const cache = session();
    let finish!: (messages: MessageDto[]) => void;
    const pending = cache.readMessages('c1', () => new Promise(resolve => { finish = resolve; }));
    cache.event(event('message.updated', message('old', 'c1', 'edited')));
    cache.event(event('message.created', { ...message('new'), createdAt: '2020-01-01T00:00:00Z' }));
    cache.event(event('message.status_changed', { messageId: 'old', status: 'read' }));
    cache.event(event('message.deleted', { messageId: 'delete', conversationId: 'c1' }));
    finish([message('old'), message('delete')]);
    const result = await pending;
    expect(result.map(row => [row.id, row.body, row.status])).toEqual([['old', 'edited', 'read'], ['new', 'new', 'sent']]);
  });
  it('patches inactive cached histories and receipts without a conversationId', () => {
    const cache = session();
    cache.client.setQueryData(cache.key('messages', 'c2'), [message('second', 'c2')]);
    cache.event(event('message.status_changed', { messageId: 'second', status: 'read' }));
    expect(cache.client.getQueryData<MessageDto[]>(cache.key('messages', 'c2'))?.[0].status).toBe('read');
    cache.event(event('message.updated', message('second', 'c2', 'changed')));
    expect(cache.client.getQueryData<MessageDto[]>(cache.key('messages', 'c2'))?.[0].body).toBe('changed');
    cache.event(event('message.deleted', { messageId: 'second', conversationId: 'c2' }));
    expect(cache.client.getQueryData(cache.key('messages', 'c2'))).toEqual([]);
  });
  it('does not regress a newer HTTP receipt when a delayed frame is replayed', async () => {
    const cache = session(); let finish!: (rows: MessageDto[]) => void;
    const pending = cache.readMessages('c1', () => new Promise(resolve => { finish = resolve; }));
    cache.event(event('message.status_changed', { messageId: 'old', status: 'delivered' }));
    finish([{ ...message('old'), status: 'read' }]);
    expect((await pending)[0].status).toBe('read');
  });
  it('rejects other workspace frames and separates users/sessions', () => {
    const cache = session();
    cache.client.setQueryData(cache.key('messages', 'c1'), [message('old')]);
    cache.event(event('message.deleted', { messageId: 'old', conversationId: 'c1' }, 'other'));
    expect(cache.client.getQueryData<MessageDto[]>(cache.key('messages', 'c1'))).toHaveLength(1);
    const other = new TalkSession('user2:session2:w', 'w'); sessions.push(other);
    expect(other.client.getQueryData(other.key('messages', 'c1'))).toBeUndefined();
    cache.writeUI('draft:c1', 'private draft', ''); cache.clear();
    expect(cache.readUI('draft:c1', '')).toBe('');
    expect(cache.client.getQueryCache().getAll()).toEqual([]);
  });
  it('does not refresh unrelated query freshness when frames arrive', async () => {
    vi.useFakeTimers(); const cache = session();
    const key = cache.key('messages', 'c1'); const list = cache.key('conversations', 'all', 'all', '');
    cache.client.setQueryData(key, [message('old')]); cache.client.setQueryData(list, [conversation('c1')]);
    const messageTime = cache.client.getQueryState(key)!.dataUpdatedAt; const listTime = cache.client.getQueryState(list)!.dataUpdatedAt;
    await vi.advanceTimersByTimeAsync(16_000);
    cache.event(event('message.status_changed', { messageId: 'other-message', status: 'read' }));
    cache.event(event('contact.updated', { id: 'other-contact', name: 'Other', phone: '123' }));
    expect(cache.client.getQueryState(key)!.dataUpdatedAt).toBe(messageTime);
    expect(cache.client.getQueryState(list)!.dataUpdatedAt).toBe(listTime);
  });
  it('limits histories to 30/100 messages, protects active, preserves evicted drafts', async () => {
    const cache = session(); cache.setActive('active');
    cache.writeUI('draft:c0', 'still here', '');
    cache.client.setQueryData(cache.key('messages', 'active'), [message('active', 'active')]);
    for (let index = 0; index < 35; index++) {
      const id = `c${index}`;
      const rows = await cache.readMessages(id, async () => Array.from({ length: 105 }, (_, n) => message(`${n}`, id)));
      cache.client.setQueryData(cache.key('messages', id), rows);
    }
    expect(cache.client.getQueryCache().findAll({ queryKey: cache.key('messages') })).toHaveLength(30);
    expect(cache.client.getQueryData(cache.key('messages', 'active'))).toBeDefined();
    expect(cache.client.getQueryData(cache.key('messages', 'c0'))).toBeUndefined();
    expect(cache.readUI('draft:c0', '')).toBe('still here');
    expect(cache.client.getQueryData<MessageDto[]>(cache.key('messages', 'c34'))?.[0].id).toBe('5');
    expect(cache.client.getDefaultOptions().queries?.gcTime).toBe(600_000);
  });
  it('deduplicates 150ms hover/focus prefetch and admits at most two concurrent reads', async () => {
    vi.useFakeTimers(); const cache = session();
    const finishes: Array<() => void> = [];
    const read = vi.fn(() => new Promise<MessageDto[]>(resolve => finishes.push(() => resolve([]))));
    cache.prefetch('c1', read); cache.prefetch('c1', read); cache.prefetch('c2', read); cache.prefetch('c3', read);
    await vi.advanceTimersByTimeAsync(149); expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2);
    finishes.forEach(finish => finish()); await vi.advanceTimersByTimeAsync(0);
    cache.prefetch('cancel', read); cache.cancelPrefetch('cancel'); await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.client.getQueryCache().getAll().every(query => query.queryKey[2] === 'messages')).toBe(true);
  });
});

describe('realtime list membership and reconciliation', () => {
  it('inserts/moves/removes known conversation memberships including hidden search results', () => {
    const row = conversation('new', { manualMarked: true, unreadCount: 1, aiControlStatus: 'human_controlled', contactName: 'Maria', hiddenUntilReply: true });
    expect(patchConversations([], event('conversation.updated', row))).toEqual([]);
    expect(patchConversations([], event('conversation.updated', row), { search: 'MARIA' })).toEqual([row]);
    expect(patchConversations([], event('conversation.updated', { ...row, hiddenUntilReply: false }), { view: 'marked' })).toHaveLength(1);
    expect(patchConversations([row], event('conversation.updated', { ...row, manualMarked: false }), { view: 'marked' })).toEqual([]);
    expect(conversationMatches(row, { view: 'unread', search: 'Maria' })).toBe(true);
    expect(conversationMatches(row, { channelId: 'other', search: 'Maria' })).toBe(false);
    expect(conversationMatches(row, { assignedUserId: 'someone', search: 'Maria' })).toBe(false);
    expect(conversationMatches(conversation('review', { unreadCount: 1, aiControlStatus: 'agent_allowed' }), { view: 'unread' })).toBe('unknown');
  });
  it('patches known views without refetching and batches only unresolved private-review queries', async () => {
    vi.useFakeTimers(); const cache = session();
    const all = cache.key('conversations', 'all', 'all', '');
    const marked = cache.key('conversations', 'marked', 'all', '');
    const reply = cache.key('conversations', 'reply', 'all', '');
    cache.client.setQueryData(all, []); cache.client.setQueryData(marked, []); cache.client.setQueryData(reply, []);
    const invalidate = vi.spyOn(cache.client, 'invalidateQueries');
    cache.event(event('conversation.updated', conversation('c1', { manualMarked: true })));
    expect(cache.client.getQueryData<ConversationDto[]>(all)?.[0].id).toBe('c1');
    expect(cache.client.getQueryData<ConversationDto[]>(marked)?.[0].id).toBe('c1');
    await vi.advanceTimersByTimeAsync(200);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(cache.client.getQueryState(all)?.isInvalidated).toBe(false);
    expect(cache.client.getQueryState(reply)?.isInvalidated).toBe(true);
  });
  it('does not starve fallback reconciliation under continuous frames', async () => {
    vi.useFakeTimers(); const cache = session();
    cache.client.setQueryData(cache.key('conversations', 'reply', 'all', ''), []);
    const invalidate = vi.spyOn(cache.client, 'invalidateQueries');
    for (let index = 0; index < 11; index++) {
      cache.event(event('conversation.updated', conversation('c1')));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(invalidate).toHaveBeenCalled();
  });
  it('replays list insertion/removal after an HTTP snapshot', async () => {
    const cache = session(); let finish!: (rows: ConversationDto[]) => void;
    const pending = cache.readConversations(() => new Promise(resolve => { finish = resolve; }), { view: 'marked' });
    cache.event(event('conversation.updated', conversation('removed', { manualMarked: false })));
    cache.event(event('conversation.updated', conversation('inserted', { manualMarked: true })));
    finish([conversation('removed', { manualMarked: true })]);
    expect((await pending).map(row => row.id)).toEqual(['inserted']);
  });
});
