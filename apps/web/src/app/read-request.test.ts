import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGetConversationMessages, apiGetConversations, apiGetAttentionCount } from './api';
import { withReadDeadline } from './read-request';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Atendimento reads', () => {
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
