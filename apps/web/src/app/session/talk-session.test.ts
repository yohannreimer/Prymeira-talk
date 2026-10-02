import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import type { ChannelHealthDto, ConversationDto, MessageDto, RealtimeEvent } from '@prymeira-talk/shared';
import { TalkSession, conversationMatches, patchConversations } from './talk-session';

const message = (id: string, conversationId = 'c1', body = id): MessageDto => ({ id, conversationId, workspaceId: 'w', providerMessageId: null, direction: 'inbound', type: 'text', body, mediaUrl: null, status: 'sent', sentByUserId: null, createdAt: '2026-09-30T00:00:00Z' });
const conversation = (id: string, overrides: Partial<ConversationDto> = {}): ConversationDto => ({ id, workspaceId: 'w', channelId: 'channel', contactId: `contact-${id}`, status: 'open', assignedUserId: null, departmentId: null, lastMessageAt: '2026-09-30T00:00:00Z', lastMessagePreview: null, unreadCount: 0, priority: 'normal', ...overrides });
const event = (type: string, payload: unknown, workspaceId = 'w') => ({ type, workspaceId, payload }) as RealtimeEvent;
const sessions: TalkSession[] = [];
const session = () => { const value = new TalkSession('user:session:w', 'w'); sessions.push(value); return value; };
afterEach(() => { for (const value of sessions.splice(0)) value.clear(); vi.useRealTimers(); });

