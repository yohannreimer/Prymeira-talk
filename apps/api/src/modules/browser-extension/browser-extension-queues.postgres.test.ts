import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll,beforeAll,describe,it,expect } from 'vitest';
import { listExtensionQueue,resolveExtensionQueueTarget } from './browser-extension-queues.js';
const url=process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('extension queues against PostgreSQL',()=>{
 let db:PrismaClient;const workspaces:string[]=[];let phone=0;
 beforeAll(()=>{db=new PrismaClient({datasources:{db:{url}}});});
 afterAll(async()=>{
  const where={workspaceId:{in:workspaces}};
  await db.conversation.updateMany({where,data:{activeAgentSessionId:null}});
  await db.conversationFollowup.deleteMany({where});await db.aiAgentSession.deleteMany({where});await db.message.deleteMany({where});
  await db.conversation.deleteMany({where});await db.aiAgent.deleteMany({where});await db.contact.deleteMany({where});await db.channel.deleteMany({where});await db.userProfile.deleteMany({where});await db.$disconnect();
 });
 async function fixture(){
  const workspaceId=`extension-queues-${randomUUID()}`;workspaces.push(workspaceId);
  const channel=await db.channel.create({data:{workspaceId,provider:'evolution',providerKey:randomUUID(),status:'connected',verifiedMessagingPhoneNumber:'15550001111'}});
  const user=await db.userProfile.create({data:{workspaceId,clerkUserId:randomUUID(),displayName:'Synthetic owner'}});
  const agent=await db.aiAgent.create({data:{workspaceId,name:'Synthetic agent',systemPrompt:'Synthetic test'}});
  const auth={workspaceId,clerkUserId:user.clerkUserId,role:'agent' as const};const account={channelId:channel.id,selfAddress:'15550001111@c.us'};
  async function conversation(extra:Record<string,unknown>={},group=false){const contact=await db.contact.create({data:{workspaceId,phone:`1555${String(++phone).padStart(7,'0')}`,isGroup:group}});
   return db.conversation.create({data:{workspaceId,channelId:channel.id,contactId:contact.id,assignedUserId:user.id,...extra}});}
  async function followup(conversationId:string){const anchor=await db.message.create({data:{workspaceId,conversationId,direction:'outbound',type:'text',body:'Synthetic',status:'sent'}});
   return db.conversationFollowup.create({data:{workspaceId,conversationId,agentId:agent.id,kind:'human_commercial',status:'review',activeKey:'active',anchorMessageId:anchor.id,anchorMessageAt:anchor.createdAt,anchorIngestedAt:anchor.createdAt,scheduledAt:new Date(),draftBody:'Synthetic follow-up'}});}
  async function handoff(extra:Record<string,unknown>={},completed=false){const c=await conversation(extra);const session=await db.aiAgentSession.create({data:{workspaceId,conversationId:c.id,agentId:agent.id,status:'handoff_requested',handoffReason:'Synthetic human task',handoffActionCompletedAt:completed?new Date():null}});await db.conversation.update({where:{id:c.id},data:{activeAgentSessionId:session.id}});return c;}
  return {workspaceId,channel,user,agent,auth,account,conversation,followup,handoff};
 }
 it('never returns another workspace, channel, assignee, group or closed conversation',async()=>{
  const f=await fixture(),other=await fixture();const own=await f.followup((await f.conversation()).id);
  await f.followup((await f.conversation({assignedUserId:null})).id);await f.followup((await f.conversation({status:'closed'})).id);await f.followup((await f.conversation({},true)).id);
  await other.followup((await other.conversation()).id);
  const second=await db.channel.create({data:{workspaceId:f.workspaceId,provider:'evolution',providerKey:randomUUID(),status:'connected',verifiedMessagingPhoneNumber:'15550002222'}});
  await f.followup((await f.conversation({channelId:second.id})).id);
  const result=await listExtensionQueue(db,f.auth,{account:f.account,kind:'review'});
  expect(result.items.map(r=>r.id)).toEqual([own.id]);expect(result.counts.review).toBe(1);
  await expect(resolveExtensionQueueTarget(db,f.auth,{account:{...f.account,channelId:other.channel.id},kind:'review',id:own.id,expectedUpdatedAt:own.updatedAt.toISOString()})).rejects.toMatchObject({code:'EXTENSION_CHANNEL_NOT_FOUND'});
 });
 it('matches the persistent human handoff rule and excludes completed or hidden tasks',async()=>{
  const f=await fixture();const expected=await f.handoff();await f.handoff({},true);await f.handoff({status:'closed'});await f.handoff({hiddenUntilReply:true});await f.handoff({assignedUserId:null});
  const queue=await listExtensionQueue(db,f.auth,{account:f.account,kind:'human'});
  expect(queue.items.map(r=>r.conversation.id)).toEqual([expected.id]);expect(queue.counts.human).toBe(1);
  expect((await resolveExtensionQueueTarget(db,f.auth,{account:f.account,kind:'human',id:expected.id})).prepare).toBeNull();
 });
 it('paginates beyond thirty items and rejects removed cursors and changed revisions',async()=>{
  const f=await fixture();for(let i=0;i<31;i++)await f.followup((await f.conversation()).id);
  const page=await listExtensionQueue(db,f.auth,{account:f.account,kind:'review'});expect(page.items).toHaveLength(30);expect(page.counts.review).toBe(31);
  const next=await listExtensionQueue(db,f.auth,{account:f.account,kind:'review',cursor:page.nextCursor!});expect(next.items).toHaveLength(1);expect(next.nextCursor).toBeNull();
  const row=page.items[0]!;await db.conversationFollowup.update({where:{id:row.id},data:{draftBody:'Changed safely'}});
  await expect(resolveExtensionQueueTarget(db,f.auth,{account:f.account,kind:'review',id:row.id,expectedUpdatedAt:row.followup!.updatedAt})).rejects.toMatchObject({code:'EXTENSION_QUEUE_STALE'});
  await db.conversationFollowup.update({where:{id:page.nextCursor!},data:{status:'cancelled',activeKey:null}});
  await expect(listExtensionQueue(db,f.auth,{account:f.account,kind:'review',cursor:page.nextCursor!})).rejects.toMatchObject({code:'EXTENSION_QUEUE_STALE'});
 });
});
