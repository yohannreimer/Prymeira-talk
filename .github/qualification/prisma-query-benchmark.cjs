// Controlled synthetic diagnostic. This does not establish macro qualification.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto'),{spawnSync}=require('node:child_process'),{performance}=require('node:perf_hooks');
const COUNT=2930,ORDER=['host-1','actual-immutable-alpine-1','actual-immutable-alpine-2','host-2'];
function fixtureURL(value){
 const url=new URL(value);
 assert(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname==='127.0.0.1'&&url.port==='55439'&&url.pathname==='/talk_rehearsal','Owned loopback rehearsal database required');
 url.searchParams.set('connection_limit','1');url.searchParams.set('connect_timeout','5');url.searchParams.set('pool_timeout','5');
 return url.toString();
}
function validateFixture(f){
 assert.match(f.fixtureId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.equal(f.workspaceId,'synthetic-prisma-bench-'+f.fixtureId);assert.equal(f.channelId,f.fixtureId);
 assert.equal(f.count,COUNT);assert.match(f.fingerprint,/^[a-f0-9]{64}$/);assert.match(f.sha,/^[a-f0-9]{40}$/);
 return f;
}
function fingerprint(rows){return createHash('sha256').update(JSON.stringify([...rows].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(r=>[r.id,r.redirectId]))).digest('hex');}
function percentile(values,fraction){return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1];}
function seedRows(f){return Array.from({length:COUNT},()=>({id:randomUUID(),workspaceId:f.workspaceId,channelId:f.channelId,redirectId:null}));}
function client(){
 assert.equal(process.env.NODE_ENV,'production');assert.equal(process.version,'v22.23.3');
 const {PrismaClient,Prisma}=require('@prisma/client');assert.equal(Prisma.prismaVersion.client,'6.19.3');
 return {db:new PrismaClient({datasources:{db:{url:fixtureURL(process.env.REHEARSAL_DATABASE_URL)}}}),Prisma};
}
async function owned(db){const [row]=await db.$queryRaw`SELECT current_database() AS database, current_setting('data_directory') AS directory`;assert.equal(row.database,'talk_rehearsal');assert.equal(row.directory,'/var/lib/postgresql/data/talk_fixture');}
async function read(f,label){
 validateFixture(f);assert(ORDER.includes(label));const {db,Prisma}=client();
 const limit=setTimeout(()=>{process.stderr.write('Synthetic Prisma reader deadline exceeded\n');process.exit(1);},80_000);
 try{
  await db.$connect();await owned(db);
  const timings=[],observations=[];let cpu;
  await db.$transaction(async tx=>{
   const query=()=>tx.canonicalAddress.findMany({where:{workspaceId:f.workspaceId,channelId:f.channelId},select:{id:true,redirectId:true}});
   for(let n=0;n<2;n++){const rows=await query();assert.equal(rows.length,COUNT);assert.equal(fingerprint(rows),f.fingerprint);}
   const startCPU=process.cpuUsage();
   for(let n=0;n<20;n++){const start=performance.now(),rows=await query();timings.push(performance.now()-start);observations.push(rows);}
   cpu=process.cpuUsage(startCPU);
  },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,maxWait:5000,timeout:60_000});
  for(const rows of observations){assert.equal(rows.length,COUNT);assert.equal(fingerprint(rows),f.fingerprint);}
  const header=process.report.getReport().header;
  return {kind:'synthetic-prisma-query-diagnostic',diagnosticOnly:true,runId:null,label,sha:f.sha,node:process.version,nodeEnv:process.env.NODE_ENV,prismaClient:Prisma.prismaVersion.client,prismaEngine:Prisma.prismaVersion.engine,platform:process.platform,arch:process.arch,glibcVersionRuntime:header.glibcVersionRuntime??null,engineBinaryTargets:db._engineConfig?.generator?.binaryTargets?.map(t=>t.value)??null,connectionLimit:1,isolationLevel:'ReadCommitted',warmups:2,timedReads:20,count:COUNT,fingerprint:f.fingerprint,queryWallMs:{p50:percentile(timings,.5),p95:percentile(timings,.95),samples:timings},processCPU:{userMicros:cpu.user,systemMicros:cpu.system,totalMicros:cpu.user+cpu.system,scope:'All process threads during the 20 timed reads; excludes seed, connect, transaction begin/commit, warmups, hashing and container startup'}};
 }finally{await db.$disconnect();clearTimeout(limit);}
}
function artifactDirectory(){
 const repo=fs.realpathSync(path.resolve(process.cwd(),'../..')),artifacts=path.join(repo,'validation-artifacts');
 assert.equal(fs.realpathSync(process.env.GITHUB_WORKSPACE),repo);assert.equal(fs.realpathSync(artifacts),artifacts);assert.equal(fs.lstatSync(artifacts).uid,process.getuid());
 const directory=path.join(artifacts,'prisma-query-benchmark');try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 const stat=fs.lstatSync(directory);assert(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid());assert.equal(fs.realpathSync(directory),directory);
 return directory;
}
function write(directory,name,value){fs.writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
function errorInfo(error){return {name:error.name,code:error.code??null};}
async function compare(){
 fixtureURL(process.env.REHEARSAL_DATABASE_URL);
 const directory=artifactDirectory(),image=process.env.TALK_QUAL_API_IMAGE,label=process.env.TALK_QUAL_CONTAINER_LABEL;
 assert.match(image,/^sha256:[a-f0-9]{64}$/);assert.match(label,/^[A-Za-z0-9-]+$/);assert.match(process.env.CANDIDATE_SHA,/^[a-f0-9]{40}$/);
 const fixtureId=randomUUID(),f={fixtureId,workspaceId:'synthetic-prisma-bench-'+fixtureId,channelId:fixtureId,count:COUNT,sha:process.env.CANDIDATE_SHA};
 const rows=seedRows(f);f.fingerprint=fingerprint(rows);validateFixture(f);
 const fixtureFile=path.join(directory,'fixture.json');write(directory,'fixture.json',{...f,diagnosticOnly:true,runId:null,order:ORDER});
 const {db,Prisma}=client();let ownership=false,failed=false,cleanup;
 try{
  await db.$connect();await owned(db);ownership=true;
  await db.$transaction(async tx=>{
   await tx.workspaceMirror.create({data:{workspaceId:f.workspaceId,name:'Synthetic Prisma benchmark'}});
   await tx.channel.create({data:{id:f.channelId,workspaceId:f.workspaceId,provider:'evolution',providerKey:'synthetic-prisma-bench-'+fixtureId,status:'disconnected'}});
   assert.equal((await tx.canonicalAddress.createMany({data:rows})).count,COUNT);
  },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,maxWait:5000,timeout:30_000});
  const reports=[];
  for(const variant of ORDER){
   const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',REHEARSAL_DATABASE_URL:fixtureURL(process.env.REHEARSAL_DATABASE_URL)};
   let command=process.execPath,args=[__filename,'read',fixtureFile,variant];
   if(variant.startsWith('actual-')){
    command='docker';args=['run','--rm','--pull','never','--name','talk-prisma-bench-'+randomUUID(),'--label','talk.qual='+label,'--network','host','--read-only','--tmpfs','/tmp:rw,size=128m','--cap-drop=ALL','--security-opt=no-new-privileges','--user',`${process.getuid()}:${process.getgid()}`,'--env','NODE_ENV','--env','REHEARSAL_DATABASE_URL','--mount',`type=bind,src=${fs.realpathSync(__filename)},dst=/app/talk-prisma-bench.cjs,readonly`,'--mount',`type=bind,src=${fixtureFile},dst=/talk-bench-fixture.json,readonly`,'--entrypoint','node',image,'/app/talk-prisma-bench.cjs','read','/talk-bench-fixture.json',variant];
    env.DOCKER_HOST='unix:///var/run/docker.sock';
   }
   const result=spawnSync(command,args,{env,encoding:'utf8',timeout:90_000,maxBuffer:1024*1024});
   fs.writeFileSync(path.join(directory,variant+'.stderr.log'),result.stderr??'',{flag:'wx',mode:0o600});
   try{
    assert.equal(result.status,0);const report=JSON.parse(result.stdout);assert.equal(report.count,COUNT);assert.equal(report.fingerprint,f.fingerprint);assert.equal(report.node,'v22.23.3');assert.equal(report.prismaClient,'6.19.3');assert.equal(report.nodeEnv,'production');assert.equal(report.label,variant);assert.equal(report.diagnosticOnly,true);assert.equal(report.runId,null);reports.push(report);write(directory,variant+'.json',report);
   }catch(error){failed=true;write(directory,variant+'.json',{diagnosticOnly:true,runId:null,label:variant,passed:false,status:result.status,signal:result.signal,error:errorInfo(result.error??error)});}
  }
  assert.equal(reports.length,4);assert.equal(new Set(reports.map(r=>r.prismaEngine)).size,1);
  write(directory,'comparison.json',{kind:'synthetic-prisma-query-comparison',diagnosticOnly:true,runId:null,sha:f.sha,immutableAPIImage:image,order:ORDER,passed:!failed,count:COUNT,fingerprint:f.fingerprint,results:reports.map(r=>({label:r.label,queryWallMs:r.queryWallMs,processCPU:r.processCPU})),boundary:'Fixed-order query/engine diagnostic; no macro qualification or adaptive repetition.'});
 }catch(error){failed=true;write(directory,'comparison-error.json',{diagnosticOnly:true,runId:null,error:errorInfo(error)});}
 finally{
  if(ownership){
   try{
    await owned(db);cleanup=await db.$transaction(async tx=>{
     const scope={workspaceId:f.workspaceId,channelId:f.channelId};await tx.canonicalAddress.updateMany({where:scope,data:{redirectId:null}});
     const addresses=await tx.canonicalAddress.deleteMany({where:scope}),channel=await tx.channel.deleteMany({where:{id:f.channelId,workspaceId:f.workspaceId}}),workspace=await tx.workspaceMirror.deleteMany({where:{workspaceId:f.workspaceId}});
     return {disposition:'Deleted only this UUID synthetic fixture',addresses:addresses.count,channels:channel.count,workspaces:workspace.count};
    },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,maxWait:5000,timeout:30_000});
   }catch(error){failed=true;cleanup={disposition:'Synthetic UUID fixture retained for owned runner disposal; no reset or truncate attempted',error:errorInfo(error)};}
  }else cleanup={disposition:'Ownership not established; no fixture cleanup attempted'};
  write(directory,'cleanup.json',{diagnosticOnly:true,runId:null,fixtureId,...cleanup});await db.$disconnect();
 }
 assert.equal(failed,false,'Synthetic Prisma diagnostic failed; inspect per-variant evidence');
}
module.exports={fixtureURL,validateFixture,fingerprint,percentile,seedRows,ORDER,COUNT};
if(require.main===module)(async()=>{if(process.argv[2]==='read'){const result=await read(JSON.parse(fs.readFileSync(process.argv[3],'utf8')),process.argv[4]);process.stdout.write(JSON.stringify(result)+'\n');}else{assert.equal(process.argv[2],'compare');await compare();}})().catch(error=>{process.stderr.write(JSON.stringify({kind:'synthetic-prisma-diagnostic-error',diagnosticOnly:true,runId:null,...errorInfo(error)})+'\n');process.exitCode=1;});
