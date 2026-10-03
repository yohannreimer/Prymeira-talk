import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChannelConnectionsService } from './channel-connections.js';
import { createChannelHealthMonitor, type WriterChange } from './channel-health-monitor.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const PHONE = '5547999990000';
const MIN = 60_000;

describe.skipIf(!databaseUrl)('channel health on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => {
    if (!db) return;
    await db.$executeRaw`DELETE FROM canonical_observations WHERE workspace_id = ANY(${workspaces}::text[])`;
    await db.channelConnection.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.channel.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await db.$disconnect();
  });

  async function fixture(opts: { redundancy?: boolean; active?: 'evolution' | 'waha'; evolution?: Record<string, unknown>; waha?: Record<string, unknown> } = {}) {
    const workspaceId = `health-${randomUUID()}`; workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `inst-${randomUUID()}` } });
    const base = { status: 'connected' as const, health: 'healthy' as const, eligible: true, verifiedPhoneNumber: PHONE, lastHealthyAt: new Date(), connectedAt: new Date(Date.now() - 60 * MIN) };
    const evolution = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, ...base, ...opts.evolution } });
    const waha = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: `waha-${randomUUID()}`, ...base, ...opts.waha } });
    await db.channel.update({ where: { id: channel.id }, data: { redundancyEnabled: opts.redundancy ?? true, activeConnectionId: (opts.active ?? 'evolution') === 'evolution' ? evolution.id : waha.id } });
    return { workspaceId, channelId: channel.id, evolution, waha };
  }

  /** Foreign keys are bypassed on purpose: the monitor only reads (connection, identity, time). */
  async function observe(f: { workspaceId: string; channelId: string }, connection: { id: string; provider: 'evolution' | 'waha' }, identityId: string, receivedAt: Date) {
    await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`INSERT INTO canonical_observations (id, workspace_id, channel_id, channel_provider, provider, connection_provider, connection_id, identity_id, receipt_hash, receipt_tuple, kind, event_type, mode, session_name, lifecycle_generation, received_at, source_order, payload, state)
        VALUES (${randomUUID()}::uuid, ${f.workspaceId}, ${f.channelId}::uuid, 'evolution', ${connection.provider}, ${connection.provider}::"ChannelConnectionProvider", ${connection.id}::uuid, ${identityId}::uuid, ${randomUUID().replaceAll('-', '').padEnd(64, '0')}, '{}'::jsonb, 'message', 'messages.upsert', 'live', 's', 0, (${receivedAt}::timestamptz AT TIME ZONE 'UTC'), '{}'::jsonb, '{}'::jsonb, 'applied')`;
    });
  }
  const identities = (n: number) => Array.from({ length: n }, () => randomUUID());
  const ago = (clock: Date, ms: number) => new Date(clock.getTime() - ms);
  const connectionOf = (id: string) => db.channelConnection.findUniqueOrThrow({ where: { id } });
  const activeOf = async (channelId: string) => (await db.channel.findUniqueOrThrow({ where: { id: channelId } })).activeConnectionId;

  function monitor(clockRef: { now: Date }, extra: Partial<Parameters<typeof createChannelHealthMonitor>[0]> = {}) {
    const changes: WriterChange[] = [];
    const m = createChannelHealthMonitor({ db, probe: async () => undefined, now: () => clockRef.now, onWriterChange: change => { changes.push(change); }, ...extra });
    return { m, changes };
  }

  describe('receive-loss detection', () => {
    it('marks a connection that missed three live messages the other one saw as degraded, and moves the writer off it', async () => {
      const f = await fixture(), clock = { now: new Date() };
      for (const id of identities(3)) await observe(f, f.waha, id, ago(clock.now, MIN));
      const { m, changes } = monitor(clock);
      expect(await m.evaluate({ workspaceId: f.workspaceId, id: f.channelId })).toEqual({ changed: true });
      expect(await connectionOf(f.evolution.id)).toMatchObject({ health: 'degraded', lastError: 'RECEIVE_LOSS' });
      expect(await connectionOf(f.waha.id)).toMatchObject({ health: 'healthy' });
      expect(await activeOf(f.channelId)).toBe(f.waha.id);
      expect(changes).toEqual([{ workspaceId: f.workspaceId, channelId: f.channelId, from: f.evolution.id, to: f.waha.id, reason: 'receive_loss' }]);
    });

    it('needs three, ignores the last ten seconds, and a message both connections saw is no loss', async () => {
      const f = await fixture(), clock = { now: new Date() }, { m } = monitor(clock);
      const [a, b, both, fresh1, fresh2, fresh3] = identities(6);
      await observe(f, f.waha, a!, ago(clock.now, MIN)); await observe(f, f.waha, b!, ago(clock.now, MIN));
      await observe(f, f.waha, both!, ago(clock.now, MIN)); await observe(f, f.evolution, both!, ago(clock.now, MIN));
      for (const id of [fresh1!, fresh2!, fresh3!]) await observe(f, f.waha, id, ago(clock.now, 3_000));
      expect(await m.evaluate({ workspaceId: f.workspaceId, id: f.channelId })).toEqual({ changed: false });
      expect(await connectionOf(f.evolution.id)).toMatchObject({ health: 'healthy', lastError: null });
      expect(await activeOf(f.channelId)).toBe(f.evolution.id);
    });

    it('never judges a connection on messages from before it was connected, or silence on its own', async () => {
      const f = await fixture({ waha: { connectedAt: new Date() } }), clock = { now: new Date() }, { m } = monitor(clock);
      for (const id of identities(4)) await observe(f, f.evolution, id, ago(clock.now, MIN));
      expect(await m.evaluate({ workspaceId: f.workspaceId, id: f.channelId })).toEqual({ changed: false });
      expect(await connectionOf(f.waha.id)).toMatchObject({ health: 'healthy' });
      const quiet = await fixture();
      expect(await monitor(clock).m.evaluate({ workspaceId: quiet.workspaceId, id: quiet.channelId })).toEqual({ changed: false });
      expect(await connectionOf(quiet.evolution.id)).toMatchObject({ health: 'healthy' });
    });
  });

  describe('sticky receive loss', () => {
    it('takes a WAHA that stopped receiving out of the writers, and clears the mark only when it receives again', async () => {
      const f = await fixture(), clock = { now: new Date() }, { m } = monitor(clock);
      for (const id of identities(3)) await observe(f, f.evolution, id, ago(clock.now, MIN));
      await m.evaluate({ workspaceId: f.workspaceId, id: f.channelId });
      expect(await connectionOf(f.waha.id)).toMatchObject({ health: 'degraded', lastError: 'RECEIVE_LOSS', eligible: false });
      expect(await connectionOf(f.evolution.id)).toMatchObject({ eligible: true });
      // Quiet minutes later: no new evidence either way, the mark stays.
      clock.now = new Date(clock.now.getTime() + 5 * MIN);
      await m.evaluate({ workspaceId: f.workspaceId, id: f.channelId });
      expect(await connectionOf(f.waha.id)).toMatchObject({ lastError: 'RECEIVE_LOSS' });
      // It receives again: a live message both connections got, none missed.
      const both = randomUUID();
      await observe(f, f.evolution, both, ago(clock.now, 30_000)); await observe(f, f.waha, both, ago(clock.now, 30_000));
      await m.evaluate({ workspaceId: f.workspaceId, id: f.channelId });
      expect(await connectionOf(f.waha.id)).toMatchObject({ lastError: null });
    });
  });

  describe('writer selection', () => {
    it('moves the writer when the active connection cannot write, and not when the other cannot either', async () => {
      const f = await fixture({ evolution: { health: 'unhealthy', eligible: false } }), clock = { now: new Date() }, { m, changes } = monitor(clock);
      await m.evaluate({ workspaceId: f.workspaceId, id: f.channelId });
      expect(await activeOf(f.channelId)).toBe(f.waha.id);
      expect(changes[0]).toMatchObject({ reason: 'writer_unavailable', to: f.waha.id });
      const none = await fixture({ evolution: { status: 'disconnected' }, waha: { status: 'disconnected' } });
      expect(await monitor(clock).m.evaluate({ workspaceId: none.workspaceId, id: none.channelId })).toEqual({ changed: false });
      expect(await activeOf(none.channelId)).toBe(none.evolution.id);
    });

    it('does not override a change somebody else made in the meantime, and ignores channels without redundancy', async () => {
      const f = await fixture({ evolution: { health: 'unhealthy' } }), clock = { now: new Date() };
      const racing = createChannelHealthMonitor({ db, probe: async () => undefined, now: () => clock.now });
      const original = db.channel.updateMany.bind(db.channel);
      const spy = vi.spyOn(db.channel, 'updateMany').mockImplementationOnce((async (args: never) => { await db.channel.update({ where: { id: f.channelId }, data: { activeConnectionId: null } }); return original(args); }) as never);
      expect(await racing.evaluate({ workspaceId: f.workspaceId, id: f.channelId })).toEqual({ changed: false });
      spy.mockRestore();
      expect(await activeOf(f.channelId)).toBeNull();
      const legacy = await fixture({ redundancy: false, evolution: { health: 'unhealthy' } });
      expect(await monitor(clock).m.evaluate({ workspaceId: legacy.workspaceId, id: legacy.channelId })).toEqual({ changed: false });
    });
  });

  describe('return to the primary', () => {
    it('returns only after ten unbroken healthy minutes with real events seen by both, and not while the primary misses messages', async () => {
      const f = await fixture({ active: 'waha' }), clock = { now: new Date() }, { m, changes } = monitor(clock);
      const scope = { workspaceId: f.workspaceId, id: f.channelId };
      await m.evaluate(scope);                       // starts the stability clock
      expect(await activeOf(f.channelId)).toBe(f.waha.id);
      clock.now = new Date(clock.now.getTime() + 11 * MIN);
      expect(await m.evaluate(scope)).toEqual({ changed: false });   // stable, but no agreeing events yet
      const shared = randomUUID();
      await observe(f, f.waha, shared, ago(clock.now, 2 * MIN)); await observe(f, f.evolution, shared, ago(clock.now, 2 * MIN));
      for (const id of identities(3)) await observe(f, f.waha, id, ago(clock.now, MIN));   // the primary missed these
      expect(await m.evaluate(scope)).toEqual({ changed: false });
      expect(await activeOf(f.channelId)).toBe(f.waha.id);
      expect(await connectionOf(f.evolution.id)).toMatchObject({ health: 'degraded', lastError: 'RECEIVE_LOSS' });
      await db.channelConnection.update({ where: { id: f.evolution.id }, data: { health: 'healthy', lastError: null } });
      clock.now = new Date(clock.now.getTime() + 3 * MIN);   // the misses leave the two-minute window
      expect(await m.evaluate(scope)).toEqual({ changed: false });   // healthy again, but the ten minutes start over
      clock.now = new Date(clock.now.getTime() + 11 * MIN);
      const again = randomUUID();
      await observe(f, f.waha, again, ago(clock.now, MIN)); await observe(f, f.evolution, again, ago(clock.now, MIN));
      expect(await m.evaluate(scope)).toEqual({ changed: true });
      expect(await activeOf(f.channelId)).toBe(f.evolution.id);
      expect(changes.at(-1)).toMatchObject({ reason: 'primary_recovered', to: f.evolution.id });
    });

    it('a break in health restarts the ten minutes', async () => {
      const f = await fixture({ active: 'waha' }), clock = { now: new Date() }, { m } = monitor(clock);
      const scope = { workspaceId: f.workspaceId, id: f.channelId };
      const shared = randomUUID();
      await observe(f, f.waha, shared, ago(clock.now, MIN)); await observe(f, f.evolution, shared, ago(clock.now, MIN));
      await m.evaluate(scope);
      clock.now = new Date(clock.now.getTime() + 6 * MIN);
      await db.channelConnection.update({ where: { id: f.evolution.id }, data: { health: 'degraded' } });
      await m.evaluate(scope);
      await db.channelConnection.update({ where: { id: f.evolution.id }, data: { health: 'healthy' } });
      clock.now = new Date(clock.now.getTime() + 6 * MIN);
      await m.evaluate(scope);                       // 12 minutes since the start, but only 6 unbroken
      expect(await activeOf(f.channelId)).toBe(f.waha.id);
    });
  });

  describe('tick', () => {
    it('probes both connections of every redundant channel, survives a failing probe, and skips legacy channels', async () => {
      const f = await fixture(), legacy = await fixture({ redundancy: false });
      const probe = vi.fn(async (scope: { connectionId: string }) => { if (scope.connectionId === f.evolution.id) throw new Error('provider down'); });
      const warn = vi.fn();
      await createChannelHealthMonitor({ db, probe, logger: { warn } }).tick();
      const probed = probe.mock.calls.map(([scope]) => scope.connectionId);
      expect(probed).toEqual(expect.arrayContaining([f.evolution.id, f.waha.id]));
      expect(probed).not.toContain(legacy.evolution.id);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ connectionId: f.evolution.id }), 'Connection probe failed');
    });
  });

  describe('three consecutive failed probes', () => {
    it('keeps a provider that merely failed to answer eligible for two probes and takes it down on the third', async () => {
      const f = await fixture({ waha: { status: 'disconnected', eligible: false, health: 'unknown', verifiedPhoneNumber: null, lastHealthyAt: null } });
      const getConnectionState = vi.fn(async () => { throw new Error('evolution unreachable'); });
      const service = createChannelConnectionsService(db, { evolution: { mode: 'real', client: { getConnectionState, getInstanceIdentity: vi.fn() } } as never });
      const scope = { workspaceId: f.workspaceId, channelId: f.channelId, connectionId: f.evolution.id };
      await service.refresh(scope);
      expect(await connectionOf(f.evolution.id)).toMatchObject({ health: 'degraded', consecutiveFailures: 1 });
      await service.refresh(scope);
      expect(await connectionOf(f.evolution.id)).toMatchObject({ health: 'degraded', consecutiveFailures: 2 });
      await service.refresh(scope);
      expect(await connectionOf(f.evolution.id)).toMatchObject({ health: 'unhealthy', consecutiveFailures: 3, eligible: false, lastError: 'PROVIDER_UNAVAILABLE' });
    });
  });
});