describe('session query cache', () => {
  it.each(['HTTP', 'commit'])('keeps distinct local sends with identical content when the second arrives during %s', async timing => {
    const cache = session(); const key = cache.key('messages', 'c1');
    const first = { ...message('optimistic-first', 'c1', 'same text'), direction: 'outbound' as const, status: 'pending' as const };
    const second = { ...first, id: 'optimistic-second' };
    let finish!: (rows: MessageDto[]) => void;
    const pending = cache.client.fetchQuery({ queryKey: key, queryFn: () => cache.readMessages('c1', () => new Promise(resolve => { finish = resolve; })) });
    cache.updateMessages('c1', () => [first]);
    if (timing === 'HTTP') cache.updateMessages('c1', rows => [...rows, second]);
    finish([]);
    if (timing === 'commit') queueMicrotask(() => cache.updateMessages('c1', rows => [...rows, second]));
    await pending;
    expect(cache.client.getQueryData<MessageDto[]>(key)?.map(row => [row.id, row.body, row.status])).toEqual([
      ['optimistic-first', 'same text', 'pending'], ['optimistic-second', 'same text', 'pending']
    ]);
  });
  it('replays local exact-id updates/removals without regressing a newer HTTP receipt', async () => {
    const cache = session(); const key = cache.key('messages', 'c1');
    cache.client.setQueryData(key, [message('edit'), message('remove')]);
    let finish!: (rows: MessageDto[]) => void;
    const pending = cache.client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => cache.readMessages('c1', () => new Promise(resolve => { finish = resolve; })) });
    cache.updateMessages('c1', rows => rows.filter(row => row.id !== 'remove').map(row => ({ ...row, body: 'changed locally' })));
    finish([{ ...message('edit'), status: 'read' }, message('remove')]); await pending;
    expect(cache.client.getQueryData<MessageDto[]>(key)?.map(row => [row.id, row.body, row.status])).toEqual([['edit', 'changed locally', 'read']]);
  });
  it('keeps a local failure arriving between HTTP resolution and the QueryClient commit', async () => {
    const cache = session(); const key = cache.key('messages', 'c1');
    let finish!: (rows: MessageDto[]) => void;
    const pending = cache.client.fetchQuery({ queryKey: key, queryFn: () => cache.readMessages('c1', () => new Promise(resolve => { finish = resolve; })) });
    cache.updateMessages('c1', () => [{ ...message('optimistic-new'), status: 'pending' }]);
    finish([]);
    queueMicrotask(() => cache.updateMessages('c1', rows => rows.map(row => ({ ...row, status: 'failed' }))));
    await pending;
    expect(cache.client.getQueryData<MessageDto[]>(key)?.map(row => [row.id, row.status])).toEqual([['optimistic-new', 'failed']]);
  });
  it('keeps message frames through the QueryClient commit and preserves local/frame ingestion order', async () => {
    const cache = session(); const key = cache.key('messages', 'c1');
    cache.client.setQueryData(key, [message('old'), message('delete')]);
    let finish!: (rows: MessageDto[]) => void;
    const pending = cache.client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => cache.readMessages('c1', () => new Promise(resolve => { finish = resolve; })) });
    cache.updateMessages('c1', rows => [...rows, { ...message('optimistic-new', 'c1', 'outgoing'), direction: 'outbound', status: 'pending' }]);
    finish([message('old'), message('delete')]);
    queueMicrotask(() => {
      cache.event(event('message.created', { ...message('server-new', 'c1', 'outgoing'), direction: 'outbound', status: 'read' }));
      cache.event(event('message.updated', message('old', 'c1', 'edited')));
      cache.event(event('message.status_changed', { messageId: 'old', status: 'read' }));
      cache.event(event('message.deleted', { messageId: 'delete', conversationId: 'c1' }));
    });
    await pending;
    expect(cache.client.getQueryData<MessageDto[]>(key)?.map(row => [row.id, row.body, row.status])).toEqual([['old', 'edited', 'read'], ['server-new', 'outgoing', 'read']]);
  });
  it('keeps filtered conversation removals and insertions through the QueryClient commit', async () => {
    const cache = session(); const key = cache.key('conversations', 'marked', 'all', '');
    cache.client.setQueryData(key, [conversation('c1', { manualMarked: true })]);
    let finish!: (rows: ConversationDto[]) => void;
    const pending = cache.client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => cache.readConversations(() => new Promise(resolve => { finish = resolve; }), { view: 'marked' }) });
    finish([conversation('c1', { manualMarked: true })]);
    queueMicrotask(() => {
      cache.event(event('conversation.updated', conversation('c1', { manualMarked: false })));
      cache.event(event('conversation.updated', conversation('c2', { manualMarked: true })));
    });
    await pending;
    expect(cache.client.getQueryData<ConversationDto[]>(key)?.map(row => row.id)).toEqual(['c2']);
  });
  it('keeps the pagination fence through merging its page into the cached list', async () => {
    const cache = session(); const key = cache.key('conversations', 'marked', 'all', '');
    cache.client.setQueryData(key, [conversation('existing', { manualMarked: true })]);
    let finish!: (rows: ConversationDto[]) => void;
    const pending = cache.readConversations(() => new Promise(resolve => { finish = resolve; }), { view: 'marked' }, { manualCommit: true });
    finish([conversation('page-row', { manualMarked: true })]);
    queueMicrotask(() => {
      cache.event(event('conversation.updated', conversation('page-row', { manualMarked: false })));
      cache.event(event('conversation.updated', conversation('new-row', { manualMarked: true })));
    });
    const page = await pending;
    cache.commitConversationPage(key, page, (current, next) => [...current.filter(row => !next.some(item => item.id === row.id)), ...next]);
    expect(cache.client.getQueryData<ConversationDto[]>(key)?.map(row => row.id)).toEqual(['existing', 'new-row']);
    // A later explicit read is a new snapshot, without replaying the old fence.
    await cache.client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => cache.readConversations(async () => [], { view: 'marked' }) });
    expect(cache.client.getQueryData(key)).toEqual([]);
  });
  it('keeps an independent pagination fence if a concurrent list reconciliation is canceled', async () => {
    const cache = session(); const key = cache.key('conversations', 'marked', 'all', '');
    cache.client.setQueryData(key, [conversation('c1', { manualMarked: true })]);
    let finish!: (rows: ConversationDto[]) => void;
    const controller = new AbortController();
    const pageRead = cache.readConversations(() => new Promise(resolve => { finish = resolve; }), { view: 'marked' }, { signal: controller.signal, manualCommit: true });
    const refreshing = cache.client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: ({ signal }) => { void signal; return new Promise<ConversationDto[]>(() => {}); } });
    await cache.client.cancelQueries({ queryKey: key, exact: true }); await refreshing;
    expect(controller.signal.aborted).toBe(false);
    cache.event(event('conversation.updated', conversation('c1', { manualMarked: false })));
    finish([conversation('c1', { manualMarked: true })]);
    cache.commitConversationPage(key, await pageRead, (current, next) => [...current, ...next]);
    expect(cache.client.getQueryData(key)).toEqual([]);
  });
  it('cancels a source recovery without committing its late HTTP or retaining its fence', async () => {
    const cache = session(); const key = cache.key('messages', 'c1');
    cache.client.setQueryData(key, [message('old')]);
    let finish!: (rows: MessageDto[]) => void; let signal!: AbortSignal;
    const pending = cache.refetchMessages('c1', inputSignal => { signal = inputSignal; return new Promise(resolve => { finish = resolve; }); });
    const outcome = pending.catch(error => error);
    cache.event(event('message.updated', message('old', 'c1', 'edited')));
    await cache.client.cancelQueries({ queryKey: key, exact: true });
    expect(signal.aborted).toBe(true); expect((await outcome).name).toBe('AbortError');
    finish([message('old')]); await Promise.resolve();
    expect(cache.client.getQueryData<MessageDto[]>(key)?.[0].body).toBe('edited');
    cache.event(event('message.deleted', { messageId: 'old', conversationId: 'c1' }));
    await cache.client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => cache.readMessages('c1', async () => [message('old')]) });
    expect(cache.client.getQueryData<MessageDto[]>(key)?.[0].body).toBe('old');
  });
  it('replays later local pending/failed changes in ingestion order with websocket events, but can discard earlier failures', async () => {
    const cache = session(); const old = { ...message('optimistic-old'), status: 'failed' as const };
    cache.client.setQueryData(cache.key('messages', 'c1'), [old]);
    let finish!: (rows: MessageDto[]) => void;
    const pending = cache.readMessages('c1', () => new Promise(resolve => { finish = resolve; }));
    cache.updateMessages('c1', current => [...current, { ...message('optimistic-new'), status: 'pending' }]);
    cache.event(event('message.created', { ...message('from-server'), status: 'read' }));
    cache.updateMessages('c1', current => current.map(row => row.id === 'optimistic-new' ? { ...row, status: 'failed' } : row));
    cache.updateMessages('c2', current => [...current, { ...message('other-local', 'c2'), status: 'pending' }]);
    finish([message('initial')]); const rows = await pending;
    expect(rows.map(row => [row.id, row.status])).toEqual([['initial', 'sent'], ['optimistic-new', 'failed'], ['from-server', 'read']]);
    cache.client.setQueryData(cache.key('messages', 'c1'), rows);
    expect(await cache.readMessages('c1', async () => [message('initial')])).toEqual([message('initial')]);
  });
  it('materializes a local failure changed after a read began even when its pending row predates that read', async () => {
    const cache = session(); cache.client.setQueryData(cache.key('messages', 'c1'), [{ ...message('optimistic-old'), status: 'pending' }]);
    let finish!: (rows: MessageDto[]) => void;
    const pending = cache.readMessages('c1', () => new Promise(resolve => { finish = resolve; }));
    cache.updateMessages('c1', current => current.map(row => ({ ...row, status: 'failed' })));
    finish([]); expect((await pending)[0]?.status).toBe('failed');
  });
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
  it('reconciles active attention after reconnect when a handoff event was missed', async () => {
    const cache = session(); const key = cache.key('attention', 'all'); cache.client.setQueryData(key, 2);
    const inactive = cache.key('attention', 'other-channel'); cache.client.setQueryData(inactive, 1);
    const read = vi.fn(async () => 3);
    const observer = new QueryObserver(cache.client, { queryKey: key, queryFn: () => cache.readAttention('all', read) });
    const unsubscribe = observer.subscribe(() => {});
    try {
      cache.reconcile(); await vi.waitFor(() => expect(cache.client.getQueryData(key)).toBe(3));
      expect(read).toHaveBeenCalledOnce(); expect(cache.client.getQueryData(inactive)).toBe(1);
      expect(cache.client.getQueryState(inactive)?.isInvalidated).toBe(true);
    } finally { unsubscribe(); }
  });
  it('dirties a pending count even with zero DTO delta after a newer list response already includes the event', async () => {
    vi.useFakeTimers(); const cache = session(); const key = cache.key('attention', 'all');
    const list = cache.key('conversations', 'all', 'all', ''); cache.client.setQueryData(key, 0);
    let finish!: (count: number) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; })).mockResolvedValue(1);
    const observer = new QueryObserver(cache.client, { queryKey: key, queryFn: () => cache.readAttention('all', read) });
    const unsubscribe = observer.subscribe(() => {});
    try {
      const pending = observer.refetch();
      const updated = conversation('c1', { activeAgentSessionStatus: 'handoff_requested' });
      cache.client.setQueryData(list, [updated]); cache.event(event('conversation.updated', updated));
      finish(0); await pending; await vi.advanceTimersByTimeAsync(200);
      expect(read).toHaveBeenCalledTimes(2); expect(cache.client.getQueryData(key)).toBe(1);
      expect(cache.client.getQueryState(list)?.isInvalidated).toBe(false);
    } finally { unsubscribe(); }
  });
  it('reconciles a known attention delta when its count HTTP response arrived before the conversation event', async () => {
    vi.useFakeTimers(); const cache = session();
    const key = cache.key('attention', 'all'); const list = cache.key('conversations', 'all', 'all', '');
    cache.client.setQueryData(list, [conversation('c1')]); cache.client.setQueryData(key, 0);
    const read = vi.fn(async () => 1);
    const observer = new QueryObserver(cache.client, { queryKey: key, queryFn: () => cache.readAttention('all', read) });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch(); expect(cache.client.getQueryData(key)).toBe(1);
      const updated = conversation('c1', { activeAgentSessionStatus: 'handoff_requested' });
      cache.event(event('conversation.updated', updated));
      // The immediate delta uses the older conversation membership; the server
      // reconciliation removes its duplicate contribution without a list read.
      expect(cache.client.getQueryData(key)).toBe(2);
      cache.event(event('conversation.updated', updated));
      await vi.advanceTimersByTimeAsync(199); expect(read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2); expect(cache.client.getQueryData(key)).toBe(1);
      expect(cache.client.getQueryState(list)?.isInvalidated).toBe(false);
    } finally { unsubscribe(); }
  });
  it.each([0, 1])('retains a patched attention count when an in-flight HTTP snapshot returns %i, then reconciles without double counting', async snapshot => {
    vi.useFakeTimers(); const cache = session();
    const key = cache.key('attention', 'all');
    cache.client.setQueryData(cache.key('conversations', 'all', 'all', ''), [conversation('c1')]);
    cache.client.setQueryData(key, 0);
    let finish!: (count: number) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; })).mockResolvedValue(1);
    const observer = new QueryObserver(cache.client, { queryKey: key, queryFn: () => cache.readAttention('all', read) });
    const unsubscribe = observer.subscribe(() => {});
    try {
      const pending = observer.refetch();
      cache.event(event('conversation.updated', conversation('c1', { activeAgentSessionStatus: 'handoff_requested' })));
      expect(cache.client.getQueryData(key)).toBe(1);
      finish(snapshot); await pending;
      expect(cache.client.getQueryData(key)).toBe(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(read).toHaveBeenCalledTimes(2); expect(cache.client.getQueryData(key)).toBe(1);
    } finally { unsubscribe(); }
  });
  it('reconciles active note/tag context and invalidates inactive contexts for the same contact without rereading lists/messages', async () => {
    vi.useFakeTimers(); const cache = session(); const contactId = 'shared-contact';
    const list = cache.key('conversations', 'all', 'all', '');
    const first = conversation('c1', { contactId }); const second = conversation('c2', { contactId, channelId: 'second-channel' });
    cache.client.setQueryData(list, [first, second, conversation('c3')]);
    for (const id of ['c1', 'c2', 'c3']) {
      await cache.client.fetchQuery({ queryKey: cache.key('context', id), queryFn: () => cache.readContext(id, async () => ({ notes: [], tags: [] })) });
    }
    // Its context remains cached even after the second channel drops out of a list.
    cache.client.setQueryData(list, [first, conversation('c3')]);
    const messagesKey = cache.key('messages', 'c1'); cache.client.setQueryData(messagesKey, [message('old')]);
    const messageTime = cache.client.getQueryState(messagesKey)!.dataUpdatedAt;
    const read = vi.fn(async () => ({ notes: ['second actor note'], tags: ['second actor tag'] }));
    const observer = new QueryObserver(cache.client, { queryKey: cache.key('context', 'c1'), queryFn: () => cache.readContext('c1', read) });
    const unsubscribe = observer.subscribe(() => {});
    try {
      cache.event(event('conversation.updated', first)); cache.event(event('conversation.updated', first));
      await vi.advanceTimersByTimeAsync(200);
      expect(read).toHaveBeenCalledOnce();
      expect(cache.client.getQueryData(cache.key('context', 'c1'))).toEqual({ notes: ['second actor note'], tags: ['second actor tag'] });
      expect(cache.client.getQueryState(cache.key('context', 'c2'))?.isInvalidated).toBe(true);
      expect(cache.client.getQueryState(cache.key('context', 'c3'))?.isInvalidated).toBe(false);
      expect(cache.client.getQueryState(list)?.isInvalidated).toBe(false);
      expect(cache.client.getQueryState(messagesKey)!.dataUpdatedAt).toBe(messageTime);
    } finally { unsubscribe(); }
  });
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

