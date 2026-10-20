import {test} from 'node:test';
import assert from 'node:assert/strict';
import {limitsFor, resourceExperimentOrder, twoCpuSet, assertCpuSet} from './limits.mjs';
test('raised experiment preserves the entire API quota and no role exceeds two CPUs', () => {
  const base=limitsFor('vps'), raised=limitsFor('raised');
  assert.deepEqual(raised.api, base.api);
  assert.deepEqual(base.api, {cpu:2, MiB:2048});
  for (const role of ['ingress','worker','web']) {
    assert(raised[role].cpu>base[role].cpu); assert(raised[role].cpu<=2); assert(raised[role].MiB>base[role].MiB);
  }
  raised.api.cpu=99; assert.equal(limitsFor('raised').api.cpu,2);
  assert.throws(()=>limitsFor('__proto__')); assert.throws(()=>limitsFor('production'));
});
test('each version and limit combination runs twice with balanced temporal positions', () => {
  const order=resourceExperimentOrder(); assert.equal(order.length,8);
  for(const variant of ['A','N']) for(const resourceProfile of ['vps','raised']) {
    const indices=order.flatMap((slot,i)=>slot.variant===variant&&slot.resourceProfile===resourceProfile?[i]:[]);
    assert.equal(indices.length,2); assert.equal(indices[0]+indices[1],7);
  }
  assert(order.every(s=>s.profile==='busy'));
});
test('shared affinity selects two allowed CPUs and rejects broad/untrusted CPU sets',()=>{
  assert.equal(twoCpuSet([6,2,4,0]),'0,2'); assert.equal(assertCpuSet('0,2'),'0,2');
  for(const value of [[],[0],[0,0],[-1,0],[0,1.5]]) assert.throws(()=>twoCpuSet(value));
  for(const value of ['',undefined,'0','0-3','0,0','0,1,2','0,1; other']) assert.throws(()=>assertCpuSet(value));
});
