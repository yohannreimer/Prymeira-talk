// Copied ONLY into an owned diagnostic source archive. Never a runtime dependency.
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import fs from 'node:fs';
import {Session} from 'node:inspector';
const context=new AsyncLocalStorage();
function metric(key,ms,rows){const c=context.getStore();if(!c)return;const v=c.ops[key]??={n:0,ms:0,rows:0};v.n++;v.ms+=ms;if(Number.isFinite(rows))v.rows+=rows;}
export async function span(name,fn){const start=performance.now();try{return await fn();}finally{metric(name,performance.now()-start);}}
export function rows(name,count){metric(name,0,count);}
export async function traceReceipt(receiptId,fn,emit=value=>console.info('TRACE_RECEIPT',JSON.stringify(value))){
  if(!/^[a-f0-9-]{36}$/.test(receiptId))throw Error('Synthetic receipt UUID required');
  const c={receiptId,at:Date.now(),start:performance.now(),ops:{},error:null};
  return context.run(c,async()=>{try{return await fn();}catch(e){c.error=typeof e?.code==='string'&&/^P[0-9]{4}$/.test(e.code)?e.code:'error';throw e;}finally{emit({receiptId,at:c.at,endedAt:Date.now(),ms:performance.now()-c.start,ops:c.ops,error:c.error});}});
}
function rawCategory(args){const value=Array.isArray(args[0])?args[0].join('?'):'';return /pg_advisory_xact_lock/.test(value)?'advisory':/FOR SHARE/.test(value)?'source_share':/transaction_isolation/.test(value)?'isolation':'raw';}
export function wrapClient(db){
 const delegates=new Map();
 return new Proxy(db,{get(target,key){
  const value=Reflect.get(target,key,target);
  if(key==='$transaction')return (work,options)=>{
   if(typeof work!=='function')return value.call(target,work,options);
   const start=performance.now();return span('tx.total',()=>value.call(target,async tx=>{metric('tx.to_callback',performance.now()-start);return span('tx.callback',()=>work(wrapClient(tx)));},options));
  };
  if(typeof key==='string'&&key.startsWith('$')&&typeof value==='function')return (...args)=>context.getStore()?span(rawCategory(args),()=>value.apply(target,args)):value.apply(target,args);
  if(typeof key==='string'&&!key.startsWith('_')&&value&&typeof value==='object'&&typeof value.findMany==='function'){
   if(!delegates.has(key))delegates.set(key,new Proxy(value,{get(delegate,op){const f=Reflect.get(delegate,op,delegate);if(typeof f!=='function')return f;return (...args)=>{
    if(!context.getStore())return f.apply(delegate,args);
    const start=performance.now();return Promise.resolve(f.apply(delegate,args)).then(result=>{metric(key+'.'+String(op),performance.now()-start,Array.isArray(result)?result.length:undefined);return result;},error=>{metric(key+'.'+String(op),performance.now()-start);throw error;});
   };}}));return delegates.get(key);
  }
  return typeof value==='function'?value.bind(target):value;
 }});
}
export function assertFixture(env){
 const u=new URL(env.DATABASE_URL??'invalid:');
 if(env.TALK_ISOLATED_DIAGNOSTIC!=='1'||u.hostname!=='127.0.0.1'||u.port!=='55439'||u.pathname!=='/talk_rehearsal'||!/^\/tmp\/talk-prod-rehearsal-[A-Za-z0-9]+\/worker\.cpuprofile$/.test(env.TALK_ISOLATED_PROFILE_PATH??''))throw Error('Owned isolated diagnostic fixture required');
}
export function install(db){
 assertFixture(process.env);
 const engine=new Map();
 db.$on('query',e=>{const name=/pg_advisory_xact_lock/.test(e.query)?'advisory':/FROM\s+"(?:public"\.)?"?([a-z_]+)/i.exec(e.query)?.[1]??e.query.split(' ')[0];const v=engine.get(name)??{n:0,ms:0};v.n++;v.ms+=e.duration;engine.set(name,v);});
 const lag=monitorEventLoopDelay({resolution:20});lag.enable();let previous=process.cpuUsage();
 setInterval(()=>{const cpu=process.cpuUsage(previous);previous=process.cpuUsage();console.info('TRACE_ENGINE',JSON.stringify({at:Date.now(),cpu,lag:{p95:lag.percentile(95)/1e6,max:lag.max/1e6},memory:process.memoryUsage(),queries:Object.fromEntries(engine)}));engine.clear();lag.reset();},1000).unref();
 const session=new Session();session.connect();const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(e,r)=>e?reject(e):resolve(r)));
 const ready=(async()=>{await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:2000});await post('Profiler.start');})();
 process.once('SIGUSR2',()=>{void(async()=>{await ready;const {profile}=await post('Profiler.stop');const file=process.env.TALK_ISOLATED_PROFILE_PATH;fs.writeFileSync(file+'.tmp',JSON.stringify(profile));fs.renameSync(file+'.tmp',file);session.disconnect();})().catch(()=>{console.error('TRACE_PROFILE_FAILED');});});
 return wrapClient(db);
}
