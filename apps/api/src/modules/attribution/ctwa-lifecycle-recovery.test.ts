import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createCtwaLifecycleRecovery } from './ctwa-lifecycle-recovery.js';
import { TRACKING_ENDPOINT } from './ctwa-tracking-config.js';
const workspaceId='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const config={endpoint:TRACKING_ENDPOINT,signingKey:'a'.repeat(64),enabled:true,autoForward:true,lifecycleEnabled:true,lifecycleEnabledAt:Math.floor(Date.now()/1000)-100};
function fixture(enabled=true){
 const db={ctwaAttribution:{findMany:vi.fn(async()=>[{id:'a',conversationId:'native-a'},{id:'b',conversationId:'native-b'}])},ctwaConversionEvent:{findFirst:vi.fn(async()=>null)}};
 const scheduler={confirmedBookings:vi.fn(async({conversationId}:any)=>[{eventId:`calendar-${conversationId}`,createdAt:new Date().toISOString(),startsAt:'future',label:'synthetic',meetLink:null,htmlLink:null}])};
 const service={confirmMeeting:vi.fn(async()=>({})),status:vi.fn(),confirmSale:vi.fn()};
 const worker=createCtwaLifecycleRecovery(db as unknown as PrismaClient,{secret:JSON.stringify({[workspaceId]:{...config,lifecycleEnabled:enabled},[other]:{...config,lifecycleEnabled:false}}),scheduler,service:service as any,intervalMs:1000});return{db,scheduler,service,worker};
}
describe('bounded native calendar recovery',()=>{
 it('disabled workspaces never query DB or Calendar',async()=>{const f=fixture(false);f.worker.start();await f.worker.stop();expect(f.db.ctwaAttribution.findMany).not.toHaveBeenCalled();expect(f.scheduler.confirmedBookings).not.toHaveBeenCalled();});
 it('recovers two existing native conversations with scoped bounded read-only lookups',async()=>{const f=fixture();f.worker.start();await vi.waitFor(()=>expect(f.service.confirmMeeting).toHaveBeenCalledTimes(2));await f.worker.stop();expect(f.db.ctwaAttribution.findMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({where:{workspaceId,sourceMode:'live',conversation:{contact:{workspaceId,isGroup:false}}},take:25}));expect(f.scheduler.confirmedBookings).toHaveBeenCalledTimes(2);expect(f.service.confirmMeeting).toHaveBeenCalledWith(expect.objectContaining({workspaceId,conversationId:'native-b',eventId:'calendar-native-b'}));});
 it('already captured milestone skips calendar; failure on one conversation preserves recovery of another',async()=>{const f=fixture();f.db.ctwaConversionEvent.findFirst.mockResolvedValueOnce({id:'existing'} as any);f.worker.start();await vi.waitFor(()=>expect(f.service.confirmMeeting).toHaveBeenCalledTimes(1));await f.worker.stop();expect(f.scheduler.confirmedBookings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({conversationId:'native-b'}));const g=fixture();g.scheduler.confirmedBookings.mockRejectedValueOnce(new Error('synthetic failure'));g.worker.start();await vi.waitFor(()=>expect(g.service.confirmMeeting).toHaveBeenCalledTimes(1));await g.worker.stop();expect(g.service.confirmMeeting).toHaveBeenCalledWith(expect.objectContaining({conversationId:'native-b'}));});
});
