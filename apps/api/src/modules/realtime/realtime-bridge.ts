import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { RealtimeEvent } from '@prymeira-talk/shared';
import type { RealtimeHub } from './realtime-hub.js';

/** Fan-out of realtime events between API processes through PostgreSQL LISTEN/NOTIFY.
 * Every process still publishes to its own WebSocket clients immediately; peers receive the same event
 * from NOTIFY and publish it to theirs. The origin id keeps a process from echoing its own events.
 * NOTIFY payloads are capped (8000 bytes): an oversized event reaches local clients only and is logged,
 * and clients reload canonical state on reconnect, so nothing is lost permanently. */

const CHANNEL = 'talk_realtime';
const MAX_PAYLOAD_BYTES = 7_500;

/** Prisma-only URL options make `pg` reject or misread the string. */
export function toPgConnectionString(databaseUrl: string) {
  const url = new URL(databaseUrl);
  for (const key of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size', 'socket_timeout', 'connect_timeout']) url.searchParams.delete(key);
  return url.toString();
}

export function createRealtimeBridge(options: {
  databaseUrl: string;
  hub: RealtimeHub;
  processId?: string;
  reconnectMs?: number;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}) {
  const processId = options.processId ?? randomUUID();
  const connectionString = toPgConnectionString(options.databaseUrl);
  const reconnectMs = options.reconnectMs ?? 1_000;
  const pool = new Pool({ connectionString, max: 2 });
  pool.on('error', () => { /* a broken idle connection is replaced by the pool */ });
  let listener: Client | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(delay: number) {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; void connect(); }, delay);
  }
  async function connect() {
    if (stopped) return;
    const client = new Client({ connectionString });
    listener = client;
    client.on('error', error => { options.logger?.warn({ err: error }, 'Realtime bridge listener error'); });
    client.on('end', () => { if (listener === client) { listener = null; schedule(reconnectMs); } });
    client.on('notification', message => {
      if (message.channel !== CHANNEL || !message.payload) return;
      try {
        const { o, e } = JSON.parse(message.payload) as { o?: string; e?: RealtimeEvent };
        if (!e || o === processId) return;
        options.hub.publish(e);
      } catch (error) { options.logger?.warn({ err: error }, 'Realtime bridge ignored an invalid notification'); }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      options.logger?.warn({ err: error }, 'Realtime bridge could not listen; retrying');
      if (listener === client) listener = null;
      client.removeAllListeners('end');
      await client.end().catch(() => undefined);
      schedule(reconnectMs);
    }
  }

  return {
    processId,
    async start() { stopped = false; await connect(); },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const current = listener; listener = null;
      await current?.end().catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
    get listening() { return listener !== null; },
    /** Same surface as the hub, so it can replace it as `app.realtime`. */
    addClient: options.hub.addClient,
    clientCount: options.hub.clientCount,
    publish(event: RealtimeEvent) {
      options.hub.publish(event);
      const payload = JSON.stringify({ o: processId, e: event });
      if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
        options.logger?.warn({ type: event.type, workspaceId: event.workspaceId }, 'Realtime event too large for peers; local clients only');
        return;
      }
      void pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch(error => {
        options.logger?.warn({ err: error, type: event.type }, 'Realtime bridge could not notify peers');
      });
    }
  };
}
export type RealtimeBridge = ReturnType<typeof createRealtimeBridge>;
