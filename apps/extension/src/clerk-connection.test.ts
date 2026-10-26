import { afterEach,expect,it,vi } from 'vitest';
const sdk=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('@clerk/chrome-extension/client',()=>({createClerkClient:sdk.create}));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.resetModules();sdk.create.mockReset();});
it('collapses concurrent session checks into one native SDK initialization',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T18:00:00Z'));
 const memory:Record<string,unknown>={talkAuthorization:{identity:'user:session:',workspaceId:'workspace'}};
 vi.stubGlobal('__TALK_ORIGIN__','https://talk.test');vi.stubGlobal('__CLERK_ORIGIN__','https://clerk.test');vi.stubGlobal('__CLERK_PUBLISHABLE_KEY__','pk_live_fixture');
 const get=vi.fn(async(key:string)=>({[key]:memory[key]}));
 const setAccessLevel=vi.fn(async()=>{});
 vi.stubGlobal('chrome',{storage:{local:{get,setAccessLevel,set:async(value:Record<string,unknown>)=>Object.assign(memory,value),remove:async(key:string)=>{delete memory[key];}}}});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({workspaceId:'workspace',role:'owner',channels:[]}),{status:200})));
 sdk.create.mockResolvedValue({user:{id:'user'},session:{id:'session',getToken:async()=>'synthetic-token'},organization:null});
 const {persistentConnection}=await import('./clerk-connection');
 const sessions=await Promise.all([persistentConnection!.session(),persistentConnection!.session(),persistentConnection!.session()]);
 expect(sessions.every(s=>s?.workspaceId==='workspace')).toBe(true);expect(sdk.create).toHaveBeenCalledTimes(1);
 expect(setAccessLevel).toHaveBeenCalledWith({accessLevel:'TRUSTED_CONTEXTS'});
 vi.advanceTimersByTime(1600);await persistentConnection!.session();expect(sdk.create).toHaveBeenCalledTimes(2);
});
