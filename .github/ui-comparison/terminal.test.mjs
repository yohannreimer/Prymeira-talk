import {test} from 'node:test';import assert from 'node:assert/strict';import {terminalComplete,ownedQueueCounts} from './terminal.mjs';
test('terminal requires every application and obligation, not just visibility or empty work',()=>{
 const wanted={applications:4,effects:20},complete={applications:4,applied:4,effects:20,done:20,failed:0};assert.equal(terminalComplete(complete,wanted),true);
 for(const change of [{applied:3},{effects:19,done:19},{done:19},{failed:1},{applications:0,applied:0,effects:0,done:0}])assert.equal(terminalComplete({...complete,...change},wanted),false);
 assert.throws(()=>terminalComplete(complete,{applications:0,effects:0}),/Nonempty/);
});
test('broker drain includes exact owned ready and unacknowledged counts',()=>{
 const ns='talk.prod.ui-1234abcd';const lines=['incoming','retry','dead'].map(q=>`${ns}.${q}\t0\t0`).join('\n');assert.equal(ownedQueueCounts(lines,ns).length,3);
 assert.equal(ownedQueueCounts(lines.replace('0\t0','0\t1'),ns)[0].unacknowledged,1);
 assert.throws(()=>ownedQueueCounts(lines.replace(ns+'.dead','foreign.dead'),ns),/Three/);assert.throws(()=>ownedQueueCounts(lines,'talk.prod.real'),/Owned/);
});
import {ownedConsumerPrefetch} from './terminal.mjs';
test('effective prefetch must match both actual owned consumers',()=>{
 const ns='talk.prod.ui-1234abcd',line=n=>`${ns}.incoming\t${n}\n${ns}.retry\t${n}`;
 for(const n of [1,2,8])assert.equal(ownedConsumerPrefetch(line(n),ns,n).length,2);
 assert.throws(()=>ownedConsumerPrefetch(line(8),ns,1),/differs/);assert.throws(()=>ownedConsumerPrefetch(line(1)+'\n'+ns+'.incoming\t1',ns,1),/differs/);assert.throws(()=>ownedConsumerPrefetch(line(1),ns,4),/bounded/);
});
import {awaitTerminal} from './terminal.mjs';
const completeCounts={applications:4,applied:4,effects:20,done:20,failed:0},expectedCounts={applications:4,effects:20};
const queueRows=n=>['incoming','retry','dead'].map((name,i)=>({name,ready:i===0?n:0,unacknowledged:i===0?n:0}));
test('SQL completion with queued references must wait for observed broker ACK/drain',async()=>{
 let at=0,calls=0;const result=await awaitTerminal({expected:expectedCounts,now:()=>at,pause:async ms=>{at+=ms;},readCounts:async()=>completeCounts,readQueues:async()=>queueRows(calls++===0?1:0)});
 assert.equal(result.complete,true);assert.equal(calls,2);assert.equal(result.observations[0].queues[0].ready,1);assert.equal(result.observations.at(-1).queues[0].unacknowledged,0);
});
test('terminal deadline preserves nonempty queues as a failure without clearing or replaying them',async()=>{
 let at=0;const result=await awaitTerminal({expected:expectedCounts,budgetMs:300,now:()=>at,pause:async ms=>{at+=ms;},readCounts:async()=>completeCounts,readQueues:async()=>queueRows(2)});
 assert.equal(result.complete,false);assert.equal(result.endedAt,300);assert.equal(result.queues[0].ready,2);
});
test('missing broker observations never count as an empty queue',async()=>{
 await assert.rejects(()=>awaitTerminal({expected:expectedCounts,readCounts:async()=>completeCounts,readQueues:async()=>[]}),/Three observed/);
});
