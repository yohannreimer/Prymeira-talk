import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma, PrismaClient, type ChannelConnection } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEvolutionHistorySource, type HistoryRecord } from '../evolution/evolution-history.js';
import { historyDigest } from './history-memory-budget.js';
import { recoverEvolutionWindow } from './evolution-history-recovery.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('durable bounded Evolution recovery on owned PostgreSQL', () => {
  let db: PrismaClient; const workspaces: string[] = [];
  beforeAll(() => { const u = new URL(url!); if (u.hostname !== '127.0.0.1' || u.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || u.pathname !== '/messaging_test') throw Error('Owned PostgreSQL required'); db = new PrismaClient({ datasources: { db: { url } } }); });
  afterAll(async () => { if (db) { await db.channel.deleteMany({ where: { workspaceId: { in: workspaces } } }); await db.$disconnect(); } });
  const pn = '15550000001@s.whatsapp.net';
  const row = (id: number, timestamp: number, fromMe = false): HistoryRecord => ({ key: { id: `M${String(id).padStart(4, '0')}`, remoteJid: pn, fromMe }, messageTimestamp: Math.floor(timestamp / 1000), message: { conversation: 'synthetic' } });
  async function fixture() { const workspaceId = randomUUID(); workspaces.push(workspaceId); const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } }); return db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: randomUUID(), status: 'connected', eligible: true, recoveredThroughAt: new Date(Date.now() - 600_000) } }); }
  const load = (c: ChannelConnection) => db.channelConnection.findUniqueOrThrow({ where: { id: c.id } });
  const due = (c: ChannelConnection) => db.channelConnection.update({ where: { id: c.id }, data: { historyRecoveryNextAttemptAt: null } });
  function knownCleanupTimeout(error: unknown) {
    const value = error as { code?: string; message?: string; meta?: { code?: string } };
    return (value?.code === 'P2028' && /Transaction not found|expired transaction|Transaction already closed/i.test(value.message ?? ''))
      || (value?.code === 'P2010' && ['55P03', '57014'].includes(value.meta?.code ?? ''));
  }
  /** Observe only the 250 ms cleanup boundary. Other SQL/provider failures are
   * never treated as a yielded turn. Preserve the exact last durable cursor. */
  function observeCleanup(c: ChannelConnection, firstCleanup?: () => Promise<() => Promise<void>>) {
    const timeouts = new Map<unknown, { before: ChannelConnection; elapsedMs: number }>(); let cleanups = 0;
    const proxy = new Proxy(db, { get(target, property) {
      if (property === '$transaction') return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => {
        if (options?.timeout !== 250) return target.$transaction(work, options);
        const before = await load(c), release = ++cleanups === 1 ? await firstCleanup?.() : undefined, began = Date.now();
        try { return await target.$transaction(work, options); }
        catch (error) { const elapsedMs = Date.now()-began; if (knownCleanupTimeout(error) && elapsedMs >= 230 && elapsedMs < 1000) timeouts.set(error, { before, elapsedMs }); throw error; }
        finally { await release?.(); }
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { proxy, timeouts };
  }
  async function assertYieldedCleanup(c: ChannelConnection, before: ChannelConnection) {
    const current = await load(c);
    expect(current.recoveredThroughAt).toEqual(c.recoveredThroughAt);
    expect(current.historyRecoveryCursor).toEqual(before.historyRecoveryCursor);
    expect(current.historyRecoveryLeaseToken).toBeNull(); expect(current.historyRecoveryLeaseUntil).toBeNull();
    expect(current.historyRecoveryFailures).toBeGreaterThan(0);
    expect(current.historyRecoveryNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    return current;
  }
  function provider(rows: HistoryRecord[], mutate?: (body: any, data: any) => void) {
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body));
      if (String(url).includes('findChats')) return Response.json(body.skip === 0 ? [{ remoteJid: pn }] : []);
      expect(body.where.messageTimestamp).toEqual({ gte: expect.any(String), lte: expect.any(String) });
      const filtered = rows.filter(row => row.messageTimestamp * 1000 >= Date.parse(body.where.messageTimestamp.gte) && row.messageTimestamp * 1000 <= Date.parse(body.where.messageTimestamp.lte));
      const data = { messages: { records: filtered.slice((body.page - 1) * body.offset, body.page * body.offset), total: filtered.length, pages: Math.ceil(filtered.length / body.offset), currentPage: body.page } };
      mutate?.(body, data); return Response.json(data);
    });
    return { fetch, source: createEvolutionHistorySource({ baseUrl: 'https://evolution.invalid', apiKey: 'synthetic', fetch }) };
  }
  it('skips ancient rows and resumes a dense timestamp batch across instances and applies a DESC source in chronological order before advancing', async () => {
    const c = await fixture(), now = Date.now();
    const rows = [...Array.from({ length: 150 }, (_, i) => row(i, now - 500_000 + i * 1000, i === 50)), ...Array.from({ length: 300 }, (_, i) => row(i + 1000, now - 86400_000))].sort((a,b) => b.messageTimestamp - a.messageTimestamp);
    const p = provider(rows), seen = new Set<string>(), order: number[] = []; let unread = 0, advanced = false;
    const persist = async (records: HistoryRecord[]) => { let inserted = 0; for (const r of records) if (!seen.has(r.key.id)) { seen.add(r.key.id); inserted++; order.push(r.messageTimestamp); unread = r.key.fromMe ? 0 : unread + 1; } return { inserted, held: 0 }; };
    for (let i = 0; i < 80 && !advanced; i++) {
      await due(c); const before = p.fetch.mock.calls.length;
      advanced = (await recoverEvolutionWindow(db, await load(c), p.source, persist, { now, maxPages: 1, maxItems: 7 })).advanced;
      expect(p.fetch.mock.calls.length - before).toBeLessThanOrEqual(1);
    }
    expect(advanced).toBe(true); expect(seen.size).toBe(150); expect(unread).toBe(99);
    expect(order).toEqual([...order].sort((a,b) => a-b));
    const messagePages = p.fetch.mock.calls.filter(([u]) => String(u).includes('findMessages')).map(([,init]) => JSON.parse(String(init?.body)).page);
    expect(messagePages.filter(page => page === 2)).toEqual([2,2]); expect(messagePages.filter(page => page === 1).length).toBeGreaterThan(2);
    expect((await load(c)).historyRecoveryCursor).toBeNull();
  });
  it.each([1, 50])('converges a complete timestamp-tied batch shuffled across reads with maxItems=%i', async maxItems => {
    const c=await fixture(),now=Date.now(),rows=Array.from({length:4},(_,i)=>row(i,now-500_000));let reads=0;
    const p=provider(rows,(body,data)=>{if(body.page===1&&++reads%2===0)data.messages.records.reverse();});
    const persisted:string[]=[],persist=async(records:HistoryRecord[])=>{persisted.push(...records.map(row=>row.key.id));return {inserted:records.length,held:0};};
    let advanced=false;
    for(let i=0;i<30&&!advanced;i++){
      await due(c);advanced=(await recoverEvolutionWindow(db,await load(c),p.source,persist,{now,maxPages:1,maxItems})).advanced;
    }
    expect(advanced).toBe(true);expect(reads).toBeGreaterThanOrEqual(2);
    expect(persisted).toEqual([...rows].sort((a,b)=>historyDigest(a.key).localeCompare(historyDigest(b.key))).map(row=>row.key.id));
    expect((await load(c)).historyRecoveryCursor).toBeNull();
  });
  it('keeps the cursor resumable after more than three partial content changes and eventual stability', async () => {
    const c=await fixture(),now=Date.now(),rows=Array.from({length:4},(_,i)=>row(i,now-500_000)),p=provider(rows),seen=new Set<string>();
    const persist=async(records:HistoryRecord[])=>{let inserted=0;for(const record of records)if(!seen.has(record.key.id)){seen.add(record.key.id);inserted++;}return {inserted,held:0};};
    await recoverEvolutionWindow(db,c,p.source,persist,{now,maxPages:2,maxItems:1});
    const errors:string[]=[];
    for(let i=0;i<8;i++){
      rows[0]!.message={conversation:`synthetic changed content ${i}`};await due(c);
      try{await recoverEvolutionWindow(db,await load(c),p.source,persist,{now,maxPages:1,maxItems:1});}
      catch(error){errors.push((error as Error).message);}
      expect((await load(c)).historyRecoveryCursor).toMatchObject({changedPasses:expect.any(Number)});
    }
    expect(errors).not.toContain('HISTORY_CURSOR_UNSUPPORTED');
    let advanced=false;
    for(let i=0;i<16&&!advanced;i++){await due(c);advanced=(await recoverEvolutionWindow(db,await load(c),p.source,persist,{now,maxPages:8,maxItems:1})).advanced;}
    expect(advanced).toBe(true);expect(seen.size).toBe(4);expect((await load(c)).historyRecoveryCursor).toBeNull();
  });
  it('retains its cursor when unavailable, resumes after restart and never certifies repeated pagination', async () => {
    const c = await fixture(), now = Date.now(), rows = Array.from({ length: 250 }, (_, i) => row(i, now - 86400_000));
    const p = provider(rows), persist = vi.fn(async () => ({ inserted: 0, held: 0 }));
    await recoverEvolutionWindow(db,c,p.source,persist,{now,maxPages:2}); const before = await load(c); await due(c);
    await expect(recoverEvolutionWindow(db,await load(c),{ ...p.source, recoveryChatPage: async () => { throw Error('synthetic unavailable'); }, recoveryMessagePage: async () => { throw Error('synthetic unavailable'); } },persist,{now})).rejects.toThrow('synthetic unavailable');
    expect((await load(c)).historyRecoveryCursor).toEqual(before.historyRecoveryCursor); expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
    const repeated = provider(rows, (_body,data) => { data.messages.records=rows.slice(0,100); data.messages.total=100; data.messages.pages=1; }); await due(c);
    await expect(recoverEvolutionWindow(db,await load(c),repeated.source,persist,{now})).rejects.toThrow('HISTORY_FILTER_IGNORED');
    expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
  it('rewinds a changed partial batch and later certifies two complete identical passes', async () => {
    const c=await fixture(),now=Date.now(),rows=Array.from({length:12},(_,i)=>row(i,now-500_000+i*1000)),p=provider(rows),seen=new Set<string>();
    const persist=async(records:HistoryRecord[])=>{let inserted=0;for(const record of records)if(!seen.has(record.key.id)){seen.add(record.key.id);inserted++;}return {inserted,held:0};};
    await recoverEvolutionWindow(db,c,p.source,persist,{now,maxPages:4,maxItems:2});expect((await load(c)).historyRecoveryCursor).toMatchObject({partial:{completed:2}});
    rows.unshift(row(90,now-501_000));let advanced=false;
    for(let i=0;i<8&&!advanced;i++){await due(c);advanced=(await recoverEvolutionWindow(db,await load(c),p.source,persist,{now,maxPages:8})).advanced;}
    expect(advanced).toBe(true);expect(seen.size).toBe(13);expect((await load(c)).historyRecoveryCursor).toBeNull();
  });
  it('restarts a shifted chat catalog in the same window and ignores unrelated live activity in its identity manifest', async () => {
    const c=await fixture(),now=Date.now(),jids=Array.from({length:6},(_,i)=>`1555000000${i}@s.whatsapp.net`);let shifted=false,activity=0;
    const fetch=vi.fn(async(url:unknown,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      if(String(url).includes('findChats')){
        let ids=jids.slice(body.skip,body.skip+2);
        if(body.skip===2&&!shifted){shifted=true;ids=[jids[1]!,jids[2]!];}
        return Response.json(ids.map(remoteJid=>({remoteJid,lastMessage:{key:{id:`live-${activity++}`},messageTimestamp:Math.floor(now/1000)}})));
      }
      return Response.json({messages:{records:[],currentPage:body.page,total:0,pages:0}});
    });
    const source=createEvolutionHistorySource({baseUrl:'https://evolution.invalid',apiKey:'synthetic',fetch}), observed=observeCleanup(c); let advanced=false, completedTurns=0, cleanupYields=0;
    while(completedTurns<12&&!advanced){
      await due(c); const began=Date.now();
      try { advanced=(await recoverEvolutionWindow(observed.proxy,await load(c),source,async()=>({inserted:0,held:0}),{now,maxPages:4})).advanced; completedTurns++; }
      catch(error){
        const timeout=observed.timeouts.get(error); if(!timeout)throw error;
        expect(++cleanupYields).toBeLessThanOrEqual(2); expect(Date.now()-began).toBeLessThan(6000);
        await assertYieldedCleanup(c,timeout.before);
      }
    }
    expect(advanced).toBe(true);expect(shifted).toBe(true);expect(fetch.mock.calls.filter(([url,init])=>String(url).includes('findChats')&&JSON.parse(String(init?.body)).skip===0).length).toBe(3);
  });
  it('preserves partial progress when the first 250 ms cleanup hits a real row lock, then resumes only after fixture due time', async () => {
    const c=await fixture(),now=Date.now(),p=provider(Array.from({length:3},(_,i)=>row(i,now-500_000+i*1000))),seen=new Set<string>();
    const persist=async(records:HistoryRecord[])=>{let inserted=0;for(const record of records)if(!seen.has(record.key.id)){seen.add(record.key.id);inserted++;}return {inserted,held:0};};
    const blocker=new Client({connectionString:url});await blocker.connect();
    const observed=observeCleanup(c,async()=>{
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM channel_connections WHERE workspace_id=$1 AND id=$2::uuid FOR UPDATE',[c.workspaceId,c.id]);
      return async()=>{await blocker.query('ROLLBACK');};
    });
    const began=Date.now();let thrown:unknown;
    try {
      try {await recoverEvolutionWindow(observed.proxy,c,p.source,persist,{now,maxMs:1000,maxPages:2,maxItems:1});}catch(error){thrown=error;}
      const failedTurnMs=Date.now()-began,timeout=observed.timeouts.get(thrown);expect(timeout, String(thrown)).toBeDefined();expect(failedTurnMs).toBeLessThan(1800);
      expect(timeout!.before.historyRecoveryCursor).toMatchObject({partial:{completed:1}});expect(seen.size).toBe(1);
      const yielded=await assertYieldedCleanup(c,timeout!.before),reads=p.fetch.mock.calls.length;
      expect(await recoverEvolutionWindow(db,yielded,p.source,persist,{now})).toMatchObject({advanced:false,pending:true});expect(p.fetch).toHaveBeenCalledTimes(reads);
      await due(c);
      expect(await recoverEvolutionWindow(db,await load(c),p.source,persist,{now,maxPages:8})).toMatchObject({advanced:true});
      const resumed=await load(c);expect([...seen].sort()).toEqual(['M0000','M0001','M0002']);expect(resumed.historyRecoveryCursor).toBeNull();
      const error=thrown as {code?:string;meta?:{code?:string}},output=join(process.cwd(),'../../validation-artifacts');await mkdir(output,{recursive:true});
      await writeFile(join(output,`evolution-cleanup-timeout-observations-${Date.now()}.json`),JSON.stringify({schemaVersion:1,kind:'evolution-cleanup-timeout-observations',observationsOnly:true,
        sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceState:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()?'working-tree':'clean-checkout',harnessRunId:process.env.TALK_VALIDATION_RUN_ID??null,
        errorCode:error.code,postgresCode:error.meta?.code??null,cleanupElapsedMs:timeout!.elapsedMs,failedTurnMs,
        checkpointPreserved:yielded.recoveredThroughAt?.getTime()===c.recoveredThroughAt?.getTime(),cursorPreserved:JSON.stringify(yielded.historyRecoveryCursor)===JSON.stringify(timeout!.before.historyRecoveryCursor),
        partialCompleted:1,leaseReleased:yielded.historyRecoveryLeaseToken===null&&yielded.historyRecoveryLeaseUntil===null,consecutiveFailures:yielded.historyRecoveryFailures,backoffMillisecondsAtObservation:yielded.historyRecoveryNextAttemptAt!.getTime()-(began+failedTurnMs),
        providerReadsBlockedBeforeFixtureDue:true,resumedAfterFixtureDue:true,resumedIdentities:seen.size,checkpointAdvanced:resumed.recoveredThroughAt!.getTime()>c.recoveredThroughAt!.getTime(),cursorCleared:resumed.historyRecoveryCursor===null},null,2));
    } finally {await blocker.query('ROLLBACK');await blocker.end();}
  });
  it('enforces a cumulative scan budget across a bounded batch, cursor and identity manifests', async () => {
    const c=await fixture(),now=Date.now(),base=c.recoveredThroughAt!.getTime();
    const record={...row(1,now-500_000),message:{conversation:'x'.repeat(8_300_000)}},p=provider([record]);
    await db.channelConnection.update({where:{id:c.id},data:{historyRecoveryCursor:{version:2,provider:'evolution',generation:c.lifecycleGeneration,checkpoint:c.recoveredThroughAt!.toISOString(),
      from:Math.floor((base-600_000)/1000),to:Math.floor((base+300_000)/1000),chatOffset:1,chats:[{remoteJid:pn,phoneJid:pn}],chatIndex:0,messagePage:1,messagePages:null,messageTotal:null,
      pages:Array.from({length:1000},(_,i)=>historyDigest(i)),previousPages:Array.from({length:1000},(_,i)=>historyDigest(i+1000)),seenChats:[historyDigest(pn)],seenMessages:[],changedPasses:0}}});
    const persist=vi.fn(async()=>({inserted:1,held:0}));
    await expect(recoverEvolutionWindow(db,await load(c),p.source,persist,{now,maxPages:1,maxItems:1})).rejects.toThrow('HISTORY_SCAN_LIMIT');
    expect(persist).not.toHaveBeenCalled();expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
  it('fails closed on an unknown cursor version without advancing', async () => {
    const c=await fixture(),now=Date.now(), p=provider([row(1,now-500_000)]),persist=async()=>({inserted:0,held:0});
    await db.channelConnection.update({where:{id:c.id},data:{historyRecoveryCursor:{version:999}}});
    await expect(recoverEvolutionWindow(db,await load(c),p.source,persist,{now})).rejects.toThrow('HISTORY_CURSOR_UNSUPPORTED'); expect(p.fetch).not.toHaveBeenCalled();
    expect((await load(c)).recoveredThroughAt).toEqual(c.recoveredThroughAt);
  });
});
