// Diagnostic build only: never applied to a release source or deployed image.
import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2];if(!root?.includes('/.validation/variants/'))throw Error('Owned diagnostic archive required');
const evidence={};
function patch(file,changes){const p=path.join(root,file);let s=fs.readFileSync(p,'utf8');for(const[from,to]of changes){if(!s.includes(from))throw Error('Missing patch anchor '+file);s=s.replace(from,to);}fs.writeFileSync(p,s);evidence[file]=changes.map(([from])=>from);}
patch('apps/api/src/modules/ingress/http.ts',[
 ["  const admitted = new WeakSet<object>();",`  const admitted = new WeakSet<object>();
  const telemetry = new WeakMap<object, { start: number; phases: Array<[string,number]>; peak: number }>();`],
 ["    admitted.add(request); inflight++;",`    admitted.add(request); inflight++;
    telemetry.set(request,{start:performance.now(),phases:[],peak:inflight});`],
 ["  app.addHook('onResponse', release);",`  app.addHook('onResponse', async (request,reply)=>{const t=telemetry.get(request);console.info('DIAG_HTTP',JSON.stringify({at:Date.now(),status:reply.statusCode,admitted:!!t,inflight,start:t?.start,totalMs:t?performance.now()-t.start:null,phases:t?.phases}));await release(request);});`],
 ["      let phase = 'authentication';",`      let phase = 'authentication';
      const mark = (name:string)=>{phase=name;const t=telemetry.get(request);if(t)t.phases.push([name,performance.now()-t.start]);};
      mark('authentication');`],
 ...['source','normalization','stage','publish'].map(p=>[`        phase = '${p}';`,`        mark('${p}');`])
]);
patch('apps/api/src/modules/ingress/runtime.ts',[
 ["  const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });",`  const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } }, log: [{emit:'event',level:'query'}] });
  const diag={queries:[] as Array<{category:string;duration:number}>,tx:[] as Array<{waitMs:number|null;workMs:number|null;totalMs:number;error:string|null}>};
  db.$on('query',(e)=>{diag.queries.push({category:/pg_advisory_xact_lock/.test(e.query)?'advisory':/FOR SHARE/.test(e.query)?'source-lock':e.query.split(' ')[0]!,duration:e.duration});});
  const originalTransaction=db.$transaction.bind(db);
  (db as any).$transaction=async (work:any,options:any)=>{if(typeof work!=='function')return originalTransaction(work,options);const start=performance.now();let acquired:number|null=null,error:string|null=null;try{return await originalTransaction(async(tx:any)=>{acquired=performance.now();return work(tx);},options);}catch(e){error=typeof(e as any)?.code==='string'?(e as any).code:'error';throw e;}finally{const end=performance.now();diag.tx.push({waitMs:acquired===null?null:acquired-start,workMs:acquired===null?null:end-acquired,totalMs:end-start,error});}};
  const {monitorEventLoopDelay}=await import('node:perf_hooks'),{readFileSync}=await import('node:fs');
  const lag=monitorEventLoopDelay({resolution:10});lag.enable();let priorCpu=process.cpuUsage();
  setInterval(()=>{const cpu=process.cpuUsage(priorCpu);priorCpu=process.cpuUsage();let cgroup:string|null=null;try{cgroup=readFileSync('/sys/fs/cgroup/cpu.stat','utf8');}catch{}
    console.info('DIAG_RUNTIME',JSON.stringify({at:Date.now(),role:consume?'worker':'ingress',cpu,lag:{p95:lag.percentile(95)/1e6,max:lag.max/1e6},cgroup,queries:diag.queries.splice(0),tx:diag.tx.splice(0)}));lag.reset();},1000).unref();`]
]);
fs.writeFileSync(path.join(root,'diagnostic-patches.json'),JSON.stringify(evidence,null,2));
