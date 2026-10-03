import { QueryClient, replaceEqualDeep, type QueryKey } from '@tanstack/react-query';
import { lastMessageKind, needsHumanAttention, type ChannelDto, type ConversationDto, type InboxView, type MessageDto, type RealtimeEvent } from '@prymeira-talk/shared';
import { defaultWatchdogStatus, type ChannelHealthSnapshot } from '../channel-health-snapshot';
import { SessionBlobCache } from './blob-cache';

export const READ_STALE_MS = 15_000;
export const CATALOG_STALE_MS = 5 * 60_000;
export const HISTORY_GC_MS = 10 * 60_000;
export const MAX_HISTORIES = 30;
export const MAX_MESSAGES = 100;
type LocalMessageChange = { type: 'local.messages'; conversationId: string; rows: MessageDto[]; removedIds: Set<string> };
type FenceEvent = RealtimeEvent | LocalMessageChange;
type Fence = { events: FenceEvent[]; queryHash?: string; finish(): void };
type ReadCommit = { fence: Fence; apply(data: unknown): unknown };
type ReadOptions = { signal?: AbortSignal; manualCommit?: boolean };

export function receiptStatus(current: MessageDto['status'], incoming: MessageDto['status']) {
  const rank = { pending: 0, sent: 1, delivered: 2, read: 3, failed: -1 };
  // Receipts can arrive late and HTTP can already contain a newer receipt.
  if (rank[current] >= 1 && rank[incoming] < rank[current]) return current;
  return incoming;
}

export function patchMessages(messages: MessageDto[], event: RealtimeEvent, conversationId: string): MessageDto[] {
  if (event.type === 'message.deleted') return event.payload.conversationId === conversationId && messages.some(message => message.id === event.payload.messageId)
    ? messages.filter(message => message.id !== event.payload.messageId) : messages;
  if (event.type === 'message.status_changed') {
    const index = messages.findIndex(message => message.id === event.payload.messageId);
    if (index < 0) return messages;
    const status = receiptStatus(messages[index].status, event.payload.status);
    if (status === messages[index].status) return messages;
    const next = [...messages]; next[index] = { ...messages[index], status }; return next;
  }
  if (event.type !== 'message.created' && event.type !== 'message.updated') return messages;
  if (event.payload.conversationId !== conversationId) return messages;
  const index = messages.findIndex(message => message.id === event.payload.id ||
    Boolean(event.payload.providerMessageId && message.providerMessageId === event.payload.providerMessageId) ||
    (message.id.startsWith('optimistic-') && message.status === 'pending' && message.direction === event.payload.direction && message.type === event.payload.type && message.body === event.payload.body));
  if (index < 0) return event.type === 'message.created' ? [...messages, event.payload].slice(-MAX_MESSAGES) : messages;
  const next = [...messages]; next[index] = { ...event.payload, status: receiptStatus(messages[index].status, event.payload.status) }; return next;
}

export type InboxListScope = { view?: InboxView; channelId?: string; search?: string; status?: 'active' | 'closed' | 'all'; assignedUserId?: string };
/** Private-review channel mode/assistant state are intentionally absent from DTOs.
 * Only those unresolved memberships need a server reconciliation. */
