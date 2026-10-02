import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RealtimeEvent } from '@prymeira-talk/shared';
import { createRealtimeHub } from './realtime-hub.js';
import { createRealtimeBridge, toPgConnectionString, type RealtimeBridge } from './realtime-bridge.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;

describe('toPgConnectionString', () => {
  it('drops Prisma-only options and keeps credentials and database', () => {
    expect(toPgConnectionString('postgresql://u:p@db:5432/talk?schema=public&connection_limit=5&sslmode=require')).toBe('postgresql://u:p@db:5432/talk?sslmode=require');
  });
});

describe.skipIf(!databaseUrl)('realtime bridge across processes on PostgreSQL', () => {
  const bridges: RealtimeBridge[] = [];
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
  });
  afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.stop())); });

  async function node(workspaceId: string) {
    const hub = createRealtimeHub();
    const received: RealtimeEvent[] = [];
    hub.addClient(workspaceId, { readyState: 1, send: payload => received.push(JSON.parse(payload)) });
    const warn = vi.fn();
    const bridge = createRealtimeBridge({ databaseUrl: databaseUrl!, hub, reconnectMs: 50, logger: { warn } });
    bridges.push(bridge);
    await bridge.start();
    return { bridge, received, warn };
  }
  const event = (workspaceId: string, messageId: string = randomUUID()): RealtimeEvent => ({ type: 'message.deleted', workspaceId, payload: { messageId, conversationId: randomUUID() } });
  const until = async (read: () => boolean) => { const end = Date.now() + 5_000; while (!read()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };

  it('delivers an event to local and peer clients exactly once, and only inside the workspace', async () => {
    const ws = `bridge-${randomUUID()}`;
    const a = await node(ws), b = await node(ws), other = await node(`bridge-${randomUUID()}`);
    const sent = event(ws);
    a.bridge.publish(sent);
    await until(() => b.received.length === 1);
    await new Promise(r => setTimeout(r, 200));
    expect(a.received).toEqual([sent]);
    expect(b.received).toEqual([sent]);
    expect(other.received).toEqual([]);
  });

  it('keeps local delivery and warns when an event is too large for peers', async () => {
    const ws = `bridge-${randomUUID()}`;
    const a = await node(ws), b = await node(ws);
    a.bridge.publish(event(ws, 'x'.repeat(9_000)));
    await new Promise(r => setTimeout(r, 200));
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(0);
    expect(a.warn).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.deleted' }), expect.stringContaining('too large'));
  });

  it('ignores garbage notifications and resumes listening after its connection is killed', async () => {
    const ws = `bridge-${randomUUID()}`;
    const a = await node(ws), b = await node(ws);
    const admin = new Client({ connectionString: toPgConnectionString(databaseUrl!) });
    await admin.connect();
    try {
      await admin.query(`SELECT pg_notify('talk_realtime', 'not json')`);
      await admin.query(`SELECT pg_notify('talk_realtime', $1)`, [JSON.stringify({ o: 'x', e: { type: 'nope', workspaceId: ws } })]);
      await new Promise(r => setTimeout(r, 150));
      expect(b.received).toEqual([]);
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN talk_realtime%' AND pid <> pg_backend_pid()`);
    } finally { await admin.end(); }
    await until(() => a.bridge.listening && b.bridge.listening);
    await new Promise(r => setTimeout(r, 300));
    const sent = event(ws, 'depois-da-queda');
    a.bridge.publish(sent);
    await until(() => b.received.length === 1);
    expect(b.received[0]).toEqual(sent);
  });
});
