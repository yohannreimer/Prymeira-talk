// Diagnostic metadata only. No query text, parameters, credentials, or SQL mutations are recorded.
import { PrismaClient } from '@prisma/client';
import { appendFileSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const url=new URL(process.env.REHEARSAL_DATABASE_URL);
if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='55439'||url.pathname!=='/talk_rehearsal')throw Error('Owned loopback rehearsal database required');
const repo=realpathSync(path.resolve(process.cwd(),'../..')),artifacts=path.join(repo,'validation-artifacts');
if(realpathSync(process.env.GITHUB_WORKSPACE??'')!==repo||realpathSync(artifacts)!==artifacts||lstatSync(artifacts).uid!==process.getuid())throw Error('Owned current-repository artifacts required');
const output=path.join(artifacts,'postgres-waits.jsonl');
try{const stat=lstatSync(output);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw Error('Unowned observer output');}catch(error){if(error.code!=='ENOENT')throw error;}
const append=value=>appendFileSync(output,JSON.stringify(value)+'\n',{mode:0o600,flush:true});
url.searchParams.set('connection_limit','1');url.searchParams.set('connect_timeout','5');url.searchParams.set('pool_timeout','2');url.searchParams.set('application_name','talk-qualification-observer');
const db=new PrismaClient({datasources:{db:{url:url.toString()}}}),started=performance.now();
let stopping=false;
const hardStop=setTimeout(()=>{append({kind:'observer-time-limit',elapsedMs:performance.now()-started});process.exit(1);},180_000);
process.once('SIGTERM',()=>{stopping=true;append({kind:'observer-stopped',elapsedMs:performance.now()-started});void db.$disconnect().finally(()=>process.exit(0));setTimeout(()=>process.exit(0),1000).unref();});
try{
 const [owned]=await db.$queryRaw`SELECT current_database() AS database, current_setting('data_directory') AS directory`;
 if(owned.database!=='talk_rehearsal'||owned.directory!=='/var/lib/postgresql/data/talk_fixture')throw Error('PostgreSQL ownership mismatch');
 append({kind:'observer-start',diagnostic:true,harnessRunId:null,cadenceMs:100,maximumMs:180_000});
 while(!stopping&&performance.now()-started<180_000){
  const tick=performance.now();
  const activities=await db.$queryRaw`SELECT datname AS database, pid, state, wait_event_type, wait_event,
    EXTRACT(EPOCH FROM (clock_timestamp()-query_start))::double precision*1000 AS age_ms,
    CASE WHEN query ~* '^[[:space:]]*SELECT' THEN 'SELECT' WHEN query ~* '^[[:space:]]*INSERT' THEN 'INSERT'
      WHEN query ~* '^[[:space:]]*UPDATE' THEN 'UPDATE' WHEN query ~* '^[[:space:]]*DELETE' THEN 'DELETE'
      WHEN query ~* '^[[:space:]]*BEGIN' THEN 'BEGIN' WHEN query ~* '^[[:space:]]*COMMIT' THEN 'COMMIT'
      WHEN query ~* '^[[:space:]]*ROLLBACK' THEN 'ROLLBACK' ELSE 'OTHER' END AS query_class,
    cardinality(pg_blocking_pids(pid))::integer AS blocking_pid_count
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`;
  append({kind:'postgres-waits',at:new Date().toISOString(),elapsedMs:performance.now()-started,activities});
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,100-(performance.now()-tick))));
 }
}catch(error){append({kind:'observer-error',name:error.name,code:error.code??null});process.exitCode=1;}
finally{clearTimeout(hardStop);await db.$disconnect();}
