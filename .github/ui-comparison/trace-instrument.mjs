import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(process.argv[2]??'');if(!root.includes('/.validation/variants/')||!root.endsWith('-diagnostic'))throw Error('Owned diagnostic source archive required');
const changes={};function patch(file,items){const p=path.join(root,file);let s=fs.readFileSync(p,'utf8');for(const [a,b]of items){if(!s.includes(a))throw Error('Missing diagnostic anchor '+file);s=s.replace(a,b);}fs.writeFileSync(p,s);changes[file]=items.map(([a])=>a);}
fs.copyFileSync('.github/ui-comparison/trace.mjs',path.join(root,'apps/api/src/modules/ingress/isolated-diagnostic.mjs'));
patch('apps/api/src/modules/ingress/runtime.ts',[
 ["import {", "import {install as installIsolatedDiagnostic} from './isolated-diagnostic.mjs';\nimport {"],
 ['  const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });',"  const db = installIsolatedDiagnostic(new PrismaClient({ datasources: { db: { url: config.databaseUrl } },log:[{emit:'event',level:'query'}] }));"]
]);
patch('apps/api/src/modules/ingress/consumer.ts',[
 ["import type { Channel", "import {traceReceipt} from './isolated-diagnostic.mjs';\nimport type { Channel"],
 ['  private async deliver(message: ConsumeMessage) {',`  private async deliver(message: ConsumeMessage) {
    const reference = decodeReference(message);
    if (!reference || !('receiptId' in reference)) return this.deliverTraced(message);
    return traceReceipt(reference.receiptId, () => this.deliverTraced(message));
  }
  private async deliverTraced(message: ConsumeMessage) {`]
]);
patch('apps/api/src/modules/ingress/application.ts',[
 ["import { setTimeout", "import {span} from './isolated-diagnostic.mjs';\nimport { setTimeout"],
 ["await this.store.persistInTransaction(tx, event, { receiptKey: `${receiptId}:${eventIndex}` });","await span('app.store', () => this.store.persistInTransaction(tx, event, { receiptKey: `${receiptId}:${eventIndex}` }));"],
 ["await this.afterPersist(tx, receipt, eventIndex, event, result, source);","await span('app.afterPersist', () => this.afterPersist(tx, receipt, eventIndex, event, result, source));"]
]);
patch('apps/api/src/modules/messaging/canonical-store.ts',[
 ["import {", "import {rows as diagnosticRows} from '../ingress/isolated-diagnostic.mjs';\nimport {"],
 ['    const parents = new Map(rows.map(r => [r.id, r.redirectId]));',"    diagnosticRows('graph',rows.length);\n    const parents = new Map(rows.map(r => [r.id, r.redirectId]));"]
]);
fs.writeFileSync(path.join(root,'diagnostic-patches.json'),JSON.stringify(changes,null,2));
