// Diagnostic archive ONLY. No SQL, parameters, payloads or error messages are retained.
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs';
export function assertTimingFixture(env){
 const u=new URL(env.DATABASE_URL??'invalid:');
 if(env.TALK_ISOLATED_TRANSACTION_TIMING!=='1'||u.hostname!=='127.0.0.1'||u.port!=='55439'||u.pathname!=='/talk_rehearsal'||!/^\/tmp\/talk-prod-rehearsal-[A-Za-z0-9]+\/worker\.transactions\.json$/.test(env.TALK_ISOLATED_TIMING_PATH??''))throw Error('Owned timing fixture required');
}
export function rawTimingCategory(args){
 const sql=Array.isArray(args[0])?args[0].join('?'):'';
 return /canonical_graph_redirects/.test(sql)?'graph':/INSERT INTO "canonical_chat_members"/.test(sql)?'membership_insert':/pg_advisory_xact_lock/.test(sql)?'advisory':/FOR SHARE/.test(sql)?'source_share':/transaction_isolation/.test(sql)?'isolation':'raw';
}
export function createTimingCollector({now=()=>performance.now(),wall=()=>Date.now(),maxReceipts=4096,maxQueries=2048}={}){
 const local=new AsyncLocalStorage(),receipts=[],issues=new Set();let active=0;
 const errorCode=e=>typeof e?.code==='string'&&/^P[0-9]{4}$/.test(e.code)?e.code:'error';
 const since=c=>now()-c.start;
 function traceReceipt(receiptId,fn){
  if(!/^[a-f0-9-]{36}$/.test(receiptId))throw Error('Synthetic receipt UUID required');
  if(receipts.length+active>=maxReceipts){issues.add('receipt_limit');return fn();}
  const c={receiptId,at:wall(),start:now(),transactions:[],queries:[],spans:[],error:null};active++;
  return local.run({receipt:c,transaction:null,stage:null},async()=>{try{return await fn();}catch(e){c.error=errorCode(e);throw e;}finally{active--;c.endedAt=wall();c.ms=since(c);delete c.start;receipts.push(c);}});
 }
 async function traceSpan(name,fn){
  const context=local.getStore();if(!context)return fn();
  const c=context.receipt,s={name,startMs:since(c),endMs:null};c.spans.push(s);
  return local.run({...context,stage:name},async()=>{try{const r=await fn();if(name==='app.store'&&['created','duplicate','enriched','held'].includes(r?.outcome))s.outcome=r.outcome;return r;}finally{s.endMs=since(c);}});
 }
 async function query(name,fn){
  const context=local.getStore();if(!context)return fn();
  const c=context.receipt,t=context.transaction;
  if(c.queries.length>=maxQueries){issues.add('query_limit');return fn();}
  const q={name,transaction:t?.id??null,stage:context.stage,startMs:since(c),endMs:null,error:null};c.queries.push(q);
  try{
   const result=await fn();
   if(t&&name==='isolation'&&Array.isArray(result)){
    const row=result.find(x=>Number.isSafeInteger(x?.__isolated_pid));
    if(row){const clock=new Date(row.__isolated_clock);if(!Number.isFinite(clock.getTime()))throw Error('Invalid server clock');
     if(t.backendPid&&t.backendPid!==row.__isolated_pid)throw Error('Transaction connection changed');
     t.backendPid=row.__isolated_pid;t.serverAnchor??=clock.toISOString();}
   }
   if(Array.isArray(result))q.rows=result.length;
   return result;
  }catch(e){q.error=errorCode(e);throw e;}finally{q.endMs=since(c);}
 }
 function wrapClient(db){
  const delegates=new Map();
  return new Proxy(db,{get(target,key){
   const value=Reflect.get(target,key,target);
   if(key==='$transaction')return (work,options)=>{
    const context=local.getStore();if(typeof work!=='function'||!context)return value.call(target,work,options);
    const c=context.receipt,t={id:c.transactions.length,startMs:since(c),callbackStartMs:null,callbackEndMs:null,endMs:null,error:null};c.transactions.push(t);
    return (async()=>{try{return await value.call(target,async tx=>{
     t.callbackStartMs=since(c);
     return local.run({...context,transaction:t},async()=>{try{return await work(wrapClient(tx));}finally{t.callbackEndMs=since(c);}});
    },options);}catch(e){t.error=errorCode(e);throw e;}finally{t.endMs=since(c);}})();
   };
   if(typeof key==='string'&&key.startsWith('$')&&typeof value==='function')return (...args)=>local.getStore()?query(rawTimingCategory(args),()=>value.apply(target,args)):value.apply(target,args);
   if(typeof key==='string'&&!key.startsWith('_')&&value&&typeof value==='object'&&typeof value.findMany==='function'){
    if(!delegates.has(key))delegates.set(key,new Proxy(value,{get(delegate,operation){
     const f=Reflect.get(delegate,operation,delegate);if(typeof f!=='function')return f;
     return (...args)=>local.getStore()?query(key+'.'+String(operation),()=>f.apply(delegate,args)):f.apply(delegate,args);
    }}));return delegates.get(key);
   }
   return typeof value==='function'?value.bind(target):value;
  }});
 }
 return {traceReceipt,traceSpan,wrapClient,snapshot:()=>({version:1,complete:issues.size===0&&active===0,issues:[...issues],active,receipts})};
}
const collector=createTimingCollector();
export const traceTimingReceipt=collector.traceReceipt,traceTimingSpan=collector.traceSpan;
export function installTiming(db){
 assertTimingFixture(process.env);
 process.once('SIGUSR2',()=>{const file=process.env.TALK_ISOLATED_TIMING_PATH;const data=JSON.stringify(collector.snapshot());if(Buffer.byteLength(data)>64*1024*1024)throw Error('Timing evidence size exceeded');fs.writeFileSync(file+'.tmp',data);fs.renameSync(file+'.tmp',file);});
 return collector.wrapClient(db);
}
