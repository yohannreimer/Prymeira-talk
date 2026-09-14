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
