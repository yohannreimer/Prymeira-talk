import { randomUUID } from 'node:crypto';
import { PrismaClient, type ChannelConnection } from '@prisma/client';
import { afterAll, beforeAll, expect, it, describe, vi } from 'vitest';
import { historyDigest } from './history-memory-budget.js';
import { recoverWahaWindow } from './waha-history-recovery.js';
import type { WahaMessage, WahaRecoveryQuery } from '../waha/waha.client.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('bounded durable WAHA recovery on owned PostgreSQL', () => {
  let db: PrismaClient; const workspaces: string[] = [];
  beforeAll(async () => { const u = new URL(url!); if (u.hostname !== '127.0.0.1' || u.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || u.pathname !== '/messaging_test') throw Error('Owned PostgreSQL required'); db = new PrismaClient({ datasources: { db: { url } } }); });
  afterAll(async () => { if (db) { await db.channel.deleteMany({ where: { workspaceId: { in: workspaces } } }); await db.$disconnect(); } });
  async function fixture() { const workspaceId = randomUUID(); workspaces.push(workspaceId); const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } }); return db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: randomUUID(), status: 'connected', eligible: true, recoveredThroughAt: new Date(Date.now() - 600_000) } }); }
  const row = (id: number, at: number): WahaMessage => ({ id: `false_15550000001@c.us_M${id}`, timestamp: Math.floor(at / 1000), fromMe: false, body: 'synthetic' });
  function provider(messages: WahaMessage[]) { return vi.fn(async (q: WahaRecoveryQuery) => { const all = messages.filter(m => m.timestamp! >= q.from && m.timestamp! <= q.to); const page = all.slice(q.offset, q.offset + q.limit); return { messages: page, rawDigest: historyDigest(page), rawCount: page.length, nextOffset: q.offset + page.length, exhausted: !page.length }; }); }
  const load = async (c: ChannelConnection) => db.channelConnection.findUniqueOrThrow({ where: { id: c.id } });
  const due = async (c: ChannelConnection) => db.channelConnection.update({ where: { id: c.id }, data: { historyRecoveryNextAttemptAt: null } });
  it('recovers a reconnect gap before a twenty-day backlog without advancing old coverage', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, initial = await fixture(), checkpoint = new Date(now - 20 * 86400_000);
    const c = await db.channelConnection.update({ where: { id: initial.id }, data: { recoveredThroughAt: checkpoint, disconnectedAt: new Date(now - 120_000) } });
    const read = provider([row(1, checkpoint.getTime() + 60_000), row(2, now - 60_000)]), persisted: string[] = [];
    const persist = async (m: WahaMessage[]) => { persisted.push(...m.map(x => x.id)); return { inserted: m.length, held: 0 }; };
    await recoverWahaWindow(db, c, { read, persist }, { now, maxPages: 8 });
    expect(read.mock.calls[0][0].from).toBeGreaterThanOrEqual((now - 25 * 60_000) / 1000);
    expect(persisted).toContain(row(2, now).id); expect(persisted).not.toContain(row(1, now).id);
    expect((await load(c)).recoveredThroughAt).toEqual(checkpoint);
  });
  it('a new reconnect bypasses an old backlog backoff', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, initial = await fixture();
    const c = await db.channelConnection.update({ where: { id: initial.id }, data: { recoveredThroughAt: new Date(now - 20 * 86400_000), disconnectedAt: new Date(now - 120_000), historyRecoveryFailures: 6, historyRecoveryNextAttemptAt: new Date(now + 3600_000) } });
    const read = provider([row(2, now - 60_000)]), persist = vi.fn(async (m: WahaMessage[]) => ({ inserted: m.length, held: 0 }));
    await recoverWahaWindow(db, c, { read, persist }, { now, maxPages: 8 });
    expect(persist).toHaveBeenCalledOnce(); expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
  it('retains an unfinished recent gap across restart and another physical reconnect', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, initial = await fixture();
    const c = await db.channelConnection.update({ where: { id: initial.id }, data: { recoveredThroughAt: new Date(now - 20 * 86400_000), disconnectedAt: new Date(now - 120_000) } });
    const messages = Array.from({ length: 73 }, (_, i) => row(i, now - 60_000)), read = provider(messages), seen = new Set<string>();
    const persist = async (m: WahaMessage[]) => { let inserted = 0; for (const x of m) if (!seen.has(x.id)) { seen.add(x.id); inserted++; } return { inserted, held: 0 }; };
    await recoverWahaWindow(db, c, { read, persist }, { now, maxPages: 1 });
    const later = now + 10 * 60_000; messages.push(row(100, later - 60_000));
    await db.channelConnection.update({ where: { id: c.id }, data: { lifecycleGeneration: 2, disconnectedAt: new Date(later - 120_000) } });
    for (let n = 0; n < 15 && seen.size < 74; n++) { await due(c); await recoverWahaWindow(db, await load(c), { read, persist }, { now: later, maxPages: 2 }); }
    expect(seen.size).toBe(74); expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
  it('continues old work between recent checks and isolates an old hold from the next reconnect', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, initial = await fixture(), checkpoint = new Date(now - 20 * 86400_000);
    const c = await db.channelConnection.update({ where: { id: initial.id }, data: { recoveredThroughAt: checkpoint, disconnectedAt: new Date(now - 120_000) } });
    const messages = [row(1, checkpoint.getTime() + 60_000), row(2, now - 60_000)], read = provider(messages), seen = new Set<string>();
    const persist = async (m: WahaMessage[]) => { if (m.some(x => x.id === row(1, now).id)) return { inserted: 0, held: 1 }; for (const x of m) seen.add(x.id); return { inserted: m.length, held: 0 }; };
    await recoverWahaWindow(db, c, { read, persist }, { now, maxPages: 8 });
    await expect(recoverWahaWindow(db, await load(c), { read, persist }, { now: now + 30_000, maxPages: 8 })).rejects.toThrow('HISTORY_CANONICAL_HOLD');
    const later = now + 120_000; messages.push(row(3, later - 60_000));
    await db.channelConnection.update({ where: { id: c.id }, data: { lifecycleGeneration: 2, disconnectedAt: new Date(now + 45_000) } });
    await recoverWahaWindow(db, await load(c), { read, persist }, { now: later, maxPages: 8 });
    expect(seen.has(row(3, now).id)).toBe(true); expect((await load(c)).recoveredThroughAt).toEqual(checkpoint);
  });
  it('preserves an in-progress legacy backlog cursor while completing recent recovery first', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, initial = await fixture(), checkpoint = new Date(now - 20 * 86400_000);
    const oldCursor = { version: 1, generation: 0, checkpoint: checkpoint.toISOString(), from: checkpoint.getTime() / 1000 - 600,
      to: checkpoint.getTime() / 1000 + 300, offset: 50, pages: ['a'.repeat(64)], previousPages: null, changedPasses: 0 };
    const c = await db.channelConnection.update({ where: { id: initial.id }, data: { recoveredThroughAt: checkpoint, historyRecoveryCursor: oldCursor } });
    const read = provider([row(2, now - 60_000)]), persist = async (m: WahaMessage[]) => ({ inserted: m.length, held: 0 });
    await recoverWahaWindow(db, c, { read, persist }, { now, maxPages: 8 });
    const saved = (await load(c)).historyRecoveryCursor as unknown as { backlog: { cursor: unknown } };
    expect(saved.backlog.cursor).toEqual(oldCursor);
    read.mockClear(); await recoverWahaWindow(db, await load(c), { read, persist }, { now, maxPages: 1 });
    expect(read.mock.calls[0][0].offset).toBe(50); expect((await load(c)).recoveredThroughAt).toEqual(checkpoint);
  });
  it('resumes dense priority pages after process restarts and certifies only after both complete passes', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, initial = await fixture();
    const c = await db.channelConnection.update({ where: { id: initial.id }, data: { recoveredThroughAt: new Date(now - 20 * 86400_000) } });
    const read = provider(Array.from({ length: 173 }, (_, i) => row(i, now - 60_000))), seen = new Set<string>();
    const persist = async (m: WahaMessage[]) => { let inserted = 0; for (const x of m) if (!seen.has(x.id)) { seen.add(x.id); inserted++; } return { inserted, held: 0 }; };
    let advanced = false;
    for (let n = 0; n < 12 && !advanced; n++) {
      advanced = (await recoverWahaWindow(db, await load(c), { read, persist }, { now, clock: () => now + n * 31_000, maxPages: 1 })).advanced;
      const state = (await load(c)).historyRecoveryCursor as unknown as { recentThroughAt: string | null };
      if (!advanced) expect(state.recentThroughAt).toBeNull();
    }
    expect(advanced).toBe(true); expect(seen.size).toBe(173);
    expect(read.mock.calls.map(([q]) => q.offset)).toEqual([0, 50, 100, 150, 173, 0, 50, 100, 150, 173]);
    expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
  it('a recent provider failure backs off only that lane while old coverage can progress', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, initial = await fixture(), checkpoint = new Date(now - 20 * 86400_000);
    const c = await db.channelConnection.update({ where: { id: initial.id }, data: { recoveredThroughAt: checkpoint } });
    const base = provider([row(1, checkpoint.getTime() + 60_000)]);
    const read = vi.fn(async (q: WahaRecoveryQuery) => { if (q.from > checkpoint.getTime() / 1000 + 1000) throw Error('synthetic provider failure'); return base(q); });
    const persist = async (m: WahaMessage[]) => ({ inserted: m.length, held: 0 });
    await expect(recoverWahaWindow(db, c, { read, persist }, { now })).rejects.toThrow('synthetic provider failure');
    await recoverWahaWindow(db, await load(c), { read, persist }, { now, maxPages: 8 });
    expect((await load(c)).recoveredThroughAt!.getTime()).toBe(checkpoint.getTime() + 300_000);
    const state = (await load(c)).historyRecoveryCursor as unknown as { recent: { failures: number }; recentThroughAt: string | null };
    expect(state.recent.failures).toBe(1); expect(state.recentThroughAt).toBeNull();
  });
  it('fences priority work on another reconnect before any stale page is persisted', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000, initial = await fixture();
    const c = await db.channelConnection.update({ where: { id: initial.id }, data: { recoveredThroughAt: new Date(now - 20 * 86400_000) } });
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { started = r; });
    const read = async (q: WahaRecoveryQuery) => { started(); await gate; return provider([row(2, now - 60_000)])(q); }, persist = vi.fn(async () => ({ inserted: 1, held: 0 }));
    const running = recoverWahaWindow(db, c, { read, persist }, { now }); await ready;
    expect(await recoverWahaWindow(db, c, { read: vi.fn(), persist }, { now })).toMatchObject({ advanced: false });
    await db.channelConnection.update({ where: { id: c.id }, data: { lifecycleGeneration: 2 } }); release();
    await expect(running).rejects.toThrow('HISTORY_LEASE_LOST'); expect(persist).not.toHaveBeenCalled();
    expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
  it('does not page through ancient messages and advances only after two identical exhausted passes', async () => {
    const c = await fixture(), now = Date.now(); const read = provider([...Array.from({ length: 7300 }, (_, i) => row(i, now - 86400_000)), row(8000, now - 500_000)]), persist = vi.fn(async (m: WahaMessage[]) => ({ inserted: m.length, held: 0 }));
    const result = await recoverWahaWindow(db, c, { read, persist }, { now, maxPages: 8 });
    expect(result).toMatchObject({ recovered: 1, advanced: true }); expect(read).toHaveBeenCalledTimes(4); expect(persist).toHaveBeenCalledOnce();
    expect((await load(c)).recoveredThroughAt!.getTime()).toBe(Math.floor((c.recoveredThroughAt!.getTime() + 300_000) / 1000) * 1000);
  });
  it('resumes a dense window across processes and never caps the number of recoverable messages', async () => {
    const c = await fixture(), now = Date.now(), messages = Array.from({ length: 173 }, (_, i) => row(i, now - 500_000));
    const read = provider(messages), seen = new Set<string>(), persist = vi.fn(async (rows: WahaMessage[]) => { let inserted = 0; for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); inserted++; } return { inserted, held: 0 }; });
    let advanced = false;
    for (let i = 0; i < 12 && !advanced; i++) { await due(c); advanced = (await recoverWahaWindow(db, await load(c), { read, persist }, { now, maxPages: 1 })).advanced; }
    expect(advanced).toBe(true); expect(seen.size).toBe(173); expect(persist).toHaveBeenCalledTimes(4); expect(read.mock.calls.map(([q]) => q.offset)).toEqual([0,50,100,150,173,0,50,100,150,173]);
    expect((await load(c)).historyRecoveryCursor).toBeNull();
  });
  it('retries a partially persisted page after restart without moving the cursor past it', async () => {
    const c = await fixture(), now = Date.now(), read = provider([row(1, now - 500_000), row(2, now - 500_000)]), seen = new Set<string>(); let crash = true;
    const persist = async (rows: WahaMessage[]) => { for (const r of rows) { seen.add(r.id); if (crash) { crash = false; throw Error('synthetic crash after first canonical commit'); } } return { inserted: 0, held: 0 }; };
    await expect(recoverWahaWindow(db, c, { read, persist }, { now })).rejects.toThrow('synthetic crash');
    expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt); await due(c);
    expect(await recoverWahaWindow(db, await load(c), { read, persist }, { now, maxPages: 8 })).toMatchObject({ advanced: true }); expect(seen.size).toBe(2); expect(read.mock.calls[1][0].offset).toBe(0);
  });
  it('continues past a raw page containing only hidden control records', async () => {
    const c = await fixture(), now = Date.now(), persist = vi.fn(async (m: WahaMessage[]) => ({ inserted: m.length, held: 0 }));
    const read = vi.fn(async (q: WahaRecoveryQuery) => q.offset === 0 ? { messages: [], rawDigest: 'a'.repeat(64), rawCount: 50, nextOffset: 50, exhausted: false } : q.offset === 50 ? { messages: [row(1, now - 500_000)], rawDigest: 'b'.repeat(64), rawCount: 1, nextOffset: 51, exhausted: false } : { messages: [], rawDigest: 'c'.repeat(64), rawCount: 0, nextOffset: 51, exhausted: true });
    expect(await recoverWahaWindow(db, c, { read, persist }, { now, maxPages: 8 })).toMatchObject({ advanced: true, recovered: 1 }); expect(read.mock.calls.map(([q])=>q.offset)).toEqual([0,50,51,0,50,51]);
  });
  it('does not certify a window changed during pagination; later stable passes recover the new row', async () => {
    const c = await fixture(), now = Date.now(), rows = [row(1, now - 500_000)], seen = new Set<string>(); let changed = false;
    const read = provider(rows), persist = async (m: WahaMessage[]) => { for(const r of m) seen.add(r.id); if(!changed){ rows.unshift(row(2, now - 501_000)); changed=true; } return {inserted:m.length,held:0}; };
    await recoverWahaWindow(db,c,{read,persist},{now,maxPages:4}); expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt); await due(c);
    expect(await recoverWahaWindow(db,await load(c),{read,persist},{now,maxPages:8})).toMatchObject({advanced:true}); expect(seen.size).toBe(2);
  });
  it('rejects ignored timestamp filters without persisting or advancing', async () => {
    const c=await fixture(), now=Date.now(), persist=vi.fn(); const read=async(q:WahaRecoveryQuery)=>({messages:[row(1,now-86400_000)],rawDigest:'a'.repeat(64),rawCount:1,nextOffset:q.offset+1,exhausted:false});
    await expect(recoverWahaWindow(db,c,{read,persist},{now})).rejects.toThrow('HISTORY_FILTER_IGNORED'); expect(persist).not.toHaveBeenCalled(); expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
  it('leaves held normalization pending with backoff and does not re-read while cooling down', async()=>{
    const c=await fixture(),now=Date.now(),read=provider([row(1,now-500_000)]),persist=async()=>({inserted:0,held:1});
    await expect(recoverWahaWindow(db,c,{read,persist},{now})).rejects.toThrow('HISTORY_CANONICAL_HOLD'); const before=read.mock.calls.length;
    expect((await load(c)).historyRecoveryFailures).toBe(1); await recoverWahaWindow(db,await load(c),{read,persist},{now}); expect(read).toHaveBeenCalledTimes(before);
  });
  it('fences concurrent workers and refuses checkpoint advancement after lifecycle changes', async()=>{
    const c=await fixture(),now=Date.now(); let release!:()=>void; const gate=new Promise<void>(r=>{release=r;}); const base=provider([row(1,now-500_000)]); let started!:()=>void; const ready=new Promise<void>(r=>{started=r;});
    const read=async(q:WahaRecoveryQuery)=>{started();await gate;return base(q);},persist=async(m:WahaMessage[])=>({inserted:m.length,held:0});
    const running=recoverWahaWindow(db,c,{read,persist},{now});await ready;
    expect(await recoverWahaWindow(db,c,{read:vi.fn(),persist},{now})).toMatchObject({advanced:false});
    await db.channelConnection.update({where:{id:c.id},data:{lifecycleGeneration:2}});release();await expect(running).rejects.toThrow('HISTORY_LEASE_LOST'); expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
});
