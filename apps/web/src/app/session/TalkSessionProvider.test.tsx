// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TalkSessionProvider, useSessionState, useTalkSession } from './TalkSessionProvider';
import { TalkSession } from './talk-session';
import { apiGetCurrentTalkUser, apiGetAuditLog, apiGetAgentImprovements, apiGetConversationMessages } from '../api';
import { ReadAccessError } from '../read-request';

const auth = vi.hoisted(() => ({ userId: 'user1', sessionId: 'session1', orgId: null, getToken: vi.fn(async () => 'token') }));
vi.mock('../auth', () => ({ useTalkAuth: () => auth }));
vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), apiGetCurrentTalkUser: vi.fn() }));
class Socket {
  static instances: Socket[] = [];
  onclose: ((event: { code: number }) => void) | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  constructor() { Socket.instances.push(this); }
}

describe('authenticated session scope', () => {
  let root: ReturnType<typeof createRoot>; let container: HTMLDivElement;
  const mounted: TalkSession[] = [];
  function Probe() {
    const { session } = useTalkSession(); const [draft, setDraft] = useSessionState('draft:c1', '');
    useEffect(() => { mounted.push(session); }, [session]);
    return <><span>{session.scope} {draft}</span><button type="button" onClick={() => { setDraft('private draft'); session.client.setQueryData(session.key('messages', 'c1'), ['private history']); }}>Draft</button></>;
  }
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };
  const render = async () => { await act(async () => root.render(<TalkSessionProvider><Probe /></TalkSessionProvider>)); await flush(); };
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket); Socket.instances = [];
    auth.userId = 'user1'; auth.sessionId = 'session1'; auth.getToken.mockResolvedValue('token'); mounted.length = 0;
    vi.mocked(apiGetCurrentTalkUser).mockResolvedValue({ workspaceId: 'w1', role: 'agent' });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('clears history/drafts/socket when the user or login session changes', async () => {
    await render(); const previous = mounted[0];
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(previous.readUI('draft:c1', '')).toBe('private draft');
    auth.userId = 'user2'; auth.sessionId = 'session2'; await render();
    expect(container.textContent).toContain('user2:session2'); expect(container.textContent).not.toContain('private draft');
    expect(previous.client.getQueryCache().getAll()).toEqual([]); expect(previous.readUI('draft:c1', '')).toBe('');
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
  });
  it('revalidates workspace/role on focus and starts a clean scope', async () => {
    await render(); const previous = mounted[0];
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    vi.mocked(apiGetCurrentTalkUser).mockResolvedValue({ workspaceId: 'w2', role: 'owner' });
    await act(async () => window.dispatchEvent(new Event('focus'))); await flush();
    expect(container.textContent).toContain('w2'); expect(container.textContent).not.toContain('private draft');
    expect(previous.client.getQueryCache().getAll()).toEqual([]); expect(previous.readUI('draft:c1', '')).toBe('');
  });
  it('retains data on a temporary validation failure, then clears it on revocation', async () => {
    await render(); const previous = mounted[0];
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    vi.mocked(apiGetCurrentTalkUser).mockRejectedValue(new Error('rede indisponível'));
    await act(async () => window.dispatchEvent(new Event('focus'))); await flush();
    expect(container.textContent).toContain('private draft'); expect(container.textContent).toContain('rede indisponível');
    await act(async () => window.dispatchEvent(new Event('talk:access-revoked'))); await flush();
    expect(container.textContent).not.toContain('private draft'); expect(previous.client.getQueryCache().getAll()).toEqual([]);
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
  });
  it.each(['SETTINGS_MANAGE_FORBIDDEN', 'AGENT_MANAGE_FORBIDDEN'])('preserves an authenticated agent session after %s', async code => {
    await render(); const previous = mounted[0];
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, error: 'Management permission required.' }), { status: 403 })));
    await act(async () => {
      const pending = code === 'SETTINGS_MANAGE_FORBIDDEN' ? apiGetAuditLog(auth.getToken) : apiGetAgentImprovements(auth.getToken, 'agent-id');
      await expect(pending).rejects.toMatchObject({ code });
    });
    await act(async () => window.dispatchEvent(new Event('focus'))); await flush();
    expect(container.textContent).toContain('private draft'); expect(mounted).toHaveLength(1);
    expect(previous.client.getQueryData(previous.key('messages', 'c1'))).toEqual(['private history']);
    expect(previous.readUI('draft:c1', '')).toBe('private draft'); expect(Socket.instances[0].close).not.toHaveBeenCalled();
    expect(apiGetCurrentTalkUser).toHaveBeenLastCalledWith(expect.any(Function), expect.any(AbortSignal));
  });
  it('clears an authenticated session when a read reports actual product revocation', async () => {
    await render(); const previous = mounted[0];
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ statusCode: 403, error: 'Forbidden', message: 'Product access denied.' }), { status: 403 })));
    await act(async () => { await expect(apiGetConversationMessages('c1', auth.getToken)).rejects.toBeInstanceOf(ReadAccessError); }); await flush();
    expect(container.textContent).toContain('Seu acesso mudou'); expect(container.textContent).not.toContain('private draft');
    expect(previous.client.getQueryCache().getAll()).toEqual([]); expect(previous.readUI('draft:c1', '')).toBe('');
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
  });
  it('clears the scoped client and session UI on logout/unmount', async () => {
    await render(); const previous = mounted[0];
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => root.render(<p>Signed out</p>));
    expect(previous.client.getQueryCache().getAll()).toEqual([]); expect(previous.readUI('draft:c1', '')).toBe('');
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
  });
  it('fences a delayed validation after revocation until explicit retry', async () => {
    await render(); let finish!: (value: { workspaceId: string; role: 'agent' }) => void;
    vi.mocked(apiGetCurrentTalkUser).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => window.dispatchEvent(new Event('talk:access-revoked')));
    await act(async () => finish({ workspaceId: 'w1', role: 'agent' })); await flush();
    expect(container.textContent).toContain('Seu acesso mudou'); expect(mounted).toHaveLength(1); expect(Socket.instances).toHaveLength(1);
    const calls = vi.mocked(apiGetCurrentTalkUser).mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('focus'))); await flush();
    expect(apiGetCurrentTalkUser).toHaveBeenCalledTimes(calls);
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click()); await flush();
    expect(mounted).toHaveLength(2); expect(Socket.instances).toHaveLength(2);
  });
  it('cannot reopen a socket when a pending periodic token refresh completes after revocation', async () => {
    await render(); let finish!: (token: string) => void;
    auth.getToken.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => { window.dispatchEvent(new Event('talk:access-revoked')); finish('late-token'); await Promise.resolve(); });
    await flush();
    expect(container.textContent).toContain('Seu acesso mudou'); expect(Socket.instances).toHaveLength(1);
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(Socket.instances).toHaveLength(1);
  });
});
