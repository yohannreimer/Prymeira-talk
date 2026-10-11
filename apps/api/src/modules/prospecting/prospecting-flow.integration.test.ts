import { pauseAgentOnHumanOutbound } from "../conversations/pause-agent-on-human-outbound.js";
import { lockProspectingConversation } from "./prospecting-lock.js";
import { createCampaignControlsService } from "../campaigns/campaign-controls.service.js";
import { createAgentFollowupRuntime } from "../agents/agent-followup-runtime.js";
import { calculateFollowupDueAt, resolveFollowupPlan } from "../followups/channel-followup-plan.js";
import { replayProspectingFollowupObservations } from "./prospecting-followup-observation.js";
import { createSettingsService } from "../settings/settings.service.js";
import { dispatchProspectingOutbound } from "./prospecting-delivery.js";
import { AGENT_REPLY_LEASE_MS } from "../agents/agent-reply-claim.js";
import { createAgentsService } from "../agents/agents.service.js";
import { createAgentPackageService } from "../agents/agent-package.service.js";
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCampaignWorker } from '../campaigns/campaign-worker.js';
import { createCampaignWorkerRepository } from '../campaigns/campaign-worker.repository.js';
import { observeProspectingInbound } from './prospecting-lifecycle.js';
import { autonomousAgentAllowed, stopProspectingConversation, validateProspectingAgent } from './prospecting-policy.js';
import { updateProspectingModule } from './module-settings.js';
import { createAgentReplyScheduler } from '../agents/agent-reply-scheduler.js';
import { createConversationFollowupsService } from '../followups/conversation-followups.service.js';
import { createAgentRuntime } from '../agents/agent-runtime.js';
import { evolutionRoutes } from '../evolution/evolution.routes.js';
import { settingsRoutes } from '../settings/settings.routes.js';
import { createAssistantRepository } from '../assistant/assistant-repository.js';
import { createConversationsService, type PrismaLike as ConversationsPrismaLike } from '../conversations/conversations.service.js';
import { reserveProspectingOutbound } from './prospecting-delivery.js';

