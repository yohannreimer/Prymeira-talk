import os from 'node:os';import {limitsFor,resourceExperimentOrder,twoCpuSet} from './limits.mjs';
import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url)),pg=require('pg');const root=process.cwd(),art=path.join(root,'validation-artifacts');
const label='vps-compare-'+process.env.GITHUB_RUN_ID;if(!/^vps-compare-[0-9]+$/.test(label)||process.env.GITHUB_ACTIONS!=='true')throw Error('Owned CI only');
const images=JSON.parse(fs.readFileSync(path.join(art,'images.json'))),N='f2ff10305183d0a866d2564067f82f520dc7258b',B='1d7aa19ed9c4a48532937408b9ece782c53d5cd6';
function run(command,args,options={}){const r=cp.spawnSync(command,args,{encoding:'utf8',maxBuffer:12*1024*1024,...options});if(r.status!==0)throw Error(`${command} failed ${r.status}: ${(r.stderr??'').slice(-3000)}`);return r.stdout.trim();}
function save(n,x){fs.writeFileSync(path.join(art,n),JSON.stringify(x,null,2));}
function ids(){return run('docker',['ps','-aq','--filter','label=talk.compare='+label]).split('\n').filter(Boolean);}
function cleanup(){const found=ids();if(found.length)run('docker',['rm','-f',...found]);}
const fingerprints={};
for(const [key,image]of Object.entries(images)){if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Image ID required');const code=key.endsWith('_web')?`find /usr/share/nginx/html -type f -exec sha256sum '{}' ';' | sort`:`const fs=require('fs'),c=require('crypto');console.log(JSON.stringify({node:process.version,arch:process.arch,prisma:require('@prisma/client').Prisma.prismaVersion,files:Object.fromEntries(['dist/ingress.js','dist/ingress-worker.js','dist/server.js'].map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))}));`;const value=run('docker',['run','--rm','--pull','never','--network','none','--entrypoint',key.endsWith('_web')?'sh':'node',image,key.endsWith('_web')?'-c':'-e',code]);fingerprints[key]=key.endsWith('_web')?value:JSON.parse(value);}
save('runtime-fingerprints.json',fingerprints);
if(fingerprints.A_ingress.files['dist/ingress.js']!=='264d3e4205fea8f1ca8cdc830151ac80c86b435aeebd5cfad4684960d0c677db'||fingerprints.A_worker.files['dist/ingress-worker.js']!=='3c1816f07d03e0e362330a09708ad7e79c428531ce7f29d5bf2ff9b7fc011d28')throw Error('Observed live bundle hash mismatch');
for(const[k,v]of Object.entries(fingerprints))if(!k.endsWith('_web')&&(v.node!=='v22.23.3'||v.arch!=='x64'||v.prisma.client!=='6.19.3'))throw Error('Wrong runtime');
const url=new URL(process.env.TALK_TEST_DATABASE_ADMIN_URL);if(url.hostname!=='127.0.0.1'||url.port!=='55439'||url.pathname!=='/postgres')throw Error('Unowned admin');const admin=new pg.Client({connectionString:url.href});await admin.connect();if((await admin.query("SELECT current_setting('data_directory') AS d")).rows[0].d!=='/var/lib/postgresql/data/talk_fixture')throw Error('Unowned DB');
const variants={D:{ingress:images.N,worker:images.D,api:images.N,web:images.N_web},A:{ingress:images.A_ingress,worker:images.A_worker,api:images.A_api,web:images.A_web},N:{ingress:images.N,worker:images.N,api:images.N,web:images.N_web}};
const traceExperiment=process.env.UI_COMPARISON_TRACE_EXPERIMENT==='true';
if(traceExperiment&&(!images.D||fingerprints.D.files['dist/ingress-worker.js']===fingerprints.N.files['dist/ingress-worker.js']))throw Error('Diagnostic worker image required');
const limitExperiment=process.env.UI_COMPARISON_LIMIT_EXPERIMENT==='true';
let cpuSet=null;
if(limitExperiment||traceExperiment){
 const allowed=JSON.parse(run('python3',['-c','import os,json; print(json.dumps(sorted(os.sched_getaffinity(0))))']));cpuSet=twoCpuSet(allowed);
 const fixtures={postgres:process.env.TALK_COMPARE_PG_ID,rabbitmq:process.env.TALK_COMPARE_RABBIT_ID};
 for(const [role,id]of Object.entries(fixtures)){
  if(!/^[a-f0-9]{64}$/.test(id??''))throw Error('Exact owned CI service ID required');
  const inspected=JSON.parse(run('docker',['inspect',id]))[0];
  const expectedImage=role==='postgres'?'postgres:16.13-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50':'rabbitmq:3.12.14-alpine@sha256:97907aceae0a6fbfb24847724adadf12f536a2b9bf547a42bc9dad153ed74e99';
  if(inspected.Config.Image!==expectedImage)throw Error('Unexpected fixture image');
  run('docker',['update','--cpuset-cpus',cpuSet,id]);
 }
 run('taskset',['-apc',cpuSet,String(process.pid)]);
 save('shared-cpu-boundary.json',{cpuSet,allowedBefore:allowed,controllerAffinity:JSON.parse(run('python3',['-c','import os,json; print(json.dumps(sorted(os.sched_getaffinity(0))))'])),fixtures:Object.fromEntries(Object.entries(fixtures).map(([role,id])=>{const x=JSON.parse(run('docker',['inspect',id]))[0];return[role,{id:x.Id,image:x.Config.Image,cpuSet:x.HostConfig.CpusetCpus}]})),scope:'Application, PostgreSQL, RabbitMQ, offer generator, browser and observer share these same two logical CPUs; other VPS services are absent.'});
}
const pilot=process.env.UI_COMPARISON_PILOT==='true';const profiles=(process.env.UI_COMPARISON_PROFILES??'sustained,busy').split(',');if(!profiles.length||profiles.some(p=>!['sustained','busy'].includes(p)))throw Error('Undeclared profile');if(limitExperiment&&(pilot||profiles.join(',')!=='busy'))throw Error('Resource experiment requires complete busy profile');const order=traceExperiment?['N','D','N'].map(variant=>({variant,profile:'busy',resourceProfile:'raised'})):limitExperiment?resourceExperimentOrder():pilot?[{variant:'A',profile:'sustained'},{variant:'N',profile:'sustained'}]:profiles.flatMap(profile=>['A','N','N','A'].map(variant=>({profile,variant})));
const summary={controller:run('git',['rev-parse','HEAD']),candidate:N,variants,order,pilot,limitExperiment,traceExperiment,cpuSet,limits:limitsFor('vps'),resourceProfiles:limitExperiment?{vps:limitsFor('vps'),raised:limitsFor('raised')}:undefined,slots:[],startedAt:new Date().toISOString()};save('comparison-plan.json',summary);
try{for(const [index,slot]of order.entries()){
 cleanup();await admin.query('DROP DATABASE IF EXISTS talk_rehearsal');await admin.query('CREATE DATABASE talk_rehearsal');
 run('pnpm',['--filter','@prymeira-talk/api','exec','prisma','migrate','deploy','--schema',path.join(root,'.validation/variants',slot.variant==='A'?B:N,'apps/api/prisma/schema.prisma')],{env:{...process.env,DATABASE_URL:process.env.REHEARSAL_DATABASE_URL}});
 const name=`${String(index+1).padStart(2,'0')}-${slot.profile}-${slot.variant}${limitExperiment||traceExperiment?'-'+slot.resourceProfile:''}`,output=path.join(art,name);fs.mkdirSync(output,{recursive:true});const config={...slot,pilot,output,label,cpuSet,traceExperiment,diagnostic:slot.variant==='D',limits:limitsFor(slot.resourceProfile??'vps'),images:variants[slot.variant]};fs.writeFileSync(path.join(output,'config.json'),JSON.stringify(config,null,2));
 let stopped=false;const samples=[];const sampler=(async()=>{while(!stopped){const found=ids();if(found.length){const result=cp.spawnSync('docker',['stats','--no-stream','--format','{{json .}}',...found,process.env.TALK_COMPARE_PG_ID,process.env.TALK_COMPARE_RABBIT_ID],{encoding:'utf8',timeout:7000});samples.push({at:Date.now(),host:{loadavg:os.loadavg(),freeMemory:os.freemem(),cpuPressure:fs.readFileSync('/proc/pressure/cpu','utf8')},exit:result.status,lines:(result.stdout??'').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))});}await new Promise(r=>setTimeout(r,1000));}})();
 const log=fs.openSync(path.join(output,'slot-process.log'),'w');let result;
 try{result=await new Promise(resolve=>{const child=cp.spawn('node',['.github/ui-comparison/slot.mjs',path.join(output,'config.json')],{stdio:['ignore',log,log]});const timer=setTimeout(()=>child.kill('SIGTERM'),370000);child.on('close',(exit,signal)=>{clearTimeout(timer);resolve({exit,signal});});});}finally{stopped=true;await sampler;fs.closeSync(log);cleanup();fs.writeFileSync(path.join(output,'resources.json'),JSON.stringify(samples,null,2));}
 let evidence=null;try{evidence=JSON.parse(fs.readFileSync(path.join(output,'slot-result.json')));}catch{}
 const item={...slot,name,...result,evidence};summary.slots.push(item);save('comparison-summary.json',summary);console.log('UI_SLOT '+JSON.stringify(item));
 // Infrastructure/browser failure invalidates paired comparison; preserve diagnostic evidence for correction.
 if(result.exit!==0)throw Error('Slot failed: '+name);
}}finally{cleanup();await admin.end();summary.completedAt=new Date().toISOString();save('comparison-summary.json',summary);}
