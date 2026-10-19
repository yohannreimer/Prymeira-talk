import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';import crypto from 'node:crypto';import {createRequire} from 'node:module';const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));const pg=require('pg');
const root=fs.realpathSync(process.cwd()),art=path.join(root,'validation-artifacts');fs.mkdirSync(art,{recursive:true});
const E='da7a017ad53d3265396ec41e8fde8c49e360215f';
const C='4c718f6f8b3450e1633697bef5e45381ab813dcb',B='1d7aa19ed9c4a48532937408b9ece782c53d5cd6';
const expected={ingress:'264d3e4205fea8f1ca8cdc830151ac80c86b435aeebd5cfad4684960d0c677db',worker:'3c1816f07d03e0e362330a09708ad7e79c428531ce7f29d5bf2ff9b7fc011d28'};
const label='vps-compare-'+process.env.GITHUB_RUN_ID;if(!/^vps-compare-[0-9]+$/.test(label))throw Error('Owned GitHub job only');
const env={...process.env};for(const k of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_KEY/.test(k))delete env[k];delete env.NODE_OPTIONS;delete env.TALK_VALIDATION_RUN_ID;
function run(cmd,args,options={}){const r=cp.spawnSync(cmd,args,{cwd:root,env,encoding:'utf8',maxBuffer:16*1024*1024,...options});if(r.status!==0)throw Error(`${cmd} ${args.slice(0,3).join(' ')} failed ${r.status}: ${(r.stderr??'').slice(-1500)}`);return r.stdout.trim();}
function write(file,x){fs.writeFileSync(file,JSON.stringify(x,null,2)+'\n');}
function ids(){return run('docker',['ps','-aq','--filter','label=talk.compare='+label]).split('\n').filter(Boolean);}
function cleanup(){const found=ids();if(found.length)run('docker',['rm','-f',...found]);}
const images=JSON.parse(fs.readFileSync(path.join(art,'images.json'))),fingerprints={};
for(const[key,image]of Object.entries(images)){
 if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Immutable image ID required');
 const code=`const fs=require('fs'),c=require('crypto');console.log(JSON.stringify({node:process.version,arch:process.arch,prisma:require('@prisma/client').Prisma.prismaVersion,files:Object.fromEntries(['dist/ingress.js','dist/ingress-worker.js'].map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))}));`;
 fingerprints[key]=JSON.parse(run('docker',['run','--rm','--pull','never','--network','none','--entrypoint','node',image,'-e',code]));
 if(fingerprints[key].node!=='v22.23.3'||fingerprints[key].prisma.client!=='6.19.3'||fingerprints[key].prisma.engine!=='c2990dca591cba766e3b7ef5d9e8a84796e47ab7')throw Error('Runtime version mismatch');
}
write(path.join(art,'runtime-fingerprints.json'),fingerprints);
if(fingerprints.A_ingress.files['dist/ingress.js']!==expected.ingress||fingerprints.A_worker.files['dist/ingress-worker.js']!==expected.worker)throw Error('Rebuilt deployed bundle differs from live read; comparison blocked');
const variants={A:{ingress:images.A_ingress,worker:images.A_worker,schema:B,description:'exact deployed role revisions, bundles matched live hashes; reconstructed OS layers'},B:{ingress:images.B,worker:images.B,schema:B,description:'pre-change source control'},E:{ingress:images.E,worker:images.E,schema:E,description:'static authentication without empty SQL transaction'},C:{ingress:images.C,worker:images.C,schema:C,description:'approved candidate runtime9e1, tooling4c7'}};
const adminUrl=env.TALK_TEST_DATABASE_ADMIN_URL;if(new URL(adminUrl).hostname!=='127.0.0.1'||new URL(adminUrl).port!=='55439'||new URL(adminUrl).pathname!=='/postgres')throw Error('Unowned DB endpoint');
const admin=new pg.Client({connectionString:adminUrl});await admin.connect();const owned=(await admin.query("SELECT current_setting('data_directory') AS directory")).rows[0];if(owned.directory!=='/var/lib/postgresql/data/talk_fixture')throw Error('Unowned PostgreSQL');
const api=path.join(root,'apps/api');fs.mkdirSync(path.join(api,'tmp'),{recursive:true});fs.copyFileSync(path.join(root,'.github/comparison/common-load.postgres.test.ts'),path.join(api,'tmp/common-load.postgres.test.ts'));
const order=['A','B','C','C','B','A'],summary={kind:'matched-comparison',diagnosticOnly:true,qualification:false,controllerSha:run('git',['rev-parse','HEAD']),startedAt:new Date().toISOString(),variants,order:[{variant:'C',recovery:'enabled'},{variant:'E',recovery:'enabled'},{variant:'E',recovery:'disabled'},{variant:'C',recovery:'disabled'},{variant:'E',recovery:'disabled',ingressCpu:'1'},{variant:'C',recovery:'disabled',ingressCpu:'1'}],slots:[],caps:{ingress:{cpu:.5,memoryMiB:512},worker:{cpu:.75,memoryMiB:768}},limitations:['Same code bundles/Node/Prisma verified; not original full OCI/OS layer identity','Not full VPS capacity, API effects execution, browser or WhatsApp transport certification']};write(path.join(art,'comparison-plan.json'),summary);
try{
 for(const[zero,slot]of summary.order.entries()){
  const num=String(zero+1).padStart(2,'0'),name=`${num}-${slot.recovery}-${slot.variant}`,output=path.join(art,name);fs.mkdirSync(output);const variant=variants[slot.variant];cleanup();
  // Reset only this job's isolated database; no backend termination or shared DB connection.
  await admin.query('DROP DATABASE IF EXISTS talk_rehearsal');await admin.query('CREATE DATABASE talk_rehearsal');
  const schema=path.join(root,'.validation/variants',variant.schema,'apps/api/prisma/schema.prisma');
  run('pnpm',['--filter','@prymeira-talk/api','exec','prisma','migrate','deploy','--schema',schema],{env:{...env,DATABASE_URL:env.REHEARSAL_DATABASE_URL}});
  const clients=await admin.query("SELECT datname FROM pg_database WHERE datname='talk_rehearsal'");if(clients.rows.length!==1)throw Error('Fixture missing');
  let stop=false;const samples=[];
  const sampler=(async()=>{while(!stop){const containers=ids();if(containers.length){const r=cp.spawnSync('docker',['stats','--no-stream','--format','{{json .}}',...containers,env.TALK_COMPARE_PG_ID,env.TALK_COMPARE_RABBIT_ID],{encoding:'utf8',timeout:5000});samples.push({at:new Date().toISOString(),exit:r.status,rows:(r.stdout??'').trim().split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return {parseError:true};}}),error:(r.stderr??'').trim()});}await new Promise(r=>setTimeout(r,1000));}})();
  const stdout=fs.openSync(path.join(output,'stdout.log'),'wx'),stderr=fs.openSync(path.join(output,'stderr.log'),'wx');const start=Date.now();let result;
  try{
   result=await new Promise(resolve=>{
    const child=cp.spawn('pnpm',['exec','vitest','run','tmp/common-load.postgres.test.ts','--maxWorkers=1','--fileParallelism=false','--reporter=default','--reporter=json','--outputFile.json='+path.join(output,'tests.json')],{cwd:api,env:{...env,NODE_OPTIONS:'--import=file://'+path.join(root,'.github/comparison/image-spawn.mjs'),TALK_COMPARE_INGRESS_IMAGE:variant.ingress,TALK_COMPARE_WORKER_IMAGE:variant.worker,TALK_COMPARE_LABEL:label,TALK_COMPARE_INGRESS_CPU:slot.ingressCpu??'0.5',TALK_LOAD_DIAGNOSTIC_RECOVERY:slot.recovery,TALK_COMPARE_VARIANT:slot.variant,TALK_COMPARE_SLOT:num,TALK_COMPARE_RUNTIME_ARTIFACTS:JSON.stringify({variant,fingerprints})},stdio:['ignore',stdout,stderr]});
    const timer=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000).unref();},370000);child.once('error',e=>{clearTimeout(timer);resolve({exit:null,error:e.name});});child.once('close',(exit,signal)=>{clearTimeout(timer);resolve({exit,signal});});
   });
  }finally{stop=true;await sampler;fs.closeSync(stdout);fs.closeSync(stderr);cleanup();}
  write(path.join(output,'docker-samples.json'),samples);
  for(const file of fs.readdirSync(art))if((/^(load-observations|admission|recovery-trace)-\d+\.json$/.test(file))||file==='runtime.log')fs.renameSync(path.join(art,file),path.join(output,file));
  const obsFile=fs.readdirSync(output).find(n=>/^load-observations-/.test(n));const obs=obsFile?JSON.parse(fs.readFileSync(path.join(output,obsFile))):null;
  let failures;try{const tests=JSON.parse(fs.readFileSync(path.join(output,'tests.json')));failures=tests.testResults.flatMap(s=>s.assertionResults.flatMap(t=>t.failureMessages.map(message=>({test:t.title,message}))));}catch(e){failures=[{test:'report',message:e.name}];}
  const item={...slot,slot:num,failures,...result,elapsedMs:Date.now()-start,executionCompleted:obs?.executionCompleted??false,admission:obs?.admission??null,finalOracleIdentities:obs?.finalOracleIdentities??null,applicationP95Ms:obs?.applicationMs?.p95??null,ingressP95Ms:obs?.ingressMs?.p95??null,latencyPass:obs?.latencyPass??false,artifact:name};summary.slots.push(item);write(path.join(art,'comparison-summary.json'),summary);console.log('MATCHED_SLOT '+JSON.stringify(item));console.log('DIAGNOSTIC_SLOT '+JSON.stringify({slot:num,variant:slot.variant,recovery:slot.recovery,ingressCpu:slot.ingressCpu??'0.5',accepted:item.admission?.accepted,statusCounts:item.admission?.statusCounts,ingressP95Ms:item.ingressP95Ms,applicationP95Ms:item.applicationP95Ms,executionCompleted:item.executionCompleted,latencyPass:item.latencyPass,failures:item.failures.length}));
 }
}finally{cleanup();await admin.end();summary.completedAt=new Date().toISOString();summary.allSlotsExecuted=summary.slots.length===summary.order.length;summary.allObservationsComplete=summary.allSlotsExecuted&&summary.slots.every(s=>s.executionCompleted&&s.exit===0);write(path.join(art,'comparison-summary.json'),summary);}
if(!summary.allObservationsComplete)process.exitCode=1;
