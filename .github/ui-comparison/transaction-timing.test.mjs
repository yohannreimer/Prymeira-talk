import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createTimingCollector,assertTimingFixture} from './transaction-timing-runtime.mjs';
import {prepareTimingVariant} from './transaction-timing-instrument.mjs';
import {sanitizePostgresDurations} from './transaction-timing-log.mjs';
const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('timing is restricted to owned loopback database, flag and output root',()=>{
 const env={TALK_ISOLATED_TRANSACTION_TIMING:'1',DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:55439/talk_rehearsal',TALK_ISOLATED_TIMING_PATH:'/tmp/talk-prod-rehearsal-abc123/worker.transactions.json'};assert.doesNotThrow(()=>assertTimingFixture(env));
 for(const override of [{TALK_ISOLATED_TRANSACTION_TIMING:''},{DATABASE_URL:'postgresql://fixture@production.invalid/talk_rehearsal'},{TALK_ISOLATED_TIMING_PATH:'/tmp/not-owned.json'}])assert.throws(()=>assertTimingFixture({...env,...override}));
});
test('concurrent receipts isolate query and transaction phases, preserve bindings and options',async()=>{
 const c=createTimingCollector(),options={isolationLevel:'ReadCommitted',timeout:15000,maxWait:5000};
 const raw={marker:1,message:{marker:2,async findMany(args){assert.equal(this.marker,2);assert.equal(args.secret,'PRIVATE');await pause(args.delay);return [{value:'PRIVATE'}];}},async $queryRaw(parts){assert.equal(this.marker,1);assert(parts.join('').includes('transaction_isolation'));return [{isolation:'read committed',__isolated_pid:321,__isolated_clock:new Date('2026-10-20T16:00:00Z')}];},async $transaction(work,opts){assert.equal(this.marker,1);assert.equal(opts,options);await pause(2);const value=await work(this);await pause(2);return value;}};
 const db=c.wrapClient(raw);
 await Promise.all([c.traceReceipt(first,()=>db.$transaction(async tx=>{await tx.$queryRaw`SELECT current_setting('transaction_isolation')`;return c.traceSpan('app.store',()=>tx.message.findMany({secret:'PRIVATE',delay:8}));},options)),c.traceReceipt(second,()=>db.message.findMany({secret:'PRIVATE',delay:1}))]);
 const s=c.snapshot(),a=s.receipts.find(x=>x.receiptId===first),b=s.receipts.find(x=>x.receiptId===second);assert(s.complete);assert.equal(a.transactions.length,1);assert.equal(b.transactions.length,0);assert.equal(a.queries.length,2);assert.equal(b.queries.length,1);
 const t=a.transactions[0];assert.equal(t.backendPid,321);assert.equal(t.serverAnchor,'2026-10-20T16:00:00.000Z');assert(t.startMs<=t.callbackStartMs&&t.callbackStartMs<=t.callbackEndMs&&t.callbackEndMs<=t.endMs);assert.equal(a.queries[1].stage,'app.store');assert(!JSON.stringify(s).includes('PRIVATE'));
});
test('tagged parameters, return identity and errors are preserved; failed callback is not successful commit',async()=>{
 const c=createTimingCollector(),error=Object.assign(Error('PRIVATE'),{code:'P2034'});let n=0;
 const raw={async $executeRaw(parts,...args){n++;assert(parts[0].includes('pg_advisory_xact_lock'));assert.deepEqual(args,['PRIVATE']);throw error;},async $transaction(fn){return fn(this);}};const db=c.wrapClient(raw);
 await assert.rejects(c.traceReceipt(first,()=>db.$transaction(tx=>tx.$executeRaw`SELECT pg_advisory_xact_lock(${'PRIVATE'})`)),e=>e===error);
 const s=c.snapshot(),r=s.receipts[0];assert.equal(n,1);assert.equal(r.queries[0].name,'advisory');assert.equal(r.queries[0].error,'P2034');assert.equal(r.transactions[0].error,'P2034');assert.equal(r.error,'P2034');assert(!JSON.stringify(s).includes('PRIVATE'));
});
test('collection bounds invalidate evidence without suppressing original work',async()=>{
 const c=createTimingCollector({maxReceipts:1,maxQueries:1});let calls=0;const db=c.wrapClient({message:{async findMany(){calls++;return [];}}});
 await c.traceReceipt(first,async()=>{await db.message.findMany();await db.message.findMany();});await c.traceReceipt(second,()=>db.message.findMany());
 assert.equal(calls,3);assert.deepEqual(new Set(c.snapshot().issues),new Set(['query_limit','receipt_limit']));assert(!c.snapshot().complete);assert.equal(c.snapshot().receipts[0].queries.length,1);
});
test('PG parser handles protocol phases/COMMIT/ROLLBACK and exports no SQL or parameters',()=>{
 const lines=[
 '2026-10-20 16:00:00.123 UTC [321] app=talk-worker LOG:  duration: 0.003 ms parse s0: SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
 '2026-10-20 16:00:00.124 UTC [321] app=talk-worker LOG:  duration: 122.433 ms execute s0: SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
 '2026-10-20 16:00:00.125 UTC [321] app=talk-worker LOG:  duration: 0.514 ms statement: COMMIT',
 '2026-10-20 16:00:00.126 UTC [321] app=talk-worker LOG:  duration: 0.012 ms execute s1: ROLLBACK',
 '2026-10-20 16:00:00.127 UTC [321] app=talk-worker LOG:  duration: 0.012 ms execute s2: SELECT "public"."messages"."body" FROM "public"."messages" WHERE "body"=$1',
 '2026-10-20 16:00:00.127 UTC [321] app=talk-worker DETAIL: parameters: $1=PRIVATE'
 ];const d=sanitizePostgresDurations(lines.join('\n'));assert(d.complete);assert.equal(d.entries.length,5);assert.equal(d.entries[1].category,'advisory');assert.equal(d.entries[1].durationMs,122.433);assert.equal(d.entries[2].category,'COMMIT');assert.equal(d.entries[3].category,'ROLLBACK');assert.equal(d.entries[4].table,'messages');assert(!JSON.stringify(d).includes('PRIVATE'));assert(!JSON.stringify(d).includes('pg_advisory_xact_lock'));assert(!JSON.stringify(d).includes('WHERE')); 
});
test('unparsed duration records invalidate server evidence',()=>{const d=sanitizePostgresDurations('duration: not the controlled PG16 format');assert(!d.complete);assert.equal(d.unmatchedDurationLines,1);});
test('instrumentation changes only listed diagnostic archive files and refuses repeated patch',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'talk-timing-patch-')),root=path.join(tmp,'.validation/variants/reference-transaction-timing');
 try{
  const files=['apps/api/src/modules/ingress/runtime.ts','apps/api/src/modules/ingress/consumer.ts','apps/api/src/modules/ingress/application.ts','apps/api/src/modules/messaging/canonical-boundary.ts'];
  for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.copyFileSync(file,path.join(root,file));}
  const manifest=prepareTimingVariant(root);assert.equal(Object.keys(manifest.files).length,5);for(const file of files)assert.notEqual(manifest.files[file].before,manifest.files[file].after);
  const source=fs.readFileSync(path.join(root,files[3]),'utf8');assert(source.includes('pg_advisory_xact_lock'));assert.equal((source.match(/__isolated_pid/g)??[]).length,2);assert(source.includes('READ COMMITTED'));
  const after=fs.readFileSync(path.join(root,files[2]),'utf8');assert(after.includes("{ isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 }"));assert.throws(()=>prepareTimingVariant(root));assert.throws(()=>prepareTimingVariant('/tmp/not-owned'));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('outside a traced receipt native Prisma promises are returned unchanged',()=>{
 const c=createTimingCollector(),original={then(){},prismaPromise:true};const db=c.wrapClient({message:{findMany(){return original;}},$executeRaw(){return original;}});assert.equal(db.message.findMany(),original);assert.equal(db.$executeRaw`SELECT 1`,original);
});
