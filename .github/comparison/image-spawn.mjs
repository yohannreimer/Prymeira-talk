import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export function buildImageSpawn(command,args,options,env=process.env){
 if(command!==process.execPath||!['dist/ingress.js','dist/ingress-worker.js'].includes(args[0]))return null;
 const role=args[0]==='dist/ingress.js'?'ingress':'worker',image=env[role==='ingress'?'TALK_COMPARE_INGRESS_IMAGE':'TALK_COMPARE_WORKER_IMAGE'];
 if(!/^sha256:[a-f0-9]{64}$/.test(image??''))throw Error('Immutable local image required');
 const input=options.env??{},root=realpathSync(path.dirname(input.INGRESS_PRIVATE_ROOT??''));
 if(!/^(?:\/private)?\/tmp\/talk-prod-rehearsal-[A-Za-z0-9]+$/.test(root))throw Error('Unowned fixture path');
 const sealed={NODE_ENV:'production'};
 for(const[k,v]of Object.entries(input))if(v!==undefined&&(k.startsWith('INGRESS_')||k==='DATABASE_URL'||k==='TALK_MEDIA_STORE_PATH'||['EVOLUTION_API_BASE_URL','EVOLUTION_API_KEY','WAHA_API_BASE_URL','WAHA_API_KEY'].includes(k)))sealed[k]=v;
 for(const k of ['DATABASE_URL','INGRESS_AMQP_URL','EVOLUTION_API_BASE_URL','WAHA_API_BASE_URL'])if(sealed[k]&&new URL(sealed[k]).hostname!=='127.0.0.1')throw Error('External fixture URL');
 if(new URL(sealed.DATABASE_URL).pathname!=='/talk_rehearsal'||new URL(sealed.DATABASE_URL).port!=='55439'||new URL(sealed.INGRESS_AMQP_URL).pathname!=='/talk_test'||new URL(sealed.INGRESS_AMQP_URL).port!=='56739'||!path.resolve(sealed.TALK_MEDIA_STORE_PATH).startsWith(root+'/'))throw Error('Wrong owned infrastructure');
 const label=env.TALK_COMPARE_LABEL;if(!/^vps-compare-[a-zA-Z0-9-]+$/.test(label??''))throw Error('Unowned container label');
 const ingressCpu=env.TALK_COMPARE_INGRESS_CPU??'0.5';if(!['0.5','1'].includes(ingressCpu))throw Error('Only declared diagnostic CPU quotas allowed');
 const docker=['run','--rm','--pull','never','--name','vps-compare-'+randomUUID(),'--label','talk.compare='+label,'--label','talk.compare.role='+role,'--network','host','--read-only','--tmpfs','/tmp:rw,size=128m','--cap-drop=ALL','--security-opt=no-new-privileges','--user',`${process.getuid()}:${process.getgid()}`,'--cpus',role==='worker'?'0.75':ingressCpu,'--memory',role==='worker'?'768m':'512m','--memory-swap',role==='worker'?'768m':'512m','--mount',`type=bind,src=${root},dst=${root}`];
 for(const k of Object.keys(sealed))docker.push('--env',k);
 docker.push('--entrypoint','node',image,...args);
 return {command:'docker',args:docker,options:{...options,env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:'unix:///var/run/docker.sock',...sealed}}};
}
const original=cp.spawn;cp.spawn=function(command,args=[],options={}){const mapped=buildImageSpawn(command,args,options);return mapped?original(mapped.command,mapped.args,mapped.options):original(command,args,options);};syncBuiltinESMExports();
