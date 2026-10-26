import { expect,it,vi } from 'vitest';
import { createPersistentConnection,type NativeAuth,type NativeConnectionDependencies } from './persistent-connection';
function setup(){
 let saved:{identity:string;workspaceId:string}|null=null;
 let user:NativeAuth|null={identity:'user:session:org',getToken:vi.fn(async()=>'fresh-token')};
 const fetch=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({workspaceId:'workspace',role:'owner',channels:[]}),{status:200,headers:{'Content-Type':'application/json'}}));
 const deps:NativeConnectionDependencies={apiUrl:'https://talk.test/api',auth:async()=>user,fetch:fetch as typeof globalThis.fetch,get:async()=>saved,set:async value=>{saved=value;},clear:async()=>{saved=null;}};
 return {deps,fetch,get saved(){return saved;},set user(value:NativeAuth|null){user=value;}};
}
it('keeps authorization across worker recreation, obtains fresh tokens and returns DTOs only',async()=>{
 const f=setup(),first=createPersistentConnection(f.deps);
 expect(await first.session()).toBeNull();await first.connect();expect(f.saved?.identity).toBe('user:session:org');
 const restarted=createPersistentConnection(f.deps);expect((await restarted.session())?.workspaceId).toBe('workspace');
 expect(JSON.stringify(await restarted.session())).not.toContain('fresh-token');
 const init=f.fetch.mock.calls.at(-1)?.[1] as RequestInit;expect(init.credentials).toBe('omit');expect(init.redirect).toBe('error');expect(init.headers).toMatchObject({Authorization:'Bearer fresh-token'});
});
it('clears authorization when user/session changes or Hub revokes access',async()=>{
 const f=setup(),connection=createPersistentConnection(f.deps);await connection.connect();f.user={identity:'other:session:org',getToken:async()=>'other-token'};
 expect(await connection.session()).toBeNull();expect(f.saved).toBeNull();
 await connection.connect();f.fetch.mockImplementation(async()=>new Response(JSON.stringify({error:'Acesso removido.'}),{status:403}));
 expect(await connection.session()).toBeNull();expect(f.saved).toBeNull();
});
it('checks workspace before dispatching queue data and does not reconnect after sign out',async()=>{
 const f=setup(),connection=createPersistentConnection(f.deps);await connection.connect();
 f.fetch.mockImplementation(async()=>new Response(JSON.stringify({workspaceId:'other',role:'owner',channels:[]}),{status:200}));
 await expect(connection.execute({action:'queue',kind:'review',account:{channelId:'00000000-0000-4000-8000-000000000001',selfAddress:'15550001111@c.us'}})).rejects.toThrow('empresa conectada mudou');expect(f.saved).toBeNull();
 expect(await connection.session()).toBeNull();
});
it('sign out fences an in-flight connect and serializes the authorization write',async()=>{
 const f=setup(),connection=createPersistentConnection(f.deps);let release:()=>void=()=>{};
 f.fetch.mockImplementation(async()=>{await new Promise<void>(resolve=>{release=resolve;});return new Response(JSON.stringify({workspaceId:'workspace',role:'owner',channels:[]}),{status:200});});
 const pending=connection.connect();await vi.waitFor(()=>expect(f.fetch).toHaveBeenCalled());await connection.disconnect();release();
 await expect(pending).rejects.toThrow('conexão mudou');expect(f.saved).toBeNull();
});
