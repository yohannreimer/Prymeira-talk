import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGetConversationMessages, apiGetConversations, apiGetAttentionCount, apiGetAuditLog, apiGetAgentImprovements, apiGetCurrentTalkUser } from './api';
import { ReadAccessError, withReadDeadline } from './read-request';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Atendimento reads', () => {
  it('opts into compact history media while preserving its authenticated cancellable read', async () => {
    const mediaUrl = 'https://talk.example.test/api/conversations/c1/messages/m1/media?v=source';
    const dto = { id: 'm1', conversationId: 'c1', workspaceId: 'w', providerMessageId: 'provider-id', direction: 'inbound', type: 'file',
      body: 'Caption', mediaUrl, status: 'read', sentByUserId: null, createdAt: '2026-09-30T00:00:00Z', attachment: { mimeType: 'application/pdf' } };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([dto]))); vi.stubGlobal('fetch', fetch);
    expect(await apiGetConversationMessages('c1', async () => 'token')).toEqual([dto]);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/conversations\/c1\/messages\?compactMedia=1$/);
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer token' }, signal: expect.any(AbortSignal) });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('bounds token acquisition within the total eight seconds and never starts fetch after timeout', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    let release!: (token: string) => void;
    const token = new Promise<string>(resolve => { release = resolve; });
    const pending = apiGetConversationMessages('c1', () => token);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(8_000); await assertion;
    release('late-token'); await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels a replaced read during token acquisition with no request or retry', async () => {
    const controller = new AbortController(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const pending = apiGetConversations(() => new Promise(() => {}), {}, controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the remaining budget for response body parsing', async () => {
    vi.useFakeTimers();
    const response = { ok: true, status: 200, json: () => new Promise(() => {}) };
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetch);
    const pending = apiGetConversationMessages('c1', async () => { await new Promise(resolve => setTimeout(resolve, 6_000)); return 'token'; });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(6_000); expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000); await assertion;
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('forwards cancellation to the attention-count fetch', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"count":1}')); vi.stubGlobal('fetch', fetch);
    expect(await apiGetAttentionCount(async () => 'token')).toBe(1);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('does not even invoke a read that was already canceled', async () => {
    const controller = new AbortController(); controller.abort(); const read = vi.fn();
    await expect(withReadDeadline(controller.signal, read)).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('operation refusal and authentication boundaries', () => {
  const observeRevocation = () => {
    const target = new EventTarget(); const revoked = vi.fn(); target.addEventListener('talk:access-revoked', revoked);
    vi.stubGlobal('window', target); return revoked;
  };
  it.each(['SETTINGS_MANAGE_FORBIDDEN', 'AGENT_MANAGE_FORBIDDEN'])('keeps %s as a local operation error without an extra authentication read', async code => {
    const revoked = observeRevocation();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, error: 'Management permission required.' }), { status: 403 })); vi.stubGlobal('fetch', fetch);
    const read = code === 'SETTINGS_MANAGE_FORBIDDEN' ? apiGetAuditLog : (token: () => Promise<string>) => apiGetAgentImprovements(token, 'agent-id');
    await expect(read(async () => 'token')).rejects.toMatchObject({ name: 'ApiRequestError', code });
    expect(revoked).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['Product access denied.', 'Workspace access denied.'])('revokes access for the actual middleware contract: %s', async message => {
    const revoked = observeRevocation();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ statusCode: 403, error: 'Forbidden', message }), { status: 403 })); vi.stubGlobal('fetch', fetch);
    await expect(apiGetConversationMessages('c1', async () => 'token')).rejects.toBeInstanceOf(ReadAccessError);
    expect(revoked).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([200, 403])('revalidates an ambiguous operation 403 against /me, whose status is %i', async status => {
    const revoked = observeRevocation();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'This operation is forbidden.' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: 'w', role: 'agent' }), { status })); vi.stubGlobal('fetch', fetch);
    const pending = apiGetAuditLog(async () => 'token');
    if (status === 200) { await expect(pending).rejects.toMatchObject({ name: 'ApiRequestError' }); expect(revoked).not.toHaveBeenCalled(); }
    else { await expect(pending).rejects.toBeInstanceOf(ReadAccessError); expect(revoked).toHaveBeenCalledOnce(); }
    expect(String(fetch.mock.calls[1][0])).toMatch(/\/me$/);
    expect(fetch.mock.calls[1][1].signal).toBe(fetch.mock.calls[0][1].signal);
  });
  it.each([401, 403])('fails closed when /me itself refuses authentication with %i', async status => {
    const revoked = observeRevocation(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    await expect(apiGetCurrentTalkUser(async () => 'token')).rejects.toBeInstanceOf(ReadAccessError); expect(revoked).toHaveBeenCalledOnce();
  });
  it('bounds 403 body classification within the token/body deadline and ignores a late body after cancellation', async () => {
    vi.useFakeTimers(); const revoked = observeRevocation(); let finish!: (body: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 403, ok: false, clone: () => ({ json: () => new Promise(resolve => { finish = resolve; }) }) }));
    const pending = apiGetAuditLog(async () => { await new Promise(resolve => setTimeout(resolve, 6_000)); return 'token'; });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(6_000); await vi.advanceTimersByTimeAsync(2_000); await rejected;
    finish({ message: 'Product access denied.' }); await vi.advanceTimersByTimeAsync(0); expect(revoked).not.toHaveBeenCalled();
  });
  it('shares the remaining token/read deadline with ambiguous 403 revalidation and cancels a late auth denial', async () => {
    vi.useFakeTimers(); const revoked = observeRevocation(); let finish!: (response: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Operation forbidden.' }), { status: 403 }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const pending = apiGetAuditLog(async () => { await new Promise(resolve => setTimeout(resolve, 6_000)); return 'token'; });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(6_000); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000); await rejected;
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
    finish(new Response('{}', { status: 401 })); await vi.advanceTimersByTimeAsync(0); expect(revoked).not.toHaveBeenCalled();
  });
});
