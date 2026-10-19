import { randomUUID } from 'node:crypto';
import { PrismaClient, type ChannelConnection } from '@prisma/client';
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
    const source=createEvolutionHistorySource({baseUrl:'https://evolution.invalid',apiKey:'synthetic',fetch});let advanced=false;
    for(let i=0;i<12&&!advanced;i++){await due(c);advanced=(await recoverEvolutionWindow(db,await load(c),source,async()=>({inserted:0,held:0}),{now,maxPages:4})).advanced;}
    expect(advanced).toBe(true);expect(shifted).toBe(true);expect(fetch.mock.calls.filter(([url,init])=>String(url).includes('findChats')&&JSON.parse(String(init?.body)).skip===0).length).toBe(3);
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
