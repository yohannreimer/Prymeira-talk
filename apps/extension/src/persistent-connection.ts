import { executeExtensionCommand, type ExtensionCommand, type ExtensionReply } from '@prymeira-talk/shared';
export type NativeAuth = { identity:string; getToken:()=>Promise<string|null> };
type Authorization={identity:string;workspaceId:string};
export type NativeConnectionDependencies={
 auth:()=>Promise<NativeAuth|null>; fetch:typeof fetch; apiUrl:string;
 get:()=>Promise<Authorization|null>;set:(value:Authorization)=>Promise<void>;clear:()=>Promise<void>;
};
class ConnectionError extends Error { constructor(message:string,public status=401){super(message);} }
/** Auth credentials stay in the worker. Content scripts and the panel receive DTOs only. */
export function createPersistentConnection(deps:NativeConnectionDependencies){
 let generation=0,writes=Promise.resolve(),lastDisconnectReason:string|null=null;
 const ensureCurrent=(expected:number)=>{if(expected!==generation)throw new ConnectionError('A conexão mudou. Conecte novamente.',409);};
 async function execute(raw:ExtensionCommand,authorize=false):Promise<ExtensionReply>{
  const expected=generation;await writes.catch(()=>{});ensureCurrent(expected);const saved=await deps.get();
  if(!authorize&&!saved)throw new ConnectionError('Conecte sua conta do Talk.');
  const auth=await deps.auth();ensureCurrent(expected);
  if(!auth||(!authorize&&saved!.identity!==auth.identity)){
   const reason=auth?'A conta do Talk mudou. Conecte novamente.':'O login do Talk não está disponível. Conecte novamente.';await disconnect(reason);throw new ConnectionError(reason);
  }
  const request=async<T>(path:string,init:RequestInit={}):Promise<T>=>{
   ensureCurrent(expected);
   if(!/^\/(browser-extension\/(channels|resolve|queue|navigate)|assistant\/conversations\/[a-f0-9-]{36}(\/suggestions)?|conversations\/[a-f0-9-]{36}\/(followup|actions)|followups\/[a-f0-9-]{36}\/(postpone|cancel|done|no-followup))$/.test(path))throw new ConnectionError('Comando indisponível.',403);
   const token=await auth.getToken();ensureCurrent(expected);
   if(!token){await disconnect('A sessão expirou. Entre novamente no Talk.');throw new ConnectionError('Entre novamente no Talk.');}
   const response=await deps.fetch(`${deps.apiUrl}${path}`,{...init,credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20_000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}});
   ensureCurrent(expected);
   const data=await response.json();
   if(!response.ok){
    if(response.status===401||response.status===403)await disconnect(response.status===401?'O Talk recusou a sessão. Conecte novamente.':'O acesso ao Talk foi recusado. Confira as permissões da conta.');
    throw new ConnectionError(typeof data.error==='string'?data.error:data.error?.message??'Não foi possível consultar o Talk. Tente novamente.',response.status);
   }
   if(path==='/browser-extension/channels'&&!authorize&&saved!.workspaceId!==data.workspaceId){await disconnect('A empresa conectada mudou. Conecte novamente.');throw new ConnectionError('A empresa conectada mudou. Conecte novamente.');}
   return data as T;
  };
  const result=await executeExtensionCommand(raw,request,auth.identity);ensureCurrent(expected);
  if(result.ok&&'workspaceId' in result.data){
   if(!authorize&&saved!.workspaceId!==result.data.workspaceId){await disconnect('A empresa conectada mudou. Conecte novamente.');throw new ConnectionError('A empresa conectada mudou. Conecte novamente.');}
   if(authorize){const value={identity:auth.identity,workspaceId:result.data.workspaceId};writes=writes.catch(()=>{}).then(async()=>{ensureCurrent(expected);await deps.set(value);});await writes;ensureCurrent(expected);lastDisconnectReason=null;}
  }
  return result;
 }
 async function disconnect(reason:string|null=null){lastDisconnectReason=reason;++generation;writes=writes.catch(()=>{}).then(()=>deps.clear());await writes;}
 async function connect(){try{return await execute({action:'session'},true);}catch(error){if(error instanceof ConnectionError&&error.status===401)return null;throw error;}}
 async function session(){if(!await deps.get())return null;try{const result=await execute({action:'session'});return result.ok&&'channels' in result.data?result.data:null;}catch(error){if(error instanceof ConnectionError&&(error.status===401||error.status===403))return null;throw error;}}
 return {execute,connect,disconnect,session,lastError:()=>lastDisconnectReason};
}
