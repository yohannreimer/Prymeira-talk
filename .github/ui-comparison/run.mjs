import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url)),pg=require('pg');const root=process.cwd(),art=path.join(root,'validation-artifacts');
const label='vps-compare-'+process.env.GITHUB_RUN_ID;if(!/^vps-compare-[0-9]+$/.test(label)||process.env.GITHUB_ACTIONS!=='true')throw Error('Owned CI only');
const images=JSON.parse(fs.readFileSync(path.join(art,'images.json'))),N='f2ff10305183d0a866d2564067f82f520dc7258b',B='1d7aa19ed9c4a48532937408b9ece782c53d5cd6';
function run(command,args,options={}){const r=cp.spawnSync(command,args,{encoding:'utf8',maxBuffer:12*1024*1024,...options});if(r.status!==0)throw Error(`${command} failed ${r.status}: ${(r.stderr??'').slice(-3000)}`);return r.stdout.trim();}
function save(n,x){fs.writeFileSync(path.join(art,n),JSON.stringify(x,null,2));}
function ids(){return run('docker',['ps','-aq','--filter','label=talk.compare='+label]).split('\n').filter(Boolean);}
function cleanup(){const found=ids();if(found.length)run('docker',['rm','-f',...found]);}
const fingerprints={};
for(const [key,image]of Object.entries(images)){if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Image ID required');const code=key==='web'?`find /usr/share/nginx/html -type f -exec sha256sum '{}' ';' | sort`:`const fs=require('fs'),c=require('crypto');console.log(JSON.stringify({node:process.version,arch:process.arch,prisma:require('@prisma/client').Prisma.prismaVersion,files:Object.fromEntries(['dist/ingress.js','dist/ingress-worker.js','dist/server.js'].map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))}));`;const value=run('docker',['run','--rm','--pull','never','--network','none','--entrypoint',key==='web'?'sh':'node',image,key==='web'?'-c':'-e',code]);fingerprints[key]=key==='web'?value:JSON.parse(value);}
save('runtime-fingerprints.json',fingerprints);
if(fingerprints.A_ingress.files['dist/ingress.js']!=='264d3e4205fea8f1ca8cdc830151ac80c86b435aeebd5cfad4684960d0c677db'||fingerprints.A_worker.files['dist/ingress-worker.js']!=='3c1816f07d03e0e362330a09708ad7e79c428531ce7f29d5bf2ff9b7fc011d28')throw Error('Observed live bundle hash mismatch');
for(const[k,v]of Object.entries(fingerprints))if(k!=='web'&&(v.node!=='v22.23.3'||v.arch!=='x64'||v.prisma.client!=='6.19.3'))throw Error('Wrong runtime');
const url=new URL(process.env.TALK_TEST_DATABASE_ADMIN_URL);if(url.hostname!=='127.0.0.1'||url.port!=='55439'||url.pathname!=='/postgres')throw Error('Unowned admin');const admin=new pg.Client({connectionString:url.href});await admin.connect();if((await admin.query("SELECT current_setting('data_directory') AS d")).rows[0].d!=='/var/lib/postgresql/data/talk_fixture')throw Error('Unowned DB');
const variants={A:{ingress:images.A_ingress,worker:images.A_worker,api:images.A_api,web:images.web},N:{ingress:images.N,worker:images.N,api:images.N,web:images.web}};
const pilot=process.env.UI_COMPARISON_PILOT==='true';const order=pilot?[{variant:'A',profile:'sustained'},{variant:'N',profile:'sustained'}]:['sustained','busy'].flatMap(profile=>['A','N','N','A'].map(variant=>({profile,variant})));
const summary={controller:run('git',['rev-parse','HEAD']),candidate:N,variants,order,pilot,limits:{ingress:{cpu:.5,MiB:512},worker:{cpu:.75,MiB:768},api:{cpu:2,MiB:2048},web:{cpu:1,MiB:1024}},slots:[],startedAt:new Date().toISOString()};save('comparison-plan.json',summary);
try{for(const [index,slot]of order.entries()){
 cleanup();await admin.query('DROP DATABASE IF EXISTS talk_rehearsal');await admin.query('CREATE DATABASE talk_rehearsal');
 run('pnpm',['--filter','@prymeira-talk/api','exec','prisma','migrate','deploy','--schema',path.join(root,'.validation/variants',slot.variant==='A'?B:N,'apps/api/prisma/schema.prisma')],{env:{...process.env,DATABASE_URL:process.env.REHEARSAL_DATABASE_URL}});
 const name=`${String(index+1).padStart(2,'0')}-${slot.profile}-${slot.variant}`,output=path.join(art,name);fs.mkdirSync(output,{recursive:true});const config={...slot,pilot,output,label,images:variants[slot.variant]};fs.writeFileSync(path.join(output,'config.json'),JSON.stringify(config,null,2));
 let stopped=false;const samples=[];const sampler=(async()=>{while(!stopped){const found=ids();if(found.length){const result=cp.spawnSync('docker',['stats','--no-stream','--format','{{json .}}',...found,process.env.TALK_COMPARE_PG_ID,process.env.TALK_COMPARE_RABBIT_ID],{encoding:'utf8',timeout:7000});samples.push({at:Date.now(),exit:result.status,lines:(result.stdout??'').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))});}await new Promise(r=>setTimeout(r,1000));}})();
 const log=fs.openSync(path.join(output,'slot-process.log'),'w');let result;
 try{result=await new Promise(resolve=>{const child=cp.spawn('node',['.github/ui-comparison/slot.mjs',path.join(output,'config.json')],{stdio:['ignore',log,log]});const timer=setTimeout(()=>child.kill('SIGTERM'),370000);child.on('close',(exit,signal)=>{clearTimeout(timer);resolve({exit,signal});});});}finally{stopped=true;await sampler;fs.closeSync(log);cleanup();fs.writeFileSync(path.join(output,'resources.json'),JSON.stringify(samples,null,2));}
 let evidence=null;try{evidence=JSON.parse(fs.readFileSync(path.join(output,'slot-result.json')));}catch{}
 const item={...slot,name,...result,evidence};summary.slots.push(item);save('comparison-summary.json',summary);console.log('UI_SLOT '+JSON.stringify(item));
 // Infrastructure/browser failure invalidates paired comparison; preserve diagnostic evidence for correction.
 if(result.exit!==0)throw Error('Slot failed: '+name);
}}finally{cleanup();await admin.end();summary.completedAt=new Date().toISOString();save('comparison-summary.json',summary);}
