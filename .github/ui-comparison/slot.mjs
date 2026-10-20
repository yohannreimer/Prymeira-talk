import {awaitTerminal,ownedQueueCounts,ownedConsumerPrefetch} from './terminal.mjs';
import {limitsFor,assertCpuSet} from './limits.mjs';
import {makeEnvelopes} from './payloads.mjs';
import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';import http from 'node:http';import {randomUUID,createHash,createHmac} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url)),{PrismaClient}=require('@prisma/client');
const config=JSON.parse(fs.readFileSync(process.argv[2])),output=config.output,label=config.label;
const limits=limitsFor(config.resourceProfile??'vps'),cpuSet=config.cpuSet===null||config.cpuSet===undefined?null:assertCpuSet(config.cpuSet);
if(JSON.stringify(limits)!==JSON.stringify(config.limits))throw Error('Unexpected resource limits');
const affinityArgs=cpuSet?['--cpuset-cpus',cpuSet]:[];
if(!/^vps-compare-[0-9]+$/.test(label)||process.env.GITHUB_ACTIONS!=='true')throw Error('Owned CI only');
const database=process.env.REHEARSAL_DATABASE_URL,broker=process.env.INGRESS_TEST_AMQP_URL;
if(new URL(database).hostname!=='127.0.0.1'||new URL(database).port!=='55439'||new URL(database).pathname!=='/talk_rehearsal'||new URL(broker).hostname!=='127.0.0.1'||new URL(broker).port!=='56739'||new URL(broker).pathname!=='/talk_test')throw Error('Owned fixtures only');
const db=new PrismaClient({datasources:{db:{url:database}}}); const root=fs.mkdtempSync('/tmp/talk-prod-rehearsal-');const children=[],logs=[],boundary=[];
const workspaceId='ui-rehearsal',instance='ui-evolution',session='ui-waha',secret='rehearsal-evolution-secret-123',wahaSecret='rehearsal-waha-secret-1234567';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));function save(n,x){fs.writeFileSync(path.join(output,n),JSON.stringify(x,(_key,v)=>typeof v==='bigint'?v.toString():v,2));}
async function until(fn,timeout=60000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){try{last=await fn();if(last)return last;}catch(e){last=e.message;}await sleep(100);}throw Error('Timed out: '+JSON.stringify(last));}
const external=http.createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');boundary.push({at:Date.now(),method:req.method,path:url.pathname});res.setHeader('content-type','application/json');
 if(url.pathname==='/access-check'&&req.headers.authorization==='Bearer local.eyJzdWIiOiJkZW1vX2FnZW50X21hcmluYSJ9.bypass')return res.end(JSON.stringify({allowed:true,product_key:'talk',status:'active',reason:'isolated fixture',workspace_id:workspaceId,workspace_role:'owner',product_role:'owner'}));
 if(url.pathname==='/me/products')return res.end(JSON.stringify({customer:{name:'Operadora Sintética',email:'fixture@example.invalid'},products:[]}));
 if(url.pathname==='/api/server/version')return res.end(JSON.stringify({engine:'GOWS'}));
 if(req.method==='GET'&&url.pathname.startsWith('/api/ui-waha/')){res.setHeader('x-talk-recovery-pagination','1');res.setHeader('x-talk-recovery-raw-digest',createHash('sha256').update('[]').digest('hex'));res.setHeader('x-talk-recovery-raw-count','0');res.setHeader('x-talk-recovery-next-offset','0');res.setHeader('x-talk-recovery-exhausted','true');return res.end('[]');}
 res.statusCode=403;res.end(JSON.stringify({error:'unconfigured synthetic boundary'}));});
