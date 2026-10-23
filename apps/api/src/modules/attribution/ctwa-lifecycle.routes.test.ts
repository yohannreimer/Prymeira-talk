import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../../test/build-app.js';
import { ctwaLifecycleRoutes } from './ctwa-lifecycle.routes.js';
import { CtwaOperationError } from './ctwa-service.js';
const id='00000000-0000-4000-8000-000000000001',headers={authorization:'Bearer synthetic-token'};
async function fixture(role:'owner'|'manager'|'agent'='owner'){
 const app=await buildApp({PRYMEIRA_LOCAL_AUTH_BYPASS:true,PRYMEIRA_LOCAL_WORKSPACE_ID:'synthetic-workspace',PRYMEIRA_LOCAL_ROLE:role},{authEnabled:true});
 app.addHook('preHandler',async request=>{request.talk.clerkUserId='synthetic-owner';});
 const service={status:vi.fn(async()=>({enabled:true,native:true,items:[]})),confirmMeeting:vi.fn(),confirmSale:vi.fn(async()=>({id,state:'pending_validation'}))};
 await app.register(ctwaLifecycleRoutes,{service:service as any});return{app,service};
}
describe('authenticated owner lifecycle endpoints',()=>{
 it.each(['manager','agent'] as const)('%s cannot read status or confirm sales',async role=>{const{app,service}=await fixture(role);try{expect((await app.inject({url:`/conversations/${id}/ctwa-lifecycle`,headers})).statusCode).toBe(403);expect((await app.inject({method:'POST',url:`/conversations/${id}/ctwa-lifecycle/sales`,headers,payload:{orderId:'s',valueCents:100,currency:'BRL'}})).statusCode).toBe(403);expect(service.status).not.toHaveBeenCalled();expect(service.confirmSale).not.toHaveBeenCalled();}finally{await app.close();}});
 it('derives actor/workspace from auth and rejects caller scope and invalid cents',async()=>{const{app,service}=await fixture();try{expect((await app.inject(`/conversations/${id}/ctwa-lifecycle`)).statusCode).toBe(401);const get=await app.inject({url:`/conversations/${id}/ctwa-lifecycle`,headers});expect(get.statusCode).toBe(200);expect(get.headers['cache-control']).toBe('private, no-store');expect(service.status).toHaveBeenCalledWith('synthetic-workspace',id);
 for(const payload of [{orderId:'s',valueCents:0,currency:'BRL'},{orderId:'s',valueCents:1.1,currency:'BRL'},{orderId:'s',valueCents:100,currency:'USD'},{orderId:'s',valueCents:100,currency:'BRL',workspaceId:'other'}])expect((await app.inject({method:'POST',url:`/conversations/${id}/ctwa-lifecycle/sales`,headers,payload})).statusCode).toBe(400);
 const post={method:'POST' as const,url:`/conversations/${id}/ctwa-lifecycle/sales`,headers,payload:{orderId:'s',valueCents:12345,currency:'BRL'}};expect((await app.inject(post)).statusCode).toBe(200);expect(service.confirmSale).toHaveBeenCalledWith({...post.payload,workspaceId:'synthetic-workspace',conversationId:id,userId:'synthetic-owner',role:'owner'});service.confirmSale.mockRejectedValueOnce(new CtwaOperationError('sale_conflict'));expect((await app.inject(post)).statusCode).toBe(409);
 }finally{await app.close();}});
});
