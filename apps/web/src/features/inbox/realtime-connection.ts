import { realtimeEventSchema, type RealtimeEvent } from '@prymeira-talk/shared';
import { buildRealtimeAuthProtocols, buildRealtimeUrl } from '../../app/api';
import { withReadDeadline } from '../../app/read-request';

export class RealtimeConnection {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private token: string | null = null;
  private stopped = true;
  private attempt = 0;
  private opened = false;
  private acquisition: AbortController | null = null;
  private listeners = new Set<(event: RealtimeEvent) => void>();
  constructor(private onReconnect: () => void = () => {}, private onRevoked: () => void = () => {}, private freshToken?: (signal: AbortSignal) => Promise<string | null>) {}
  subscribe(listener: (event: RealtimeEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  updateToken(token: string | null) {
    this.token = token;
    if (!token) { this.stop(); return; }
    if (this.stopped) { this.stopped = false; this.connect(); }
  }
  private connect() {
    if (this.stopped || !this.token || this.acquisition || this.socket) return;
    if (!this.freshToken) { this.openSocket(); return; }
    const controller = new AbortController(); this.acquisition = controller;
    void withReadDeadline(controller.signal, signal => this.freshToken!(signal)).then(token => {
      if (controller.signal.aborted || this.stopped) return;
      if (!token) { this.stop(); this.onRevoked(); return; }
      this.token = token;
      this.openSocket();
    }).catch(() => { if (!controller.signal.aborted && !this.stopped) this.retry(); })
      .finally(() => { if (this.acquisition === controller) this.acquisition = null; });
  }
  private openSocket() {
    if (this.stopped || !this.token || this.socket) return;
    let socket: WebSocket;
    try { socket = new WebSocket(buildRealtimeUrl(), buildRealtimeAuthProtocols(this.token)); }
    catch { this.retry(); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      this.attempt = 0;
      if (this.opened) this.onReconnect();
      this.opened = true;
    };
    socket.onmessage = message => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const result = realtimeEventSchema.safeParse(JSON.parse(message.data));
        if (result.success) for (const listener of this.listeners) listener(result.data);
      } catch { /* A malformed frame must not terminate a valid stream. */ }
    };
    socket.onclose = event => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      if ([1008, 4001, 4003, 4401, 4403].includes(event.code)) { this.stop(); this.onRevoked(); return; }
      this.retry();
    };
    socket.onerror = () => { socket.close(); };
  }
  private retry() {
    if (this.stopped || !this.token) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), Math.min(30_000, 500 * 2 ** this.attempt++));
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer);
    this.acquisition?.abort(); this.acquisition = null;
    const socket = this.socket; this.socket = null;
    if (socket) { socket.onclose = null; socket.onmessage = null; socket.close(); }
  }
}
