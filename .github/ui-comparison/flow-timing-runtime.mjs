// Diagnostic archive ONLY: bounded metadata, never message bodies, SQL or parameters.
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import fs from 'node:fs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function assertFlowFixture(env){
 const u=new URL(env.DATABASE_URL??'invalid:');
 if(env.TALK_ISOLATED_FLOW_TIMING!=='1'||u.hostname!=='127.0.0.1'||u.port!=='55439'||u.pathname!=='/talk_rehearsal'||!/^\/tmp\/talk-prod-rehearsal-[A-Za-z0-9]+\/(api|worker)\.flow\.json$/.test(env.TALK_ISOLATED_FLOW_PATH??''))throw Error('Owned flow fixture required');
}
export function createFlowCollector({now=()=>performance.now(),wall=()=>Date.now(),limit=16000}={}){
 const context=new AsyncLocalStorage(),claims=[],idles=[],events=[],samples=[],issues=new Set(),byId=new Map();let activeHandlers=0,activeFinishes=0;
 const code=e=>typeof e?.code==='string'&&/^P[0-9]{4}$/.test(e.code)?e.code:'error';
 function append(array,row){if(array.length>=limit){issues.add('collection_limit');return null;}array.push(row);return row;}
 function valid(e){if(!e||!uuid.test(e.id)||!uuid.test(e.messageId??'')||e.workspaceId!=='ui-rehearsal'){issues.add('unexpected_effect_scope');return false;}return true;}
 async function claim(fn){const start=now(),r=append(claims,{startAt:wall(),endAt:null,ms:null,effect:null,error:null});try{const e=await fn();if(e&&e.messageId&&valid(e)&&r){r.effect={id:e.id,messageId:e.messageId,kind:e.kind,attempts:e.attempts};byId.set(e.id,r);}return e;}catch(e){if(r)r.error=code(e);throw e;}finally{if(r){r.endAt=wall();r.ms=now()-start;}}}
 async function handler(e,fn){const r=byId.get(e.id),start=now();if(r){r.handlerStartAt=wall();r.operations=[];}activeHandlers++;
  try{return await context.run(r??null,async()=>{const result=await fn();if(r)r.outcome=['done','retry','failed'].includes(result?.status)?result.status:'unknown';return result;});}
  catch(error){if(r)r.handlerError=code(error);throw error;}finally{activeHandlers--;if(r){r.handlerEndAt=wall();r.handlerMs=now()-start;}}
 }
 async function finish(e,fn){const r=byId.get(e.id),start=now();if(r)r.finishStartAt=wall();activeFinishes++;
  try{const changed=await fn();if(r)r.finishChanged=changed;return changed;}catch(error){if(r)r.finishError=code(error);throw error;}finally{activeFinishes--;if(r){r.finishEndAt=wall();r.finishMs=now()-start;}}
 }
 async function operation(name,fn){const r=context.getStore(),start=now();try{return await fn();}finally{if(r&&['message.read','conversation.dto'].includes(name))append(r.operations,{name,ms:now()-start});}}
 async function idle(requestedMs,fn){const start=now(),r=append(idles,{startAt:wall(),requestedMs,endAt:null,ms:null});try{return await fn();}finally{if(r){r.endAt=wall();r.ms=now()-start;}}}
 function event(stage,e){if(!['hub','ws_send','notify_submit','notify_done','notify_receive'].includes(stage))throw Error('Unknown diagnostic stage');if(!['message.created','message.updated'].includes(e?.type))return;
  if(e.workspaceId!=='ui-rehearsal'||!uuid.test(e.payload?.id??'')){issues.add('unexpected_event_scope');return;}
  append(events,{stage,type:e.type,messageId:e.payload.id,at:wall(),effectId:context.getStore()?.effect?.id??null});
 }
 return {claim,handler,finish,operation,idle,event,sample:value=>append(samples,value),snapshot:()=>({version:1,complete:issues.size===0&&activeHandlers===0&&activeFinishes===0,issues:[...issues],activeHandlers,activeFinishes,claims,idles,events,samples})};
}
const collector=createFlowCollector();let installed=false;
export const flowClaim=collector.claim,flowHandler=collector.handler,flowFinish=collector.finish,flowOperation=collector.operation,flowIdle=collector.idle,flowEvent=collector.event;
export function installFlow(){
 if(installed)return;assertFlowFixture(process.env);installed=true;
 const lag=monitorEventLoopDelay({resolution:20});lag.enable();let previous=process.cpuUsage(),at=performance.now();
 const timer=setInterval(()=>{const cpu=process.cpuUsage(previous),next=performance.now();previous=process.cpuUsage();collector.sample({at:Date.now(),elapsedMs:next-at,cpuUserUs:cpu.user,cpuSystemUs:cpu.system,lagP50ms:lag.percentile(50)/1e6,lagP95ms:lag.percentile(95)/1e6,lagMaxMs:lag.max/1e6,rss:process.memoryUsage().rss});at=next;lag.reset();},1000);timer.unref();
 process.once('SIGUSR2',()=>{const file=process.env.TALK_ISOLATED_FLOW_PATH,data=JSON.stringify(collector.snapshot());if(Buffer.byteLength(data)>32*1024*1024)throw Error('Flow evidence too large');fs.writeFileSync(file+'.tmp',data);fs.renameSync(file+'.tmp',file);});
}
