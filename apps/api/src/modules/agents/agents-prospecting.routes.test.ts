import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { agentsRoutes } from './agents.routes.js';

const followup = { timeZone: 'America/Sao_Paulo', businessDays: [1,2,3,4,5], businessHours: { start:'08:00',end:'18:00' }, steps: [{afterBusinessMinutes:60,instruction:'Retome com clareza.'}],closeAfterBusinessMinutes:0 };
async function setup() {
  const app = Fastify();
  let agent = { id: '00000000-0000-4000-8000-000000000101', workspaceId: 'workspace_a', type:'attendance', name:'Assistente', status:'inactive',
    providerMode:'prymeira_managed',provider:'simulated',model:'simulated',systemPrompt:'Converse com clareza.',behaviorConfig:{},handoffConfig:{},limitsConfig:{},allowedActions:['send_message'],createdAt:new Date(),updatedAt:new Date() };
  const create = vi.fn(async ({data}) => {agent={...agent,...data};return agent;});
  const update = vi.fn(async ({data}) => {agent={...agent,...data};return agent;});
  const store={aiAgent:{findFirst:vi.fn(async()=>agent),create,update},$transaction:async(callback:(tx:unknown)=>unknown)=>callback(store)};
  app.decorate('prisma',store as unknown as typeof app.prisma);
  app.addHook('onRequest',async request=>{request.talk={workspaceId:'workspace_a',role:'owner'};});
  await app.register(agentsRoutes); return {app,create,update};
}
describe('agent prospecting CRUD contracts',()=>{
  it.each([
    ['unknown time zone', { timeZone:'America/Not_A_Zone' }],
    ['reversed hours', { businessHours:{start:'18:00',end:'08:00'} }],
    ['equal hours', { businessHours:{start:'08:00',end:'08:00'} }],
    ['duplicate days', { businessDays:[1,1,2] }],
    ['more than seven days', { businessDays:[0,1,2,3,4,5,6,0] }],
    ['repeated cumulative delays', { steps:[
      {afterBusinessMinutes:60,instruction:'Primeiro'},
      {afterBusinessMinutes:60,instruction:'Segundo'}
    ] }],
    ['decreasing cumulative delays', { steps:[
      {afterBusinessMinutes:120,instruction:'Primeiro'},
      {afterBusinessMinutes:60,instruction:'Segundo'}
    ] }]
  ])('rejects %s on create and update before persistence',async(_label, invalid)=>{
    const {app,create,update}=await setup();
    try {
      const invalidFollowup={...followup,...invalid};
      const created=await app.inject({method:'POST',url:'/agents',payload:{
        name:'Prospecção',systemPrompt:'Converse com clareza.',type:'prospecting',
        prospectingGoal:'Agendar conversa',followupConfig:invalidFollowup
      }});
      expect(created.statusCode).toBe(400);
      const updated=await app.inject({method:'PATCH',url:'/agents/00000000-0000-4000-8000-000000000101',payload:{followupConfig:invalidFollowup}});
      expect(updated.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    }finally{await app.close();}
  });
  it('requires a goal and persists type, goal and followups through create/update',async()=>{
    const {app}=await setup();
    try {
      const invalid=await app.inject({method:'POST',url:'/agents',payload:{name:'Prospecção',systemPrompt:'Converse com clareza.',type:'prospecting'}});
      expect(invalid.statusCode).toBe(400);
      const created=await app.inject({method:'POST',url:'/agents',payload:{name:'Prospecção',systemPrompt:'Converse com clareza.',type:'prospecting',prospectingGoal:'Agendar conversa',followupConfig:followup}});
      expect(created.statusCode).toBe(201); expect(created.json()).toMatchObject({type:'prospecting',handoffConfig:{prospectingGoal:'Agendar conversa'},behaviorConfig:{followup}});
      const updated=await app.inject({method:'PATCH',url:'/agents/00000000-0000-4000-8000-000000000101',payload:{prospectingGoal:'Confirmar interesse',followupConfig:{...followup,steps:[]}}});
      expect(updated.statusCode).toBe(200);expect(updated.json()).toMatchObject({handoffConfig:{prospectingGoal:'Confirmar interesse'},behaviorConfig:{followup:{steps:[]}}});
      const excessive=await app.inject({method:'PATCH',url:'/agents/00000000-0000-4000-8000-000000000101',payload:{followupConfig:{...followup,steps:Array(11).fill(followup.steps[0])}}});
      expect(excessive.statusCode).toBe(400);
    } finally {await app.close();}
  });
  it('keeps older agents as attendance and prospecting followups empty by default',async()=>{
    const {app}=await setup();
    try {
      const attendance=await app.inject({method:'POST',url:'/agents',payload:{name:'Assistente',systemPrompt:'Converse com clareza.'}});
      expect(attendance.statusCode).toBe(201);expect(attendance.json().type).toBe('attendance');
      const created=await app.inject({method:'POST',url:'/agents',payload:{name:'Prospecção',systemPrompt:'Converse com clareza.',type:'prospecting',prospectingGoal:'Confirmar interesse'}});
      expect(created.statusCode).toBe(201);expect(created.json().behaviorConfig.followup.steps).toEqual([]);
    }finally{await app.close();}
  });
});