export function conversationMatches(row: ConversationDto, scope: InboxListScope): boolean | 'unknown' {
  if (scope.channelId && row.channelId !== scope.channelId) return false;
  if (scope.assignedUserId && row.assignedUserId !== scope.assignedUserId) return false;
  if (scope.status === 'closed' && row.status !== 'closed') return false;
  if (scope.status === 'active' && row.status === 'closed') return false;
  if (!scope.search && row.hiddenUntilReply) return false;
  if (scope.search) {
    const search = scope.search.trim();
    let digits = search.replace(/\D/g, '');
    if (digits.startsWith('55') && digits.length === 13 && digits[4] === '9') digits = digits.slice(0, 4) + digits.slice(5);
    if (!(row.contactName ?? '').toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
      !(row.contactPhone ?? '').includes(digits || search)) return false;
  }
  if (scope.view === 'marked') return Boolean(row.manualMarked);
  if (scope.view === 'handoff') return needsHumanAttention(row);
  if (scope.view === 'unread') {
    if (!row.unreadCount) return false;
    return row.aiControlStatus === 'human_controlled' || needsHumanAttention(row) ? true : 'unknown';
  }
  if (scope.view === 'reply') {
    if (row.status === 'closed') return false;
    if (needsHumanAttention(row)) return true;
    if (row.aiControlStatus === 'human_controlled' && !row.replyDismissed && row.replyTriageAnchorMessageId &&
      ['needs_reply', 'uncertain'].includes(row.replyTriageDecision ?? '')) return true;
    return 'unknown';
  }
  return true;
}
function sortRows(rows: ConversationDto[]) {
  return rows.sort((left, right) => (Date.parse(right.lastMessageAt ?? '') || 0) - (Date.parse(left.lastMessageAt ?? '') || 0));
}
export function patchConversations(rows: ConversationDto[], event: RealtimeEvent, scope: InboxListScope = {}): ConversationDto[] {
  if (event.type === 'contact.updated') {
    if (!rows.some(row => row.contactId === event.payload.id)) return rows;
    return rows.flatMap(row => {
    if (row.contactId !== event.payload.id) return [row];
    const updated = { ...row, contactName: event.payload.name, contactPhone: event.payload.phone };
    return conversationMatches(updated, scope) === false ? [] : [updated];
    });
  }
  // The card's ticks follow the conversation's newest message; a late (recovered) older one does not replace it.
  if (event.type === 'message.created' || event.type === 'message.updated') {
    const message = event.payload;
    let changed = false;
    const next = rows.map(row => {
      if (row.id !== message.conversationId) return row;
      const current = row.lastMessage;
      if (current && current.id !== message.id && Date.parse(message.createdAt) < Date.parse(current.createdAt)) return row;
      if (current?.id === message.id && current.status === message.status && current.direction === message.direction) return row;
      changed = true;
      return { ...row, lastMessage: { id: message.id, direction: message.direction, status: message.status, createdAt: message.createdAt,
        kind: lastMessageKind({ type: message.type, body: message.body, mimeType: message.attachment?.mimeType, mediaUrl: message.mediaUrl }) } };
    });
    return changed ? next : rows;
  }
  if (event.type === 'message.status_changed') {
    const { messageId, status } = event.payload;
    if (!rows.some(row => row.lastMessage?.id === messageId && row.lastMessage.status !== status)) return rows;
    return rows.map(row => row.lastMessage?.id === messageId ? { ...row, lastMessage: { ...row.lastMessage, status } } : row);
  }
  if (event.type !== 'conversation.updated') return rows;
  const previousRow = rows.find(row => row.id === event.payload.id);
  // Most writers publish the conversation without its last message; keep the one the card already knows.
  const payload = event.payload.lastMessage === undefined && previousRow?.lastMessage !== undefined
    ? { ...event.payload, lastMessage: previousRow.lastMessage } : event.payload;
  const membership = conversationMatches(payload, scope);
  if (membership === false) return previousRow ? rows.filter(row => row.id !== payload.id) : rows;
  if (membership === 'unknown' && !previousRow) return rows;
  return sortRows([...rows.filter(row => row.id !== payload.id), payload]);
}
function scopeFromKey(key: QueryKey): InboxListScope {
  return { view: key[3] as InboxView, channelId: key[4] === 'all' ? undefined : key[4] as string, search: key[5] as string, status: 'all' };
}

