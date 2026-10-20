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