const url = process.env.CAMPAIGN_INTEGRATION_DATABASE_URL;
const safe = url ? ['localhost', '127.0.0.1'].includes(new URL(url).hostname) && new URL(url).pathname === '/campaign_test' : false;
// The worker claims globally: run integration files serially against this disposable DB.
describe.skipIf(!safe).sequential('campaign prospecting with disposable PostgreSQL', () => {
  let prisma: PrismaClient;
  let workspaceId: string, channelId: string, agentId: string, recipientId: string, campaignId: string;
  const phone = '5511987654321';
  const followup = { timeZone: 'America/Sao_Paulo', businessDays: [0,1,2,3,4,5,6], businessHours: { start: '00:00', end: '23:59' },
    steps: [{ afterBusinessMinutes: 1, instruction: 'Pergunte se deseja continuar.' }], closeAfterBusinessMinutes: 0 };
  const cadence = { minDelaySeconds: 30, maxDelaySeconds: 30, batchSize: 20, pauseMinSeconds: 0, pauseMaxSeconds: 0,
    windowStart: '00:00', windowEnd: '23:59' };
  const verify = vi.fn(async ({ numbers }: { numbers: string[] }) => ({ numbers: numbers.map(phone => ({ phone, available: true })), raw: {} }));
  beforeAll(() => { prisma = new PrismaClient({ datasources: { db: { url: url! } } }); });
  beforeEach(async () => {
    workspaceId = `prospecting-test-${randomUUID()}`;
    await prisma.workspaceMirror.create({ data: { workspaceId, limits: { unrelated: 12, agentBehavior: { replyWaitSeconds: 17 }, modules: { campaignProspecting: true } } } });
    agentId = (await prisma.aiAgent.create({ data: { workspaceId, name: 'Prospectora', type: 'prospecting', status: 'active',
      systemPrompt: 'Converse de forma clara e pergunte sobre o interesse.', handoffConfig: { prospectingGoal: 'Agendar demonstração', confidenceThreshold: 0.55 },
      behaviorConfig: { followup }, allowedActions: ['send_message', 'request_handoff'] } })).id;
    channelId = (await prisma.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: `test-${workspaceId}`, status: 'connected',
      encryptedConfig: { assistant: { mode: 'automatic', agentId } }, followupConfig: { enabled: false, timeZone: 'America/Sao_Paulo', businessDays: [1,2,3,4,5], businessHours: { start: '08:00', end: '18:00' }, steps: [{afterMinutes: 100}], humanCommercialDelivery: 'review' } } })).id;
    await prisma.campaignChannelThrottle.create({ data: { workspaceId, channelId } });
    const job = await makeJob(); campaignId = job.campaignId; recipientId = job.id;
  });
  afterEach(async () => {
    await prisma.conversation.deleteMany({ where: { workspaceId } });
    await prisma.campaign.deleteMany({ where: { workspaceId } });
    await prisma.campaignChannelThrottle.deleteMany({ where: { workspaceId } });
    await prisma.aiAgent.deleteMany({ where: { workspaceId } });
    await prisma.contact.deleteMany({ where: { workspaceId } });
    await prisma.channel.deleteMany({ where: { workspaceId } });
    await prisma.auditLog.deleteMany({ where: { workspaceId } });
    await prisma.integrationConfig.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMirror.deleteMany({ where: { workspaceId } });
  });
  afterAll(async () => { await prisma.$disconnect(); });
  async function makeJob(contactId?: string, destination = phone) {
    const campaign = await prisma.campaign.create({ data: { workspaceId, name: 'Oferta Setembro', status: 'sending', channelId,
      prospectingAgentId: agentId, prospectingContext: 'Demonstração do plano Premium', audience: {}, messageBody: 'Olá, deseja saber mais?', cadence,
      mode: 'real', startMode: 'now' } });
    return prisma.campaignRecipient.create({ data: { workspaceId, campaignId: campaign.id, channelId, contactId,
      phoneSnapshot: destination, status: 'pending', scheduledAt: new Date(Date.now() - 1000), contactSnapshot: { message: 'Olá, deseja saber mais?' } } });
  }
  async function origin() { return prisma.campaignProspectingReservation.findUniqueOrThrow({ where: { workspaceId_recipientId: { workspaceId, recipientId } } }); }
  async function inbound(conversationId: string, extra: { historical?: boolean; type?: 'text'|'system'; createdAt?: Date; direction?: 'inbound'|'outbound'; isGroup?: boolean } = {}) {
    const message = await prisma.message.create({ data: { workspaceId, conversationId, direction: extra.direction ?? 'inbound', type: extra.type ?? 'text',
      body: 'Tenho interesse', status: 'delivered', createdAt: extra.createdAt ?? new Date() } });
    const result = await observeProspectingInbound(prisma, { workspaceId, conversationId, messageId: message.id, direction: message.direction,
      type: message.type, createdAt: message.createdAt, ingestedAt: message.ingestedAt, historical: extra.historical, isGroup: extra.isGroup });
    return { message, result };
  }
  async function confirmed() {
    const sendText = vi.fn(async () => ({ providerMessageId: randomUUID(), raw: {} }));
    await createCampaignWorker({ prisma, evolution: { sendText, checkWhatsappNumbersAvailability: verify } }).processOne();
    expect(sendText).toHaveBeenCalledOnce();
    return origin();
  }
  async function webhookApp() {
    const app = Fastify(); app.decorate('prisma', prisma); app.decorate('realtime', { publish: vi.fn() } as unknown as typeof app.realtime);
    await app.register(evolutionRoutes, { webhookSecret: 'test-secret' });
    return app;
  }
  async function hook(app: Awaited<ReturnType<typeof webhookApp>>, body: string, fromMe: boolean, id = randomUUID()) {
    return app.inject({ method: 'POST', url: `/webhooks/evolution/${workspaceId}`, headers: { 'x-prymeira-talk-secret': 'test-secret' },
      payload: { event: 'messages.upsert', instance: `test-${workspaceId}`, data: { key: { id, remoteJid: `${phone}@s.whatsapp.net`, fromMe }, message: { conversation: body }, messageTimestamp: Math.floor(Date.now()/1000) } } });
  }

  it('requires confirmed dispatch and first new live response, allows assisted-channel AI, and exposes source', async () => {
    const row = await confirmed();
    expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId })).toBe(false);
    expect(await prisma.conversationFollowup.count({ where: { workspaceId } })).toBe(0);
    for (const extra of [{ historical: true }, { isGroup: true }, { type: 'system' as const }, { direction: 'outbound' as const }, { createdAt: new Date(row.dispatchIntentAt!.getTime() - 10_000) }]) {
      expect((await inbound(row.conversationId, extra)).result.activated).toBe(false);
    }
    const first = await inbound(row.conversationId, { createdAt: new Date(Math.floor(row.dispatchIntentAt!.getTime()/1000)*1000) });
    expect(first.result.activated).toBe(true);
    expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId, expectedGeneration: row.generation })).toBe(true);
    expect(await autonomousAgentAllowed(prisma, { workspaceId: 'another-workspace', conversationId: row.conversationId, agentId })).toBe(false);
    expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId, expectedGeneration: randomUUID() })).toBe(false);
    const session = await prisma.aiAgentSession.findFirstOrThrow({ where: { workspaceId } });
    expect(session.firstResponseMessageId).toBe(first.message.id);
    expect(session.sourceCampaignId).toBe(campaignId);
    expect(await createAssistantRepository(prisma).schedule({ workspaceId, conversationId: row.conversationId, trigger: 'inbound' })).toBe(false);
    const dto = await createConversationsService(prisma as unknown as ConversationsPrismaLike).getConversationDto({ workspaceId, conversationId: row.conversationId });
    expect(dto.sourceCampaign).toEqual({ id: campaignId, name: 'Oferta Setembro' });
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'paused' } });
    expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId })).toBe(true);
  });

  it('preserves response bursts arriving before acknowledgment and never replays history', async () => {
    let firstId = '', latestId = '';
    const replay = vi.fn();
    await createCampaignWorker({ prisma, evolution: { checkWhatsappNumbersAvailability: verify, sendText: async () => {
      const row = await origin(); firstId = (await inbound(row.conversationId)).message.id;
      latestId = (await inbound(row.conversationId)).message.id;
      await inbound(row.conversationId, { historical: true });
      expect(await prisma.aiAgentSession.count({ where: { workspaceId } })).toBe(0);
      return { providerMessageId: randomUUID(), raw: {} };
    } }, onProspectingReplyReady: replay }).processOne();
    const session = await prisma.aiAgentSession.findFirstOrThrow({ where: { workspaceId } });
    expect(session.firstResponseMessageId).toBe(firstId);
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({ messageId: latestId }));
    const scheduler = createAgentReplyScheduler({ prisma, agentRuntime: { runForMessage: vi.fn() }, debounceMs: 0 });
    await scheduler.scheduleActiveSessionForMessage({ workspaceId, conversationId: session.conversationId, messageId: firstId });
    expect((await prisma.aiAgentPendingReply.findFirstOrThrow({ where: { workspaceId } })).lastMessageId).toBe(latestId);
  });

  it('retains a reservation after uncertain sends and never authorizes AI or retries', async () => {
    const sendText = vi.fn(async () => { const row = await origin(); await inbound(row.conversationId); throw new Error('lost acknowledgment'); });
    const worker = createCampaignWorker({ prisma, evolution: { sendText, checkWhatsappNumbersAvailability: verify } });
    await worker.processOne(); await worker.processOne();
    expect(sendText).toHaveBeenCalledOnce();
    const row = await origin(); expect(row.status).toBe('uncertain');
    expect((await inbound(row.conversationId)).result.activated).toBe(false);
    expect(await prisma.aiAgentSession.count({ where: { workspaceId } })).toBe(0);
    expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId })).toBe(false);
  });

  it('skips a human-owned existing contact even when its saved phone has different formatting', async () => {
    const contact = await prisma.contact.create({ data: { workspaceId, phone: `+${phone}` } });
    const conversation = await prisma.conversation.create({ data: { workspaceId, channelId, contactId: contact.id, aiControlStatus: 'human_controlled' } });
    await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { contactId: contact.id } });
    const sendText = vi.fn(); await createCampaignWorker({ prisma, evolution: { sendText, checkWhatsappNumbersAvailability: verify } }).processOne();
    expect(sendText).not.toHaveBeenCalled();
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: recipientId } })).status).toBe('skipped_in_service');
    expect(await prisma.contact.count({ where: { workspaceId } })).toBe(1);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).aiControlStatus).toBe('human_controlled');
  });

  it('serializes concurrent campaign reservations for the same contact', async () => {
    const other = await makeJob(); const repository = createCampaignWorkerRepository(prisma);
    const firstToken = randomUUID(), secondToken = randomUUID();
    await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { status: 'in_flight', leaseToken: firstToken } });
    await prisma.campaignRecipient.update({ where: { id: other.id }, data: { status: 'in_flight', leaseToken: secondToken } });
    const result = await Promise.all([repository.reserveProspecting(recipientId, firstToken), repository.reserveProspecting(other.id, secondToken)]);
    expect(result.map(x=>x.status).sort()).toEqual(['in_service', 'reserved']);
    expect(await prisma.campaignProspectingReservation.count({ where: { workspaceId } })).toBe(1);
  });

  it('revalidates module/agent at send time and keeps disabled sessions stopped on re-enable', async () => {
    const row = await confirmed(); const first = await inbound(row.conversationId);
    const scheduler = createAgentReplyScheduler({ prisma, agentRuntime: { runForMessage: vi.fn() } });
    await scheduler.scheduleActiveSessionForMessage({ workspaceId, conversationId: row.conversationId, messageId: first.message.id });
    const session = await prisma.aiAgentSession.findFirstOrThrow({ where: { workspaceId } });
    await prisma.conversationFollowup.create({ data: { workspaceId, conversationId: row.conversationId, agentId, sessionId: session.id,
      kind: 'qualification', status: 'scheduled', activeKey: 'active', stepIndex: 1, anchorMessageId: first.message.id,
      anchorMessageAt: first.message.createdAt, anchorIngestedAt: first.message.ingestedAt!, scheduledAt: new Date() } });
    await prisma.aiAgent.update({ where: { id: agentId }, data: { status: 'inactive' } });
    expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId })).toBe(false);
    await prisma.aiAgent.update({ where: { id: agentId }, data: { status: 'active' } });
    await updateProspectingModule(prisma, workspaceId, false);
    expect((await prisma.aiAgentPendingReply.findFirstOrThrow({ where: { workspaceId } })).status).toBe('cancelled');
    expect((await prisma.conversationFollowup.findFirstOrThrow({ where: { workspaceId } })).status).toBe('cancelled');
    expect((await prisma.aiAgentSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('paused_by_human');
    await updateProspectingModule(prisma, workspaceId, true);
    expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId })).toBe(false);
    expect((await inbound(row.conversationId)).result.activated).toBe(false);
    expect((await prisma.workspaceMirror.findUniqueOrThrow({ where: { workspaceId } })).limits).toMatchObject({ unrelated: 12, agentBehavior: { replyWaitSeconds: 17 } });
  });

  it('lets the agent followup plan override a disabled channel plan, cancels on inbound and stops on closure', async () => {
    const row = await confirmed(); await inbound(row.conversationId);
    const service = createConversationFollowupsService(prisma);
    const outbound = await prisma.message.create({ data: { workspaceId, conversationId: row.conversationId, direction: 'outbound', type: 'text', body: 'Vamos conversar?', status: 'sent', metadata: {source:'ai_agent'} } });
    const result = await service.observeConversationActivity({ workspaceId, conversationId: row.conversationId, messageId: outbound.id, direction: 'outbound', source: 'agent' });
    expect(result.status).toBe('scheduled');
    const planned = await prisma.conversationFollowup.findFirstOrThrow({ where: { workspaceId } });
    expect(planned.scheduledAt.getTime() - outbound.createdAt.getTime()).toBeLessThan(120_000);
    const response = await inbound(row.conversationId);
    await service.observeConversationActivity({ workspaceId, conversationId: row.conversationId, messageId: response.message.id, direction: 'inbound', source: 'customer' });
    expect((await prisma.conversationFollowup.findUniqueOrThrow({ where: { id: planned.id } })).status).toBe('cancelled');
    await stopProspectingConversation(prisma, workspaceId, row.conversationId, 'conversation_closed');
    expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId })).toBe(false);
  });

  it('recognizes initial dispatch echo before ack, then binds a live response', async () => {
    const app = await webhookApp();
    try {
      const providerId = randomUUID();
      await createCampaignWorker({ prisma, evolution: { checkWhatsappNumbersAvailability: verify, sendText: async () => {
        const echo = await hook(app, 'Olá, deseja saber mais?', true, providerId); expect(echo.statusCode).toBe(200);
        const reply = await hook(app, 'Tenho interesse', false); expect(reply.statusCode).toBe(200);
        return { providerMessageId: providerId, raw: {} };
      } } }).processOne();
      const row = await origin(); expect(row.status).toBe('confirmed');
      expect(await prisma.message.count({ where: { workspaceId, providerMessageId: providerId } })).toBe(1);
      expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId })).toBe(true);
    } finally { await app.close(); }
  });

  it('reconciles a durable agent reply echo and treats a different human outbound as intervention', async () => {
    const row = await confirmed(); await inbound(row.conversationId);
    const app = await webhookApp();
    try {
      const pending = await reserveProspectingOutbound(prisma, { workspaceId, conversationId: row.conversationId, agentId, generation: row.generation, type: 'text', body: 'Podemos marcar amanhã?' });
      const providerId = randomUUID();
      await dispatchProspectingOutbound(prisma,pending,async()=>{expect((await hook(app,pending.body ?? '',true,providerId)).statusCode).toBe(200);return {providerMessageId:providerId};});
      expect(await prisma.message.count({ where: { workspaceId, providerMessageId: providerId } })).toBe(1);
      expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId })).toBe(true);
      expect((await hook(app, 'Sou o vendedor humano.', true)).statusCode).toBe(200);
      expect((await origin()).status).toBe('stopped');
      expect(await autonomousAgentAllowed(prisma, { workspaceId, conversationId: row.conversationId, agentId })).toBe(false);
    } finally { await app.close(); }
  });

  it('applies owner-only module route with preservation, realtime and handoff brief scheduling', async () => {
    const row = await confirmed(); await inbound(row.conversationId);
    const app = Fastify(); const publish = vi.fn(), schedule = vi.fn(); let role: 'owner'|'manager'|'agent' = 'manager';
    app.decorate('prisma', prisma); app.decorate('realtime', { publish } as unknown as typeof app.realtime);
    app.addHook('onRequest', async request => { request.talk = {workspaceId, role}; });
    await app.register(settingsRoutes, { handoffBriefService: { schedule } });
    try {
      expect((await app.inject({method:'PATCH',url:'/settings/modules',payload:{campaignProspecting:false}})).statusCode).toBe(403);
      role = 'owner'; const result = await app.inject({method:'PATCH',url:'/settings/modules',payload:{campaignProspecting:false}});
      expect(result.statusCode).toBe(200); expect(result.json().modules.campaignProspecting).toBe(false);
      expect(result.json().behavior.agentReplyWaitSeconds).toBe(17);
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({type:'conversation.updated',payload:expect.objectContaining({aiControlStatus:'human_controlled',sourceCampaign:{id:campaignId,name:'Oferta Setembro'}})}));
      expect(schedule).toHaveBeenCalledWith({workspaceId,conversationId:row.conversationId});
    } finally { await app.close(); }
  });

  it('passes goal/context to generation and prevents a stale reply when the agent is disabled during generation', async () => {
    const row = await confirmed(); const response = await inbound(row.conversationId);
    const generate = vi.fn(async () => {
      await prisma.aiAgent.update({ where: { id: agentId }, data: { status: 'inactive' } });
      return { confidence: 1, reply: 'Qual horário prefere?', actions: [], handoff: { required: false, reason: null } };
    });
    const sendText = vi.fn(async () => ({providerMessageId:randomUUID(),raw:{}}));
    const runtime = createAgentRuntime({ prisma: prisma as unknown as Parameters<typeof createAgentRuntime>[0]['prisma'], provider: { generate },
      evolution: { mode: 'real', client: { sendText } } as Parameters<typeof createAgentRuntime>[0]['evolution'] });
    const result = await runtime.runForMessage({ workspaceId, conversationId: row.conversationId, agentId, messageId: response.message.id, trigger: 'automation' });
    expect(result.status).toBe('skipped'); expect(sendText).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({systemPrompt:expect.stringContaining('Agendar demonstração')}));
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({systemPrompt:expect.stringContaining('Demonstração do plano Premium')}));
  });

  it('sends a reactive reply through the durable boundary with an echo before ack', async () => {
    const row = await confirmed(); const response = await inbound(row.conversationId); const app = await webhookApp();
    const providerId = randomUUID();
    const runtime = createAgentRuntime({ prisma: prisma as unknown as Parameters<typeof createAgentRuntime>[0]['prisma'],
      provider: { generate: vi.fn(async () => ({confidence:1,reply:'Qual horário prefere?',actions:[],handoff:{required:false,reason:null}})) },
      evolution: { mode:'real',client:{sendText:async () => { const echo=await hook(app,'Qual horário prefere?',true,providerId);expect(echo.statusCode).toBe(200);return {providerMessageId:providerId,raw:{}};} } } as Parameters<typeof createAgentRuntime>[0]['evolution'] });
    try {
      const result=await runtime.runForMessage({workspaceId,conversationId:row.conversationId,agentId,messageId:response.message.id,trigger:'automation'});
      expect(result.status).toBe('completed');expect(await prisma.message.count({where:{workspaceId,providerMessageId:providerId}})).toBe(1);
      expect(await autonomousAgentAllowed(prisma,{workspaceId,conversationId:row.conversationId,agentId})).toBe(true);
    }finally{await app.close();}
  });

  it('roundtrips type, goal and the per-agent plan through portable packages',async()=>{
    const packages=createAgentPackageService(prisma as unknown as Parameters<typeof createAgentPackageService>[0]);
    const exported=await packages.exportPackage({workspaceId,agentId});
    expect(exported.agent.type).toBe('prospecting');expect(exported.agent.handoff.prospectingGoal).toBe('Agendar demonstração');expect(exported.agent.followup).toEqual(followup);
    const imported=await packages.importPackage({workspaceId,package:exported,variableValues:{}});
    expect(imported.agent).toMatchObject({type:'prospecting',handoffConfig:{prospectingGoal:'Agendar demonstração'},behaviorConfig:{followup}});
    const legacy={...exported,agent:{...exported.agent,type:undefined}};
    expect((await packages.importPackage({workspaceId,package:legacy,variableValues:{}})).agent.type).toBe('attendance');
  });

  it('pauses pending campaign sends when the module is disabled during number verification',async()=>{
    const sendText=vi.fn();
    await createCampaignWorker({prisma,evolution:{sendText,checkWhatsappNumbersAvailability:async input=>{await updateProspectingModule(prisma,workspaceId,false);return verify(input);}}}).processOne();
    expect(sendText).not.toHaveBeenCalled();expect((await prisma.campaign.findUniqueOrThrow({where:{id:campaignId}})).status).toBe('paused');
    expect(await prisma.campaignProspectingReservation.count({where:{workspaceId}})).toBe(0);
  });

  it('hands off when the goal is reached even when the configured actions omit request_handoff',async()=>{
    const row=await confirmed();const response=await inbound(row.conversationId);
    await prisma.aiAgent.update({where:{id:agentId},data:{allowedActions:['send_message']}});
    const scheduler=createAgentReplyScheduler({prisma,agentRuntime:{runForMessage:vi.fn()}});
    await scheduler.scheduleActiveSessionForMessage({workspaceId,conversationId:row.conversationId,messageId:response.message.id});
    const sendText=vi.fn(), schedule=vi.fn();
    const runtime=createAgentRuntime({prisma:prisma as unknown as Parameters<typeof createAgentRuntime>[0]['prisma'],
      handoffBriefService:{schedule},
      provider:{generate:vi.fn(async()=>({confidence:1,reply:'Vou transferir para confirmar sua demonstração.',actions:[],handoff:{required:true,reason:'Cliente confirmou interesse na demonstração.'}}))},
      evolution:{mode:'real',client:{sendText}} as Parameters<typeof createAgentRuntime>[0]['evolution']});
    const result=await runtime.runForMessage({workspaceId,conversationId:row.conversationId,agentId,messageId:response.message.id,trigger:'automation'});
    expect(result.status).toBe('handoff_requested');expect(sendText).not.toHaveBeenCalled();
    const session=await prisma.aiAgentSession.findFirstOrThrow({where:{workspaceId}});
    expect(schedule).toHaveBeenCalledWith({workspaceId,conversationId:row.conversationId});
    expect(await prisma.aiAgentRun.count({where:{workspaceId,status:'handoff_requested'}})).toBe(1);
    expect(session.status).toBe('handoff_requested');expect(session.handoffReason).toContain('demonstração');
    expect((await origin()).status).toBe('stopped');
    expect((await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}})).status).toBe('cancelled');
  });

  it('explicit refusal cancels pending replies and followups at live ingestion without generating a reply',async()=>{
    const row=await confirmed();const first=await inbound(row.conversationId);
    const scheduler=createAgentReplyScheduler({prisma,agentRuntime:{runForMessage:vi.fn()}});
    await scheduler.scheduleActiveSessionForMessage({workspaceId,conversationId:row.conversationId,messageId:first.message.id});
    const outbound=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:'outbound',type:'text',body:'Qual horário prefere?',status:'sent',metadata:{source:'ai_agent'}}});
    await createConversationFollowupsService(prisma).observeConversationActivity({workspaceId,conversationId:row.conversationId,messageId:outbound.id,direction:'outbound',source:'agent'});
    const app=await webhookApp();
    try{expect((await hook(app,'Não tenho interesse. Pare de enviar mensagens.',false)).statusCode).toBe(200);}finally{await app.close();}
    expect((await origin()).status).toBe('stopped');
    expect((await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}})).status).toBe('cancelled');
    expect((await prisma.conversationFollowup.findFirstOrThrow({where:{workspaceId}})).status).toBe('cancelled');
    expect((await scheduler.scheduleActiveSessionForMessage({workspaceId,conversationId:row.conversationId,messageId:first.message.id})).scheduled).toBe(false);
  });

  it('persists reply scheduling in the confirmation commit even if the process fails before its callback',async()=>{
    let replyId='';
    const worker=createCampaignWorker({prisma,evolution:{checkWhatsappNumbersAvailability:verify,sendText:async()=>{
      const row=await origin();replyId=(await inbound(row.conversationId)).message.id;return {providerMessageId:randomUUID(),raw:{}};
    }},onProspectingReplyReady:async()=>{throw new Error('Simulated crash after commit');}});
    await expect(worker.processOne()).rejects.toThrow('Simulated crash after commit');
    const pending=await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}});
    expect(pending.status).toBe('pending');expect(pending.lastMessageId).toBe(replyId);
    const runForMessage=vi.fn(async()=>({status:'completed' as const}));
    const restarted=createAgentReplyScheduler({prisma,agentRuntime:{runForMessage}});
    await restarted.processDueReplies({now:new Date(Date.now()+60_000)});
    expect(runForMessage).toHaveBeenCalledWith(expect.objectContaining({messageId:replyId,prospectingGeneration:(await origin()).generation}));
    expect((await prisma.aiAgentPendingReply.findUniqueOrThrow({where:{id:pending.id}})).status).toBe('completed');
    await restarted.processDueReplies({now:new Date(Date.now()+120_000)});expect(runForMessage).toHaveBeenCalledOnce();
  });

  it('fences fetched jobs when agent rules change and never resurrects jobs after disabling and reactivating the agent',async()=>{
    const row=await confirmed();const response=await inbound(row.conversationId);
    const oldPending=await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}});
    const agents=createAgentsService(prisma as unknown as Parameters<typeof createAgentsService>[0]);
    await agents.updateAgent({workspaceId,agentId,data:{prospectingGoal:'Confirmar interesse atualizado'}});
    expect((await origin()).generation).not.toBe(row.generation);
    expect((await prisma.aiAgentPendingReply.findUniqueOrThrow({where:{id:oldPending.id}})).status).toBe('cancelled');
    const generate=vi.fn();const runtime=createAgentRuntime({prisma:prisma as unknown as Parameters<typeof createAgentRuntime>[0]['prisma'],provider:{generate}});
    const stale=await runtime.runForMessage({workspaceId,conversationId:row.conversationId,agentId,messageId:response.message.id,trigger:'automation',prospectingGeneration:row.generation});
    expect(stale.status).toBe('skipped');expect(generate).not.toHaveBeenCalled();
    await agents.updateAgent({workspaceId,agentId,data:{status:'inactive'}});
    await agents.updateAgent({workspaceId,agentId,data:{status:'active'}});
    expect((await origin()).status).toBe('stopped');expect(await autonomousAgentAllowed(prisma,{workspaceId,conversationId:row.conversationId,agentId})).toBe(false);
  });

  it('routes a resolved LID reply to the reserved phone conversation',async()=>{
    const row=await confirmed();const app=await webhookApp();
    try{
      const result=await app.inject({method:'POST',url:`/webhooks/evolution/${workspaceId}`,headers:{'x-prymeira-talk-secret':'test-secret'},payload:{event:'messages.upsert',instance:`test-${workspaceId}`,data:{key:{id:randomUUID(),remoteJid:'123456789@lid',remoteJidAlt:`${phone}@s.whatsapp.net`,fromMe:false},message:{conversation:'Tenho interesse'},messageTimestamp:Math.floor(Date.now()/1000)}}});
      expect(result.statusCode).toBe(200);expect(await prisma.conversation.count({where:{workspaceId}})).toBe(1);
      expect(await autonomousAgentAllowed(prisma,{workspaceId,conversationId:row.conversationId,agentId})).toBe(true);
    }finally{await app.close();}
  });

  it.each(["none", "prepared", "sending", "uncertain", "confirmed"])("recovers a crashed processing claim safely at %s delivery phase", async phase => {
    const row=await confirmed(); await inbound(row.conversationId);
    const token=randomUUID();
    const pending=await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}});
    await prisma.aiAgentPendingReply.update({where:{id:pending.id},data:{status:"processing",claimToken:token,
      lockedAt:new Date(Date.now()-AGENT_REPLY_LEASE_MS-1000),scheduledAt:new Date(Date.now()-1000)}});
    if(phase!=="none") await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"outbound",type:"text",
      body:"Resposta reservada",status:phase==="confirmed"?"sent":"pending",metadata:{source:"ai_agent",prospectingGeneration:row.generation,
        prospectingDispatch:phase,replyClaimId:pending.id,replyClaimToken:token}}});
    const runForMessage=vi.fn(async()=>({status:"completed" as const}));
    const scheduler=createAgentReplyScheduler({prisma,agentRuntime:{runForMessage}});
    await scheduler.processDueReplies();
    const recovered=await prisma.aiAgentPendingReply.findUniqueOrThrow({where:{id:pending.id}});
    expect(runForMessage).toHaveBeenCalledTimes(["none","prepared"].includes(phase)?1:0);
    expect(recovered.status).toBe(["sending","uncertain"].includes(phase)?"failed":"completed");
    await scheduler.processDueReplies();expect(runForMessage).toHaveBeenCalledTimes(["none","prepared"].includes(phase)?1:0);
  });

  it("atomically claims a fetched response across two scheduler instances",async()=>{
    const row=await confirmed();await inbound(row.conversationId);
    await prisma.aiAgentPendingReply.updateMany({where:{workspaceId},data:{scheduledAt:new Date(Date.now()-1000)}});
    let fetched=0;let release!:()=>void;const bothFetched=new Promise<void>(resolve=>{release=resolve;});
    const racing=prisma.$extends({query:{aiAgentPendingReply:{async findMany({args,query}){
      const result=await query(args);if(args.where?.status==="pending"){fetched++;if(fetched===2)release();await bothFetched;}return result;
    }}}});
    const runForMessage=vi.fn(async()=>({status:"completed" as const}));
    await Promise.all([1,2].map(()=>createAgentReplyScheduler({prisma:racing as unknown as Parameters<typeof createAgentReplyScheduler>[0]["prisma"],agentRuntime:{runForMessage}}).processDueReplies()));
    expect(runForMessage).toHaveBeenCalledOnce();expect((await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}})).attempts).toBe(1);
  });

  it.each(["cancel", "reschedule"])("does not claim a stale snapshot after %s",async change=>{
    const row=await confirmed();await inbound(row.conversationId);
    await prisma.aiAgentPendingReply.updateMany({where:{workspaceId},data:{scheduledAt:new Date(Date.now()-1000)}});
    const racing=prisma.$extends({query:{aiAgentPendingReply:{async findMany({args,query}){
      const result=await query(args);if(args.where?.status==="pending")await prisma.aiAgentPendingReply.updateMany({where:{workspaceId},data:
        change==="cancel"?{status:"cancelled"}:{scheduledAt:new Date(Date.now()+60000),instruction:"Nova instrução"}});return result;
    }}}});
    const runForMessage=vi.fn();await createAgentReplyScheduler({prisma:racing as unknown as Parameters<typeof createAgentReplyScheduler>[0]["prisma"],agentRuntime:{runForMessage}}).processDueReplies();
    expect(runForMessage).not.toHaveBeenCalled();expect((await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}})).status).toBe(change==="cancel"?"cancelled":"pending");
  });

  it("fences a running generation when its queue ownership is replaced before dispatch",async()=>{
    const row=await confirmed();await inbound(row.conversationId);
    await prisma.aiAgentPendingReply.updateMany({where:{workspaceId},data:{scheduledAt:new Date(Date.now()-1000)}});
    const sendText=vi.fn();const runtime=createAgentRuntime({prisma:prisma as unknown as Parameters<typeof createAgentRuntime>[0]["prisma"],provider:{generate:vi.fn(async()=>{
      await prisma.aiAgentPendingReply.updateMany({where:{workspaceId},data:{status:"pending",claimToken:null,scheduledAt:new Date(Date.now()+60000)}});
      return {confidence:1,reply:"Resposta antiga",actions:[],handoff:{required:false,reason:null}};
    })},evolution:{mode:"real",client:{sendText}} as Parameters<typeof createAgentRuntime>[0]["evolution"]});
    await createAgentReplyScheduler({prisma,agentRuntime:runtime}).processDueReplies();expect(sendText).not.toHaveBeenCalled();
    expect((await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}})).status).toBe("pending");
  });

  it("cannot dispatch a prepared outbound after crash recovery replaces its claim",async()=>{
    const row=await confirmed();await inbound(row.conversationId);const token=randomUUID();
    const pending=await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}});
    await prisma.aiAgentPendingReply.update({where:{id:pending.id},data:{status:"processing",claimToken:token,lockedAt:new Date(Date.now()-AGENT_REPLY_LEASE_MS-1000)}});
    const outbound=await reserveProspectingOutbound(prisma,{workspaceId,conversationId:row.conversationId,agentId,generation:row.generation,type:"text",body:"Antiga",
      metadata:{replyClaimId:pending.id,replyClaimToken:token}});
    await createAgentReplyScheduler({prisma,agentRuntime:{runForMessage:vi.fn(async()=>({status:"completed" as const}))}}).processDueReplies();
    const send=vi.fn();await expect(dispatchProspectingOutbound(prisma,outbound,send)).rejects.toThrow("queue ownership");expect(send).not.toHaveBeenCalled();
    expect((await prisma.message.findUniqueOrThrow({where:{id:outbound.id}})).metadata).toMatchObject({prospectingDispatch:"cancelled"});
  });

  it("serializes behavior settings with module disable without restoring the old enabled flag",async()=>{
    let read!:()=>void, resume!:()=>void;const hasRead=new Promise<void>(resolve=>{read=resolve;});const gate=new Promise<void>(resolve=>{resume=resolve;});
    const paused=prisma.$extends({query:{workspaceMirror:{async findUnique({args,query}){const result=await query(args);if(args.where.workspaceId===workspaceId){read();await gate;}return result;}}}});
    const behavior=createSettingsService(paused as unknown as Parameters<typeof createSettingsService>[0]).updateAgentBehavior({workspaceId,agentReplyWaitSeconds:29});
    await hasRead;let disabled=false;const disable=updateProspectingModule(prisma,workspaceId,false).then(()=>{disabled=true;});
    await new Promise(resolve=>setTimeout(resolve,30));expect(disabled).toBe(false);resume();await Promise.all([behavior,disable]);
    const limits=(await prisma.workspaceMirror.findUniqueOrThrow({where:{workspaceId}})).limits;
    expect(limits).toMatchObject({unrelated:12,modules:{campaignProspecting:false},agentBehavior:{replyWaitSeconds:29}});
  });

  it.each([false,true])("stops a live audio refusal in a burst before the later text anchor (cached=%s)",async cached=>{
    let audioId="",textId="";
    await prisma.integrationConfig.create({data:{workspaceId,provider:"openai_compatible",mode:"real",status:"configured",settings:{baseUrl:"https://provider.example/v1",apiKey:"test",chatModel:"test"}}});
    const transcribe=vi.fn(async()=>({text:"Não tenho interesse. Pare de enviar mensagens.",playback:null}));const generate=vi.fn();
    const runtime=createAgentRuntime({prisma:prisma as unknown as Parameters<typeof createAgentRuntime>[0]["prisma"],provider:{generate},
      mediaResolver:vi.fn(async()=>({bytes:Buffer.from("audio"),mimeType:"audio/ogg",source:"data_url" as const})),audioTranscriberFactory:()=>({transcribe})});
    await createCampaignWorker({prisma,evolution:{checkWhatsappNumbersAvailability:verify,sendText:async()=>{
      const row=await origin();const audio=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"inbound",type:"audio",status:"delivered",
        body:cached?"Não tenho interesse. Pare de enviar mensagens.":"Áudio recebido",mediaUrl:"data:audio/ogg;base64,YXVkaW8="}});audioId=audio.id;
      await observeProspectingInbound(prisma,{workspaceId,conversationId:row.conversationId,messageId:audio.id,direction:"inbound",type:"audio",createdAt:audio.createdAt,ingestedAt:audio.ingestedAt});
      textId=(await inbound(row.conversationId)).message.id;
      // Transcription is allowed while initial delivery is still unconfirmed.
      expect((await runtime.prepareAudioMessage({workspaceId,messageId:audio.id})).status).toBe("completed");
      return {providerMessageId:randomUUID(),raw:{}};
    }}}).processOne();
    const row=await origin();expect(row.status).toBe("stopped");expect(transcribe).toHaveBeenCalledTimes(cached?0:1);
    const result=await runtime.runForMessage({workspaceId,conversationId:row.conversationId,agentId,messageId:textId,trigger:"automation"});
    expect(result.status).toBe("skipped");expect(generate).not.toHaveBeenCalled();expect(audioId).not.toBe("");
  });

  it("checks earlier live audio at runtime and excludes imported audio from refusal control",async()=>{
    const row=await confirmed();const first=await inbound(row.conversationId);
    const historical=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"inbound",type:"audio",body:"Não tenho interesse",status:"delivered",metadata:{historyImport:true}}});
    const generate=vi.fn();const runtime=createAgentRuntime({prisma:prisma as unknown as Parameters<typeof createAgentRuntime>[0]["prisma"],provider:{generate}});
    expect((await runtime.prepareAudioMessage({workspaceId,messageId:historical.id})).status).toBe("skipped");expect((await origin()).status).toBe("confirmed");
    const audio=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"inbound",type:"audio",body:"Não tenho interesse",status:"delivered"}});
    await observeProspectingInbound(prisma,{workspaceId,conversationId:row.conversationId,messageId:audio.id,direction:"inbound",type:"audio",createdAt:audio.createdAt,ingestedAt:audio.ingestedAt});
    const latest=await inbound(row.conversationId);
    const outbound=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"outbound",type:"text",body:"Qual horário?",status:"sent",metadata:{source:"ai_agent"}}});
    await createConversationFollowupsService(prisma).observeConversationActivity({workspaceId,conversationId:row.conversationId,messageId:outbound.id,direction:"outbound",source:"agent"});
    const result=await runtime.runForMessage({workspaceId,conversationId:row.conversationId,agentId,messageId:latest.message.id,trigger:"automation"});
    expect(result.status).toBe("skipped");expect(generate).not.toHaveBeenCalled();expect((await origin()).status).toBe("stopped");
    expect((await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}})).status).toBe("cancelled");
    expect((await prisma.conversationFollowup.findFirstOrThrow({where:{workspaceId}})).status).toBe("cancelled");
  });

  it("deliberate reset releases confirmed ended bindings and initializes fresh same-agent provenance",async()=>{
    const old=await confirmed();await inbound(old.conversationId);const oldSession=await prisma.aiAgentSession.findFirstOrThrow({where:{workspaceId}});
    await stopProspectingConversation(prisma,workspaceId,old.conversationId,"human handoff");
    const service=createConversationsService(prisma as unknown as ConversationsPrismaLike);await service.resetConversation({workspaceId,conversationId:old.conversationId,actorUserId:null});
    expect(await prisma.campaignProspectingReservation.count({where:{workspaceId}})).toBe(0);
    expect(await prisma.auditLog.findFirst({where:{workspaceId,action:"prospecting.binding_released"}})).not.toBeNull();
    // An ended legacy session retained by a release path must be initialized too.
    await prisma.aiAgentSession.create({data:{workspaceId,agentId,conversationId:old.conversationId,status:"closed",sourceCampaignId:old.campaignId,
      sourceRecipientId:old.recipientId,prospectingGeneration:old.generation,messageCount:77,handoffReason:"Old reason"}});
    await prisma.campaignChannelThrottle.update({where:{workspaceId_channelId:{workspaceId,channelId}},data:{nextAvailableAt:null}});
    const job=await makeJob();campaignId=job.campaignId;recipientId=job.id;const fresh=await confirmed();const response=await inbound(fresh.conversationId);
    const session=await prisma.aiAgentSession.findFirstOrThrow({where:{workspaceId}});
    expect(session).toMatchObject({status:"active",sourceCampaignId:campaignId,sourceRecipientId:recipientId,prospectingGeneration:fresh.generation,
      firstResponseMessageId:response.message.id,messageCount:0,handoffReason:null});expect(fresh.generation).not.toBe(old.generation);
    expect(await prisma.auditLog.findFirst({where:{workspaceId,action:"prospecting.session_rebound"}})).not.toBeNull();
  });

  it("deliberate reset never releases an uncertain campaign send into an automatic retry",async()=>{
    await createCampaignWorker({prisma,evolution:{checkWhatsappNumbersAvailability:verify,sendText:async()=>{throw new Error("lost ack");}}}).processOne();
    const old=await origin();expect(old.status).toBe("uncertain");
    await createConversationsService(prisma as unknown as ConversationsPrismaLike).resetConversation({workspaceId,conversationId:old.conversationId,actorUserId:null});
    expect(await prisma.campaignProspectingReservation.count({where:{workspaceId}})).toBe(1);
    const job=await makeJob();const sendText=vi.fn();await createCampaignWorker({prisma,evolution:{checkWhatsappNumbersAvailability:verify,sendText}}).processOne();
    expect(sendText).not.toHaveBeenCalled();expect((await prisma.campaignRecipient.findUniqueOrThrow({where:{id:job.id}})).status).toBe("pending");
    const leaseToken=randomUUID();await prisma.campaignRecipient.update({where:{id:job.id},data:{status:"in_flight",leaseToken}});
    expect((await createCampaignWorkerRepository(prisma).reserveProspecting(job.id,leaseToken)).status).toBe("in_service");
  });

  it("sends an automatic prospecting followup through the conversation service while its echo precedes the HTTP acknowledgement",async()=>{
    const row=await confirmed();await inbound(row.conversationId);
    const lifecycle=createConversationFollowupsService(prisma);
    const initial=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"outbound",type:"text",body:"Qual horário prefere?",status:"sent",metadata:{source:"ai_agent"}}});
    await lifecycle.observeConversationActivity({workspaceId,conversationId:row.conversationId,messageId:initial.id,direction:"outbound",source:"agent"});
    const planned=await prisma.conversationFollowup.findFirstOrThrow({where:{workspaceId}});
    await prisma.conversationFollowup.update({where:{id:planned.id},data:{scheduledAt:new Date(Date.now()-1000)}});
    const app=await webhookApp(), providerId=randomUUID();
    const sendText=vi.fn(async()=>{
      const pending=await prisma.message.findFirstOrThrow({where:{workspaceId,direction:"outbound",status:"pending"}});
      expect(pending.metadata).toMatchObject({source:"ai_agent",followupId:planned.id,prospectingDispatch:"sending"});
      expect((await hook(app,pending.body ?? "",true,providerId)).statusCode).toBe(200);
      return {providerMessageId:providerId,raw:{}};
    });
    const outbound=createConversationsService(prisma as unknown as ConversationsPrismaLike,{evolution:{mode:"real",client:{sendText}} as unknown as NonNullable<Parameters<typeof createConversationsService>[1]>["evolution"]});
    const runtime=createAgentFollowupRuntime({prisma:prisma as unknown as Parameters<typeof createAgentFollowupRuntime>[0]["prisma"],followups:lifecycle,outbound,
      provider:{generate:vi.fn(async()=>({confidence:1,reply:"Ainda deseja agendar uma demonstração?",actions:[],handoff:{required:false,reason:null}}))},
      jevFollowupDecision:{decide:vi.fn(async()=>({outcome:"follow_up",purpose:"confirm_active",route:"automatic_send",stage:"qualification",risk:"none"} as const))}});
    try{
      expect((await runtime.runFollowup({workspaceId,followupId:planned.id})).status).toBe("sent");
      expect(sendText).toHaveBeenCalledOnce();expect(await prisma.message.count({where:{workspaceId,providerMessageId:providerId}})).toBe(1);
      const message=await prisma.message.findFirstOrThrow({where:{workspaceId,providerMessageId:providerId}});
      expect(message.metadata).toMatchObject({prospectingDispatch:"confirmed",followupId:planned.id});
      expect((await origin()).status).toBe("confirmed");expect(await autonomousAgentAllowed(prisma,{workspaceId,conversationId:row.conversationId,agentId})).toBe(true);
      expect((await prisma.conversationFollowup.findUniqueOrThrow({where:{id:planned.id}})).status).toBe("sent");
      expect(await prisma.conversationFollowup.count({where:{workspaceId,activeKey:"active"}})).toBe(0);
    }finally{await app.close();}
  });

  it("adopts an explicitly reserved automatic followup into the same dispatch/echo boundary",async()=>{
    const row=await confirmed();await inbound(row.conversationId);const app=await webhookApp(), providerId=randomUUID(), followupId=randomUUID();
    const reserved=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"outbound",type:"text",body:"Rascunho reservado anterior",status:"pending"}});
    const sendText=vi.fn(async()=>{expect((await hook(app,"Seguimos?",true,providerId)).statusCode).toBe(200);return {providerMessageId:providerId,raw:{}};});
    const service=createConversationsService(prisma as unknown as ConversationsPrismaLike,{evolution:{mode:"real",client:{sendText}} as unknown as NonNullable<Parameters<typeof createConversationsService>[1]>["evolution"]});
    try{
      const delivery=await service.createPendingOutboundMessage({workspaceId,conversationId:row.conversationId,body:"Seguimos?",sentByUserId:null,reservedMessageId:reserved.id,
        metadata:{source:"ai_agent",agentId,prospectingGeneration:row.generation,followupId}});
      expect(delivery.message).toMatchObject({id:reserved.id,status:"sent"});expect(await prisma.message.count({where:{workspaceId,providerMessageId:providerId}})).toBe(1);
      expect((await origin()).status).toBe("confirmed");
    }finally{await app.close();}
  });

  async function crashedConfirmedReply() {
    const row=await confirmed();await inbound(row.conversationId);
    const pending=await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}}), token=randomUUID();
    await prisma.aiAgentPendingReply.update({where:{id:pending.id},data:{status:"processing",claimToken:token,lockedAt:new Date()}});
    const reserved=await reserveProspectingOutbound(prisma,{workspaceId,conversationId:row.conversationId,agentId,generation:row.generation,type:"text",body:"Qual horário prefere?",
      metadata:{replyClaimId:pending.id,replyClaimToken:token}});
    const send=vi.fn(async()=>({providerMessageId:randomUUID()}));const delivered=await dispatchProspectingOutbound(prisma,reserved,send);
    return {row,pending,delivered,send};
  }

  it("recovers followup observation after confirmed reactive delivery without regenerating/resending or shifting the original due time",async()=>{
    const {row,pending,delivered,send}=await crashedConfirmedReply();const lifecycle=createConversationFollowupsService(prisma);
    expect(await prisma.conversationFollowup.count({where:{workspaceId}})).toBe(0);
    const runForMessage=vi.fn();const scheduler=createAgentReplyScheduler({prisma,agentRuntime:{runForMessage},followupService:lifecycle});
    await scheduler.processDueReplies({now:new Date(Date.now()+AGENT_REPLY_LEASE_MS+1000)});
    expect((await prisma.aiAgentPendingReply.findUniqueOrThrow({where:{id:pending.id}})).status).toBe("completed");
    const followupRow=await prisma.conversationFollowup.findFirstOrThrow({where:{workspaceId}});
    const plan=resolveFollowupPlan({followup},null,true)!;
    expect(followupRow).toMatchObject({status:"scheduled",stepIndex:1,anchorMessageId:delivered.id});
    expect(followupRow.scheduledAt).toEqual(calculateFollowupDueAt(delivered.createdAt,plan.steps[0]!.afterMinutes,plan));
    expect((await prisma.message.findUniqueOrThrow({where:{id:delivered.id}})).metadata).toMatchObject({prospectingFollowupObservation:"observed"});
    await scheduler.processDueReplies({now:new Date(Date.now()+AGENT_REPLY_LEASE_MS*2)});
    expect(await prisma.conversationFollowup.count({where:{workspaceId}})).toBe(1);expect(runForMessage).not.toHaveBeenCalled();expect(send).toHaveBeenCalledOnce();
  });

  it.each([false,true])("does not reset a progressed or exhausted sequence if observation already committed before the crash (exhausted=%s)",async exhausted=>{
    const {row,pending,delivered}=await crashedConfirmedReply();
    const twoSteps={...followup,steps:[...followup.steps,{afterBusinessMinutes:2,instruction:"Uma última tentativa breve."}]};
    await prisma.aiAgent.update({where:{id:agentId},data:{behaviorConfig:{followup:twoSteps}}});
    const lifecycle=createConversationFollowupsService(prisma);await lifecycle.observeConversationActivity({workspaceId,conversationId:row.conversationId,messageId:delivered.id,direction:"outbound",source:"agent"});
    async function advance() {
      const active=await prisma.conversationFollowup.findFirstOrThrow({where:{workspaceId,activeKey:"active"}});
      await prisma.conversationFollowup.update({where:{id:active.id},data:{scheduledAt:new Date(Date.now()-1000)}});
      const claim=await lifecycle.claimScheduledFollowup({workspaceId,followupId:active.id});expect(claim.status).toBe("claimed");if(claim.status!=="claimed")throw new Error("missing claim");
      const current=await prisma.conversationFollowup.findUniqueOrThrow({where:{id:active.id}});
      const message=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"outbound",type:"text",body:"Followup enviado",status:"sent",metadata:{source:"ai_agent",followupId:active.id}}});
      await lifecycle.completeAutomaticFollowup({workspaceId,followupId:active.id,followup:current,claim,agentBehaviorConfig:{followup:twoSteps},finalBody:message.body!,decision:{},sentMessageId:message.id,sentMessageAt:message.createdAt});
    }
    await advance();if(exhausted)await advance();const before=await prisma.conversationFollowup.findMany({where:{workspaceId},orderBy:{stepIndex:"asc"}});
    const runForMessage=vi.fn();await createAgentReplyScheduler({prisma,agentRuntime:{runForMessage},followupService:lifecycle}).processDueReplies({now:new Date(Date.now()+AGENT_REPLY_LEASE_MS+1000)});
    expect(await prisma.conversationFollowup.findMany({where:{workspaceId},orderBy:{stepIndex:"asc"}})).toEqual(before);
    expect(runForMessage).not.toHaveBeenCalled();expect((await prisma.aiAgentPendingReply.findUniqueOrThrow({where:{id:pending.id}})).status).toBe("completed");
  });

  it.each(["inbound","human","module"])("followup observation replay cannot restore work cancelled by %s",async change=>{
    const {row,delivered}=await crashedConfirmedReply();const lifecycle=createConversationFollowupsService(prisma);
    await lifecycle.observeConversationActivity({workspaceId,conversationId:row.conversationId,messageId:delivered.id,direction:"outbound",source:"agent"});
    if(change==="inbound") { const reply=await inbound(row.conversationId);await lifecycle.observeConversationActivity({workspaceId,conversationId:row.conversationId,messageId:reply.message.id,direction:"inbound",source:"customer"}); }
    else if(change==="human") await stopProspectingConversation(prisma,workspaceId,row.conversationId,"human_intervention");
    else await updateProspectingModule(prisma,workspaceId,false);
    const before=await prisma.conversationFollowup.findMany({where:{workspaceId}});expect(before[0]!.status).toBe("cancelled");
    await replayProspectingFollowupObservations(prisma,lifecycle,20);
    expect(await prisma.conversationFollowup.findMany({where:{workspaceId}})).toEqual(before);
    expect((await prisma.message.findUniqueOrThrow({where:{id:delivered.id}})).metadata).toMatchObject({prospectingFollowupObservation:"observed"});
  });

  it("reconciles a delayed automatic echo after agent rules rotate the generation, while distinct human outbound still stops it",async()=>{
    const row=await confirmed();await inbound(row.conversationId);const app=await webhookApp(), providerId=randomUUID();
    const pending=await reserveProspectingOutbound(prisma,{workspaceId,conversationId:row.conversationId,agentId,generation:row.generation,type:"text",body:"Resposta iniciada antes da nova regra"});
    let entered!:()=>void, finish!:()=>void;const sending=new Promise<void>(resolve=>{entered=resolve;}), gate=new Promise<void>(resolve=>{finish=resolve;});
    const dispatch=dispatchProspectingOutbound(prisma,pending,async()=>{entered();await gate;return {providerMessageId:providerId};});
    try{
      await sending;await createAgentsService(prisma as unknown as Parameters<typeof createAgentsService>[0]).updateAgent({workspaceId,agentId,data:{prospectingGoal:"Confirmar interesse e transferir"}});
      const fresh=await origin();expect(fresh.generation).not.toBe(row.generation);
      expect((await hook(app,pending.body ?? "",true,providerId)).statusCode).toBe(200);
      expect(await prisma.message.count({where:{workspaceId,providerMessageId:providerId}})).toBe(1);
      expect((await origin()).status).toBe("confirmed");expect(await autonomousAgentAllowed(prisma,{workspaceId,conversationId:row.conversationId,agentId,expectedGeneration:fresh.generation})).toBe(true);
      finish();await dispatch;expect(await prisma.message.count({where:{workspaceId,providerMessageId:providerId}})).toBe(1);
      expect((await hook(app,"Agora fala o vendedor humano",true)).statusCode).toBe(200);expect((await origin()).status).toBe("stopped");
    }finally{finish();await dispatch.catch(()=>undefined);await app.close();}
  });

  it("serializes human intervention and prospecting stop on the same conversation lock without PostgreSQL deadlock",async()=>{
    const row=await confirmed();const first=await inbound(row.conversationId);
    const outbound=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"outbound",type:"text",body:"Qual horário?",status:"sent",metadata:{source:"ai_agent"}}});
    await createConversationFollowupsService(prisma).observeConversationActivity({workspaceId,conversationId:row.conversationId,messageId:outbound.id,direction:"outbound",source:"agent"});
    let held!:()=>void, proceed!:()=>void;const locked=new Promise<void>(resolve=>{held=resolve;}), gate=new Promise<void>(resolve=>{proceed=resolve;});
    const human=prisma.$transaction(async tx=>{await lockProspectingConversation(tx,workspaceId,row.conversationId);held();await gate;await pauseAgentOnHumanOutbound(tx,{workspaceId,conversationId:row.conversationId});});
    await locked;const stop=stopProspectingConversation(prisma,workspaceId,row.conversationId,"concurrent_stop");
    await new Promise(resolve=>setTimeout(resolve,25));proceed();await expect(Promise.all([human,stop])).resolves.toBeDefined();
    expect((await origin()).status).toBe("stopped");expect((await prisma.conversation.findUniqueOrThrow({where:{id:row.conversationId}})).aiControlStatus).toBe("human_controlled");
    expect((await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}})).status).toBe("cancelled");
    expect((await prisma.conversationFollowup.findFirstOrThrow({where:{workspaceId}})).status).toBe("cancelled");
  });

  it("module disable wins against an activation already holding the conversation lock without a deadlock",async()=>{
    const row=await confirmed();const message=await prisma.message.create({data:{workspaceId,conversationId:row.conversationId,direction:"inbound",type:"text",body:"Tenho interesse",status:"delivered"}});
    let held!:()=>void, proceed!:()=>void;const locked=new Promise<void>(resolve=>{held=resolve;}), gate=new Promise<void>(resolve=>{proceed=resolve;});
    const activation=prisma.$transaction(async tx=>{await lockProspectingConversation(tx,workspaceId,row.conversationId);held();await gate;
      await observeProspectingInbound(tx,{workspaceId,conversationId:row.conversationId,messageId:message.id,direction:"inbound",type:"text",body:message.body,createdAt:message.createdAt,ingestedAt:message.ingestedAt});});
    await locked;const disable=updateProspectingModule(prisma,workspaceId,false);await new Promise(resolve=>setTimeout(resolve,25));proceed();
    await expect(Promise.all([activation,disable])).resolves.toBeDefined();
    expect((await origin()).status).toBe("stopped");expect((await prisma.conversation.findUniqueOrThrow({where:{id:row.conversationId}})).aiControlStatus).toBe("human_controlled");
    expect((await prisma.aiAgentSession.findFirstOrThrow({where:{workspaceId}})).status).toBe("paused_by_human");
    expect((await prisma.aiAgentPendingReply.findFirstOrThrow({where:{workspaceId}})).status).toBe("cancelled");
  });

  it("only authorizes newly ingested replies after persisted dispatch intent, never a support message in the prepared gap",async()=>{
    const repository=createCampaignWorkerRepository(prisma);const job=await repository.claimDue();expect(job?.id).toBe(recipientId);const token=job!.leaseToken!;
    expect((await repository.reserveProspecting(recipientId,token)).status).toBe("reserved");const prepared=await origin();expect(prepared.status).toBe("prepared");expect(prepared.dispatchIntentAt).toBeNull();
    const gap=await inbound(prepared.conversationId);expect(gap.result.liveEligible).toBe(false);expect((await origin()).pendingInboundMessageId).toBeNull();
    await new Promise(resolve=>setTimeout(resolve,5));expect(await repository.markVerified(recipientId,token)).toBe(true);
    expect((await origin()).dispatchIntentAt).not.toBeNull();
    const repeated=await observeProspectingInbound(prisma,{workspaceId,conversationId:prepared.conversationId,messageId:gap.message.id,direction:"inbound",type:"text",body:gap.message.body,createdAt:gap.message.createdAt,ingestedAt:gap.message.ingestedAt});
    expect(repeated.liveEligible).toBe(false);
    await repository.settle({id:recipientId,leaseToken:token,status:"sent",providerMessageId:randomUUID(),contactId:prepared.contactId,message:"Olá, deseja saber mais?"});
    expect(await prisma.aiAgentSession.count({where:{workspaceId}})).toBe(0);expect(await autonomousAgentAllowed(prisma,{workspaceId,conversationId:prepared.conversationId,agentId})).toBe(false);
    const actual=await inbound(prepared.conversationId);expect(actual.result.liveEligible).toBe(true);
    const session=await prisma.aiAgentSession.findFirstOrThrow({where:{workspaceId}});expect(session.firstResponseMessageId).toBe(actual.message.id);
    expect(await autonomousAgentAllowed(prisma,{workspaceId,conversationId:prepared.conversationId,agentId})).toBe(true);
  });

  it.each(["pause","cancel"])("releases a definitively prepared reservation on campaign %s and never strands or sends it before resume",async action=>{
    const repository=createCampaignWorkerRepository(prisma);const job=await repository.claimDue();const token=job!.leaseToken!;
    const first=await repository.reserveProspecting(recipientId,token);expect(first.status).toBe("reserved");
    expect(await repository.reserveProspecting(recipientId,token)).toEqual(first);
    const controls=createCampaignControlsService(prisma);if(action==="pause")await controls.pause(workspaceId,campaignId);else await controls.cancelRemaining(workspaceId,campaignId);
    expect(await repository.markVerified(recipientId,token)).toBe(false);expect(await repository.returnPending({id:recipientId,leaseToken:token})).toBe(true);
    expect(await prisma.campaignProspectingReservation.count({where:{workspaceId}})).toBe(0);
    expect((await prisma.campaignRecipient.findUniqueOrThrow({where:{id:recipientId}})).status).toBe(action==="pause"?"pending":"canceled");
    const sendText=vi.fn(async()=>({providerMessageId:randomUUID(),raw:{}}));const worker=createCampaignWorker({prisma,evolution:{checkWhatsappNumbersAvailability:verify,sendText}});
    await worker.processOne();expect(sendText).not.toHaveBeenCalled();
    if(action==="pause"){await controls.resume(workspaceId,campaignId);await worker.processOne();expect(sendText).toHaveBeenCalledOnce();expect((await origin()).status).toBe("confirmed");}
  });

  it.each(["prepared","sending"])("restart recovers only a provably pre-network %s reservation",async phase=>{
    const repository=createCampaignWorkerRepository(prisma);const job=await repository.claimDue();const token=job!.leaseToken!;
    await repository.reserveProspecting(recipientId,token);if(phase==="sending")expect(await repository.markVerified(recipientId,token)).toBe(true);
    const future=new Date(Date.now()+100_000);const recovery=createCampaignWorkerRepository(prisma,{now:()=>future});await recovery.markExpiredUncertain();
    const recipient=await prisma.campaignRecipient.findUniqueOrThrow({where:{id:recipientId}});expect(recipient.status).toBe(phase==="prepared"?"pending":"uncertain");
    const sendText=vi.fn(async()=>({providerMessageId:randomUUID(),raw:{}}));await createCampaignWorker({prisma,now:()=>future,evolution:{checkWhatsappNumbersAvailability:verify,sendText}}).processOne();
    expect(sendText).toHaveBeenCalledTimes(phase==="prepared"?1:0);
    if(phase==="sending")expect((await origin()).status).toBe("uncertain");
  });

  it('rejects Meta, foreign and inactive agents for prospecting bindings', async () => {
    await expect(validateProspectingAgent(prisma, 'foreign-workspace', agentId)).rejects.toThrow('PROSPECTING_UNAVAILABLE');
    await prisma.channel.update({where:{id:channelId},data:{provider:'meta_cloud'}});
    await expect(validateProspectingAgent(prisma, workspaceId, agentId, channelId)).rejects.toThrow('PROSPECTING_UNAVAILABLE');
    await prisma.channel.update({where:{id:channelId},data:{provider:'evolution'}});
    await prisma.aiAgent.update({where:{id:agentId},data:{status:'inactive'}});
    await expect(validateProspectingAgent(prisma, workspaceId, agentId, channelId)).rejects.toThrow('PROSPECTING_UNAVAILABLE');
  });
});
