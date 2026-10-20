import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {prepareTimingVariant} from './transaction-timing-instrument.mjs';
export function prepareFlowVariant(directory){
 const root=path.resolve(directory);if(!root.includes('/.validation/variants/')||!root.endsWith('-transaction-timing'))throw Error('Owned flow archive required');
 const hash=v=>createHash('sha256').update(v).digest('hex'),changes={
  'apps/api/src/modules/ingress/effect-runner.ts':[
   ["import { createIdleBackoff", "import {installFlow,flowClaim,flowHandler,flowFinish,flowIdle} from './isolated-flow-timing.mjs';\nimport { createIdleBackoff"],
   ['export function createEffectRunner(options: EffectRunnerOptions) {','export function createEffectRunner(options: EffectRunnerOptions) {\n  installFlow();'],
   ['const effect = await claim();','const effect = await flowClaim(claim);'],
   ['outcome = await handlers[effect.kind]!(effect, { signal });','outcome = await flowHandler(effect, () => handlers[effect.kind]!(effect, { signal }));'],
   ['const changed = await finish(effect, outcome);','const changed = await flowFinish(effect, () => finish(effect, outcome));'],
   ['if (ran === 0) await delay(idleMs, undefined, { signal: options.signal }).catch(() => undefined);','if (ran === 0) await flowIdle(idleMs, () => delay(idleMs, undefined, { signal: options.signal }).catch(() => undefined));']
  ],
  'apps/api/src/modules/ingress/effect-handlers.ts':[
   ["import type { PrismaClient }", "import {flowOperation} from './isolated-flow-timing.mjs';\nimport type { PrismaClient }"],
   ['const conversation = await db.conversation.findUnique({ where: { workspaceId_id: { workspaceId, id: conversationId } }, include: conversationDtoInclude });',"const conversation = await flowOperation('conversation.dto', () => db.conversation.findUnique({ where: { workspaceId_id: { workspaceId, id: conversationId } }, include: conversationDtoInclude }));"],
   ["'realtime.message': async effect => {\n      const scope = needs(effect);\n      if (!scope) return skipped('no_message');\n      const message = await db.message.findFirst({ where: { id: scope.messageId, workspaceId: scope.workspaceId } });", "'realtime.message': async effect => {\n      const scope = needs(effect);\n      if (!scope) return skipped('no_message');\n      const message = await flowOperation('message.read', () => db.message.findFirst({ where: { id: scope.messageId, workspaceId: scope.workspaceId } }));"]
  ],
  'apps/api/src/modules/realtime/realtime-hub.ts':[
   ['import { realtimeEventSchema }',"import {flowEvent} from '../ingress/isolated-flow-timing.mjs';\nimport { realtimeEventSchema }"],
   ['const parsedEvent = realtimeEventSchema.parse(event);',"flowEvent('hub', event);\n      const parsedEvent = realtimeEventSchema.parse(event);"],
   ['client.send(payload);',"flowEvent('ws_send', parsedEvent);\n          client.send(payload);"]
  ],
  'apps/api/src/modules/realtime/realtime-bridge.ts':[
   ["import { randomUUID }", "import {flowEvent} from '../ingress/isolated-flow-timing.mjs';\nimport { randomUUID }"],
   ['if (!e || o === processId) return;',"if (!e || o === processId) return;\n        flowEvent('notify_receive', e);"],
   ["void pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch(error => {", "flowEvent('notify_submit', event);\n      void pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).then(value => { flowEvent('notify_done', event); return value; }).catch(error => {"]
  ]
 };
 const prepared=[];for(const[file,items]of Object.entries(changes)){const before=fs.readFileSync(path.join(root,file),'utf8');let after=before;for(const[a,b]of items){if(after.split(a).length-1!==1)throw Error('Unexpected flow anchor '+file);after=after.replace(a,b);}prepared.push({file,before,after});}
 // Validate all extra anchors before the existing timing patch writes anything.
 const transaction=prepareTimingVariant(root),files={};
 for(const{file,before,after}of prepared){fs.writeFileSync(path.join(root,file),after);files[file]={before:hash(before),after:hash(after)};}
 const file='apps/api/src/modules/ingress/isolated-flow-timing.mjs',helper=fs.readFileSync(new URL('./flow-timing-runtime.mjs',import.meta.url));fs.writeFileSync(path.join(root,file),helper);files[file]={before:null,after:hash(helper)};
 const manifest={scope:'Owned API and worker diagnostic archives; no scheduling, SQL, lease, dependency, lock, retry or ACK changes',transaction,files};fs.writeFileSync(path.join(root,'flow-timing-patch.json'),JSON.stringify(manifest,null,2));return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))prepareFlowVariant(process.argv[2]);
