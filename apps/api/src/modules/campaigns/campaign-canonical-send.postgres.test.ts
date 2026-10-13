import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCampaignWorker } from './campaign-worker.js';
import { createOutboundRouter } from '../channels/outbound-router.js';
import { createOutboundDispatchJournal } from '../channels/outbound-dispatch-journal.js';
import { IngressApplicationService } from '../ingress/application.js';
import { IngressJournal } from '../ingress/journal.js';
import { IngressPrivateStore } from '../ingress/private-store.js';
import { normalizeReceipt } from '../ingress/normalization.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { observeProspectingInbound } from '../prospecting/prospecting-lifecycle.js';
import type { EvolutionClient } from '../evolution/evolution.client.js';
import { createConversationsService, type PrismaLike as ConversationsPrismaLike } from '../conversations/conversations.service.js';
import { createAgentRuntime } from '../agents/agent-runtime.js';
import { repairPausedProspecting } from './paused-prospecting-repair.js';

const url = process.env.CAMPAIGN_INTEGRATION_DATABASE_URL;
const safe = url && new URL(url).hostname === '127.0.0.1' && new URL(url).pathname === '/campaign_test';
describe.skipIf(!safe).sequential('campaign identity through real canonical ingress', () => {
  let db: PrismaClient, root: string, journal: IngressJournal, ingress: IngressApplicationService;
  const workspaces: string[] = [];
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    root = await mkdtemp('/private/tmp/campaign-canonical-');
    const files = new IngressPrivateStore(root); await files.initialize();
    journal = new IngressJournal(db, files); ingress = new IngressApplicationService(journal);
  });
  afterAll(async () => {
    for (const workspaceId of workspaces) {
      await db.ingressReceipt.deleteMany({ where: { workspaceId } });
      await db.outboundIntent.deleteMany({ where: { workspaceId } });
      await db.channel.deleteMany({ where: { workspaceId } });
      await db.campaign.deleteMany({ where: { workspaceId } });
      await db.contact.deleteMany({ where: { workspaceId } });
      await db.aiAgent.deleteMany({ where: { workspaceId } });
      await db.workspaceMirror.deleteMany({ where: { workspaceId } });
    }
    await db.$disconnect(); await rm(root, { recursive: true, force: true });
  });
  async function fixture(provider: 'evolution' | 'waha' = 'evolution') {
    const workspaceId = `campaign-identity-${randomUUID()}`; workspaces.push(workspaceId);
    await db.workspaceMirror.create({ data: { workspaceId, limits: { modules: { campaignProspecting: true } } } });
    const agent = await db.aiAgent.create({ data: { workspaceId, name: 'João', type: 'prospecting', status: 'active',
      systemPrompt: 'Converse.', allowedActions: ['send_message'], handoffConfig: { prospectingGoal: 'Agendar uma conversa' } } });
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID(), status: 'connected', redundancyEnabled: true } });
    const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider,
      sessionName: channel.providerKey, status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '15550001111', lastHealthyAt: new Date() } });
    if (provider === 'waha') await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: randomUUID(), verifiedPhoneNumber: '15550001111' } });
    await db.channel.update({ where: { id: channel.id }, data: { activeConnectionId: connection.id } });
    const contact = await db.contact.create({ data: { workspaceId, phone: '4730290282', name: 'Sardanha Refrigeração' } });
    const campaign = await db.campaign.create({ data: { workspaceId, channelId: channel.id, name: 'Teste', messageBody: 'Oi, aqui é o João.', audience: {}, status: 'scheduled', prospectingAgentId: agent.id,
      cadence: { minDelaySeconds: 120, maxDelaySeconds: 300, windowStart: '00:00', windowEnd: '23:59' }, hideFromInboxUntilReply: true } });
    const recipient = await db.campaignRecipient.create({ data: { workspaceId, campaignId: campaign.id, channelId: channel.id,
      contactId: contact.id, phoneSnapshot: '554730290282', contactSnapshot: { message: 'Oi, aqui é o João.' }, status: 'pending', scheduledAt: new Date(Date.now() - 1000) } });
    await db.campaignChannelThrottle.create({ data: { workspaceId, channelId: channel.id } });
    async function receive(direction: 'inbound' | 'outbound', id: string, body: string) {
      const source = await db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId, channelId: channel.id,
        authenticatedSource: { provider, connectionId: connection.id }, mode: 'live', observedAt: new Date().toISOString() }));
      const raw = provider === 'evolution' ? { event: 'MESSAGES_UPSERT', instance: connection.sessionName,
        data: { key: { id, remoteJid: '554730290282@s.whatsapp.net', fromMe: direction === 'outbound' }, message: { conversation: body }, messageTimestamp: Math.floor(Date.now() / 1000) } }
        : { event: 'message.any', session: connection.sessionName, payload: { id: `${direction === 'outbound'}_554730290282@c.us_${id}`, from: '554730290282@c.us', to: '554730290282@c.us', fromMe: direction === 'outbound', body, timestamp: Math.floor(Date.now() / 1000) } };
      const staged = await journal.stage({ transportNamespace: 'campaign.fixture', source, authentication: 'fixture',
        raw: Buffer.from(JSON.stringify(raw)), payload: normalizeReceipt(source, raw), reauthenticate: async () => {} });
      await ingress.apply(staged.id); return staged.id;
    }
    return { workspaceId, agent, channel, connection, contact, campaign, recipient, receive };
  }
  it.each(['evolution', 'waha'] as const)('keeps early %s echo and customer reply on João’s original conversation', async provider => {
    const f = await fixture(provider), stanza = randomUUID(); const earlyReceipts: string[] = [];
    const send = vi.fn(async (command: { text: string }) => {
      const id = `${stanza}-${earlyReceipts.length + 1}`;
      const receipt = await f.receive('outbound', id, command.text); earlyReceipts.push(receipt);
      expect(await db.ingressEventProgress.findFirst({ where: { receiptId: receipt } })).toMatchObject({ state: 'held' });
      return { providerMessageId: id, raw: provider === 'evolution'
        ? { key: { id, remoteJid: '554730290282@s.whatsapp.net', fromMe: true } }
        : { id: `true_554730290282@c.us_${id}` } };
    });
    const base = { sendText: send, checkWhatsappNumbersAvailability: vi.fn(async ({ numbers }: { numbers: string[] }) => ({ numbers: numbers.map(phone => ({ phone, available: true })), raw: {} })) } as unknown as EvolutionClient;
    const router = createOutboundRouter({ base, waha: { sendText: send } as never, db, campaignPrisma: db, journal: createOutboundDispatchJournal(db) });
    await createCampaignWorker({ prisma: db, evolution: router }).processOne();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: f.recipient.id } })).toMatchObject({ status: 'sent', contactId: f.contact.id, phoneSnapshot: '554730290282' });
    expect(await db.contact.findMany({ where: { workspaceId: f.workspaceId } })).toEqual([expect.objectContaining({ id: f.contact.id, phone: '554730290282' })]);
    await ingress.recertify(earlyReceipts[0]!, 0);
    await f.receive('outbound', `${stanza}-1`, 'Oi, aqui é o João.');
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, direction: 'outbound' } })).toBe(1);
    const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    expect(conversation.aiControlStatus).toBe('agent_allowed');
    await f.receive('inbound', randomUUID(), 'Bom dia, como posso ajudar?');
    const reply = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId, direction: 'inbound' } });
    await observeProspectingInbound(db, { workspaceId: f.workspaceId, conversationId: conversation.id,
      messageId: reply.id, direction: reply.direction, type: reply.type, body: reply.body, createdAt: reply.createdAt, ingestedAt: reply.ingestedAt });
    expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    expect(await db.aiAgentSession.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ agentId: f.agent.id, conversationId: conversation.id, status: 'active' });
    const service = createConversationsService(db as unknown as ConversationsPrismaLike, { evolution: { mode: 'real', client: router,
      webhookSecret: 'fixture-only', publicWebhookUrl: () => '', localWebhookUrl: () => '' } });
    const reservation = await db.campaignProspectingReservation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    await service.createPendingOutboundMessage({ workspaceId: f.workspaceId, conversationId: conversation.id,
      body: 'Obrigado! Você cuida dos orçamentos?', sentByUserId: null,
      metadata: { source: 'ai_agent', agentId: f.agent.id, prospectingGeneration: reservation.generation } });
    await ingress.recertify(earlyReceipts[1]!, 0);
    await f.receive('outbound', `${stanza}-2`, 'Obrigado! Você cuida dos orçamentos?');
    expect(send).toHaveBeenCalledTimes(2);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, direction: 'outbound' } })).toBe(2);
    expect(await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ aiControlStatus: 'agent_allowed' });
    expect(await db.outboundIntent.count({ where: { workspaceId: f.workspaceId, state: 'bound' } })).toBe(2);
  });
  it.each([false, true])('sends separate prospecting paragraphs and stops on human takeover=%s', async humanTakeover => {
    const f = await fixture(), receipts: string[] = [];
    const send = vi.fn(async (command: { text: string }) => {
      const id = randomUUID(); receipts.push(await f.receive('outbound', id, command.text));
      if (humanTakeover && command.text === 'A IA responde clientes.') await db.conversation.updateMany({
        where: { workspaceId: f.workspaceId }, data: { aiControlStatus: 'human_controlled' }
      });
      return { providerMessageId: id, raw: { key: { id, remoteJid: '554730290282@s.whatsapp.net', fromMe: true } } };
    });
    const base = { sendText: send, checkWhatsappNumbersAvailability: vi.fn(async ({ numbers }: { numbers: string[] }) => ({ numbers: numbers.map(phone => ({ phone, available: true })), raw: {} })) } as unknown as EvolutionClient;
    const router = createOutboundRouter({ base, waha: null, db, campaignPrisma: db, journal: createOutboundDispatchJournal(db) });
    await createCampaignWorker({ prisma: db, evolution: router }).processOne();
    const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    await f.receive('inbound', randomUUID(), 'Sou eu que cuido. Como funciona?');
    const reply = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId, direction: 'inbound' } });
    await observeProspectingInbound(db, { workspaceId: f.workspaceId, conversationId: conversation.id,
      messageId: reply.id, direction: reply.direction, type: reply.type, body: reply.body, createdAt: reply.createdAt, ingestedAt: reply.ingestedAt });
    await db.aiAgent.update({ where: { id: f.agent.id }, data: { behaviorConfig: { replyInBubbles: true } } });
    const runtime = createAgentRuntime({ prisma: db as never, provider: { generate: vi.fn(async () => ({
      confidence: 1, reply: 'A IA responde clientes.\n\nAjuda a dar retorno aos orçamentos.\n\nQuer entender como funciona aí?',
      actions: [], handoff: { required: false, reason: null }
    })) }, evolution: { mode: 'real', client: router } });
    const outcome = await runtime.runForMessage({ workspaceId: f.workspaceId, agentId: f.agent.id,
      conversationId: conversation.id, messageId: reply.id, trigger: 'automation' });
    if (humanTakeover) {
      expect(outcome.status).toBe('failed');
      expect(send.mock.calls.map(([command]) => command.text)).toEqual(['Oi, aqui é o João.', 'A IA responde clientes.']);
      expect(await db.conversation.findUnique({ where: { id: conversation.id } })).toMatchObject({ aiControlStatus: 'human_controlled' });
      return;
    }
    expect(outcome.status).toBe('completed');
    expect(send.mock.calls.map(([command]) => command.text)).toEqual([
      'Oi, aqui é o João.', 'A IA responde clientes.', 'Ajuda a dar retorno aos orçamentos.', 'Quer entender como funciona aí?'
    ]);
    expect(await db.outboundIntent.count({ where: { workspaceId: f.workspaceId, originKind: 'prospecting_delivery', state: 'bound' } })).toBe(3);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, direction: 'outbound' } })).toBe(4);
    expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    expect(await db.conversation.findUnique({ where: { id: conversation.id } })).toMatchObject({ aiControlStatus: 'agent_allowed' });
  });
  it('persists incomplete acceptance and never retries the same recipient automatically', async () => {
    const f = await fixture();
    const sendText = vi.fn(async () => ({ providerMessageId: 'only-a-global-id', raw: {} }));
    const base = { sendText, checkWhatsappNumbersAvailability: async ({ numbers }: { numbers: string[] }) => ({ numbers: numbers.map(phone => ({ phone, available: true })), raw: {} }) } as unknown as EvolutionClient;
    const router = createOutboundRouter({ base, waha: null, db, campaignPrisma: db, journal: createOutboundDispatchJournal(db) });
    const worker = createCampaignWorker({ prisma: db, evolution: router });
    await worker.processOne(); await worker.processOne();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: f.recipient.id } })).toMatchObject({ status: 'uncertain' });
    expect(await db.outboundIntent.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ state: 'accepted_unbound' });
    expect(await db.outboundResult.count({ where: { workspaceId: f.workspaceId, outcome: 'accepted' } })).toBe(1);
  });
  it('does not bypass existing human control on the country-coded contact', async () => {
    const f = await fixture();
    const contact = await db.contact.create({ data: { workspaceId: f.workspaceId, phone: '554730290282' } });
    await db.conversation.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id, contactId: contact.id, aiControlStatus: 'human_controlled' } });
    const sendText = vi.fn();
    await createCampaignWorker({ prisma: db, evolution: { sendText, checkWhatsappNumbersAvailability: async ({ numbers }) => ({ numbers: numbers.map(phone => ({ phone, available: true })), raw: {} }) } }).processOne();
    expect(sendText).not.toHaveBeenCalled();
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: f.recipient.id } })).toMatchObject({ status: 'skipped_in_service' });
  });
  it.each([false, true])('repairs exact legacy copies without replaying replies; respects manual control=%s', async manual => {
    const f = await fixture(), stanza = randomUUID();
    const old = await db.conversation.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id, contactId: f.contact.id } });
    const duplicate = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: old.id, direction: 'outbound',
      type: 'text', body: 'Oi, aqui é o João.', status: 'sent', providerEventId: `campaign:${f.recipient.id}`, providerMessageId: stanza } });
    await db.campaignRecipient.update({ where: { id: f.recipient.id }, data: { status: 'sent', providerMessageId: stanza, sentAt: new Date() } });
    const reservation = await db.campaignProspectingReservation.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id,
      contactId: f.contact.id, conversationId: old.id, campaignId: f.campaign.id, recipientId: f.recipient.id, agentId: f.agent.id,
      status: 'confirmed', dispatchStartedAt: new Date(), dispatchIntentAt: new Date(), confirmedAt: new Date() } });
    const journal = createOutboundDispatchJournal(db);
    const dispatchId = await journal.begin({ workspaceId: f.workspaceId, channelId: f.channel.id, kind: 'text', destination: '554730290282' });
    await journal.accept(dispatchId, { connectionId: f.connection.id, providerMessageId: stanza });
    await f.receive('outbound', stanza, 'Oi, aqui é o João.');
    await f.receive('inbound', randomUUID(), 'Bom dia, como posso ajudar?');
    const actual = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId, id: { not: old.id } } });
    if (manual) {
      const user = await db.userProfile.create({ data: { workspaceId: f.workspaceId, clerkUserId: randomUUID(), displayName: 'Operador' } });
      await db.conversation.update({ where: { id: actual.id }, data: { aiControlUpdatedById: user.id } });
    }
    const company = 'Trevo Metais | Aços | Metais | Tubo | Corrimão';
    const pending = await db.campaignRecipient.create({ data: { workspaceId: f.workspaceId, campaignId: f.campaign.id,
      channelId: f.channel.id, status: 'pending', phoneSnapshot: '554730292666', contactSnapshot: { fields: { empresa: company }, message: `Quem cuida disso aí na ${company}?` } } });
    await db.campaign.update({ where: { id: f.campaign.id }, data: { status: 'paused' } });
    const args = { workspaceId: f.workspaceId, campaignNames: ['Teste'] };
    const dry = await repairPausedProspecting(db, args);
    expect(dry.applied).toBe(false);
    expect(await db.campaignProspectingReservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ conversationId: old.id });
    const repaired = await repairPausedProspecting(db, { ...args, apply: true });
    expect(repaired.changes).toHaveLength(manual ? 1 : 2);
    expect(repaired.skipped).toHaveLength(manual ? 1 : 0);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: f.campaign.id } })).toMatchObject({ status: 'paused' });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ contactSnapshot: { message: 'Quem cuida disso aí na Trevo Metais?' } });
    if (!manual) {
      expect(await db.campaignProspectingReservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ conversationId: actual.id, contactId: actual.contactId });
      const service = createConversationsService(db as unknown as ConversationsPrismaLike);
      expect(await service.listMessages({ workspaceId: f.workspaceId, conversationId: actual.id })).toHaveLength(2);
      expect(await db.message.findUniqueOrThrow({ where: { id: duplicate.id } })).toMatchObject({ body: 'Oi, aqui é o João.', metadata: { campaignDuplicateAudit: true } });
    }
    expect(await db.aiAgentPendingReply.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    expect((await repairPausedProspecting(db, { ...args, apply: true })).changes).toHaveLength(0);
  });
});
