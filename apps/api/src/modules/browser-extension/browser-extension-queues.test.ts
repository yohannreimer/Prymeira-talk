import { describe, expect, it, vi } from 'vitest';
import { listExtensionQueue, resolveExtensionQueueTarget } from './browser-extension-queues.js';
const channelId = '00000000-0000-4000-8000-000000000001';
const account = { channelId, selfAddress: '5547991234567@c.us' };
const auth = { workspaceId: 'A', clerkUserId: 'user', role: 'agent' as const };
const record = { id: 'followup', updatedAt: new Date('2026-10-26T10:00:00Z'), scheduledAt: new Date('2026-10-26T12:00:00Z'), kind: 'human_commercial', status: 'review',
 conversation: { id: 'conversation', channelId, contact: { name: 'Ana', phone: '554787654321' } } };
function db() { return { userProfile: { findFirst: vi.fn(async()=>({id:'agent'})) }, channel: { findFirst: vi.fn(async()=>({id:channelId,status:'connected',verifiedMessagingPhoneNumber:'554791234567'})) },
 conversationFollowup: { findMany: vi.fn(async(_args:unknown)=>[record]), count: vi.fn(async()=>1), findFirst: vi.fn(async()=>record) },
 conversation: { findMany: vi.fn(async()=>[]), count: vi.fn(async()=>2), findFirst: vi.fn(async()=>null) } }; }
describe('extension queues',()=>{
 it('scopes counts and rows to the verified channel, workspace and assignee',async()=>{
  const database=db(); const result=await listExtensionQueue(database as never,auth,{account,kind:'review'});
  expect(result.items[0]).toMatchObject({ id:'followup',conversation:{id:'conversation',phone:'554787654321'} });
  const query=database.conversationFollowup.findMany.mock.calls[0]?.[0] as any;
  expect(query.where).toMatchObject({workspaceId:'A',activeKey:'active',status:'review',conversation:{is:{workspaceId:'A',channelId,assignedUserId:'agent',retiredIntoConversationId:null,status:{not:'closed'},contact:{is:{isGroup:false}}}}});
  expect(query.take).toBe(31);expect(result.counts.human).toBe(2);
 });
 it('rejects number mismatch before reading queues',async()=>{
  const database=db();await expect(listExtensionQueue(database as never,auth,{account:{...account,selfAddress:'5511987654321@c.us'},kind:'review'})).rejects.toMatchObject({code:'EXTENSION_NUMBER_MISMATCH'});
  expect(database.conversationFollowup.findMany).not.toHaveBeenCalled();
 });
 it('refuses foreign/removed cursors and stale preparations',async()=>{
  const database=db();database.conversationFollowup.findFirst.mockResolvedValue(null as never);
  await expect(listExtensionQueue(database as never,auth,{account,kind:'review',cursor:'foreign'})).rejects.toMatchObject({code:'EXTENSION_QUEUE_STALE'});
  database.conversationFollowup.findFirst.mockResolvedValue(record);
  await expect(resolveExtensionQueueTarget(database as never,auth,{account,kind:'review',id:'followup',expectedUpdatedAt:'2026-10-26T09:00:00Z'})).rejects.toMatchObject({code:'EXTENSION_QUEUE_STALE'});
 });
 it('returns a revalidated destination, never a caller-supplied URL',async()=>{
  expect(await resolveExtensionQueueTarget(db() as never,auth,{account,kind:'review',id:'followup',expectedUpdatedAt:'2026-10-26T10:00:00Z'})).toMatchObject({conversation:{id:'conversation',phone:'554787654321'},prepare:{id:'followup',expectedUpdatedAt:'2026-10-26T10:00:00.000Z'}});
 });
});
