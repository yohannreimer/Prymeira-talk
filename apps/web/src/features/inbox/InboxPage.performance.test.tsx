// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDto, MessageDto } from '@prymeira-talk/shared';
import { InboxPage } from './InboxPage';
import { TalkSessionContext } from '../../app/session/TalkSessionProvider';
import { TalkSession } from '../../app/session/talk-session';
import { RealtimeConnection } from './realtime-connection';
import { apiCreateConversationMessage, apiGetConversationMessages, apiGetConversations, apiGetAssistantConversation, apiGetConversationContext, apiMarkConversationRead } from '../../app/api';

const renders = vi.hoisted(() => ({ media: vi.fn(), assistant: vi.fn(), avatar: vi.fn() }));
vi.mock('./InboxMedia', () => ({ InboxMedia: ({ message }: { message: MessageDto }) => { renders.media(); return <span>{message.body}</span>; }, mediaCaption: () => null }));
vi.mock('./ContactAvatar', () => ({ ContactAvatar: () => { renders.avatar(); return <span />; }, ContactPhotoProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./AssistantPanel', () => ({ AssistantPanel: () => { renders.assistant(); return <span>Assistente</span>; } }));
vi.mock('./VoiceRecorder', () => ({ VoiceRecorder: () => null }));
vi.mock('./RichDraft', () => ({ RichDraft: forwardRef(function MockDraft(props: { value: string; onChange(value: string): void }, ref) {
  useImperativeHandle(ref, () => ({ focus() {}, format() {}, insertText(text: string) { props.onChange(props.value + text); } }));
  return <input aria-label="Mensagem" value={props.value} onChange={event => props.onChange(event.target.value)} />;
}) }));
vi.mock('../../app/api', async importOriginal => ({ ...await importOriginal<typeof import('../../app/api')>(),
  apiGetConversationMessages: vi.fn(), apiGetConversations: vi.fn(), apiGetConversationContext: vi.fn(),
  apiGetChannels: vi.fn(async () => []), apiGetTags: vi.fn(async () => []), apiGetAttentionCount: vi.fn(async () => 0),
  apiGetAssistantConversation: vi.fn(async () => ({ settings: { mode: 'disabled', agentId: null }, status: 'paused', history: [], suggestion: null, currentContextKey: null, humanControlled: true, humanSupport: false, awaitingCustomer: false, agentName: null, error: null })),
  apiMarkConversationRead: vi.fn(), apiCreateConversationMessage: vi.fn()
}));

const conversation = (id: string): ConversationDto => ({ id, workspaceId: 'w', channelId: 'channel', contactId: `contact-${id}`, contactName: id, status: 'open', assignedUserId: null, departmentId: null, lastMessageAt: null, lastMessagePreview: null, unreadCount: 0, priority: 'normal' });
const message = (id: string): MessageDto => ({ id: `m-${id}`, conversationId: id, workspaceId: 'w', providerMessageId: null, direction: 'inbound', type: 'image', body: `history-${id}`, mediaUrl: 'data:image/png;base64,YQ==', status: 'read', sentByUserId: null, createdAt: '2026-09-30T00:00:00Z' });

describe('Atendimento query/UI integration', () => {
  let container: HTMLDivElement; let root: ReturnType<typeof createRoot>; let session: TalkSession;
  const token = async () => 'token';
  const render = async (visible = true) => {
    await act(async () => {
      root.render(<TalkSessionContext.Provider value={{ session, realtime: new RealtimeConnection(), currentUser: { workspaceId: 'w', role: 'agent' }, getToken: token }}><QueryClientProvider client={session.client}>{visible ? <InboxPage /> : <p>Outro módulo</p>}</QueryClientProvider></TalkSessionContext.Provider>);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();
  };
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };
  const select = async (id: string) => {
    await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label^="Abrir conversa com ${id}"]`)!.click(); }); await flush();
  };
  const type = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Mensagem"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }); await flush();
  };
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true });
    session = new TalkSession('user:session:w', 'w');
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    window.history.replaceState(null, '', '/?module=atendimento');
    vi.mocked(apiGetConversations).mockResolvedValue([conversation('c1'), conversation('c2'), conversation('c3')]);
    vi.mocked(apiGetConversationMessages).mockImplementation(async id => [message(id)]);
    vi.mocked(apiGetConversationContext).mockResolvedValue({ tags: [], notes: [], departments: [], boardStages: [], primaryBoardStage: null });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); session.clear(); vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks(); });

  it('restores drafts/selection on module return and shows a repeated target synchronously without a read', async () => {
    await render(); expect(container.textContent).toContain('history-c1'); await type('rascunho c1');
    await select('c2'); expect(container.querySelector<HTMLInputElement>('[aria-label="Mensagem"]')!.value).toBe('');
    await type('rascunho c2'); await select('c1');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Mensagem"]')!.value).toBe('rascunho c1');
    expect(apiGetConversationMessages).toHaveBeenCalledTimes(2);
    await render(false); await render();
    expect(container.textContent).toContain('history-c1');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Mensagem"]')!.value).toBe('rascunho c1');
    expect(apiGetConversationMessages).toHaveBeenCalledTimes(2);
    expect(apiGetAssistantConversation).toHaveBeenCalledTimes(2);
  });
  it('typing after the first character does not rerender media, avatars/list or sidebar', async () => {
    await render(); await type('a');
    const counts = [renders.media.mock.calls.length, renders.avatar.mock.calls.length, renders.assistant.mock.calls.length];
    await type('abc'); await type('abcdef');
    expect([renders.media.mock.calls.length, renders.avatar.mock.calls.length, renders.assistant.mock.calls.length]).toEqual(counts);
    expect(session.readUI('draft:c1', '')).toBe('abcdef');
  });
  it('aborts replaced histories and cannot paint a late response in another conversation', async () => {
    await render(); let release!: (rows: MessageDto[]) => void; let signal!: AbortSignal;
    vi.mocked(apiGetConversationMessages).mockImplementation((id, _token, inputSignal) => {
      if (id === 'c2') { signal = inputSignal!; return new Promise(resolve => { release = resolve; }); }
      return Promise.resolve([message(id)]);
    });
    await select('c2'); await select('c3'); expect(signal.aborted).toBe(true);
    await act(async () => release([message('c2')])); await flush();
    expect(container.querySelector('.message-thread')?.textContent).toContain('history-c3');
    expect(container.querySelector('.message-thread')?.textContent).not.toContain('history-c2');
  });
  it('retains history on focus/refetch failure with local retry recovery', async () => {
    await render(); vi.mocked(apiGetConversationMessages).mockRejectedValue(new Error('rede indisponível'));
    await act(async () => session.reconcile()); await flush();
    expect(container.querySelector('.message-thread')?.textContent).toContain('history-c1');
    expect(container.querySelector('.message-thread')?.textContent).toContain('rede indisponível');
    vi.mocked(apiGetConversationMessages).mockResolvedValue([{ ...message('c1'), body: 'recuperado' }]);
    await act(async () => container.querySelector<HTMLButtonElement>('.message-thread .error-note button')!.click()); await flush();
    expect(container.querySelector('.message-thread')?.textContent).toContain('recuperado');
    expect(container.textContent).not.toContain('rede indisponível');
  });
  it('shows a second actor note/tag after conversation.updated while keeping list/history reads independent', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('.assistant-tabs button')!.click()); await flush();
    const lists = vi.mocked(apiGetConversations).mock.calls.length; const histories = vi.mocked(apiGetConversationMessages).mock.calls.length;
    vi.mocked(apiGetConversationContext).mockResolvedValue({ tags: [{ id: 'new-tag', name: 'Atualizada por outro agente', color: '#123456' }],
      notes: [{ id: 'new-note', body: 'Nota adicionada por outro agente', createdAt: '2026-09-30T00:00:00Z', createdByName: 'Outro agente' }],
      departments: [], boardStages: [], primaryBoardStage: null });
    // Notes are shared by the contact, including another WhatsApp channel.
    await act(async () => session.event({ type: 'conversation.updated', workspaceId: 'w', payload: { ...conversation('other-channel'), contactId: 'contact-c1' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); }); await flush();
    expect(container.textContent).toContain('Nota adicionada por outro agente');
    expect(container.textContent).toContain('Atualizada por outro agente');
    expect(apiGetConversationContext).toHaveBeenCalledTimes(2);
    expect(apiGetConversations).toHaveBeenCalledTimes(lists); expect(apiGetConversationMessages).toHaveBeenCalledTimes(histories);
  });
  it('prefetch only fetches messages and never marks read or invokes assistant processing', async () => {
    await render(); const assistantCalls = vi.mocked(apiGetAssistantConversation).mock.calls.length;
    const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Abrir conversa com c2"]')!;
    await act(async () => { button.focus(); await vi.advanceTimersByTimeAsync(150); }); await flush();
    expect(apiGetConversationMessages).toHaveBeenCalledTimes(2);
    expect(apiGetAssistantConversation).toHaveBeenCalledTimes(assistantCalls);
    expect(apiMarkConversationRead).not.toHaveBeenCalled();
    await select('c2'); expect(apiGetConversationMessages).toHaveBeenCalledTimes(2);
  });
  it('enables numeric-only diagnostics explicitly and excludes canceled targets', async () => {
    window.history.replaceState(null, '', '/?module=atendimento&talkPerf=1');
    await render(); expect(container.querySelector('[aria-label="Diagnóstico de desempenho"]')).not.toBeNull();
    await select('c2'); await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    const panel = container.querySelector('[aria-label="Diagnóstico de desempenho"]')!;
    expect(panel.textContent).toContain('1 aberturas'); expect(panel.textContent).not.toContain('history-c2');
    expect(panel.textContent).not.toContain('token'); expect(panel.textContent).not.toContain('contact-c2');
    let release!: (rows: MessageDto[]) => void;
    vi.mocked(apiGetConversationMessages).mockImplementation(id => id === 'c3' ? new Promise(resolve => { release = resolve; }) : Promise.resolve([message(id)]));
    await select('c3'); await select('c1'); await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    await act(async () => release([message('c3')])); await flush();
    expect(panel.textContent).toContain('2 aberturas'); expect(panel.textContent).toContain('1 canceladas');
  });
  it('retains a file draft across module navigation while disposing/recreating its preview URL', async () => {
    const create = vi.fn().mockReturnValueOnce('blob:first-preview').mockReturnValueOnce('blob:second-preview');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    await render(); const file = new File(['image'], 'draft.png', { type: 'image/png' });
    const input = container.querySelector<HTMLInputElement>('.composer-file-input')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
    expect(session.readUI('draftFile:c1', null)).toBe(file);
    expect(container.querySelector<HTMLImageElement>('.composer-attachment-preview img')?.src).toBe('blob:first-preview');
    await render(false); expect(revoke).toHaveBeenCalledWith('blob:first-preview');
    await render(); expect(session.readUI('draftFile:c1', null)).toBe(file);
    expect(container.querySelector<HTMLImageElement>('.composer-attachment-preview img')?.src).toBe('blob:second-preview');
  });
  it('restores a tall history after switching to a short one and preserves list position on module return', async () => {
    await render(); const list = container.querySelector<HTMLDivElement>('.conversation-items')!;
    list.scrollTop = 500; await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    const thread = container.querySelector<HTMLDivElement>('.message-thread')!;
    thread.scrollTop = 450; await act(async () => thread.dispatchEvent(new Event('scroll', { bubbles: true })));
    await select('c2'); thread.scrollTop = 0; await act(async () => thread.dispatchEvent(new Event('scroll', { bubbles: true })));
    await select('c1'); expect(container.querySelector<HTMLDivElement>('.message-thread')?.scrollTop).toBe(450);
    await render(false); await render();
    expect(container.querySelector<HTMLDivElement>('.conversation-items')?.scrollTop).toBe(500);
    expect(container.querySelector<HTMLDivElement>('.message-thread')?.scrollTop).toBe(450);
  });
  it('does not reinsert an unmarked conversation from an older paginated HTTP response', async () => {
    session.writeUI('view', 'marked', 'all');
    const first = Array.from({ length: 50 }, (_, index) => ({ ...conversation(`c${index + 1}`), manualMarked: true }));
    let finish!: (rows: ConversationDto[]) => void;
    vi.mocked(apiGetConversations).mockImplementation(async (_token, filters) => filters?.cursor
      ? new Promise(resolve => { finish = resolve; }) : first);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('.conversation-load-more')!.click());
    await act(async () => session.event({ type: 'conversation.updated', workspaceId: 'w', payload: { ...conversation('older'), manualMarked: false } }));
    await act(async () => finish([{ ...conversation('older'), manualMarked: true }])); await flush();
    expect(container.querySelector('button[aria-label^="Abrir conversa com older"]')).toBeNull();
  });
  it('keeps the raw full-page cursor when realtime removes a row from that page', async () => {
    session.writeUI('view', 'marked', 'all');
    const first = Array.from({ length: 50 }, (_, index) => ({ ...conversation(`c${index + 1}`), manualMarked: true }));
    const second = Array.from({ length: 50 }, (_, index) => ({ ...conversation(`c${index + 51}`), manualMarked: true }));
    let finish!: (rows: ConversationDto[]) => void;
    vi.mocked(apiGetConversations).mockImplementation(async (_token, filters) => {
      if (!filters?.cursor) return first;
      if (filters.cursor === 'c50') return new Promise(resolve => { finish = resolve; });
      return [{ ...conversation('c101'), manualMarked: true }];
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('.conversation-load-more')!.click());
    await act(async () => session.event({ type: 'conversation.updated', workspaceId: 'w', payload: { ...conversation('c100'), manualMarked: false } }));
    await act(async () => finish(second)); await flush();
    expect(container.querySelector('button[aria-label^="Abrir conversa com c100"]')).toBeNull();
    expect(container.querySelector('.conversation-load-more')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.conversation-load-more')!.click()); await flush();
    expect(vi.mocked(apiGetConversations).mock.calls.at(-1)?.[1]?.cursor).toBe('c100');
    expect(container.querySelector('button[aria-label^="Abrir conversa com c101"]')).not.toBeNull();
  });
  it('revalidates the loaded list extent and preserves its scroll on a stale module return', async () => {
    const first = Array.from({ length: 50 }, (_, index) => conversation(`c${index + 1}`));
    const second = Array.from({ length: 50 }, (_, index) => conversation(`c${index + 51}`));
    vi.mocked(apiGetConversations).mockImplementation(async (_token, filters) => !filters?.cursor ? first : filters.cursor === 'c50' ? second : [conversation('c101')]);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('.conversation-load-more')!.click()); await flush();
    const list = container.querySelector<HTMLDivElement>('.conversation-items')!;
    Object.defineProperty(list, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
    list.scrollTop = 1200; await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    await render(false); await act(async () => { await vi.advanceTimersByTimeAsync(16_000); }); await render();
    expect(container.querySelector('button[aria-label^="Abrir conversa com c100"]')).not.toBeNull();
    expect(container.querySelector<HTMLDivElement>('.conversation-items')?.scrollTop).toBe(1200);
    expect(vi.mocked(apiGetConversations).mock.calls.map(call => call[1]?.cursor)).toEqual([undefined, 'c50', undefined, 'c50']);
    await act(async () => container.querySelector<HTMLButtonElement>('.conversation-load-more')!.click()); await flush();
    expect(vi.mocked(apiGetConversations).mock.calls.at(-1)?.[1]?.cursor).toBe('c100');
  });
  it('serializes an in-flight page with reconciliation and blocks pagination during a delayed refresh', async () => {
    const first = Array.from({ length: 50 }, (_, index) => conversation(`c${index + 1}`));
    const second = Array.from({ length: 50 }, (_, index) => conversation(`c${index + 51}`));
    let finishPage!: (rows: ConversationDto[]) => void;
    vi.mocked(apiGetConversations).mockImplementation(async (_token, filters) => filters?.cursor ? new Promise(resolve => { finishPage = resolve; }) : first);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('.conversation-load-more')!.click());
    await act(async () => session.reconcile()); await flush();
    expect(apiGetConversations).toHaveBeenCalledTimes(2);
    vi.mocked(apiGetConversations).mockImplementation(async (_token, filters) => filters?.cursor ? second : first);
    await act(async () => finishPage(second)); await flush();
    expect(container.querySelector('button[aria-label^="Abrir conversa com c100"]')).not.toBeNull();
    expect(vi.mocked(apiGetConversations).mock.calls.map(call => call[1]?.cursor)).toEqual([undefined, 'c50', undefined, 'c50']);
    let finishRefresh!: (rows: ConversationDto[]) => void;
    vi.mocked(apiGetConversations).mockImplementation(async (_token, filters) => filters?.cursor ? second : new Promise(resolve => { finishRefresh = resolve; }));
    await act(async () => session.reconcile()); await flush();
    const button = container.querySelector<HTMLButtonElement>('.conversation-load-more')!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click()); expect(apiGetConversations).toHaveBeenCalledTimes(5);
    await act(async () => finishRefresh(first)); await flush();
    expect(container.querySelector('button[aria-label^="Abrir conversa com c100"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.conversation-load-more')?.disabled).toBe(false);
  });
  it('preserves a websocket read receipt when a delayed send acknowledgement reports sent', async () => {
    await render(); let finish!: (row: MessageDto) => void;
    vi.mocked(apiCreateConversationMessage).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await type('outgoing'); await act(async () => container.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const sent: MessageDto = { ...message('c1'), id: 'sent-id', type: 'text', direction: 'outbound', body: 'outgoing', status: 'sent', providerMessageId: 'provider-id' };
    await act(async () => session.event({ type: 'message.created', workspaceId: 'w', payload: { ...sent, status: 'read' } }));
    await act(async () => finish(sent)); await flush();
    const rows = session.client.getQueryData<MessageDto[]>(session.key('messages', 'c1'))!;
    expect(rows.find(row => row.id === 'sent-id')?.status).toBe('read');
    expect(rows.filter(row => row.body === 'outgoing')).toHaveLength(1);
    expect(apiCreateConversationMessage).toHaveBeenCalledOnce();
  });
});
