import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeConnection } from './realtime-connection';
vi.mock('../../app/api', () => ({ buildRealtimeUrl: () => 'wss://example.test/realtime', buildRealtimeAuthProtocols: (token: string) => ['auth', token] }));
class Socket {
  static instances: Socket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string, readonly protocols: string[]) { Socket.instances.push(this); }
}
beforeEach(() => { vi.useFakeTimers(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('session websocket', () => {
  it('shares one socket as subscriptions and refreshed tokens change, and safely ignores malformed frames', () => {
    const connection = new RealtimeConnection(); connection.updateToken('first');
    const callback = vi.fn(); const unsubscribe = connection.subscribe(callback);
    connection.updateToken('refreshed'); const socket = Socket.instances[0];
    socket.onmessage?.({ data: '{broken' }); socket.onmessage?.({ data: '{}' });
    socket.onmessage?.({ data: JSON.stringify({ type: 'message.status_changed', workspaceId: 'w', payload: { messageId: 'm', status: 'read' } }) });
    expect(Socket.instances).toHaveLength(1); expect(callback).toHaveBeenCalledOnce();
    unsubscribe(); connection.subscribe(callback); expect(Socket.instances).toHaveLength(1); connection.stop();
  });
  it('reconnects at 500ms then exponential delays up to 30 seconds and reconciles after open', async () => {
    const reconnect = vi.fn(); const connection = new RealtimeConnection(reconnect);
    connection.updateToken('token'); Socket.instances[0].onopen?.(); Socket.instances[0].onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(499); expect(Socket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(Socket.instances).toHaveLength(2);
    Socket.instances[1].onopen?.(); expect(reconnect).toHaveBeenCalledOnce();
    for (const delay of [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const count = Socket.instances.length;
      Socket.instances.at(-1)?.onclose?.({ code: 1006 });
      await vi.advanceTimersByTimeAsync(delay - 1); expect(Socket.instances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(Socket.instances).toHaveLength(count + 1);
    }
    connection.stop();
  });
  it('stops reconnection on missing/revoked auth and cancels scheduled work on teardown', async () => {
    const revoked = vi.fn(); const connection = new RealtimeConnection(() => {}, revoked);
    connection.updateToken(null); expect(Socket.instances).toHaveLength(0);
    connection.updateToken('token'); Socket.instances[0].onclose?.({ code: 4401 });
    await vi.advanceTimersByTimeAsync(60_000); expect(Socket.instances).toHaveLength(1); expect(revoked).toHaveBeenCalledOnce();
    connection.updateToken('new-auth'); Socket.instances.at(-1)?.onclose?.({ code: 1006 }); connection.stop();
    await vi.advanceTimersByTimeAsync(30_000); expect(Socket.instances).toHaveLength(2);
  });
  it('waits for a fresh token on reconnect and coalesces acquisition before opening one socket', async () => {
    let finish!: (token: string) => void;
    const token = vi.fn().mockResolvedValueOnce('fresh-first').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const connection = new RealtimeConnection(vi.fn(), vi.fn(), token);
    connection.updateToken('cached'); await vi.advanceTimersByTimeAsync(0);
    expect(Socket.instances[0].protocols).toEqual(['auth', 'fresh-first']);
    Socket.instances[0].onopen?.(); Socket.instances[0].onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(500); expect(token).toHaveBeenCalledTimes(2); expect(Socket.instances).toHaveLength(1);
    connection.updateToken('another-cached-token'); await vi.advanceTimersByTimeAsync(100);
    expect(token).toHaveBeenCalledTimes(2);
    finish('fresh-reconnect'); await vi.advanceTimersByTimeAsync(0);
    expect(Socket.instances).toHaveLength(2); expect(Socket.instances[1].protocols).toEqual(['auth', 'fresh-reconnect']);
    connection.stop();
  });
  it('cancels a pending token acquisition on teardown and bounds a hung acquisition to eight seconds', async () => {
    let finish!: (token: string) => void; let signal!: AbortSignal;
    const token = vi.fn((input: AbortSignal) => { signal = input; return new Promise<string>(resolve => { finish = resolve; }); });
    const connection = new RealtimeConnection(vi.fn(), vi.fn(), token);
    connection.updateToken('cached'); connection.stop(); expect(signal.aborted).toBe(true);
    finish('late-token'); await vi.advanceTimersByTimeAsync(0); expect(Socket.instances).toHaveLength(0);
    connection.updateToken('cached'); await vi.advanceTimersByTimeAsync(8_000); expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(499); expect(token).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(token).toHaveBeenCalledTimes(3); expect(Socket.instances).toHaveLength(0);
    connection.stop();
  });
});
