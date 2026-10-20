import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createFlowCollector,assertFlowFixture} from './flow-timing-runtime.mjs';import {prepareFlowVariant} from './flow-timing-instrument.mjs';
const id='00000000-0000-4000-8000-000000000001',messageId='00000000-0000-4000-8000-000000000002';
const effect={id,messageId,workspaceId:'ui-rehearsal',kind:'realtime.message',attempts:1,frozen:{body:'PRIVATE'}};
test('flow collector is restricted to loopback, exact flags and owned role output',()=>{
 const e={DATABASE_URL:'postgresql://test@127.0.0.1:55439/talk_rehearsal',TALK_ISOLATED_FLOW_TIMING:'1',TALK_ISOLATED_FLOW_PATH:'/tmp/talk-prod-rehearsal-abc/api.flow.json'};assert.doesNotThrow(()=>assertFlowFixture(e));
 for(const o of [{DATABASE_URL:'postgresql://test@production.invalid/talk_rehearsal'},{TALK_ISOLATED_FLOW_TIMING:'0'},{TALK_ISOLATED_FLOW_PATH:'/tmp/arbitrary.json'}])assert.throws(()=>assertFlowFixture({...e,...o}));
});
test('claim/handler/finish/operation preserve result identity and capture no payload or result',async()=>{
 const c=createFlowCollector(),outcome={status:'done',result:{body:'PRIVATE'}};assert.equal(await c.claim(async()=>effect),effect);
 assert.equal(await c.handler(effect,async()=>{assert.equal(await c.operation('message.read',async()=>outcome),outcome);c.event('hub',{type:'message.created',workspaceId:'ui-rehearsal',payload:{id:messageId,body:'PRIVATE'}});return outcome;}),outcome);
 assert.equal(await c.finish(effect,async()=>1),1);const s=c.snapshot();assert(s.complete);assert.equal(s.claims.length,1);assert.equal(s.claims[0].outcome,'done');assert.equal(s.claims[0].finishChanged,1);assert.equal(s.claims[0].operations[0].name,'message.read');assert.equal(s.events[0].effectId,id);assert(!JSON.stringify(s).includes('PRIVATE'));
});
test('handler and finish failures propagate original errors and clear active state',async()=>{
 const c=createFlowCollector(),error=Object.assign(Error('PRIVATE'),{code:'P2034'});await c.claim(async()=>effect);
 await assert.rejects(c.handler(effect,async()=>{throw error;}),e=>e===error);await assert.rejects(c.finish(effect,async()=>{throw error;}),e=>e===error);const s=c.snapshot();assert(s.complete);assert.equal(s.claims[0].handlerError,'P2034');assert.equal(s.claims[0].finishError,'P2034');assert(!JSON.stringify(s).includes('PRIVATE'));
});
test('bounded collection and foreign scopes invalidate evidence without suppressing work',async()=>{
 const c=createFlowCollector({limit:1});let calls=0;await c.claim(async()=>{calls++;return effect;});await c.claim(async()=>{calls++;return effect;});await c.handler(effect,async()=>{calls++;return {status:'done'};});assert.equal(calls,3);assert(!c.snapshot().complete);assert(c.snapshot().issues.includes('collection_limit'));
 const foreign=createFlowCollector();await foreign.claim(async()=>({...effect,workspaceId:'another'}));assert(!foreign.snapshot().complete);
});
test('idle records actual wait and runs once without changing the requested cadence',async()=>{
 let n=0;const c=createFlowCollector({now:()=>n,wall:()=>100+n});const token={};assert.equal(await c.idle(1000,async()=>{n=1130;return token;}),token);assert.deepEqual(c.snapshot().idles,[{startAt:100,requestedMs:1000,endAt:1230,ms:1130}]);
});
test('archive patch keeps SQL/dependencies/fences/cadence and refuses repeat/outside roots',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'talk-flow-patch-')),root=path.join(tmp,'.validation/variants/ref-transaction-timing');
 try{const files=['apps/api/src/modules/ingress/runtime.ts','apps/api/src/modules/ingress/consumer.ts','apps/api/src/modules/ingress/application.ts','apps/api/src/modules/messaging/canonical-boundary.ts','apps/api/src/modules/ingress/effect-runner.ts','apps/api/src/modules/ingress/effect-handlers.ts','apps/api/src/modules/realtime/realtime-hub.ts','apps/api/src/modules/realtime/realtime-bridge.ts'];for(const f of files){fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.copyFileSync(f,path.join(root,f));}
  const manifest=prepareFlowVariant(root);assert.equal(Object.keys(manifest.files).length,5);const runner=fs.readFileSync(path.join(root,'apps/api/src/modules/ingress/effect-runner.ts'),'utf8');const original=fs.readFileSync('apps/api/src/modules/ingress/effect-runner.ts','utf8');assert.equal(runner.match(/WITH next AS[\s\S]*?RETURNING[^`]+/)[0],original.match(/WITH next AS[\s\S]*?RETURNING[^`]+/)[0]);assert(runner.includes('FOR UPDATE SKIP LOCKED'));assert(runner.includes('options.idleMs ?? 1_000, options.maxIdleMs ?? 5_000'));assert(runner.includes('state = \'running\' AND locked_by ='));assert.throws(()=>prepareFlowVariant(root));assert.throws(()=>prepareFlowVariant('/tmp/unowned'));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
