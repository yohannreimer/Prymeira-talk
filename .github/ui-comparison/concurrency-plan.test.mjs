import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {concurrencyOrder,preparePrefetchVariant} from './concurrency-plan.mjs';
test('balanced order isolates batch changes at8 and concurrency1/2 with repeated same images',()=>{
 const order=concurrencyOrder();assert.deepEqual(order.map(x=>x.variant),['R8','C8','C2','C1','C1','C2','C8','R8']);
 for(const row of order){assert.equal(row.resourceProfile,'raised');assert.equal(row.prefetch,Number(row.variant.slice(1)));}
});
test('prefetch patch requires an owned archive, exact bounded value and one runtime anchor',()=>{
 assert.throws(()=>preparePrefetchVariant('/tmp/not-owned',1),/Owned/);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'talk-prefetch-'));
 try{for(const n of [1,2]){const dir=path.join(root,'.validation/variants/source-prefetch-'+n),file=path.join(dir,'apps/api/src/modules/ingress/runtime.ts');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'consumer = await IngressTransportConsumer.start({ url: config.amqpUrl, application: service });');
  const result=preparePrefetchVariant(dir,n);assert.equal(result.prefetch,n);assert.notEqual(Object.values(result.files)[0].before,Object.values(result.files)[0].after);assert.match(fs.readFileSync(file,'utf8'),new RegExp('prefetch: '+n));assert.throws(()=>preparePrefetchVariant(dir,n),/anchor/);
 }assert.throws(()=>preparePrefetchVariant(path.join(root,'.validation/variants/source-prefetch-8'),8),/Owned/);}finally{fs.rmSync(root,{recursive:true});}
});
