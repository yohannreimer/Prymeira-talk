import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { createCtwaLifecycleService } from './ctwa-lifecycle.js';
import { createCtwaTrackingWorker } from './ctwa-tracking-bridge.js';
import { ctwaEventData,createCtwaService } from './ctwa-service.js';
import { hash } from './ctwa-payload.js';
import { TRACKING_ENDPOINT } from './ctwa-tracking-config.js';
const url=process.env.CTWA_TEST_DATABASE_URL;
if(url){const parsed=new URL(url);if(parsed.protocol!=='postgresql:'||parsed.hostname!=='127.0.0.1'||!parsed.port||!['/messaging_test','/talk_ctwa_test'].includes(parsed.pathname))throw new Error('Refusing non-disposable lifecycle database');}
describe.skipIf(!url)('trusted lifecycle disposable PostgreSQL migration and concurrency',()=>{
 const db=new PrismaClient({datasources:{db:{url:url??'postgresql://unused/unused'}}});const workspaceId=randomUUID();
 const confirmedAt=new Date(),activation=Math.floor(confirmedAt.getTime()/1000)-600;
 const secret=JSON.stringify({[workspaceId]:{endpoint:TRACKING_ENDPOINT,signingKey:'a'.repeat(64),enabled:true,autoForward:true,lifecycleEnabled:true,lifecycleEnabledAt:activation}});
 const service=createCtwaLifecycleService(db,{secret,now:()=>confirmedAt});
 let channelId:string,conversationId:string,otherConversationId:string,contactId:string,original:any;
 async function attribution(channel:string,conversation:string,offset=-10000){const eventTime=new Date(confirmedAt.getTime()+offset);const message=await db.message.create({data:{workspaceId,conversationId:conversation,direction:'inbound',type:'text',body:'Owned lifecycle fixture'}});const click=`synthetic-${randomUUID()}`;const attr=await db.ctwaAttribution.create({data:{workspaceId,channelId:channel,conversationId:conversation,messageId:message.id,ctwaClid:click,clickHash:hash(click),sourceMode:'live',capturedAt:eventTime}});await db.ctwaConversionEvent.create({data:{...ctwaEventData(attr,'LeadSubmitted'),eventTime,state:'tracking_accepted',attemptCount:1}});return attr;}
 beforeAll(async()=>{const channel=await db.channel.create({data:{workspaceId,provider:'evolution',providerKey:randomUUID()}});channelId=channel.id;const contact=await db.contact.create({data:{workspaceId,phone:'5500000000000',name:'Owned lifecycle'}});contactId=contact.id;conversationId=(await db.conversation.create({data:{workspaceId,channelId,contactId}})).id;const otherChannel=(await db.channel.create({data:{workspaceId,provider:'evolution',providerKey:randomUUID()}})).id;otherConversationId=(await db.conversation.create({data:{workspaceId,channelId:otherChannel,contactId}})).id;original=await attribution(channelId,conversationId);await attribution(otherChannel,otherConversationId);});
 afterAll(async()=>{await db.channel.deleteMany({where:{workspaceId}});await db.contact.deleteMany({where:{workspaceId}});await db.$disconnect();});
 it('parallel owner confirmations create one workspace sale and preserve immutable money/time/origin',async()=>{
  const input={workspaceId,conversationId,userId:'synthetic-owner',role:'owner',orderId:'parallel-sale',valueCents:12345,currency:'BRL'};
  const results=await Promise.all(Array.from({length:8},()=>service.confirmSale(input)));expect(new Set(results.map(r=>r.id)).size).toBe(1);const row=await db.ctwaConversionEvent.findUniqueOrThrow({where:{id:results[0]!.id}});expect(row).toMatchObject({attributionId:original.id,valueCents:12345n,sourceReference:hash('parallel-sale'),lifecycleSource:'owner_manual',eventTime:confirmedAt});
  await attribution(channelId,conversationId,-1000);expect((await service.confirmSale(input)).id).toBe(row.id);expect((await db.ctwaConversionEvent.findUniqueOrThrow({where:{id:row.id}})).attributionId).toBe(original.id);
  await expect(service.confirmSale({...input,valueCents:54321})).rejects.toThrow('sale_conflict');await expect(service.confirmSale({...input,conversationId:otherConversationId})).rejects.toThrow('sale_conflict');
  expect(await db.ctwaConversionEvent.count({where:{workspaceId,lifecycleSource:'owner_manual',sourceReference:hash('parallel-sale')}})).toBe(1);
  await expect(db.ctwaConversionEvent.update({where:{id:row.id},data:{valueCents:0n}})).rejects.toThrow();await expect(db.ctwaConversionEvent.update({where:{id:row.id},data:{currency:'USD'}})).rejects.toThrow();
  const direct=createCtwaService(db,{secret:JSON.stringify({[workspaceId]:{enabled:true,datasetId:'123',whatsappBusinessAccountId:'456',accessToken:'synthetic'}})});await expect(direct.dispatch(workspaceId,row.id)).rejects.toThrow('tracking_owned');
 });
 it('concurrent cross-channel sale reference has one winner across the whole workspace',async()=>{
  const base={workspaceId,userId:'synthetic-owner',role:'owner',orderId:'cross-channel-race',valueCents:999,currency:'BRL'};
  const results=await Promise.allSettled([service.confirmSale({...base,conversationId}),service.confirmSale({...base,conversationId:otherConversationId})]);expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);expect(await db.ctwaConversionEvent.count({where:{workspaceId,sourceReference:hash(base.orderId),lifecycleSource:'owner_manual'}})).toBe(1);
  // Keep this independently tested sale terminal so the worker assertion below concerns its original two rows.
  await db.ctwaConversionEvent.updateMany({where:{workspaceId,sourceReference:hash(base.orderId)},data:{state:'tracking_accepted'}});
 });
 it('parallel Calendar replay/rebooking persists one trusted meeting and immutable original confirmation time',async()=>{
  const results=await Promise.all(Array.from({length:8},(_,i)=>service.confirmMeeting({workspaceId,conversationId,eventId:`calendar-${i}`,createdAt:confirmedAt.toISOString()})));expect(new Set(results.map(r=>r.id)).size).toBe(1);expect(await db.ctwaConversionEvent.count({where:{workspaceId,conversationId,lifecycleSource:'calendar_confirmed'}})).toBe(1);
  const row=await db.ctwaConversionEvent.findUniqueOrThrow({where:{id:results[0]!.id}});expect(row.eventName).toBe('QualifiedLead');expect(row.eventTime).toEqual(confirmedAt);expect((await service.confirmMeeting({workspaceId,conversationId,eventId:'reschedule',createdAt:confirmedAt.toISOString()})).id).toBe(row.id);
 });
 it('legacy accepted/pending purchase references across channels are conflicts and remain untrusted',async()=>{
  const other=await db.ctwaAttribution.findFirstOrThrow({where:{workspaceId,conversationId:otherConversationId}});
  for(const state of ['accepted','pending_validation']){const orderId=`legacy-${state}`;const legacy=await db.ctwaConversionEvent.create({data:{...ctwaEventData(other,'Purchase',{orderId,value:1,currency:'BRL'}),state}});await expect(service.confirmSale({workspaceId,conversationId,userId:'synthetic-owner',role:'owner',orderId,valueCents:100,currency:'BRL'})).rejects.toThrow('sale_conflict');expect(await db.ctwaConversionEvent.findUniqueOrThrow({where:{id:legacy.id}})).toMatchObject({state,lifecycleSource:null,valueCents:null});}
 });
 it('worker exports only trusted lifecycle rows; accepted lead and old qualified/purchase preparations stay fenced',async()=>{
  const attr=await db.ctwaAttribution.findFirstOrThrow({where:{workspaceId,conversationId:otherConversationId}});await db.ctwaConversionEvent.create({data:ctwaEventData(attr,'QualifiedLead')});const calls:any[]=[];
  const worker=createCtwaTrackingWorker(db,{secret,fetch:async(_url,init)=>{const body=JSON.parse(init!.body as string);calls.push(body);return Response.json({eventId:body.eventId,state:'accepted',metaStatusCode:200});}});
  worker.start();await vi.waitFor(()=>expect(calls).toHaveLength(2));await worker.stop();expect(calls.every(body=>body.version===2)).toBe(true);expect(calls.map(body=>body.eventName).sort()).toEqual(['Purchase','QualifiedLead']);expect(await db.ctwaConversionEvent.count({where:{workspaceId,lifecycleSource:null,eventName:{in:['Purchase','QualifiedLead']},attemptCount:0}})).toBe(3);
  expect((await db.ctwaConversionEvent.findFirstOrThrow({where:{workspaceId,attributionId:original.id,eventName:'LeadSubmitted'}})).state).toBe('tracking_accepted');
 });
});