function start(role,entry,env){if(config.traceExperiment||config.observeWaits||config.transactionTimingExperiment){const u=new URL(env.DATABASE_URL);u.searchParams.set('application_name','talk-'+role);env={...env,DATABASE_URL:u.href};}const image=config.images[role];if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Immutable image required');const quotas=Object.fromEntries(Object.entries(limits).map(([role,q])=>[role,[String(q.cpu),q.MiB+'m']]));const args=['run','--rm','--pull','never','--name',label+'-'+role,'--label','talk.compare='+label,'--label','talk.compare.role='+role,'--network','host','--read-only','--tmpfs','/tmp:rw,size=128m','--cap-drop=ALL','--security-opt=no-new-privileges','--user',`${process.getuid()}:${process.getgid()}`,...affinityArgs,'--cpus',quotas[role][0],'--memory',quotas[role][1],'--memory-swap',quotas[role][1],'--mount',`type=bind,src=${root},dst=${root}`];for(const[k,v]of Object.entries(env))args.push('--env',k+'='+v);args.push('--entrypoint','node',image,entry);const child=cp.spawn('docker',args,{stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',s=>logs.push('['+role+'] '+s));child.stderr.on('data',s=>logs.push('['+role+'] '+s));return child;}
function resourceSnapshot(){
 const snapshot={at:Date.now(),roles:{}};
 for(const role of ['ingress','worker','api','web']){
  const name=label+'-'+role,x=JSON.parse(cp.execFileSync('docker',['inspect',name],{encoding:'utf8'}))[0];
  if(x.Config.Labels['talk.compare']!==label||x.Config.Labels['talk.compare.role']!==role||x.Image!==config.images[role])throw Error('Unexpected runtime identity');
  const q=limits[role];if(x.HostConfig.NanoCpus!==q.cpu*1e9||x.HostConfig.Memory!==q.MiB*1024*1024||x.HostConfig.MemorySwap!==x.HostConfig.Memory||(cpuSet&&x.HostConfig.CpusetCpus!==cpuSet))throw Error('Runtime quota/affinity mismatch');
  const result=cp.spawnSync('docker',['exec',name,'sh','-c','cat /sys/fs/cgroup/cpu.stat; cat /sys/fs/cgroup/memory.events; cat /sys/fs/cgroup/memory.peak'],{encoding:'utf8',timeout:5000});
  if(result.status!==0)throw Error('Missing cgroup v2 resource evidence');
  snapshot.roles[role]={at:Date.now(),id:x.Id,image:x.Image,cpuSet:x.HostConfig.CpusetCpus,nanoCpus:x.HostConfig.NanoCpus,memoryBytes:x.HostConfig.Memory,cgroup:result.stdout};
 }
 return snapshot;
}
let browser,pollPromise,polling=false,waitPromise,waiting=false;const waitSamples=[];
try{
 await new Promise(r=>external.listen(18481,'127.0.0.1',r));
 await db.userProfile.create({data:{workspaceId,clerkUserId:'demo_agent_marina',role:'owner',displayName:'Operadora Sintética',presenceState:'online'}});
 const channel=await db.channel.create({data:{workspaceId,provider:'evolution',providerKey:instance,displayName:'Canal sintético',status:'connected',historyImportStatus:'completed',verifiedMessagingPhoneNumber:'15550008888'}});
 await db.channelConnection.create({data:{workspaceId,channelId:channel.id,provider:'evolution',sessionName:instance,status:'connected',health:'healthy',eligible:true,verifiedPhoneNumber:'15550008888',historyRecoveryNextAttemptAt:new Date(Date.now()+3600000)}});
 await db.channelConnection.create({data:{workspaceId,channelId:channel.id,provider:'waha',sessionName:session,status:'connected',health:'healthy',eligible:true,verifiedPhoneNumber:'15550008888',lastHealthyAt:new Date(),recoveredThroughAt:new Date(Date.now()-600000)}});
 const conversations=[];
 for(let i=0;i<20;i++){
  const phone=String(15551000000+i),contact=await db.contact.create({data:{workspaceId,phone,name:`UI Contato ${String(i).padStart(2,'0')}`}});
  const conversation=await db.conversation.create({data:{workspaceId,channelId:channel.id,contactId:contact.id,lastMessageAt:new Date(Date.now()-60000),lastMessagePreview:'Histórico sintético anterior',unreadCount:0}});conversations.push(conversation);
  await db.message.createMany({data:Array.from({length:100},(_,j)=>({workspaceId,conversationId:conversation.id,direction:j%3===0?'outbound':'inbound',type:'text',body:`Histórico sintético ${i}/${j}: consulta de atendimento`,status:'delivered',createdAt:new Date(Date.now()-3600000+j*1000)}))});
 }
 const addresses=Array.from({length:2930},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,workspaceId,channelId:channel.id}));await db.canonicalAddress.createMany({data:addresses});await db.canonicalAddressAlias.createMany({data:addresses.map((a,i)=>({workspaceId,channelId:channel.id,addressId:a.id,address:`${15551000000+i}@s.whatsapp.net`}))});
 const env={NODE_ENV:'production',DATABASE_URL:database,INGRESS_TRANSPORT_STAGE:'production',INGRESS_AMQP_URL:broker,INGRESS_NAMESPACE:'talk.prod.ui-'+randomUUID().slice(0,8),INGRESS_PRIVATE_ROOT:path.join(root,'ingress'),INGRESS_WORKSPACE_ALLOWLIST:workspaceId,INGRESS_EVOLUTION_SECRET:secret,INGRESS_WAHA_SECRET:wahaSecret,INGRESS_PORT:'18411',INGRESS_RECOVERY_ENABLED:'true',TALK_MEDIA_STORE_PATH:path.join(root,'media'),EVOLUTION_API_BASE_URL:'http://127.0.0.1:18481',EVOLUTION_API_KEY:'synthetic-only',WAHA_API_BASE_URL:'http://127.0.0.1:18481',WAHA_API_KEY:'synthetic-only',REALTIME_BRIDGE_ENABLED:'true'};
 start('ingress','dist/ingress.js',env);start('worker','dist/ingress-worker.js',config.timingDiagnostic?{...env,TALK_ISOLATED_TRANSACTION_TIMING:'1',TALK_ISOLATED_TIMING_PATH:path.join(root,'worker.transactions.json')}:config.diagnostic?{...env,TALK_ISOLATED_DIAGNOSTIC:'1',TALK_ISOLATED_PROFILE_PATH:path.join(root,'worker.cpuprofile')}:env);
 start('api','dist/server.js',{...env,API_HOST:'127.0.0.1',API_PORT:'3002',CORS_ORIGINS:'http://127.0.0.1:18476',RATE_LIMIT_MAX:'300',PRYMEIRA_ACCOUNT_API_URL:'http://127.0.0.1:18481',PRYMEIRA_LOCAL_AUTH_BYPASS:'false',CLERK_SECRET_KEY:'synthetic-only-no-live-key',EVOLUTION_WEBHOOK_SECRET:secret,EVOLUTION_MODE:'simulated',PUBLIC_TALK_URL:'http://127.0.0.1:18476',LOCAL_TALK_URL:'http://127.0.0.1:3002',EFFECTS_ENABLED:'true',EFFECTS_WORKSPACE_ALLOWLIST:workspaceId,LEGACY_WEBHOOK_DELEGATED_WORKSPACES:workspaceId,CANONICAL_HISTORY_IMPORT_ENABLED:'true',FOLLOWUP_BRAIN_WORKSPACES:'off',CONTACT_NAME_RECOVERY_ENABLED:'false',CHANNEL_WATCHDOG_ENABLED:'false',CHANNEL_HEALTH_MONITOR_ENABLED:'false',INBOX_TRIAGE_ENABLED:'false',TALK_UPLOAD_DIR:path.join(root,'uploads')});
 const nginx=fs.readFileSync('apps/web/nginx.conf','utf8').replace('listen 80;','listen 18476;').replaceAll('http://api:3002','http://127.0.0.1:3002');fs.writeFileSync(path.join(root,'nginx.conf'),nginx);
 const web=cp.spawn('docker',['run','--rm','--pull','never','--name',label+'-web','--label','talk.compare='+label,'--label','talk.compare.role=web','--network','host',...affinityArgs,'--cpus',String(limits.web.cpu),'--memory',limits.web.MiB+'m','--memory-swap',limits.web.MiB+'m','--mount',`type=bind,src=${root}/nginx.conf,dst=/etc/nginx/conf.d/default.conf,readonly`,'--env','VITE_API_URL=http://127.0.0.1:18476/api','--env','VITE_LOCAL_AUTH_BYPASS=true','--env','VITE_PRYMEIRA_HUB_URL=http://127.0.0.1:18481',config.images.web],{stdio:['ignore','pipe','pipe']});children.push(web);web.stdout.on('data',s=>logs.push('[web] '+s));web.stderr.on('data',s=>logs.push('[web] '+s));
 await until(async()=>{if(children.some(c=>c.exitCode!==null))throw Error('Runtime exited');return (await fetch('http://127.0.0.1:18411/health').catch(()=>null))?.ok&&(await fetch('http://127.0.0.1:3002/health').catch(()=>null))?.ok&&(await fetch('http://127.0.0.1:18476/health').catch(()=>null))?.ok;});
 const warm=makeEnvelopes({rawId:'UI-WARMUP-1',phone:'15551000000',text:'Pré-validação sintética dos dois provedores',timestamp:Math.floor(Date.now()/1000),instance,session,index:0}),warmReceipts=[];
 for(const provider of ['evolution','waha']){const raw=JSON.stringify(warm[provider]),headers={'content-type':'application/json',...(provider==='evolution'?{'x-prymeira-talk-secret':secret}:{'x-webhook-hmac-algorithm':'sha512','x-webhook-hmac':createHmac('sha512',wahaSecret).update(raw).digest('hex')})};const r=await fetch(`http://127.0.0.1:18411/webhooks/${provider}/${workspaceId}`,{method:'POST',headers,body:raw,signal:AbortSignal.timeout(10000)});const data=await r.json();if(r.status!==202||!data.receiptId)throw Error('Provider fixture not admitted');warmReceipts.push(data.receiptId);}
 const warmProof=await until(async()=>{const applications=await db.ingressApplication.findMany({where:{receiptId:{in:warmReceipts}}}),identities=await db.canonicalMessageIdentity.findMany({where:{workspaceId,rawId:'UI-WARMUP-1'}});if(applications.length!==2||applications.some(a=>a.state!=='applied')||identities.length!==1||identities[0].contentState!=='ready')return false;const message=await db.message.findUnique({where:{id:identities[0].messageId}});if(message?.body!==warm.evolution.data.message.conversation||message?.conversationId!==conversations[0].id)throw Error('Provider fixture changed content or association');return {applications,identities,message};},30000);save('provider-preflight.json',warmProof);
 if(config.terminalDrain){
  const brokerId=process.env.TALK_COMPARE_RABBIT_ID;if(!/^[a-f0-9]{64}$/.test(brokerId??''))throw Error('Exact owned broker container required');
  const stdout=cp.execFileSync('docker',['exec',brokerId,'rabbitmqctl','list_consumers','-q','-p','talk_test','queue_name','prefetch_count'],{encoding:'utf8',timeout:15000});
  save('effective-prefetch.json',{at:Date.now(),expected:config.prefetch,consumers:ownedConsumerPrefetch(stdout,env.INGRESS_NAMESPACE,config.prefetch)});
 }
 const browserConfig=path.join(output,'browser-config.json');save('browser-config.json',{url:'http://127.0.0.1:18476/?conversation='+conversations[0].id,output,warmupMessageId:warmProof.message.id});
 const browserLog=fs.openSync(path.join(output,'browser-process.log'),'w');browser=cp.spawn('python3',['.github/ui-comparison/browser.py',browserConfig],{stdio:['ignore',browserLog,browserLog]});
 await until(()=>{if(browser.exitCode!==null)throw Error('Browser failed');return fs.existsSync(path.join(output,'ready.json'));},90000);
 const rate=config.profile==='busy'?4:1,duration=config.pilot?8:60,count=duration*rate;const offers=[],observations=[];save('resource-before-load.json',resourceSnapshot());const began=Date.now();polling=true;
 if(config.traceExperiment||config.observeWaits){waiting=true;waitPromise=(async()=>{while(waiting){const rows=await db.$queryRaw`SELECT application_name,state,wait_event_type,wait_event,EXTRACT(epoch FROM(clock_timestamp()-xact_start))*1000 AS transaction_ms,pg_blocking_pids(pid) AS blockers, CASE WHEN query LIKE '%pg_advisory_xact_lock%' THEN 'advisory' WHEN query LIKE '%canonical_addresses%' THEN 'addresses' WHEN query LIKE '%ingress_%' THEN 'ingress' ELSE 'other' END AS category FROM pg_stat_activity WHERE datname='talk_rehearsal' AND pid<>pg_backend_pid()`;waitSamples.push({at:Date.now(),rows});await sleep(100);}})();}
 const seenDb=new Set();pollPromise=(async()=>{while(polling){const at=Date.now(),rows=await db.message.findMany({where:{workspaceId,body:{startsWith:'TALKUI_'},...(seenDb.size?{id:{notIn:[...seenDb]}}:{})},select:{id:true,body:true,conversationId:true,createdAt:true,ingestedAt:true}});for(const row of rows)seenDb.add(row.id);if(rows.length)observations.push({at:Date.now(),queryStartedAt:at,rows});await sleep(100);}})();
 const tasks=[];
 for(let i=0;i<count;i++){
  const due=began+i*1000/rate;while(Date.now()<due)await sleep(due-Date.now());
  const target=i%4===0,index=target?0:1+(i%19),phone=String(15551000000+index),marker='TALKUI_'+String(i).padStart(5,'0'),text=marker+' '+(i%10===0?'Consulta sintética detalhada sobre disponibilidade, prazo e condições. '.repeat(10):'Olá! Gostaria de confirmar a disponibilidade 😊');const rawId='UI-SYNTH-'+String(i).padStart(5,'0');
  const envelopes=makeEnvelopes({rawId,phone,text,timestamp:Math.floor(Date.now()/1000),instance,session,index});
  for(const provider of ['evolution','waha']){
   const body=envelopes[provider];
   const raw=JSON.stringify(body),headers={'content-type':'application/json',...(provider==='evolution'?{'x-prymeira-talk-secret':secret}:{'x-webhook-hmac-algorithm':'sha512','x-webhook-hmac':createHmac('sha512',wahaSecret).update(raw).digest('hex')})};
   tasks.push((async()=>{const scheduledAt=due+(provider==='waha'?40+(i*37)%120:0);while(Date.now()<scheduledAt)await sleep(scheduledAt-Date.now());const at=Date.now();let status=0,data={},error=null;try{const r=await fetch(`http://127.0.0.1:18411/webhooks/${provider}/${workspaceId}`,{method:'POST',headers,body:raw,signal:AbortSignal.timeout(20000)});status=r.status;data=await r.json();}catch(e){error=e.name;}offers.push({i,marker,target,provider,rawId,digest:createHash('sha256').update(raw).digest('hex'),at,endedAt:Date.now(),status,data,error,scheduledAt});})());
  }
 }
 await Promise.all(tasks);save('offers.json',{began,count,rate,duration,offeredUntil:Date.now(),offers});
 const drain=Date.now()+150000;let complete=false;
 while(Date.now()<drain){const live=JSON.parse(fs.readFileSync(path.join(output,'browser-live.json'),'utf8'));const seen=new Set(live.times.filter(t=>t.phase==='visibleAfterTwoFrames').map(t=>t.marker));const admitted=new Set(offers.filter(o=>o.target&&o.status===202).map(o=>o.marker));const totalAdmitted=new Set(offers.filter(o=>o.status===202).map(o=>o.marker));const applied=await db.message.count({where:{workspaceId,body:{startsWith:'TALKUI_'}}});if(admitted.size>0&&[...admitted].every(x=>seen.has(x))&&applied>=totalAdmitted.size){complete=true;break;}await sleep(250);}
 save('resource-after-load.json',resourceSnapshot());polling=false;waiting=false;await pollPromise;if(waitPromise)await waitPromise;save('database-waits.json',waitSamples);save('database-observations.json',observations);
 const readOracles=async()=>({complete,identities:await db.canonicalMessageIdentity.findMany({where:{workspaceId,rawId:{startsWith:'UI-SYNTH-'}}}),messages:await db.message.findMany({where:{workspaceId,body:{startsWith:'TALKUI_'}}}),effects:await db.ingressEffect.findMany({where:{workspaceId}}),applications:await db.ingressApplication.findMany({where:{workspaceId}}),receipts:await db.ingressReceipt.findMany({where:{workspaceId},select:{id:true,authenticatedDigest:true,createdAt:true}}),publications:await db.ingressPublishAttempt.findMany({where:{workspaceId},select:{receiptId:true,destination:true,outcome:true,createdAt:true,settledAt:true}}),deliveries:await db.ingressDelivery.findMany({where:{workspaceId},select:{receiptId:true,state:true,failures:true,recoveries:true,confirmedAt:true,consumedAt:true}})});
 const cutoff=await readOracles();save('latency-cutoff-oracles.json',cutoff);
 fs.writeFileSync(path.join(output,'stop-browser'),'');await until(()=>browser.exitCode!==null,15000);if(browser.exitCode!==0)throw Error('Browser observation failed');
 let terminal={required:!!config.terminalDrain,complete:!config.terminalDrain};
 if(config.terminalDrain){
  const receiptIds=[...new Set(offers.map(o=>o.data.receiptId).filter(Boolean))],messageIds=cutoff.identities.map(i=>i.messageId),expected={applications:count*2,effects:count*10};
  const brokerId=process.env.TALK_COMPARE_RABBIT_ID;if(!/^[a-f0-9]{64}$/.test(brokerId??''))throw Error('Exact owned broker container required');
  terminal=await awaitTerminal({expected,pause:sleep,readCounts:async()=>{
   const apps=await db.ingressApplication.groupBy({by:['state'],where:{receiptId:{in:receiptIds}},_count:{_all:true}}),effects=await db.ingressEffect.groupBy({by:['state'],where:{messageId:{in:messageIds}},_count:{_all:true}});
   const sum=rows=>rows.reduce((n,r)=>n+r._count._all,0),n=(rows,state)=>rows.find(r=>r.state===state)?._count._all??0;
   return {applications:sum(apps),applied:n(apps,'applied'),effects:sum(effects),done:n(effects,'done'),failed:n(effects,'failed')};
  },readQueues:async()=>{
   const stdout=cp.execFileSync('docker',['exec',brokerId,'rabbitmqctl','list_queues','-q','-p','talk_test','name','messages_ready','messages_unacknowledged'],{encoding:'utf8',timeout:15000});
   return ownedQueueCounts(stdout,env.INGRESS_NAMESPACE);
  }});
  terminal.complete=terminal.complete&&receiptIds.length===expected.applications&&messageIds.length===count;
  save('resource-after-terminal.json',resourceSnapshot());
 }
 save('terminal-drain.json',terminal);save('final-oracles.json',await readOracles());

 if(config.timingDiagnostic){cp.execFileSync('docker',['kill','--signal=SIGUSR2',label+'-worker']);const evidence=path.join(root,'worker.transactions.json');await until(()=>fs.existsSync(evidence),15000);fs.copyFileSync(evidence,path.join(output,'worker.transactions.json'));const timing=JSON.parse(fs.readFileSync(evidence,'utf8'));if(!timing.complete)throw Error('Incomplete transaction timing evidence');}
 if(config.diagnostic){cp.execFileSync('docker',['kill','--signal=SIGUSR2',label+'-worker']);const profile=path.join(root,'worker.cpuprofile');await until(()=>fs.existsSync(profile),15000);fs.copyFileSync(profile,path.join(output,'worker.cpuprofile'));}
 save('slot-result.json',{complete:complete&&terminal.complete,latencyComplete:complete,terminalComplete:terminal.complete,endedAt:Date.now(),count,profile:config.profile});
}finally{
 polling=false;waiting=false;if(waitPromise)await waitPromise.catch(()=>undefined);if(pollPromise)await pollPromise.catch(()=>undefined);
 fs.writeFileSync(path.join(output,'stop-browser'),'');
 if(browser&&browser.exitCode===null)await until(()=>browser.exitCode!==null,10000).catch(()=>browser.kill('SIGTERM'));
 const owned=cp.execFileSync('docker',['ps','-aq','--filter','label=talk.compare='+label],{encoding:'utf8'}).trim().split('\n').filter(Boolean);if(owned.length)cp.execFileSync('docker',['rm','-f',...owned],{stdio:'ignore'});
 for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');
 await db.$disconnect();external.closeAllConnections();await new Promise(r=>external.close(r));
 save('boundary.json',boundary);fs.writeFileSync(path.join(output,'runtime.log'),logs.join(''));
}
