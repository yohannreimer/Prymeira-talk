import os from 'node:os';import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';import {createRequire} from 'node:module';
import {limitsFor,twoCpuSet} from './limits.mjs';import {sanitizePostgresDurations} from './transaction-timing-log.mjs';import {analyze} from './analyze.mjs';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url)),pg=require('pg'),root=process.cwd(),art=path.join(root,'validation-artifacts');
const label='vps-compare-'+process.env.GITHUB_RUN_ID,reference='84fdda859a4498f7e8ff8dde0143e2d590fa4e71',candidate='4a9acfe2e62f9407d30573afba9d496a9f1af73d',controller=process.env.GITHUB_SHA;
if(!/^vps-compare-[0-9]+$/.test(label)||process.env.GITHUB_ACTIONS!=='true'||!/^[a-f0-9]{40}$/.test(candidate??''))throw Error('Owned exact CI revision required');
function run(command,args,options={}){const r=cp.spawnSync(command,args,{encoding:'utf8',maxBuffer:16*1024*1024,...options});if(r.status!==0)throw Error(`${command} failed: ${(r.stderr??'').slice(-2000)}`);return r.stdout.trim();}
function save(name,value){fs.writeFileSync(path.join(art,name),JSON.stringify(value,null,2));}
function ids(){return run('docker',['ps','-aq','--filter','label=talk.compare='+label]).split('\n').filter(Boolean);}
function cleanup(){const found=ids();if(found.length)run('docker',['rm','-f',...found]);}
const images=JSON.parse(fs.readFileSync(path.join(art,'images.json'))),fingerprints={};
for(const[key,image]of Object.entries(images)){
 if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Immutable local image ID required');
 const web=key.endsWith('_web'),code=web?"find /usr/share/nginx/html -type f -exec sha256sum '{}' ';' | sort":`const fs=require('fs'),c=require('crypto');console.log(JSON.stringify({node:process.version,arch:process.arch,prisma:require('@prisma/client').Prisma.prismaVersion,files:Object.fromEntries(['dist/ingress.js','dist/ingress-worker.js','dist/server.js'].map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))}));`;
 const result=run('docker',['run','--rm','--pull','never','--network','none','--entrypoint',web?'sh':'node',image,web?'-c':'-e',code]);fingerprints[key]=web?result:JSON.parse(result);
 if(!web&&(fingerprints[key].node!=='v22.23.3'||fingerprints[key].arch!=='x64'||fingerprints[key].prisma.client!=='6.19.3'))throw Error('Wrong runtime');
}
save('runtime-fingerprints.json',fingerprints);
if(fingerprints.R.files['dist/ingress-worker.js']!=='d7545541b9764ecd035c8bfd1c53bdb0a0dd175d61d253d5d1339bd4ca2e9941')throw Error('Wrong immutable reference worker');
if(fingerprints.R_web!==fingerprints.N_web)throw Error('Frontend changed outside approved scope');
if(fingerprints.N.files['dist/ingress-worker.js']!=='cb8a49734a19777d38a48456034d4a9dc7b2895bbe1b7091c4a5f7d21897188d'||fingerprints.N.files['dist/server.js']!=='32a6770d9399fa4085c5baf8e69776a2f2d6e192b4c6251eea441f0f1f261834')throw Error('Wrong immutable candidate runtime');
for(const normal of ['R','N'])for(const file of ['dist/ingress-worker.js','dist/server.js'])if(fingerprints[normal].files[file]===fingerprints[normal+'D'].files[file])throw Error('Diagnostic must differ');
const adminUrl=new URL(process.env.TALK_TEST_DATABASE_ADMIN_URL);if(adminUrl.hostname!=='127.0.0.1'||adminUrl.port!=='55439'||adminUrl.pathname!=='/postgres')throw Error('Owned admin only');
const admin=new pg.Client({connectionString:adminUrl.href});await admin.connect();if((await admin.query('SHOW data_directory')).rows[0].data_directory!=='/var/lib/postgresql/data/talk_fixture')throw Error('Owned cluster only');
const allowed=JSON.parse(run('python3',['-c','import os,json;print(json.dumps(sorted(os.sched_getaffinity(0))))'])),cpuSet=twoCpuSet(allowed);
const fixtures={postgres:process.env.TALK_COMPARE_PG_ID,rabbitmq:process.env.TALK_COMPARE_RABBIT_ID};
const expectedImages={postgres:'postgres:16.13-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50',rabbitmq:'rabbitmq:3.12.14-alpine@sha256:97907aceae0a6fbfb24847724adadf12f536a2b9bf547a42bc9dad153ed74e99'};
for(const[role,id]of Object.entries(fixtures)){if(!/^[a-f0-9]{64}$/.test(id??''))throw Error('Exact owned service required');const x=JSON.parse(run('docker',['inspect',id]))[0];if(x.Config.Image!==expectedImages[role])throw Error('Wrong fixture image');run('docker',['update','--cpuset-cpus',cpuSet,id]);}
run('taskset',['-apc',cpuSet,String(process.pid)]);
save('shared-cpu-boundary.json',{cpuSet,allowedBefore:allowed,controllerAffinity:JSON.parse(run('python3',['-c','import os,json;print(json.dumps(sorted(os.sched_getaffinity(0))))'])),fixtures:Object.fromEntries(Object.entries(fixtures).map(([role,id])=>{const x=JSON.parse(run('docker',['inspect',id]))[0];return[role,{id:x.Id,image:x.Config.Image,cpuSet:x.HostConfig.CpusetCpus}]})),scope:'Application, data services and controller descendants share two logical CPU IDs; other VPS services are absent.'});
const variants={R:{ingress:images.R,worker:images.R,api:images.R,web:images.R_web},N:{ingress:images.N,worker:images.N,api:images.N,web:images.N_web},RD:{ingress:images.R,worker:images.RD,api:images.RD,web:images.R_web},ND:{ingress:images.N,worker:images.ND,api:images.ND,web:images.N_web}};
await admin.query("ALTER SYSTEM SET log_line_prefix = '%m [%p] app=%a '");await admin.query('SELECT pg_reload_conf()');
const order=['R','N','RD','ND','N','R'].map(variant=>({variant,profile:'busy',resourceProfile:'raised',prefetch:8}));
const summary={controller,candidate,baseline:reference,variants,order,pilot:false,cpuSet,limits:limitsFor('raised'),slots:[],startedAt:new Date().toISOString(),scope:'Normal controls and symmetric API/worker flow diagnostics; diagnostics excluded from normal latency comparison. Locks,quotas and QoS preserved.'};save('comparison-plan.json',summary);
try{for(const[index,slot]of summary.order.entries()){
 cleanup();await admin.query('DROP DATABASE IF EXISTS talk_rehearsal');await admin.query('CREATE DATABASE talk_rehearsal');
 const diagnostic=slot.variant.endsWith('D');await admin.query("ALTER DATABASE talk_rehearsal SET log_min_duration_statement = '"+(diagnostic?'0':'-1')+"'");
 await admin.query("ALTER DATABASE talk_rehearsal SET log_parameter_max_length = '0'");await admin.query("ALTER DATABASE talk_rehearsal SET log_parameter_max_length_on_error = '0'");await admin.query("ALTER DATABASE talk_rehearsal SET log_statement = 'none'");
 run('pnpm',['--filter','@prymeira-talk/api','exec','prisma','migrate','deploy','--schema',path.join(root,'.validation/variants',slot.variant==='R'?reference:candidate,'apps/api/prisma/schema.prisma')],{env:{...process.env,DATABASE_URL:process.env.REHEARSAL_DATABASE_URL}});
 const name=`${String(index+1).padStart(2,'0')}-busy-${slot.variant}-raised`,output=path.join(art,name);fs.mkdirSync(output,{recursive:true});
 const serverLogSince=new Date().toISOString();
 const config={...slot,transactionTimingExperiment:true,timingDiagnostic:diagnostic,flowDiagnostic:diagnostic,pilot:false,output,label,cpuSet,traceExperiment:false,observeWaits:diagnostic,diagnostic:false,terminalDrain:true,limits:limitsFor('raised'),images:variants[slot.variant]};fs.writeFileSync(path.join(output,'config.json'),JSON.stringify(config,null,2));
 let stopped=false;const samples=[];const sampler=(async()=>{while(!stopped){const found=ids();if(found.length){const r=cp.spawnSync('docker',['stats','--no-stream','--format','{{json .}}',...found,...Object.values(fixtures)],{encoding:'utf8',timeout:7000});samples.push({at:Date.now(),host:{loadavg:os.loadavg(),freeMemory:os.freemem(),cpuPressure:fs.readFileSync('/proc/pressure/cpu','utf8')},exit:r.status,lines:(r.stdout??'').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))});}await new Promise(r=>setTimeout(r,1000));}})();
 const log=fs.openSync(path.join(output,'slot-process.log'),'w');let result;
 try{result=await new Promise(resolve=>{const child=cp.spawn('node',['.github/ui-comparison/slot.mjs',path.join(output,'config.json')],{stdio:['ignore',log,log]}),timer=setTimeout(()=>child.kill('SIGTERM'),370000);child.on('close',(exit,signal)=>{clearTimeout(timer);resolve({exit,signal});});});}finally{stopped=true;await sampler;fs.closeSync(log);
 if(diagnostic){const log=cp.spawnSync('docker',['logs','--since',serverLogSince,fixtures.postgres],{encoding:'utf8',maxBuffer:256*1024*1024,timeout:20000});if(log.status!==0)throw Error('Owned PostgreSQL timing log unavailable');const parsed=sanitizePostgresDurations((log.stdout??'')+'\n'+(log.stderr??''));fs.writeFileSync(path.join(output,'postgres-durations.json'),JSON.stringify(parsed));if(!parsed.complete||!parsed.entries.length)throw Error('Incomplete PostgreSQL duration parse');}
 cleanup();fs.writeFileSync(path.join(output,'resources.json'),JSON.stringify(samples,null,2));}
 let evidence=null,analysis=null;try{evidence=JSON.parse(fs.readFileSync(path.join(output,'slot-result.json')));analysis=analyze(output);}catch{}
 const item={...slot,name,...result,evidence};summary.slots.push(item);save('comparison-summary.json',summary);if(analysis)fs.writeFileSync(path.join(output,'analysis.json'),JSON.stringify(analysis,null,2));console.log('UI_SLOT '+JSON.stringify(item));
 if(result.exit!==0||!evidence?.complete||!analysis||analysis.dbMessageCount!==240||analysis.dbIdentityCount!==240||analysis.dbAppliedReceipts!==480||analysis.targetVisible!==60||Object.keys(analysis.statusCounts).length!==1||analysis.statusCounts[202]!==480||['missingDurable','missingAdmitted','unreadyIdentity','unverifiedIdentityBody','wrongAssociation','duplicateCanonical','duplicateUiBubbles','browserErrors','browserHttpErrors'].some(k=>analysis[k].length))throw Error('Incomplete or invalid synthetic slot: '+name);
}}finally{cleanup();await admin.end();summary.completedAt=new Date().toISOString();save('comparison-summary.json',summary);}
