// Independent diagnostic tail. It cannot produce or repair full-gate approval.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, realpath, lstat, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const MARKER='src/modules/ingress/production-stage.postgres.test.ts';
export const EXPECTED=[
 'src/modules/ingress/publication-lease.postgres.test.ts',
 'src/modules/ingress/recertification-queue.postgres.test.ts',
 'src/modules/ingress/setup.rabbit.test.ts',
 'src/modules/ingress/transport.postgres.test.ts',
 'src/modules/leads/leads.database.test.ts',
 'src/modules/leads/own-base.postgres.test.ts',
 'src/modules/messaging/canonical-foundation.postgres.test.ts',
 'src/modules/messaging/canonical-reducers.postgres.test.ts',
 'src/modules/messaging/canonical-schema.postgres.test.ts',
 'src/modules/messaging/canonical-store.postgres.test.ts',
 'src/modules/messaging/conversation-preview.postgres.test.ts',
 'src/modules/messaging/outbound-correlation.postgres.test.ts',
 'src/modules/messaging/outbound-fences.postgres.test.ts',
 'src/modules/messaging/outbound-intents.postgres.test.ts',
 'src/modules/messaging/outbound-schema.postgres.test.ts',
 'src/modules/prospecting/prospecting-flow.integration.test.ts',
 'src/modules/purchasing/buyer-agent.database.test.ts',
 'src/modules/purchasing/purchasing.database.test.ts',
 'src/modules/realtime/realtime-bridge.postgres.test.ts',
 'src/modules/supervision/supervision-insights.postgres.test.ts',
 'src/modules/supervision/supervision.postgres.test.ts',
 'src/modules/supervision/supervisor-reply.postgres.test.ts',
];
const TITLES=[
 'refuses a wrong secret, and reports an unknown source instead of guessing',
 'accepts a webhook the legacy 1 MiB limit rejected (413), applies the message and stores its media',
 'keeps every effect of an applied message as a durable obligation for the API process',
 'qualifies 80 canonical / 160 dual-provider envelopes in 10 seconds with concurrent bounded recovery',
];
export function selectTail(files){
 assert.equal(files.filter(f=>f===MARKER).length,1,'Exactly one production-stage marker required');
 const tail=files.slice(files.indexOf(MARKER)+1);assert.deepEqual(tail,EXPECTED,'Discovered remaining suites differ from the reviewed exact22');return tail;
}
export function eligible({report,started,observations,sha,source}){
 assert.equal(started.sha,sha);assert.equal(started.sourceState,'clean-checkout');assert.equal(started.phase,'all');assert.equal(started.state,'started');assert.match(started.runId,/^[a-f0-9-]{36}$/);
 assert.equal(report.numTotalTests,4);assert.equal(report.numPassedTests,3);assert.equal(report.numFailedTests,1);assert.equal(report.numPendingTests,0);assert.equal(report.numTodoTests,0);assert.equal(report.success,false);
 assert.equal(report.testResults.length,1);const suite=report.testResults[0];assert.equal(suite.status,'failed');assert.equal(suite.message,'');assert(suite.name.endsWith('/apps/api/'+MARKER));
 assert.deepEqual(suite.assertionResults.map(t=>t.title),TITLES);assert.deepEqual(suite.assertionResults.map(t=>t.status),['passed','passed','passed','failed']);
 assert(suite.assertionResults.slice(0,3).every(t=>t.failureMessages.length===0));
 const failure=suite.assertionResults[3];assert.equal(failure.failureMessages.length,1);
 const message=failure.failureMessages[0],match=message.match(/^AssertionError: expected ([0-9]+(?:\.[0-9]+)?) to be less than 2000\n/);assert(match,'Only application p95 assertion failure permits this tail');
 const lines=source.split('\n'),line=lines.findIndex(text=>text.includes('expect(applicationP95Ms).toBeLessThan(2000)'))+1;assert(line>0);assert(message.includes('/production-stage.postgres.test.ts:'+line+':'));
 assert.equal(observations.schemaVersion,1);assert.equal(observations.kind,'load-observations');assert.equal(observations.observationsOnly,true);assert.equal(observations.diagnosticControl,false);assert.equal(observations.sourceSha,sha);assert.equal(observations.sourceState,'clean-checkout');assert.equal(observations.harnessRunId,started.runId);assert.equal(observations.thresholds.applicationP95Ms,2000);
 assert.equal(Number(match[1]),observations.applicationMs.p95);assert(observations.applicationMs.p95>=2000);
 const beginning=Date.parse(started.startedAt),testStart=report.startTime,observed=Date.parse(observations.observedAt);assert(Number.isFinite(beginning)&&testStart>=beginning&&observed>=testStart&&observed<=Date.now());
 return {fullValidationRunId:started.runId,applicationP95Ms:observations.applicationMs.p95};
}
function git(root,args){const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(result.status,0);return result.stdout.trim();}
async function execute(root,file,output,env){
 const report=path.join(output,file.replaceAll('/','_')+'.json'),stdout=await open(report+'.stdout.log','wx',0o600),stderr=await open(report+'.stderr.log','wx',0o600);
 let outcome;
 try{outcome=await new Promise(resolve=>{
  const child=spawn('pnpm',['--filter','@prymeira-talk/api','exec','vitest','run',file,'--maxWorkers=1','--fileParallelism=false','--reporter=default','--reporter=json','--outputFile.json='+report],{cwd:root,env,stdio:['ignore',stdout.fd,stderr.fd]});
  child.once('error',error=>resolve({exitCode:null,signal:null,error:error.name}));child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));
 });}finally{await stdout.close();await stderr.close();}
 const result={file,...outcome,passedTests:null,failedTests:null,skippedTests:null,passed:false};
 try{
  const json=JSON.parse(await readFile(report,'utf8'));result.passedTests=json.numPassedTests;result.failedTests=json.numFailedTests;result.skippedTests=json.numPendingTests;
  const assertions=json.testResults?.flatMap(s=>s.assertionResults??[])??[];
  result.passed=outcome.exitCode===0&&json.success===true&&json.numTotalTests>0&&json.numFailedTests===0&&json.numPendingTests===0&&json.numTodoTests===0&&json.numPassedTests===json.numTotalTests&&assertions.length===json.numTotalTests&&assertions.every(t=>t.status==='passed'&&t.failureMessages.length===0)&&json.testResults.every(s=>s.status==='passed'&&!s.message);
 }catch(error){result.reportError=error.name;}
 return result;
}
async function main(){
 const root=await realpath(fileURLToPath(new URL('../../../',import.meta.url))),artifacts=path.join(root,'validation-artifacts');
 assert.equal(await realpath(process.env.GITHUB_WORKSPACE),root);assert.equal(await realpath(artifacts),artifacts);assert.equal((await lstat(artifacts)).uid,process.getuid());
 const output=path.join(artifacts,'diagnostic-remaining');await mkdir(output,{mode:0o700});assert.equal(await realpath(output),output);
 const summary={kind:'remaining-integration-diagnostic',diagnosticOnly:true,qualification:false,runId:randomUUID(),sha:null,sourceState:'unverified',startedAt:new Date().toISOString(),serial:true,state:'not-executed',files:[],boundary:'Independent tail evidence only. Original full validation remains failed; no validation-all or integration-summary is emitted.'};
 let admin;
 try{
  summary.sha=git(root,['rev-parse','HEAD']);assert.match(summary.sha,/^[a-f0-9]{40}$/);assert.equal(summary.sha,process.env.CANDIDATE_SHA);assert.equal(git(root,['status','--porcelain']),'','Clean current candidate required');summary.sourceState='clean-checkout';
  const started=JSON.parse(await readFile(path.join(artifacts,'validation-started.json'),'utf8')),report=JSON.parse(await readFile(path.join(artifacts,MARKER.replaceAll('/','_')+'.json'),'utf8'));
  const observations=[];
  for(const name of await readdir(artifacts))if(/^load-observations-\d+\.json$/.test(name)){const value=JSON.parse(await readFile(path.join(artifacts,name),'utf8'));if(value.harnessRunId===started.runId&&value.sourceSha===summary.sha)observations.push(value);}
  assert.equal(observations.length,1,'Exactly one matching failed full-gate load observation required');
  summary.trigger=eligible({report,started,observations:observations[0],sha:summary.sha,source:await readFile(path.join(root,'apps/api',MARKER),'utf8')});
  const {validateInfrastructure,findIntegrationTests,databaseVariables}=await import(new URL('../scripts/validation/validation.mjs',import.meta.url));
  assert.equal(process.env.TALK_TEST_POSTGRES_DATA_DIRECTORY,'/var/lib/postgresql/data/talk_fixture');
  const infra=validateInfrastructure({adminUrl:process.env.TALK_TEST_DATABASE_ADMIN_URL,brokerUrl:process.env.INGRESS_TEST_AMQP_URL,postgresPort:'55439',amqpPort:'56739'});
  const files=selectTail((await findIntegrationTests(path.join(root,'apps/api/src'))).map(file=>path.relative(path.join(root,'apps/api'),file)));
  const {Client}=await import('pg');admin=new Client({connectionString:infra.adminUrl});await admin.connect();
  const owned=(await admin.query("SELECT current_database() AS database, current_setting('data_directory') AS directory")).rows[0];assert.equal(owned.database,'postgres');assert.equal(owned.directory,process.env.TALK_TEST_POSTGRES_DATA_DIRECTORY);await admin.end();admin=null;
  const env={...process.env,TALK_TEST_POSTGRES_PORT:'55439',TALK_TEST_AMQP_PORT:'56739',INGRESS_TEST_AMQP_URL:infra.brokerUrl};delete env.TALK_VALIDATION_RUN_ID;delete env.TALK_VALIDATION_KEEP_GOING;
  for(const[key,database]of Object.entries(databaseVariables))env[key]=infra.urls[database];
  summary.state='executed';
  for(const file of files){
   let result;try{result=await execute(root,file,output,env);}catch(error){result={file,exitCode:null,passed:false,error:error.name};}
   summary.files.push(result);console.log('DIAGNOSTIC_REMAINING '+JSON.stringify(result));
  }
  summary.sourceUnchanged=git(root,['rev-parse','HEAD'])===summary.sha&&git(root,['status','--porcelain'])==='';
  summary.passed=summary.sourceUnchanged&&summary.files.length===22&&summary.files.every(file=>file.passed);
  if(!summary.passed)process.exitCode=1;
 }catch(error){summary.reason={name:error.name,message:error.message};if(summary.state==='executed')process.exitCode=1;}
 finally{if(admin)await admin.end().catch(()=>{});summary.completedAt=new Date().toISOString();await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});}
}
if(path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url))await main();
