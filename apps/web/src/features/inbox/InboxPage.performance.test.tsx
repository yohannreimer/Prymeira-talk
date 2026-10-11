// @vitest-environment jsdom
import { act, forwardRef, useEffect, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDto, MessageDto } from '@prymeira-talk/shared';
import { InboxPage } from './InboxPage';
import { optimizePhoto } from './photo-optimization';
import { TalkSessionContext } from '../../app/session/TalkSessionProvider';
import { TalkSession } from '../../app/session/talk-session';
import { RealtimeConnection } from './realtime-connection';
import { apiCreateConversationMessage, apiGetConversationMessages, apiGetConversations, apiGetAssistantConversation, apiGetConversationContext, apiMarkConversationRead, apiGetQuickReplies, apiGetContactNameInsight } from '../../app/api';

vi.mock('./photo-optimization', async original => ({ ...await original<typeof import('./photo-optimization')>(), optimizePhoto: vi.fn(async (file: File) => ({ file, reason: 'unchanged' })) }));

const renders = vi.hoisted(() => ({ media: vi.fn(), mediaMount: vi.fn(), mediaUnmount: vi.fn(), assistant: vi.fn(), avatar: vi.fn() }));
vi.mock('./InboxMedia', () => ({ InboxMedia: ({ message }: { message: MessageDto }) => {
  renders.media(); useEffect(() => { renders.mediaMount(); return () => renders.mediaUnmount(); }, []);
  return <span>{message.body}</span>;
}, mediaCaption: () => null }));
vi.mock('./ContactAvatar', () => ({ ContactAvatar: () => { renders.avatar(); return <span />; }, ContactPhotoProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./AssistantPanel', () => ({ AssistantPanel: () => { renders.assistant(); return <span>Assistente</span>; } }));
vi.mock('./VoiceRecorder', () => ({ VoiceRecorder: () => null }));
vi.mock('./RichDraft', () => ({ RichDraft: forwardRef(function MockDraft(props: { value: string; onChange(value: string): void; onKeyCommand?(key: string): boolean }, ref) {
  useImperativeHandle(ref, () => ({ focus() {}, focusEnd() {}, format() {}, insertText(text: string) { props.onChange(props.value + text); } }));
  return <input aria-label="Mensagem" value={props.value} onChange={event => props.onChange(event.target.value)}
    onKeyDown={event => { if (props.onKeyCommand?.(event.key)) event.preventDefault(); }} />;
}) }));
vi.mock('../../app/api', async importOriginal => ({ ...await importOriginal<typeof import('../../app/api')>(),
  apiGetConversationMessages: vi.fn(), apiGetConversations: vi.fn(), apiGetConversationContext: vi.fn(),
  apiGetChannels: vi.fn(async () => []), apiGetTags: vi.fn(async () => []), apiGetAttentionCount: vi.fn(async () => 0),
  apiGetAssistantConversation: vi.fn(async () => ({ settings: { mode: 'disabled', agentId: null }, status: 'paused', history: [], suggestion: null, currentContextKey: null, humanControlled: true, humanSupport: false, awaitingCustomer: false, agentName: null, error: null })),
  apiMarkConversationRead: vi.fn(), apiCreateConversationMessage: vi.fn(), apiGetQuickReplies: vi.fn(async () => []), apiGetContactNameInsight: vi.fn()
}));

const conversation = (id: string): ConversationDto => ({ id, workspaceId: 'w', channelId: 'channel', contactId: `contact-${id}`, contactName: id, status: 'open', assignedUserId: null, departmentId: null, lastMessageAt: null, lastMessagePreview: null, unreadCount: 0, priority: 'normal' });
const message = (id: string): MessageDto => ({ id: `m-${id}`, conversationId: id, workspaceId: 'w', providerMessageId: null, direction: 'inbound', type: 'image', body: `history-${id}`, mediaUrl: 'data:image/png;base64,YQ==', status: 'read', sentByUserId: null, createdAt: '2026-09-30T00:00:00Z' });
const initialScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
class ContentResizeObserver {
  static instances: ContentResizeObserver[] = [];
  observe = vi.fn(); disconnect = vi.fn();
  constructor(readonly callback: () => void) { ContentResizeObserver.instances.push(this); }
  changed() { this.callback(); }
}

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
  const caption = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>('.attachment-tray-caption')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }); await flush();
  };
  const sendTray = async () => { await act(async () => container.querySelector<HTMLButtonElement>('.attachment-tray-send')!.click()); await flush(); };
  const trayFiles = (id: string) => session.readUI<Array<{ file: File; caption: string }>>(`draftFiles:${id}`, []);
  beforeEach(() => {
    vi.mocked(optimizePhoto).mockReset().mockImplementation(async file => ({ file, reason: 'unchanged' }));
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true });
    session = new TalkSession('user:session:w', 'w');
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    window.history.replaceState(null, '', '/?module=atendimento');
    vi.mocked(apiGetConversations).mockResolvedValue([conversation('c1'), conversation('c2'), conversation('c3')]);
    vi.mocked(apiGetConversationMessages).mockImplementation(async id => [message(id)]);
    vi.mocked(apiGetConversationContext).mockResolvedValue({ tags: [], notes: [], departments: [], boardStages: [], primaryBoardStage: null });
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); session.clear(); vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (initialScrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', initialScrollTop); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop');
  });

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
  it('keeps the mounted media component across compact history and raw websocket transcription updates', async () => {
    const raw = { ...message('c1'), type: 'audio' as const, mediaUrl: 'data:audio/ogg;base64,YQ==', mediaSourceHash: 'a'.repeat(64) };
    const compact = { ...raw, mediaUrl: 'https://talk.example.test/api/conversations/c1/messages/m-c1/media?v=source' };
    vi.mocked(apiGetConversationMessages).mockResolvedValue([compact]);
    await render(); expect(renders.mediaMount).toHaveBeenCalledOnce();
    await act(async () => session.event({ type: 'message.updated', workspaceId: 'w', payload: { ...raw, body: 'Transcrição atualizada' } })); await flush();
    expect(container.textContent).toContain('Transcrição atualizada');
    expect(renders.mediaMount).toHaveBeenCalledOnce(); expect(renders.mediaUnmount).not.toHaveBeenCalled();
    vi.mocked(apiGetConversationMessages).mockResolvedValue([{ ...compact, body: 'Transcrição atualizada' }]);
    await act(async () => session.reconcile()); await flush();
    expect(renders.mediaMount).toHaveBeenCalledOnce(); expect(renders.mediaUnmount).not.toHaveBeenCalled();
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
  it('sends several dropped/picked files like WhatsApp: one message each, in order, each with its own caption', async () => {
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:text/plain;base64,YQ=='; readAsDataURL() { this.dispatchEvent(new Event('load')); } });
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    await render();
    vi.mocked(apiCreateConversationMessage).mockImplementation(async (id, body) => ({ ...message(id), id: `sent-${body.attachment?.fileName}`, direction: 'outbound', body: body.body ?? null } as MessageDto));
    const files = [new File(['a'], 'a.pdf', { type: 'application/pdf' }), new File(['b'], 'b.png', { type: 'image/png' }), new File(['c'], 'c.mp4', { type: 'video/mp4' })];
    const input = container.querySelector<HTMLInputElement>('.composer-file-input')!;
    expect(input.multiple).toBe(true);
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
    expect(container.querySelectorAll('.attachment-tray-thumb')).toHaveLength(3);
    await caption('Proposta');
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.attachment-tray-thumb > button:first-child')[2]!.click()); await flush();
    await caption('Vídeo da obra');
    await sendTray();
    const sent = vi.mocked(apiCreateConversationMessage).mock.calls.map(([, body]) => [body.attachment?.fileName, body.body]);
    expect(sent).toEqual([['a.pdf', 'Proposta'], ['b.png', undefined], ['c.mp4', 'Vídeo da obra']]);
    expect(container.querySelector('.attachment-tray')).toBeNull(); expect(trayFiles('c1')).toEqual([]);
  });
  it('prepares three large photos sequentially and sends each once with its caption and JPEG MIME', async () => {
    const read = vi.fn();
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:image/jpeg;base64,YQ=='; readAsDataURL(file: File) { read(file); this.dispatchEvent(new Event('load')); } });
    vi.mocked(optimizePhoto).mockImplementation(async file => ({ file: new File(['optimized'], file.name, { type: 'image/jpeg' }), reason: 'optimized' }));
    vi.mocked(apiCreateConversationMessage).mockImplementation(async (id, input) => ({ ...message(id), id: input.attachment!.fileName, direction: 'outbound', status: 'sent' }));
    await render();
    const files = [1, 2, 3].map(i => new File([new Uint8Array(10 * 1024 * 1024)], `photo${i}.jpg`, { type: 'image/jpeg' }));
    const input = container.querySelector<HTMLInputElement>('.composer-file-input')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
    await caption('Legenda foto 1'); await sendTray();
    expect(vi.mocked(optimizePhoto).mock.calls.map(([file, original]) => [file.name, original])).toEqual(files.map(f => [f.name, false]));
    expect(read.mock.calls.map(([f]) => f.size)).toEqual([9, 9, 9]);
    expect(vi.mocked(apiCreateConversationMessage).mock.calls.map(([id, body]) => [id, body.body, body.attachment?.fileName, body.attachment?.mimetype])).toEqual([
      ['c1', 'Legenda foto 1', 'photo1.jpg', 'image/jpeg'], ['c1', undefined, 'photo2.jpg', 'image/jpeg'], ['c1', undefined, 'photo3.jpg', 'image/jpeg']]);
    expect(trayFiles('c1')).toEqual([]); expect(files.map(f => f.size)).toEqual([10485760, 10485760, 10485760]);
  });
  it('ignores a repeated batch click while preparing and preserves identical independent photos', async () => {
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:image/jpeg;base64,YQ=='; readAsDataURL() { this.dispatchEvent(new Event('load')); } });
    let finish!: (value: Awaited<ReturnType<typeof optimizePhoto>>) => void;
    vi.mocked(optimizePhoto).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(apiCreateConversationMessage).mockImplementation(async (id) => ({ ...message(id), id: `sent-${vi.mocked(apiCreateConversationMessage).mock.calls.length}`, direction: 'outbound', status: 'sent' }));
    await render(); const file = new File([new Uint8Array(600_000)], 'same.jpg', { type: 'image/jpeg' });
    const input = container.querySelector<HTMLInputElement>('.composer-file-input')!; Object.defineProperty(input, 'files', { value: [file, file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
    const send = container.querySelector<HTMLButtonElement>('.attachment-tray-send')!;
    await act(async () => { send.click(); send.click(); }); await flush();
    expect(optimizePhoto).toHaveBeenCalledOnce(); expect(apiCreateConversationMessage).not.toHaveBeenCalled();
    await act(async () => finish({ file, reason: 'unchanged' })); await flush();
    expect(apiCreateConversationMessage).toHaveBeenCalledTimes(2); expect(optimizePhoto).toHaveBeenCalledTimes(2);
    const rows = session.client.getQueryData<MessageDto[]>(session.key('messages', 'c1'))!;
    expect(rows.filter(row => row.direction === 'outbound').map(row => row.id)).toEqual(['sent-1', 'sent-2']);
  });
  it('retains original choice and original file when delivery fails after preparation', async () => {
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:image/jpeg;base64,YQ=='; readAsDataURL() { this.dispatchEvent(new Event('load')); } });
    vi.mocked(apiCreateConversationMessage).mockRejectedValueOnce(new Error('Falha do provedor'));
    await render();
    const file = new File([new Uint8Array(600_000)], 'original.jpg', { type: 'image/jpeg' });
    const input = container.querySelector<HTMLInputElement>('.composer-file-input')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('.attachment-tray-hd')!.click()); await flush();
    await act(async () => container.querySelectorAll<HTMLInputElement>('.attachment-tray-quality input')[1]!.click()); await flush();
    await caption('Detalhes importantes'); await sendTray();
    expect(optimizePhoto).toHaveBeenCalledWith(file, true);
    expect(session.readUI<unknown[]>('draftFiles:c1', [])).toEqual([expect.objectContaining({ file, caption: 'Detalhes importantes', sendOriginal: true })]);
    expect(apiCreateConversationMessage).toHaveBeenCalledOnce();
  });
  it('restores source file and stops the batch if conversation changes during preparation', async () => {
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:image/jpeg;base64,YQ=='; readAsDataURL() { this.dispatchEvent(new Event('load')); } });
    let finish!: (value: Awaited<ReturnType<typeof optimizePhoto>>) => void;
    vi.mocked(optimizePhoto).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await select('c2'); await select('c1');
    const files = ['first', 'second'].map(name => new File([new Uint8Array(600_000)], `${name}.jpg`, { type: 'image/jpeg' }));
    const input = container.querySelector<HTMLInputElement>('.composer-file-input')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
    await caption('Conversa original'); await sendTray();
    expect(container.textContent).toContain('Preparando first.jpg');
    await select('c2'); expect(container.textContent).not.toContain('Preparando first.jpg');
    await act(async () => finish({ file: files[0], reason: 'unchanged' })); await flush();
    expect(apiCreateConversationMessage).not.toHaveBeenCalled();
    expect(trayFiles('c1')).toEqual([expect.objectContaining({ file: files[1] }), expect.objectContaining({ file: files[0], caption: 'Conversa original' })]);
  });
  it('does not dispatch an attachment if the inbox unmounts during preparation', async () => {
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:image/jpeg;base64,YQ=='; readAsDataURL() { this.dispatchEvent(new Event('load')); } });
    let finish!: (value: Awaited<ReturnType<typeof optimizePhoto>>) => void;
    vi.mocked(optimizePhoto).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); const file = new File([new Uint8Array(600_000)], 'source.jpg', { type: 'image/jpeg' });
    const input = container.querySelector<HTMLInputElement>('.composer-file-input')!; Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush(); await sendTray(); await render(false);
    await act(async () => finish({ file, reason: 'unchanged' })); await flush();
    expect(apiCreateConversationMessage).not.toHaveBeenCalled(); expect(trayFiles('c1')).toEqual([expect.objectContaining({ file })]);
  });
  it("refreshes an open conversation silently, without a note that pushes the thread down and back", async () => {
    await render();
    let finish!: (rows: MessageDto[]) => void;
    vi.mocked(apiGetConversationMessages).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { void session.client.invalidateQueries({ queryKey: session.key('messages', 'c1') }); }); await flush();
    expect(container.querySelector('.message-thread')?.textContent).not.toContain('Atualizando mensagens');
    expect(container.querySelector('.message-thread')?.textContent).toContain('history-c1');
    await act(async () => finish([message('c1')])); await flush();
  });
  it('"/" opens my quick replies, filters as I type and fills the contact\'s first name on Enter', async () => {
    const reply = (id: string, title: string, shortcut: string, body: string) => ({ id, workspaceId: 'w', title, body, category: null, shortcut, shared: false, createdAt: '', updatedAt: '' });
    vi.mocked(apiGetQuickReplies).mockResolvedValue([reply('q1', 'Bem-vindo', 'bemvindo', '{saudacao}, {primeiro_nome}! Tudo bem?'), reply('q2', 'Preços', 'precos', 'Seguem os preços.')]);
    vi.mocked(apiGetContactNameInsight).mockResolvedValue({ firstName: 'Maria', fullName: 'Maria Cecília', company: null, salutation: null, source: 'rule', ms: 3 });
    await render(); await type('Oi /');
    expect(container.querySelectorAll('.slash-menu-list > button')).toHaveLength(2);
    await type('Oi /bem');
    expect([...container.querySelectorAll('.slash-menu-list > button strong')].map(node => node.textContent)).toEqual(['Bem-vindo']);
    const input = container.querySelector<HTMLInputElement>('[aria-label="Mensagem"]')!;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await flush(); await flush();
    expect(apiGetContactNameInsight).toHaveBeenCalledWith(expect.any(Function), 'contact-c1');
    expect(input.value).toMatch(/^Oi (Bom dia|Boa tarde|Boa noite), Maria! Tudo bem\?$/);
    expect(container.querySelector('.slash-menu')).toBeNull();
    expect(apiCreateConversationMessage).not.toHaveBeenCalled();
    await type('/pre');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('.slash-menu')).toBeNull();
  });
  it("marks, for the seller only, a message their supervisor sent from the supervision view", async () => {
    vi.mocked(apiGetConversationMessages).mockImplementation(async id => [{ ...message(id), id: 'sup', direction: 'outbound', type: 'text', body: 'Aqui é o gerente', mediaUrl: null, sentBySupervisor: true }, { ...message(id), id: 'mine', direction: 'outbound', type: 'text', body: 'Resposta do vendedor', mediaUrl: null }]);
    await render();
    const labels = container.querySelectorAll('.message-supervisor-label');
    expect(labels).toHaveLength(1); expect(labels[0]!.textContent).toBe('Respondido pelo supervisor');
    expect(labels[0]!.closest('.message-bubble')?.textContent).toContain('Aqui é o gerente');
  });
  it('opens the conversation started from Contatos, even when it is not on the loaded list yet', async () => {
    await render(); expect(container.querySelector('.chat-header h2')?.textContent).toContain('c1');
    await render(false);
    const started = { ...conversation('novo-lead'), contactName: 'Lead novo' };
    window.history.pushState({ module: 'atendimento', conversation: started.id, conversationSnapshot: started }, '', '/?module=atendimento&conversation=novo-lead');
    await render();
    expect(container.querySelector('.chat-header h2')?.textContent).toContain('Lead novo');
    window.history.replaceState(null, '', '/');
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
    expect(trayFiles('c1').map(item => item.file)).toEqual([file]);
    expect(container.querySelector<HTMLImageElement>('.attachment-tray-stage img')?.src).toBe('blob:first-preview');
    await render(false); expect(revoke).toHaveBeenCalledWith('blob:first-preview');
    await render(); expect(trayFiles('c1').map(item => item.file)).toEqual([file]);
    expect(container.querySelector<HTMLImageElement>('.attachment-tray-stage img')?.src).toBe('blob:second-preview');
  });
  it('opens switched conversations at the bottom and preserves the selected history/list position on module return', async () => {
    await render(); const list = container.querySelector<HTMLDivElement>('.conversation-items')!;
    list.scrollTop = 500; await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    const thread = container.querySelector<HTMLDivElement>('.message-thread')!;
    thread.scrollTop = 450; await act(async () => thread.dispatchEvent(new Event('scroll', { bubbles: true })));
    await select('c2'); thread.scrollTop = 0; await act(async () => thread.dispatchEvent(new Event('scroll', { bubbles: true })));
    await select('c1'); await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(container.querySelector<HTMLDivElement>('.message-thread')?.scrollTop).toBe(0);
    thread.scrollTop = 450; await act(async () => thread.dispatchEvent(new Event('scroll', { bubbles: true })));
    await render(false); await render();
    expect(container.querySelector<HTMLDivElement>('.conversation-items')?.scrollTop).toBe(500);
    expect(container.querySelector<HTMLDivElement>('.message-thread')?.scrollTop).toBe(450);
  });
  it('anchors late image/content growth while at the bottom, respects manual upward scroll and restores module position', async () => {
    vi.stubGlobal('ResizeObserver', ContentResizeObserver); ContentResizeObserver.instances = [];
    const heights = { c1: 900, c2: 1500 };
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('message-thread') ? heights[this.textContent?.includes('history-c2') ? 'c2' : 'c1'] : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('message-thread') ? 300 : 0; });
    const positions = new WeakMap<HTMLElement, number>();
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return positions.get(this) ?? 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { positions.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); });
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number) {
      if (typeof options === 'object') this.scrollTop = Math.max(0, Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight));
    });
    await render(); await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    const thread = container.querySelector<HTMLDivElement>('.message-thread')!;
    const content = container.querySelector<HTMLDivElement>('.message-thread-content')!;
    expect(thread.scrollTop).toBe(600); expect(ContentResizeObserver.instances[0].observe).toHaveBeenCalledWith(content);
    const count = scroll.mock.calls.length; heights.c1 = 1300;
    await act(async () => { ContentResizeObserver.instances[0].changed(); ContentResizeObserver.instances[0].changed(); await vi.advanceTimersByTimeAsync(20); });
    expect(thread.scrollTop).toBe(1000); expect(scroll).toHaveBeenCalledTimes(count + 1);
    // A movement nobody made (the layout nudging the thread, Safari) is undone: the reader keeps the latest message.
    thread.scrollTop = 940; await act(async () => { thread.dispatchEvent(new Event('scroll')); await vi.advanceTimersByTimeAsync(20); });
    expect(thread.scrollTop).toBe(1000); expect(session.readUI('scrollFollow:c1', true)).toBe(true);
    // The reader scrolling up (wheel/trackpad) is reading history.
    await act(async () => { thread.dispatchEvent(new Event('wheel', { bubbles: true })); });
    thread.scrollTop = 970; await act(async () => thread.dispatchEvent(new Event('scroll')));
    expect(session.readUI('scrollFollow:c1', true)).toBe(false);
    await act(async () => { heights.c1 = 1400; ContentResizeObserver.instances[0].changed(); await vi.advanceTimersByTimeAsync(20); });
    expect(thread.scrollTop).toBe(970);
    heights.c1 = 1600; ContentResizeObserver.instances[0].changed();
    await act(async () => { thread.dispatchEvent(new Event('wheel', { bubbles: true })); });
    thread.scrollTop = 250; await act(async () => { thread.dispatchEvent(new Event('scroll')); await vi.advanceTimersByTimeAsync(20); });
    expect(thread.scrollTop).toBe(250);
    await act(async () => { heights.c1 = 1800; ContentResizeObserver.instances[0].changed(); await vi.advanceTimersByTimeAsync(20); });
    expect(thread.scrollTop).toBe(250);
    await act(async () => session.updateMessages('c1', rows => [...rows, { ...message('c1'), id: 'new-background', direction: 'outbound', body: 'Mensagem de outro agente' }])); await flush();
    await act(async () => { ContentResizeObserver.instances[0].changed(); await vi.advanceTimersByTimeAsync(20); });
    expect(thread.scrollTop).toBe(250);
    await select('c2'); expect(thread.scrollTop).toBe(1200);
    await select('c1'); expect(thread.scrollTop).toBe(1500);
    await act(async () => { thread.dispatchEvent(new Event('wheel', { bubbles: true })); });
    thread.scrollTop = 350; await act(async () => thread.dispatchEvent(new Event('scroll')));
    await render(false); heights.c1 = 450; await render(); await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(container.querySelector<HTMLDivElement>('.message-thread')?.scrollTop).toBe(150);
    expect(session.readUI('scroll:c1', 0)).toBe(350);
    await act(async () => { heights.c1 = 1800; ContentResizeObserver.instances.at(-1)!.changed(); await vi.advanceTimersByTimeAsync(20); });
    expect(container.querySelector<HTMLDivElement>('.message-thread')?.scrollTop).toBe(350);
    expect(session.readUI('scroll:c1', 0)).toBe(350);
  });
  it('follows captured image loads even when ResizeObserver is unavailable', async () => {
    let height = 900;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('message-thread') ? height : 0; });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('message-thread') ? 300 : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number) { if (typeof options === 'object') this.scrollTop = Math.max(0, Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight)); });
    await render(); await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    const thread = container.querySelector<HTMLDivElement>('.message-thread')!;
    const image = document.createElement('img'); thread.querySelector('.message-thread-content')!.appendChild(image);
    height = 1200;
    await act(async () => { image.dispatchEvent(new Event('load')); await vi.advanceTimersByTimeAsync(20); });
    expect(thread.scrollTop).toBe(900);
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
  it.each(['text', 'attachment'])('keeps a second identical manual %s send when the first acknowledgement arrives after module navigation', async kind => {
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:text/plain;base64,YQ=='; readAsDataURL() { this.dispatchEvent(new Event('load')); } });
    await render(); let finishFirst!: (row: MessageDto) => void; let failSecond!: (error: Error) => void;
    vi.mocked(apiCreateConversationMessage)
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failSecond = reject; }));
    const submit = async () => {
      await type('same text');
      if (kind === 'attachment') {
        const input = container.querySelector<HTMLInputElement>('.composer-file-input')!;
        Object.defineProperty(input, 'files', { value: [new File(['a'], 'same.txt', { type: 'text/plain' })], configurable: true });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
      }
      await act(async () => container.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush();
    };
    await submit(); await render(false); await render(); await submit();
    const second = session.client.getQueryData<MessageDto[]>(session.key('messages', 'c1'))!.filter(row => row.id.startsWith('optimistic-'))[1];
    expect(second).toBeDefined();
    await act(async () => finishFirst({ ...message('c1'), id: 'first-ack', providerMessageId: 'first-provider', body: 'same text', type: kind === 'attachment' ? 'file' : 'text', direction: 'outbound', status: 'sent' })); await flush();
    expect(session.client.getQueryData<MessageDto[]>(session.key('messages', 'c1'))?.filter(row => row.body === 'same text').map(row => [row.id, row.status])).toEqual([['first-ack', 'sent'], [second.id, 'pending']]);
    await act(async () => failSecond(new Error('Falha segundo envio'))); await flush();
    const rows = session.client.getQueryData<MessageDto[]>(session.key('messages', 'c1'))!;
    expect(rows.filter(row => row.body === 'same text').map(row => [row.id, row.status])).toEqual([['first-ack', 'sent'], [second.id, 'failed']]);
    expect(apiCreateConversationMessage).toHaveBeenCalledTimes(2);
  });
  it('keeps the source send failure when its history check is canceled by selection of a warm conversation', async () => {
    await render(); await select('c2'); await select('c1');
    vi.mocked(apiCreateConversationMessage).mockRejectedValueOnce(new Error('Falha A'));
    await type('first send');
    await act(async () => container.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush();
    const failure = session.readUI('sendFailure:c1', null);
    let finishRead!: (rows: MessageDto[]) => void; let signal!: AbortSignal;
    vi.mocked(apiGetConversationMessages).mockImplementationOnce((_id, _token, inputSignal) => {
      signal = inputSignal!; return new Promise(resolve => { finishRead = resolve; });
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.message-thread .error-note button')!.click()); await flush();
    await select('c2'); expect(signal.aborted).toBe(true);
    expect(session.readUI('sendFailure:c1', null)).toEqual(failure);
    await act(async () => finishRead([message('c1')])); await flush();
    await select('c1');
    expect(container.querySelector('.message-thread')?.textContent).toContain('Falha A');
    expect(session.client.getQueryData<MessageDto[]>(session.key('messages', 'c1'))?.some(row => row.id.startsWith('optimistic-') && row.status === 'failed')).toBe(true);
    expect(apiCreateConversationMessage).toHaveBeenCalledOnce();
    expect(apiGetConversationMessages).toHaveBeenCalledTimes(3);
  });
  it.each([['text', 'failed'], ['text', 'pending'], ['attachment', 'failed'], ['attachment', 'pending']] as const)('keeps a later %s send %s when an older history check finishes and clears only the consulted failure', async (kind, state) => {
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:text/plain;base64,YQ=='; readAsDataURL() { this.dispatchEvent(new Event('load')); } });
    await render(); let failSecond!: (error: Error) => void;
    vi.mocked(apiCreateConversationMessage).mockRejectedValueOnce(new Error('Falha A')).mockImplementationOnce(() => new Promise((_resolve, reject) => { failSecond = reject; }));
    const stage = async (name: string) => {
      if (kind !== 'attachment') return;
      const input = container.querySelector<HTMLInputElement>('.composer-file-input')!;
      Object.defineProperty(input, 'files', { value: [new File(['a'], name, { type: 'text/plain' })], configurable: true });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
    };
    const submit = async () => { await act(async () => container.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush(); };
    await type('first send'); await stage('first.txt'); await submit();
    expect(container.querySelector('.message-thread')?.textContent).toContain('Falha A');
    let finishRead!: (rows: MessageDto[]) => void;
    vi.mocked(apiGetConversationMessages).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    await act(async () => container.querySelector<HTMLButtonElement>('.message-thread .error-note button')!.click()); await flush();
    await type('second send'); await stage('second.txt'); await submit();
    if (state === 'failed') { await act(async () => failSecond(new Error('Falha B'))); await flush(); }
    await act(async () => finishRead([message('c1')])); await flush();
    const rows = session.client.getQueryData<MessageDto[]>(session.key('messages', 'c1'))!;
    expect(rows.filter(row => row.id.startsWith('optimistic-')).map(row => [row.body, row.status])).toEqual([['second send', state]]);
    expect(container.querySelector('.message-thread')?.textContent).not.toContain('Falha A');
    if (state === 'failed') expect(container.querySelector('.message-thread')?.textContent).toContain('Falha B');
    else {
      expect(container.querySelector('.message-thread .error-note')).toBeNull();
      await act(async () => failSecond(new Error('Falha B'))); await flush();
      expect(container.querySelector('.message-thread')?.textContent).toContain('Falha B');
    }
    // A subsequent explicit check owns failure B and can remove its old local row.
    vi.mocked(apiGetConversationMessages).mockResolvedValueOnce([message('c1')]);
    await act(async () => container.querySelector<HTMLButtonElement>('.message-thread .error-note button')!.click()); await flush();
    expect(container.querySelector('.message-thread .error-note')).toBeNull();
    expect(session.client.getQueryData<MessageDto[]>(session.key('messages', 'c1'))?.some(row => row.id.startsWith('optimistic-'))).toBe(false);
    expect(apiCreateConversationMessage).toHaveBeenCalledTimes(2);
  });
  it.each(['text', 'attachment'])('records an inactive %s send failure in its target history/draft and shows recovery on return without resending', async kind => {
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:text/plain;base64,YQ=='; readAsDataURL() { this.dispatchEvent(new Event('load')); } });
    await render(); await select('c2'); await select('c1'); let fail!: (error: Error) => void;
    vi.mocked(apiCreateConversationMessage).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const file = new File(['a'], 'document.txt', { type: 'text/plain' });
    if (kind === 'attachment') {
      // Files go through the attachment tray, each with its own caption, and are sent from there.
      const input = container.querySelector<HTMLInputElement>('.composer-file-input')!; Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
      await caption('draft to recover'); await sendTray();
    } else {
      await type('draft to recover');
      await act(async () => container.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush();
    }
    expect(apiCreateConversationMessage).toHaveBeenCalledOnce();
    await select('c2'); await act(async () => fail(new Error('Falha de rede'))); await flush();
    expect(container.querySelector('.message-thread')?.textContent).not.toContain('Falha de rede');
    expect(session.readUI('draft:c2', '')).toBe('');
    await select('c1');
    if (kind === 'attachment') expect(trayFiles('c1')).toEqual([expect.objectContaining({ file, caption: 'draft to recover' })]);
    else expect(container.querySelector<HTMLInputElement>('[aria-label="Mensagem"]')?.value).toBe('draft to recover');
    const rows = session.client.getQueryData<MessageDto[]>(session.key('messages', 'c1'))!;
    expect(rows.find(row => row.id.startsWith('optimistic-'))?.status).toBe('failed');
    expect(container.querySelector('.message-thread')?.textContent).toContain('Falha de rede');
    expect(container.querySelector('.message-thread')?.textContent).toContain('Confira o histórico antes de reenviar.');
    expect(apiCreateConversationMessage).toHaveBeenCalledOnce(); expect(apiGetConversationMessages).toHaveBeenCalledTimes(2);
  });
  it.each([['text', true], ['text', false], ['attachment', true], ['attachment', false]] as const)('preserves a newer target draft/file when a prior %s send fails after module navigation (new text: %s)', async (kind, newText) => {
    vi.stubGlobal('FileReader', class extends EventTarget { result = 'data:text/plain;base64,YQ=='; readAsDataURL() { this.dispatchEvent(new Event('load')); } });
    await render(); await select('c2'); await select('c1'); let fail!: (error: Error) => void;
    vi.mocked(apiCreateConversationMessage).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const oldFile = new File(['old'], 'old.txt', { type: 'text/plain' });
    if (kind === 'attachment') {
      const input = container.querySelector<HTMLInputElement>('.composer-file-input')!; Object.defineProperty(input, 'files', { value: [oldFile], configurable: true });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
      await caption('old caption'); await sendTray();
    } else {
      await type('old draft');
      await act(async () => container.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush();
    }
    await select('c2'); await render(false); await render(); await select('c1'); if (newText) await type('newer draft');
    const newFile = new File(['new'], 'new.txt', { type: 'text/plain' });
    const input = container.querySelector<HTMLInputElement>('.composer-file-input')!; Object.defineProperty(input, 'files', { value: [newFile], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
    await select('c2'); await act(async () => fail(new Error('Falha de rede'))); await flush(); await select('c1');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Mensagem"]')?.value).toBe(newText ? 'newer draft' : '');
    // The newer file stays first in the tray; a failed one comes back after it with its caption, never replacing it.
    expect(trayFiles('c1')[0]?.file).toBe(newFile);
    if (kind === 'attachment') expect(trayFiles('c1')[1]).toEqual(expect.objectContaining({ file: oldFile, caption: 'old caption' }));
    expect(container.querySelector('.message-thread')?.textContent).toContain('Falha de rede');
    expect(apiCreateConversationMessage).toHaveBeenCalledOnce();
  });
});
