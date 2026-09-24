import { describe,it,expect,vi } from 'vitest';
import { createAssistantScheduler } from './assistant-scheduler.js';
import { AssistantError } from './assistant-access.js';

function setup() {
  const events:string[]=[];
  const state={workspaceId:'w',conversationId:'c',requestedById:null};
  const repository={due:vi.fn(async()=>[state]),claim:vi.fn(async()=> 'lease'),fail:vi.fn(),publish:vi.fn(async()=>true),releaseLease:vi.fn()};
  const prepareContext=vi.fn(async()=>{events.push('history');});
  const loadContext=vi.fn(async()=>{events.push('context');return{conversation:{aiControlStatus:'agent_allowed'},messages:[{direction:'inbound'}]};});
  const generate=vi.fn(async()=>{events.push('model');return{body:'rascunho'};});
  const scheduler=createAssistantScheduler({} as any,{repository:repository as any,prepareContext,loadContext:loadContext as any,generate:generate as any});
  return {scheduler,prepareContext,generate,repository,events};
}
describe('history before suggestions',()=>{
  it('prepares history before reading context or generating a reply',async()=>{const s=setup();await s.scheduler.tick();expect(s.events).toEqual(['history','context','model']);});
  it('never generates with a silently missing history',async()=>{const s=setup();s.prepareContext.mockRejectedValue(new AssistantError('ASSISTANT_HISTORY_UNAVAILABLE','Histórico indisponível'));await s.scheduler.tick();expect(s.generate).not.toHaveBeenCalled();expect(s.repository.fail).toHaveBeenCalledWith(expect.anything(),'lease','Histórico indisponível');});
});
describe('human support scheduling',()=>{
  it('keeps automatic suggestions active after the next action is completed',async()=>{
    const invalidate=vi.fn().mockResolvedValue(undefined);
    const schedule=vi.fn().mockResolvedValue(true);
    const updateMany=vi.fn().mockResolvedValue({count:1});
    const scheduler=createAssistantScheduler({assistantConversationState:{updateMany}} as any,{repository:{invalidate,schedule} as any});
    await scheduler.handoffCompleted('w','c');
    await scheduler.message({workspaceId:'w',conversationId:'c',messageId:'next-customer-message',direction:'inbound'});
    expect(schedule).toHaveBeenNthCalledWith(1,{workspaceId:'w',conversationId:'c',trigger:'inbound'});
    expect(schedule).toHaveBeenNthCalledWith(2,{workspaceId:'w',conversationId:'c',messageId:'next-customer-message',direction:'inbound',trigger:'inbound'});
  });
  it('reschedules a pending customer question when a human takes control',async()=>{
    const invalidate=vi.fn().mockResolvedValue(undefined);
    const schedule=vi.fn().mockResolvedValue(true);
    const updateMany=vi.fn().mockResolvedValue({count:1});
    const scheduler=createAssistantScheduler({assistantConversationState:{updateMany}} as any,{repository:{invalidate,schedule} as any});
    await scheduler.control('w','c',true);
    expect(invalidate).toHaveBeenCalledWith('w','c');
    expect(updateMany).toHaveBeenCalledWith({where:{workspaceId:'w',conversationId:'c'},data:{lastMessageId:null}});
    expect(schedule).toHaveBeenCalledWith({workspaceId:'w',conversationId:'c',trigger:'inbound'});
  });
  it('publishes a reviewed draft while the human stays in control',async()=>{
    const state={workspaceId:'w',conversationId:'c',requestedById:null,instruction:null};
    const repository={due:vi.fn(async()=>[state]),claim:vi.fn(async()=> 'lease'),fail:vi.fn(),publish:vi.fn(async(_s,_t,_d,stillCurrent)=>stillCurrent({})),releaseLease:vi.fn()};
    const context={conversation:{aiControlStatus:'human_controlled'},humanSupport:true,messages:[{direction:'inbound'}],contextKey:'same'};
    const loadContext=vi.fn(async()=>context);
    const generate=vi.fn(async()=>({body:'Sugestão privada'}));
    const scheduler=createAssistantScheduler({} as any,{repository:repository as any,loadContext:loadContext as any,generate:generate as any});
    await scheduler.tick();
    expect(repository.publish).toHaveBeenCalledOnce();
    expect(repository.fail).not.toHaveBeenCalled();
  });
});
