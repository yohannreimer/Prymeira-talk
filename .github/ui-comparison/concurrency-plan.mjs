import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
export function concurrencyOrder(){return ['R8','C8','C2','C1','C1','C2','C8','R8'].map(variant=>({variant,profile:'busy',resourceProfile:'raised',prefetch:Number(variant.slice(1))}));}
export function preparePrefetchVariant(directory,prefetch){
 const root=path.resolve(directory);if(![1,2].includes(prefetch)||!root.includes('/.validation/variants/')||!root.endsWith('-prefetch-'+prefetch))throw Error('Owned prefetch archive required');
 const relative='apps/api/src/modules/ingress/runtime.ts',file=path.join(root,relative),before=fs.readFileSync(file,'utf8');
 const anchor='consumer = await IngressTransportConsumer.start({ url: config.amqpUrl,';
 if(before.split(anchor).length!==2)throw Error('Exactly one consumer runtime anchor required');
 const after=before.replace(anchor,`consumer = await IngressTransportConsumer.start({ prefetch: ${prefetch}, url: config.amqpUrl,`);
 fs.writeFileSync(file,after);const digest=s=>createHash('sha256').update(s).digest('hex');
 const manifest={prefetch,scope:'Owned synthetic worker image only; product default remains 8',files:{[relative]:{before:digest(before),after:digest(after)}}};
 fs.writeFileSync(path.join(root,'prefetch-patch.json'),JSON.stringify(manifest,null,2));return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))preparePrefetchVariant(process.argv[2],Number(process.argv[3]));
