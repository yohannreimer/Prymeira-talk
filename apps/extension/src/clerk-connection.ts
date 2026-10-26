import { createClerkClient } from '@clerk/chrome-extension/client';
import { CLERK_ORIGIN, CLERK_PUBLISHABLE_KEY, TALK_ORIGIN } from './config';
import { createPersistentConnection } from './persistent-connection';
const key='talkAuthorization';
const storageReady=chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
// The official SDK owns its client credential. Never expose its cache to content scripts.
export const persistentConnection=CLERK_PUBLISHABLE_KEY?createPersistentConnection({
 apiUrl:`${TALK_ORIGIN}/api`,fetch:(...args)=>fetch(...args),
 auth:async()=>{
  await storageReady;
  const clerk=await createClerkClient({publishableKey:CLERK_PUBLISHABLE_KEY,syncHost:CLERK_ORIGIN,background:true});
  if(!clerk.session||!clerk.user)return null;
  return {identity:`${clerk.user.id}:${clerk.session.id}:${clerk.organization?.id??''}`,getToken:()=>clerk.session!.getToken()};
 },
 get:async()=>{await storageReady;const value=(await chrome.storage.local.get(key))[key] as {identity?:unknown;workspaceId?:unknown}|undefined;return value&&typeof value.identity==='string'&&typeof value.workspaceId==='string'?{identity:value.identity,workspaceId:value.workspaceId}:null;},
 set:async value=>{await storageReady;await chrome.storage.local.set({[key]:value});},
 clear:async()=>{await storageReady;await chrome.storage.local.remove(key);},
}):null;