export class TalkSession {
  readonly client = new QueryClient({ defaultOptions: {
    queries: { staleTime: READ_STALE_MS, gcTime: HISTORY_GC_MS, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true,
      structuralSharing: (previous, incoming) => this.commitRead(previous, incoming) },
    mutations: { retry: false }
  } });
  readonly blobs = new SessionBlobCache();
  private ui = new Map<string, unknown>();
  private listeners = new Map<string, Set<() => void>>();
  private fences = new Set<Fence>();
  private readCommits = new WeakMap<object, ReadCommit>();
  private unsubscribeCache: () => void;
  private attentionReads = new Set<{ channel: string; dirty: boolean }>();
  private contextContacts = new Map<string, string>();
  private histories = new Map<string, number>();
  private active: string | null = null;
  private prefetching = 0;
  private prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingInvalidations = new Set<string>();
  private maxInvalidationTimer: ReturnType<typeof setTimeout> | undefined;
  private invalidationTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(readonly scope: string, readonly workspaceId: string) {
    this.unsubscribeCache = this.client.getQueryCache().subscribe(event => {
      if (event.type === 'removed' || event.type === 'updated' &&
        (event.action.type === 'error' || event.action.type === 'setState' && event.query.state.fetchStatus === 'idle')) {
        for (const fence of this.fences) if (fence.queryHash === event.query.queryHash) fence.finish();
      }
    });
  }
  get isLive() { return !this.disposed; }
  key(kind: string, ...parts: unknown[]): QueryKey { return ['talk', this.scope, kind, ...parts]; }
  readUI<T>(key: string, fallback: T): T { return this.ui.has(key) ? this.ui.get(key) as T : fallback; }
  writeUI<T>(key: string, value: T | ((current: T) => T), fallback: T) {
    if (this.disposed) return;
    const next = typeof value === 'function' ? (value as (current: T) => T)(this.readUI(key, fallback)) : value;
    if (Object.is(this.readUI(key, fallback), next)) return;
    this.ui.set(key, next); for (const listener of this.listeners.get(key) ?? []) listener();
  }
  subscribeUI(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set(); this.listeners.set(key, listeners); listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  setActive(id: string | null) { this.active = id; if (id) this.touch(id); }
  touch(id: string) {
    this.histories.delete(id); this.histories.set(id, Date.now());
    this.trim();
  }
  private trim() {
    while (this.histories.size > MAX_HISTORIES) {
      const candidate = [...this.histories.keys()].find(id => id !== this.active);
      if (!candidate) break;
      this.histories.delete(candidate);
      this.client.removeQueries({ queryKey: this.key('messages', candidate), exact: true });
      this.client.removeQueries({ queryKey: this.key('context', candidate), exact: true });
      this.contextContacts.delete(candidate);
      // Drafts and scroll positions live in UI memory and survive history eviction.
    }
  }
  async readMessages(id: string, read: () => Promise<MessageDto[]>, signal?: AbortSignal) {
    this.touch(id);
    return this.withEvents(this.key('messages', id), read, (messages, event) => {
      if (event.type !== 'local.messages') return patchMessages(messages, event, id);
      if (event.conversationId !== id) return messages;
      const rows = messages.filter(message => !event.removedIds.has(message.id));
      // Local IDs identify distinct manual sends, including identical content.
      // Content matching belongs only to acknowledgements from the server.
      for (const row of event.rows) {
        const index = rows.findIndex(message => message.id === row.id);
        if (index < 0) rows.push(row);
        else rows[index] = { ...row, status: receiptStatus(rows[index].status, row.status) };
      }
      return rows.slice(-MAX_MESSAGES);
    }, messages => messages.slice(-MAX_MESSAGES), { signal });
  }
  /** Use the source query directly: an observer may have changed targets by the
   * time its refetch resolves. TanStack also resolves canceled reads with cached
   * data, so only an unaborted source read can confirm an explicit recovery. */
  async refetchMessages(id: string, read: (signal: AbortSignal) => Promise<MessageDto[]>) {
    const query = this.client.getQueryCache().find({ queryKey: this.key('messages', id), exact: true });
    if (!query || this.disposed) throw new DOMException('Conversa indisponível.', 'AbortError');
    const request: { signal?: AbortSignal } = {};
    await query.fetch({ ...query.options, queryFn: ({ signal }) => {
      request.signal = signal;
      return this.readMessages(id, () => read(signal), signal);
    } }, { cancelRefetch: true });
    if (!request.signal || this.disposed) throw new DOMException('Leitura cancelada.', 'AbortError');
    request.signal.throwIfAborted();
  }
  /** Replay only local changes made after each read began. An explicit later
   * reconciliation can discard earlier failed optimistic messages normally. */
  updateMessages(id: string, update: (messages: MessageDto[]) => MessageDto[]) {
    if (this.disposed) return;
    const key = this.key('messages', id); const previous = this.client.getQueryData<MessageDto[]>(key) ?? [];
    const next = update(previous).slice(-MAX_MESSAGES);
    const before = new Map(previous.map(row => [row.id, row])); const ids = new Set(next.map(row => row.id));
    const rows = next.filter(row => before.get(row.id) !== row);
    const removedIds = new Set(previous.filter(row => !ids.has(row.id)).map(row => row.id));
    if (!rows.length && !removedIds.size) return;
    this.touch(id);
    for (const fence of this.fences) fence.events.push({ type: 'local.messages', conversationId: id, rows, removedIds });
    this.client.setQueryData(key, next);
  }
  readConversations(read: () => Promise<ConversationDto[]>, scope: InboxListScope = {}, options: ReadOptions = {}) {
    const key = this.key('conversations', scope.view ?? 'all', scope.channelId ?? 'all', scope.search ?? '');
    return this.withEvents(key, read, (rows, event) => event.type === 'local.messages' ? rows : patchConversations(rows, event, scope), undefined, options);
  }
  commitConversationPage(key: QueryKey, page: ConversationDto[], merge: (current: ConversationDto[], page: ConversationDto[]) => ConversationDto[]) {
    if (this.disposed) return;
    const rows = merge(this.client.getQueryData<ConversationDto[]>(key) ?? [], page);
    const read = this.readCommits.get(page);
    if (read) this.readCommits.set(rows, read);
    this.client.setQueryData(key, rows);
  }
  readContext<T>(id: string, read: () => Promise<T>, contactId = this.findConversation(id)?.contactId) {
    if (contactId) this.contextContacts.set(id, contactId);
    return read();
  }
  async readAttention(channel: string, read: () => Promise<number>) {
    const fence = { channel, dirty: false }; this.attentionReads.add(fence);
    const key = this.key('attention', channel);
    try {
      const count = await read();
      if (this.disposed) throw new DOMException('Sessão encerrada.', 'AbortError');
      if (!fence.dirty) return count;
      const query = this.client.getQueryCache().find({ queryKey: key, exact: true });
      if (query) this.scheduleInvalidation(query.queryHash);
      // The HTTP snapshot may already include the frame. Never replay a delta
      // over it: keep the patched count, then reconcile once this read settles.
      return this.client.getQueryData<number>(key) ?? count;
    } finally { this.attentionReads.delete(fence); }
  }
  private async withEvents<T extends object>(key: QueryKey, read: () => Promise<T>, patch: (data: T, event: FenceEvent) => T,
    normalize = (data: T) => data, options: ReadOptions = {}): Promise<T> {
    const query = this.client.getQueryCache().find({ queryKey: key, exact: true });
    const awaitsCommit = options.manualCommit || query?.state.fetchStatus === 'fetching';
    const fence: Fence = { events: [], queryHash: options.manualCommit ? undefined : query?.queryHash, finish: () => {
      this.fences.delete(fence); options.signal?.removeEventListener('abort', fence.finish);
    } };
    this.fences.add(fence); options.signal?.addEventListener('abort', fence.finish, { once: true });
    let handedToCache = false;
    try {
      options.signal?.throwIfAborted();
      let result = normalize(await read());
      for (const event of fence.events) result = patch(result, event);
      options.signal?.throwIfAborted();
      if (this.disposed) throw new DOMException('Sessão encerrada.', 'AbortError');
      if (awaitsCommit && this.fences.has(fence)) {
        const replayed = fence.events.length;
        this.readCommits.set(result, { fence, apply: incoming => {
          options.signal?.throwIfAborted();
          if (this.disposed) throw new DOMException('Sessão encerrada.', 'AbortError');
          let latest = incoming as T;
          // The async query adapter has more promise continuations before its
          // cache write. Replay only the events after the first replay, in order.
          for (const event of fence.events.slice(replayed)) latest = patch(latest, event);
          return latest;
        } });
        handedToCache = true;
      }
      return result;
    } finally { if (!handedToCache) fence.finish(); }
  }
  private commitRead(previous: unknown, incoming: unknown) {
    const read = incoming && typeof incoming === 'object' ? this.readCommits.get(incoming) : undefined;
    if (!read) return replaceEqualDeep(previous, incoming);
    this.readCommits.delete(incoming as object);
    try { return replaceEqualDeep(previous, read.apply(incoming)); }
    finally { read.fence.finish(); }
  }
  private findConversation(id: string) {
    for (const query of this.client.getQueryCache().findAll({ queryKey: this.key('conversations') })) {
      const row = (query.state.data as ConversationDto[] | undefined)?.find(row => row.id === id);
      if (row) return row;
    }
    const selected = this.readUI<ConversationDto | null>('selectedSnapshot', null);
    return selected?.id === id ? selected : undefined;
  }
  private invalidateContext(contactId: string | null, conversationId?: string) {
    for (const query of this.client.getQueryCache().findAll({ queryKey: this.key('context') })) {
      const id = String(query.queryKey[3]);
      const knownContact = this.contextContacts.get(id) ?? this.findConversation(id)?.contactId;
      if (id === conversationId || contactId && knownContact === contactId) this.scheduleInvalidation(query.queryHash);
    }
  }
  event(event: RealtimeEvent) {
    if (event.workspaceId !== this.workspaceId || this.disposed) return;
    for (const fence of this.fences) fence.events.push(event);
    const previous = event.type === 'conversation.updated' ? this.findConversation(event.payload.id) : undefined;
    for (const query of this.client.getQueryCache().findAll({ queryKey: this.key('messages') })) {
      const id = query.queryKey[3];
      const rows = query.state.data as MessageDto[] | undefined;
      if (typeof id === 'string' && rows) {
        const next = patchMessages(rows, event, id);
        if (next !== rows) this.client.setQueryData(query.queryKey, next);
      }
    }
    for (const query of this.client.getQueryCache().findAll({ queryKey: this.key('conversations') })) {
      const scope = scopeFromKey(query.queryKey);
      const rows = query.state.data as ConversationDto[] | undefined;
      if (rows) {
        const next = patchConversations(rows, event, scope);
        if (next !== rows) this.client.setQueryData(query.queryKey, next);
      }
      if (event.type === 'conversation.updated' && conversationMatches(event.payload, scope) === 'unknown' ||
        event.type === 'contact.updated' && scope.search) this.scheduleInvalidation(query.queryHash);
    }
    if (event.type === 'conversation.updated') {
      const next = event.payload;
      // Counts can be patched only when a previous membership is known.
      for (const query of this.client.getQueryCache().findAll({ queryKey: this.key('attention') })) {
        const channel = query.queryKey[3];
        const matches = (row: ConversationDto) => channel === 'all' || !channel || row.channelId === channel;
        const dirtyRead = () => { for (const fence of this.attentionReads) if (fence.channel === channel) fence.dirty = true; };
        // A list response can already include this event while a count response
        // still predates it; a zero DTO delta does not make the count snapshot safe.
        if (matches(next) || previous && matches(previous)) dirtyRead();
        if (!previous) { if (matches(next)) { dirtyRead(); this.scheduleInvalidation(query.queryHash); } continue; }
        const delta = Number(matches(next) && needsHumanAttention(next)) - Number(matches(previous) && needsHumanAttention(previous));
        if (delta) {
          dirtyRead();
          this.client.setQueryData<number>(query.queryKey, count => count === undefined ? count : Math.max(0, count + delta));
          // A completed count read can already include this frame while the
          // conversation DTO is older. Reconcile every delta to settle that ambiguity.
          this.scheduleInvalidation(query.queryHash);
        }
      }
      // Notes are contact-scoped while tags are conversation-scoped. Their
      // writes publish conversation.updated, so reconcile both affected scopes.
      this.invalidateContext(next.contactId, next.id);
      const selected = this.readUI<ConversationDto | null>('selectedSnapshot', null);
      if (selected?.id === next.id) this.writeUI('selectedSnapshot', next, null);
    }
    if (event.type === 'contact.updated' || event.type.startsWith('board_membership.')) {
      const contactId = event.type === 'contact.updated' ? event.payload.id
        : 'contactId' in event.payload ? event.payload.contactId : null;
      const selected = this.readUI<ConversationDto | null>('selectedSnapshot', null);
      if (event.type === 'contact.updated' && selected?.contactId === contactId) {
        this.writeUI('selectedSnapshot', { ...selected, contactName: event.payload.name, contactPhone: event.payload.phone }, null);
      }
      this.invalidateContext(contactId);
    }
    if (event.type === 'channel.health') {
      this.client.setQueryData<ChannelHealthSnapshot>(this.key('channelHealth'), snapshot => ({
        health: [...(snapshot?.health ?? []).filter(row => row.channelId !== event.payload.channelId), event.payload],
        watchdog: snapshot?.watchdog ?? defaultWatchdogStatus
      }));
    }
    if (event.type === 'channel.updated' || event.type === 'channel.deleted') {
      this.client.setQueryData<ChannelDto[]>(this.key('channels'), rows => rows ? event.type === 'channel.deleted'
        ? rows.filter(row => row.id !== event.payload.channelId)
        : [...rows.filter(row => row.id !== event.payload.id), event.payload] : rows);
      // Channel private-review settings are unavailable in conversation DTOs.
      for (const query of this.client.getQueryCache().findAll({ queryKey: this.key('conversations') })) {
        const scope = scopeFromKey(query.queryKey);
        if (scope.view === 'unread' || scope.view === 'reply') this.scheduleInvalidation(query.queryHash);
      }
    }
  }
  private scheduleInvalidation(hash: string) {
    this.pendingInvalidations.add(hash);
    clearTimeout(this.invalidationTimer);
    this.invalidationTimer = setTimeout(() => this.flushInvalidations(), 200);
    if (!this.maxInvalidationTimer) this.maxInvalidationTimer = setTimeout(() => this.flushInvalidations(), 1_000);
  }
  private flushInvalidations() {
    clearTimeout(this.invalidationTimer); clearTimeout(this.maxInvalidationTimer);
    this.invalidationTimer = undefined; this.maxInvalidationTimer = undefined;
    if (this.disposed) return;
    const pending = new Set(this.pendingInvalidations); this.pendingInvalidations.clear();
    // An invalidation during HTTP may be overwritten by its stale response. Keep
    // that reconciliation queued until the existing read has settled.
    for (const query of this.client.getQueryCache().getAll()) {
      if (pending.has(query.queryHash) && query.state.fetchStatus === 'fetching') {
        pending.delete(query.queryHash); this.scheduleInvalidation(query.queryHash);
      }
    }
    void this.client.invalidateQueries({ predicate: query => pending.has(query.queryHash) }, { cancelRefetch: false });
  }
  reconcile() {
    if (this.disposed) return;
    void this.client.invalidateQueries({ queryKey: this.key('conversations'), refetchType: 'active' });
    if (this.active) void this.client.invalidateQueries({ queryKey: this.key('messages', this.active) });
    void this.client.invalidateQueries({ queryKey: this.key('context'), refetchType: 'active' });
    void this.client.invalidateQueries({ queryKey: this.key('attention'), refetchType: 'active' });
  }
  prefetch(id: string, read: (signal: AbortSignal) => Promise<MessageDto[]>) {
    if (this.prefetchTimers.has(id) || id === this.active) return;
    this.prefetchTimers.set(id, setTimeout(() => {
      this.prefetchTimers.delete(id);
      if (this.disposed || this.prefetching >= 2 || id === this.active) return;
      this.prefetching++;
      void this.client.prefetchQuery({ queryKey: this.key('messages', id), queryFn: ({ signal }) => this.readMessages(id, () => read(signal), signal) })
        .finally(() => { this.prefetching--; this.trim(); });
    }, 150));
  }
  cancelPrefetch(id: string) { clearTimeout(this.prefetchTimers.get(id)); this.prefetchTimers.delete(id); }
  clear() {
    this.disposed = true; clearTimeout(this.invalidationTimer); clearTimeout(this.maxInvalidationTimer); this.pendingInvalidations.clear();
    for (const timer of this.prefetchTimers.values()) clearTimeout(timer);
    this.prefetchTimers.clear(); void this.client.cancelQueries(); this.client.clear(); this.blobs.clear();
    for (const fence of this.fences) fence.finish();
    this.readCommits = new WeakMap(); this.unsubscribeCache();
    this.ui.clear(); this.histories.clear(); this.fences.clear(); this.attentionReads.clear(); this.contextContacts.clear(); this.listeners.clear();
  }
}
