import {test} from 'node:test';import assert from 'node:assert/strict';import {quantiles} from './analyze.mjs';
test('nearest rank p95 includes the slow tail',()=>assert.deepEqual(quantiles(Array.from({length:20},(_,i)=>i+1)),{n:20,p50:10,p95:19,max:20}));
test('missing measurements never become zero latency',()=>{assert.deepEqual(quantiles([null,undefined,NaN]),{n:0,p50:null,p95:null,max:null});assert.deepEqual(quantiles([null,2000]),{n:1,p50:2000,p95:2000,max:2000});});
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {analyze} from './analyze.mjs';
test('coverage keeps rejected and unseen target offers outside the conditional percentile',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'talk-ui-metric-'));
 const event=(marker,i,status)=>({marker,i,target:true,rawId:'raw-'+i,at:1000,endedAt:1100,status,data:{receiptId:'r'+i}});
 const fixtures={
 'offers.json':{offers:[event('TALKUI_00001',1,202),event('TALKUI_00002',2,503),event('TALKUI_00003',3,202)]},
 'browser.json':{clocks:[{offset:5,uncertainty:.5}],times:[{marker:'TALKUI_00001',phase:'visibleAfterTwoFrames',at:3005,id:'m1'}],frames:[],errors:[],requests:[]},
 'browser-config.json':{url:'http://127.0.0.1/?conversation=c1'},
 'final-oracles.json':{identities:[{rawId:'raw-1'}],messages:[{id:'m1',body:'TALKUI_00001',conversationId:'c1'}],applications:[]},
 'database-observations.json':[]};
 try{for(const[n,v]of Object.entries(fixtures))fs.writeFileSync(path.join(dir,n),JSON.stringify(v));const x=analyze(dir);assert.equal(x.targetOffered,3);assert.equal(x.targetAdmitted,2);assert.equal(x.targetVisible,1);assert.deepEqual(x.missingAdmitted,['TALKUI_00003']);assert.deepEqual(x.metrics.visibleMs,{n:1,p50:2000,p95:2000,max:2000});assert.equal(x.statusCounts[503],1);}
 finally{fs.rmSync(dir,{recursive:true});}
});