describe('channel health realtime', () => {
  it('replaces the row of the same channel and keeps the others', () => {
    const cache = session(); const key = cache.key('channelHealth');
    const row = (channelId: string, state: ChannelHealthDto['state']): ChannelHealthDto => ({ channelId, state, since: null, lastInboundAt: null, attempts: 0 });
    const watchdog = { enabled: true, lastTickAt: null, lastTickOk: false, lastError: 'x', unreachable: true };
    cache.client.setQueryData(key, { health: [row('a', 'ok'), row('b', 'ok')], watchdog });
    cache.event(event('channel.health', row('a', 'needs_qr')));
    expect(cache.client.getQueryData(key)).toEqual({ health: [row('b', 'ok'), row('a', 'needs_qr')], watchdog });
  });
  it('creates the list when none is cached yet', () => {
    const cache = session(); const key = cache.key('channelHealth');
    cache.event(event('channel.health', { channelId: 'a', state: 'silent', since: null, lastInboundAt: null, attempts: 0 }));
    expect(cache.client.getQueryData<{ health: ChannelHealthDto[]; watchdog: unknown }>(key)).toEqual({
      health: [{ channelId: 'a', state: 'silent', since: null, lastInboundAt: null, attempts: 0 }],
      watchdog: { enabled: false, lastTickAt: null, lastTickOk: true, lastError: null, unreachable: false }
    });
  });
});
