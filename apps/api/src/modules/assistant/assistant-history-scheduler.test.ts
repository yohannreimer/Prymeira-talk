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
describe('an automatic suggestion that lost its turn',()=>{
  it('ends quietly when the seller answered first (also from the phone): no error on screen, no generation',async()=>{
    const s=setup(); const dismiss=vi.fn(); Object.assign(s.repository,{dismiss});
    const loadContext=vi.fn(async()=>({conversation:{aiControlStatus:'agent_allowed'},messages:[{direction:'inbound'},{direction:'outbound'}]}));
    const scheduler=createAssistantScheduler({} as any,{repository:s.repository as any,loadContext:loadContext as any,generate:s.generate as any});
    await scheduler.tick();
    expect(dismiss).toHaveBeenCalledWith(expect.anything(),'lease'); expect(s.repository.fail).not.toHaveBeenCalled(); expect(s.generate).not.toHaveBeenCalled();
  });
  it('still generates a follow-up the seller asked for after their own message',async()=>{
    const s=setup(); Object.assign(s.repository,{dismiss:vi.fn(),due:vi.fn(async()=>[{workspaceId:'w',conversationId:'c',requestedById:'u'}])});
    const loadContext=vi.fn(async()=>({conversation:{aiControlStatus:'agent_allowed'},messages:[{direction:'outbound'}]}));
    const scheduler=createAssistantScheduler({} as any,{repository:s.repository as any,loadContext:loadContext as any,generate:s.generate as any});
    await scheduler.tick();
    expect(s.generate).toHaveBeenCalled();
  });
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
    expect(schedule).not.toHaveBeenCalledWith(expect.objectContaining({trigger:'continuation'}));
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
    expect(schedule).not.toHaveBeenCalledWith(expect.objectContaining({trigger:'continuation'}));
  });
  it('only invalidates when the seller speaks: the panel waits for the customer, no automatic guidance',async()=>{
    const invalidate=vi.fn().mockResolvedValue(undefined);
    const schedule=vi.fn().mockResolvedValue(true);
    const scheduler=createAssistantScheduler({} as any,{repository:{invalidate,schedule} as any});
    await scheduler.message({workspaceId:'w',conversationId:'c',messageId:'seller-message',direction:'outbound'});
    expect(invalidate).toHaveBeenCalledWith('w','c');
    expect(schedule).not.toHaveBeenCalled();
  });
  it('never generates automatically after our own message, but a requested follow-up is generated',async()=>{
    const context={conversation:{aiControlStatus:'human_controlled'},humanSupport:true,messages:[{direction:'inbound'},{direction:'outbound'}],contextKey:'same'};
    for (const [requestedById, generated] of [[null,false],['seller',true]] as const) {
      const state={workspaceId:'w',conversationId:'c',requestedById,instruction:null};
      const repository={due:vi.fn(async()=>[state]),claim:vi.fn(async()=> 'lease'),fail:vi.fn(),publish:vi.fn(async()=>true),releaseLease:vi.fn()};
      const generate=vi.fn(async()=>({body:'Follow-up'}));
      const scheduler=createAssistantScheduler({} as any,{repository:repository as any,loadContext:vi.fn(async()=>context) as any,generate:generate as any});
      await scheduler.tick();
      expect(generate).toHaveBeenCalledTimes(generated ? 1 : 0);
      expect(repository.fail).toHaveBeenCalledTimes(generated ? 0 : 1);
    }
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
