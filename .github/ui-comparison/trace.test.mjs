import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertFixture,traceReceipt,wrapClient,span,rows} from './trace.mjs';
const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
test('diagnostic setup rejects non-owned paths, flags and databases',()=>{
 const env={TALK_ISOLATED_DIAGNOSTIC:'1',DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:55439/talk_rehearsal',TALK_ISOLATED_PROFILE_PATH:'/tmp/talk-prod-rehearsal-Ab1234/worker.cpuprofile'};assert.doesNotThrow(()=>assertFixture(env));
 for(const change of [{TALK_ISOLATED_DIAGNOSTIC:''},{DATABASE_URL:'postgresql://fixture:fixture@prod.invalid:55439/talk_rehearsal'},{DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:55439/postgres'},{TALK_ISOLATED_PROFILE_PATH:'/tmp/worker.cpuprofile'}])assert.throws(()=>assertFixture({...env,...change}));
});
test('concurrent contexts retain their own receipt, counts and opaque arguments',async()=>{
 const evidence=[];const raw={marker:3,canonicalAddress:{marker:4,async findMany(args){assert.equal(this.marker,4);await new Promise(r=>setTimeout(r,args.delay));return [{id:1},{id:2}];}},$transaction:async function(work){assert.equal(this.marker,3);return work(this);}};const db=wrapClient(raw);
 await Promise.all([traceReceipt(first,()=>db.$transaction(tx=>span('store',()=>tx.canonicalAddress.findMany({delay:10,secret:'PRIVATE-NEVER-LOG'}))),x=>evidence.push(x)),traceReceipt(second,async()=>{rows('graph',2930);await db.canonicalAddress.findMany({delay:1});},x=>evidence.push(x))]);
 const a=evidence.find(x=>x.receiptId===first),b=evidence.find(x=>x.receiptId===second);assert.equal(a.ops['canonicalAddress.findMany'].n,1);assert.equal(a.ops['canonicalAddress.findMany'].rows,2);assert.equal(a.ops['tx.to_callback'].n,1);assert.equal(a.ops['tx.callback'].n,1);assert.equal(a.ops.store.n,1);assert.equal(b.ops.graph.rows,2930);assert.equal(b.ops['tx.callback'],undefined);assert(!JSON.stringify(evidence).includes('PRIVATE'));assert.equal(evidence.length,2);
});
test('raw tagged queries remain bound and errors propagate exactly once',async()=>{
 const failure=Object.assign(Error('PRIVATE-ERROR'),{code:'P2034'}),evidence=[];let calls=0;const raw={marker:1,async $executeRaw(parts,...values){calls++;assert.equal(this.marker,1);assert(parts[0].includes('pg_advisory_xact_lock'));assert.deepEqual(values,['PRIVATE-ARG']);throw failure;}};const db=wrapClient(raw);
 await assert.rejects(traceReceipt(first,()=>db.$executeRaw`SELECT pg_advisory_xact_lock(${'PRIVATE-ARG'})`,x=>evidence.push(x)),e=>e===failure);assert.equal(calls,1);assert.equal(evidence[0].ops.advisory.n,1);assert.equal(evidence[0].error,'P2034');assert(!JSON.stringify(evidence).includes('PRIVATE'));
});
