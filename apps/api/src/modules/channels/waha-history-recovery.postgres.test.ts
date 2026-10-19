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
    expect(advanced).toBe(true); expect(seen.size).toBe(173); expect(persist).toHaveBeenCalledTimes(173); expect(read.mock.calls.map(([q]) => q.offset)).toEqual([0,50,100,150,173,0,50,100,150,173]);
    expect((await load(c)).historyRecoveryCursor).toBeNull();
  });
  it('retries a partially persisted page after restart without moving the cursor past it', async () => {
    const c = await fixture(), now = Date.now(), read = provider([row(1, now - 500_000), row(2, now - 500_000)]), seen = new Set<string>(); let crash = true;
    const persist = async (rows: WahaMessage[]) => { for (const r of rows) { seen.add(r.id); if (crash) { crash = false; throw Error('synthetic crash after first canonical commit'); } } return { inserted: 0, held: 0 }; };
    await expect(recoverWahaWindow(db, c, { read, persist }, { now })).rejects.toThrow('synthetic crash');
    expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt); await due(c);
    expect(await recoverWahaWindow(db, await load(c), { read, persist }, { now, maxPages: 8 })).toMatchObject({ advanced: true }); expect(seen.size).toBe(2); expect(read.mock.calls[1][0].offset).toBe(0);
  });
  it('durably yields within a dense page and resumes rows rather than restarting the prefix', async () => {
    const c = await fixture(), now = Date.now(), rows = Array.from({ length: 50 }, (_, i) => row(i, now - 500_000));
    const read = provider(rows), seen = new Set<string>(); let tick = 0;
    const persist = vi.fn(async (messages: WahaMessage[]) => { for (const m of messages) { seen.add(m.id); tick += 300; } return { inserted: messages.length, held: 0 }; });
    await recoverWahaWindow(db, c, { read, persist }, { now, maxMs: 1000, clock: () => now + tick });
    expect(seen.size).toBeGreaterThan(0); expect(seen.size).toBeLessThan(50);
    expect((await load(c)).historyRecoveryCursor).toMatchObject({ offset: 0, partial: { completed: seen.size } });
    for (let i = 0; i < 60 && (await load(c)).recoveredThroughAt?.getTime() === c.recoveredThroughAt?.getTime(); i++) {
      await due(c); tick = 0;
      await recoverWahaWindow(db, await load(c), { read, persist }, { now, maxMs: 1000, clock: () => now + tick });
    }
    expect(seen.size).toBe(50); expect((await load(c)).historyRecoveryCursor).toBeNull();
    expect(persist.mock.calls.flatMap(([m]) => m).length).toBe(50);
  });
  it('replays a changed partial page and fences a replaced lease before recording progress', async () => {
    const c=await fixture(),now=Date.now(),rows=Array.from({length:12},(_,i)=>row(i,now-500_000)),read=provider(rows),seen=new Set<string>();
    const persist=async(messages:WahaMessage[])=>{let inserted=0;for(const m of messages)if(!seen.has(m.id)){seen.add(m.id);inserted++;}return {inserted,held:0};};
    await recoverWahaWindow(db,c,{read,persist},{now,maxItems:2});
    expect((await load(c)).historyRecoveryCursor).toMatchObject({offset:0,partial:{completed:2}});
    rows.unshift(row(90,now-501_000)); await due(c);
    expect(await recoverWahaWindow(db,await load(c),{read,persist},{now,maxPages:8})).toMatchObject({advanced:true});expect(seen.size).toBe(13);
    const d=await fixture(); const replaced=async(messages:WahaMessage[])=>{await db.channelConnection.update({where:{id:d.id},data:{historyRecoveryLeaseToken:randomUUID()}});return persist(messages);};
    await expect(recoverWahaWindow(db,d,{read,persist:replaced},{now})).rejects.toThrow('HISTORY_LEASE_LOST');expect((await load(d)).recoveredThroughAt).toEqual(d.recoveredThroughAt);
  });
  it('bounds metadata row-lock waits instead of waiting behind a lifecycle transaction', async () => {
    const c=await fixture(); let ready!:()=>void,release!:()=>void;const acquired=new Promise<void>(r=>{ready=r;}),gate=new Promise<void>(r=>{release=r;});
    const blocker=db.$transaction(async tx=>{await tx.channelConnection.update({where:{id:c.id},data:{historyRecoveryFailures:0}});ready();await gate;},{timeout:5000});
    await acquired;const began=Date.now();
    try {await expect(recoverWahaWindow(db,c,{read:vi.fn(),persist:vi.fn()},{maxMs:1000})).rejects.toThrow();expect(Date.now()-began).toBeLessThan(1500);}
    finally {release();await blocker;}
    expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
  it('enforces the cumulative scan budget before persistence when a valid page plus durable manifests exceed 8MiB', async () => {
    const c=await fixture(),now=Date.now(),base=c.recoveredThroughAt!.getTime();
    await db.channelConnection.update({where:{id:c.id},data:{historyRecoveryCursor:{version:1,generation:c.lifecycleGeneration,checkpoint:c.recoveredThroughAt!.toISOString(),
      from:Math.floor((base-600_000)/1000),to:Math.floor((base+300_000)/1000),offset:50_000,pages:Array.from({length:1000},(_,i)=>historyDigest(i)),previousPages:Array.from({length:1000},(_,i)=>historyDigest(i+1000)),changedPasses:0}}});
    const persist=vi.fn(async()=>({inserted:1,held:0})),message={...row(1,now-500_000),body:'x'.repeat(8_300_000)};
    const read=async(q:WahaRecoveryQuery)=>({messages:[message],rawDigest:'f'.repeat(64),rawCount:1,nextOffset:q.offset+1,exhausted:false});
    await expect(recoverWahaWindow(db,await load(c),{read,persist},{now,maxPages:1,maxItems:1})).rejects.toThrow('HISTORY_SCAN_LIMIT');
    expect(persist).not.toHaveBeenCalled();expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
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
  it('refuses an anchor changed during an empty verification window and repeated raw control pagination', async () => {
    const c=await fixture(),now=Date.now();
    const changed=async(q:WahaRecoveryQuery)=>{await db.channel.update({where:{id:c.channelId},data:{verifiedMessagingPhoneNumber:'15550009999'}});return {messages:[],rawDigest:'a'.repeat(64),rawCount:0,nextOffset:q.offset,exhausted:true};};
    await expect(recoverWahaWindow(db,c,{read:changed,persist:vi.fn()},{now})).rejects.toThrow('HISTORY_SOURCE_CHANGED');expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
    const d=await fixture(),read=async(q:WahaRecoveryQuery)=>({messages:[],rawDigest:'a'.repeat(64),rawCount:50,nextOffset:q.offset+50,exhausted:false});
    await expect(recoverWahaWindow(db,d,{read,persist:vi.fn()},{now,maxPages:8})).rejects.toThrow('HISTORY_PAGINATION');expect((await load(d)).recoveredThroughAt).toEqual(d.recoveredThroughAt);
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
