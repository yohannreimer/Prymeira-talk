import {test} from 'node:test';import assert from 'node:assert/strict';import {waitUntilDeadline} from './deadline.mjs';
test('an early timer cannot shorten the offer window',async()=>{let at=0,calls=0;await waitUntilDeadline(10,()=>at,async ms=>{calls++;at+=Math.max(1,ms-1);});assert.equal(at,10);assert.equal(calls,2);});
test('a reached deadline schedules no extra wait',async()=>{let calls=0;await waitUntilDeadline(10,()=>10,async()=>{calls++;});assert.equal(calls,0);});
