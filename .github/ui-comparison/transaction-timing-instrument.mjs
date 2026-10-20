import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
export function prepareTimingVariant(directory){
 const root=path.resolve(directory);if(!root.includes('/.validation/variants/')||!root.endsWith('-transaction-timing'))throw Error('Owned timing archive required');
 const hash=s=>createHash('sha256').update(s).digest('hex'),files={};
 const replacements={
  'apps/api/src/modules/ingress/runtime.ts':[
   ["import {", "import {installTiming} from './isolated-transaction-timing.mjs';\nimport {"],
   ['  const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });','  const db = installTiming(new PrismaClient({ datasources: { db: { url: config.databaseUrl } } }));']
  ],
  'apps/api/src/modules/ingress/consumer.ts':[
   ["import type { Channel", "import {traceTimingReceipt} from './isolated-transaction-timing.mjs';\nimport type { Channel"],
   ['  private async deliver(message: ConsumeMessage) {',`  private async deliver(message: ConsumeMessage) {
    const reference = decodeReference(message);
    if (!reference || !('receiptId' in reference)) return this.deliverTiming(message);
    return traceTimingReceipt(reference.receiptId, () => this.deliverTiming(message));
  }
  private async deliverTiming(message: ConsumeMessage) {`]
  ],
  'apps/api/src/modules/ingress/application.ts':[
   ['import { setTimeout',"import {traceTimingSpan} from './isolated-transaction-timing.mjs';\nimport { setTimeout"],
   ['await this.store.persistInTransaction(tx, event, { receiptKey: `${receiptId}:${eventIndex}` });',"await traceTimingSpan('app.store', () => this.store.persistInTransaction(tx, event, { receiptKey: `${receiptId}:${eventIndex}` }));"],
   ['await this.afterPersist(tx, receipt, eventIndex, event, result, source);',"await traceTimingSpan('app.afterPersist', () => this.afterPersist(tx, receipt, eventIndex, event, result, source));"]
  ],
  'apps/api/src/modules/messaging/canonical-boundary.ts':[
   ["SELECT current_setting('transaction_isolation') AS isolation", "SELECT current_setting('transaction_isolation') AS isolation, pg_backend_pid() AS \"__isolated_pid\", clock_timestamp() AS \"__isolated_clock\""]
  ]
 };
 // Validate every anchor before writing any file. First import is intentionally once.
 const prepared=[];
 for(const [file,items]of Object.entries(replacements)){
  const before=fs.readFileSync(path.join(root,file),'utf8');let after=before;
  for(const [a,b]of items){const n=after.split(a).length-1,expected=file.endsWith('canonical-boundary.ts')||a.startsWith('await this.store.persistInTransaction')?2:1;if(a!=='import {'&&n!==expected)throw Error('Unexpected timing anchor '+file);if(a==='import {'&&n<1)throw Error('Missing import');after=file.endsWith('canonical-boundary.ts')?after.replaceAll(a,b):after.replace(a,b);}
  prepared.push({file,before,after});
 }
 for(const {file,before,after}of prepared){fs.writeFileSync(path.join(root,file),after);files[file]={before:hash(before),after:hash(after)};}
 const helper=fs.readFileSync(new URL('./transaction-timing-runtime.mjs',import.meta.url));const dest='apps/api/src/modules/ingress/isolated-transaction-timing.mjs';fs.writeFileSync(path.join(root,dest),helper);files[dest]={before:null,after:hash(helper)};
 const manifest={scope:'Owned diagnostic worker only; no product source or transaction semantics changed',files};fs.writeFileSync(path.join(root,'transaction-timing-patch.json'),JSON.stringify(manifest,null,2));return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))prepareTimingVariant(process.argv[2]);
