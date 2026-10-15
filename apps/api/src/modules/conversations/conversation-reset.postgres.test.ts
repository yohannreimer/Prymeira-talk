import { selectConversationPreviewInTransaction, refreshOwnedConversationPreviewInTransaction } from '../messaging/conversation-preview.js';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { PrismaClient, type Prisma } from '@prisma/client';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createConversationsService, type PrismaLike, withLastMessages } from './conversations.service.js';
import { conversationsRoutes } from './conversations.routes.js';
import { createOutboundIntents, type OutboundRequest } from '../messaging/outbound-intents.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';

const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('permanent conversation reset with real PostgreSQL ledger constraints', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  const outbound = createOutboundIntents();
  beforeAll(() => {
    const target = new URL(url!);
    if (target.hostname !== '127.0.0.1' || target.pathname !== '/messaging_test') throw Error('Owned local messaging_test required');
    db = new PrismaClient({ datasources: { db: { url } } });
  });
  afterAll(async () => {
    for (const workspaceId of workspaces) {
      // Receipt-parent and intent-parent cascades preserve the production immutable triggers.
      await db.ingressReceipt.deleteMany({ where: { workspaceId } });
      await db.outboundCorrelation.deleteMany({ where: { workspaceId } });
      await db.outboundIntent.deleteMany({ where: { workspaceId } });
      await db.channel.deleteMany({ where: { workspaceId } });
      await db.contact.deleteMany({ where: { workspaceId } });
      await db.aiAgent.deleteMany({ where: { workspaceId } });
      await db.campaign.deleteMany({ where: { workspaceId } });
      await db.auditLog.deleteMany({ where: { workspaceId } });
      await db.tag.deleteMany({ where: { workspaceId } });
      await db.userProfile.deleteMany({ where: { workspaceId } });
    }
    await db.$disconnect();
  });
  async function fixture() {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: randomUUID() } });
    const user = await db.userProfile.create({ data: { workspaceId, clerkUserId: randomUUID(), displayName: 'Fixture' } });
    const contact = await db.contact.create({ data: { workspaceId, phone: '15550001111' } });
    const retiredContact = await db.contact.create({ data: { workspaceId, phone: '15550002222' } });
    const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id,
      status: 'pending', unreadCount: 4, hiddenUntilReply: true, lastMessageAt: new Date(), lastMessagePreviewAt: new Date(), lastMessagePreview: 'old', waitingDismissedAt: new Date() } });
    const retired = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: retiredContact.id,
      retiredIntoConversationId: conversation.id, status: 'closed', aiControlStatus: 'human_controlled', hiddenUntilReply: true } });
    const agent = await db.aiAgent.create({ data: { workspaceId, name: 'Fixture', systemPrompt: 'fixture', status: 'active', type: 'prospecting' } });
    const campaign = await db.campaign.create({ data: { workspaceId, name: 'Fixture', messageBody: 'fixture' } });
    const old = new Date(Date.now() - 60_000);
    const messages = [];
    for (const current of [conversation, retired]) {
      const message = await db.message.create({ data: { workspaceId, conversationId: current.id, direction: 'inbound', type: 'text', body: 'old', status: 'delivered', createdAt: old } });
      messages.push(message);
      const session = await db.aiAgentSession.create({ data: { workspaceId, conversationId: current.id, agentId: agent.id } });
      await db.conversation.update({ where: { id: current.id }, data: { activeAgentSessionId: session.id } });
      await db.aiAgentPendingReply.create({ data: { workspaceId, conversationId: current.id, agentId: agent.id, sessionId: session.id, lastMessageId: message.id, scheduledAt: new Date(), status: 'processing', lockedAt: new Date() } });
      await db.aiAgentRun.create({ data: { workspaceId, conversationId: current.id, agentId: agent.id, sessionId: session.id, trigger: 'automation', status: 'completed', model: 'fixture', contextSummary: { old: true } } });
      await db.conversationFollowup.create({ data: { workspaceId, conversationId: current.id, agentId: agent.id, sessionId: session.id, kind: 'qualification', status: 'processing', activeKey: randomUUID(), anchorMessageId: message.id, anchorMessageAt: old, anchorIngestedAt: message.ingestedAt!, scheduledAt: new Date() } });
      await db.meetingReminder.create({ data: { workspaceId, conversationId: current.id, agentId: agent.id, eventId: randomUUID(), meetingStartsAt: new Date(), dueAt: new Date(), minutesBefore: 5, status: current.id === conversation.id ? 'scheduled' : 'processing', lockedAt: current.id === conversation.id ? null : new Date() } });
      await db.contactNote.create({ data: { workspaceId, contactId: current.contactId, conversationId: current.id, body: 'old', createdById: user.id } });
      const tag = await db.tag.create({ data: { workspaceId, name: randomUUID(), color: '#000000' } });
      await db.conversationTag.create({ data: { workspaceId, conversationId: current.id, tagId: tag.id } });
      await db.assistantConversationState.create({ data: { workspaceId, conversationId: current.id, lastMessageId: message.id, firstPendingAt: old } });
      await db.assistantSuggestion.create({ data: { workspaceId, conversationId: current.id, agentId: agent.id, revision: 1, contextKey: 'old', agentHash: 'old', body: 'old' } });
      await db.conversationInboxTriage.create({ data: { workspaceId, conversationId: current.id, anchorMessageId: message.id, decision: 'needs_reply', manualMarkedAt: old } });
      await db.campaignProspectingReservation.create({ data: { workspaceId, channelId: channel.id, contactId: current.contactId, conversationId: current.id, campaignId: campaign.id, recipientId: randomUUID(), agentId: agent.id, status: 'confirmed', dispatchStartedAt: old, dispatchIntentAt: old, confirmedAt: old } });
    }
    await db.conversationPreviewOwner.create({ data: { workspaceId, channelId: channel.id, conversationId: conversation.id, messageId: messages[0]!.id } });
    const receipt = await db.ingressReceipt.create({ data: { id: randomUUID(), workspaceId, channelId: channel.id, stageVersion: 1, transportNamespace: 'talk.isolated.reset', source: { fixture: true }, authentication: 'fixture', authenticatedDigest: '0'.repeat(64), rawRef: `${randomUUID()}.blob`, rawDigest: '0'.repeat(64), eventRef: `${randomUUID()}.blob`, eventDigest: '0'.repeat(64), eventCount: 1 } });
    const scope = { workspaceId, channelId: channel.id, receiptId: receipt.id, eventIndex: 0 };
    await db.ingressFrontier.create({ data: { ...scope, kind: 'message', exactKey: { rawId: 'fixture' } } });
    await db.ingressEventProgress.create({ data: { ...scope, conversationId: conversation.id, messageId: messages[0]!.id, state: 'applied', result: { fixture: true } } });
    await db.ingressEffect.create({ data: { ...scope, conversationId: conversation.id, messageId: messages[0]!.id, logicalKey: randomUUID(), kind: 'observe', cause: { fixture: true }, frozen: { fixture: true }, state: 'done', completedAt: new Date() } });
    const source: TrustedMessagingContext = { workspaceId, channelId: channel.id, channelProvider: 'evolution', provider: 'evolution', connectionId: connection.id, sessionName: connection.sessionName, lifecycleGeneration: 0, mode: 'live', observedAt: new Date().toISOString() };
    const request: OutboundRequest = { conversationId: conversation.id, destination: '15550001111@s.whatsapp.net', origin: { kind: 'human', originId: user.id, actionOrdinal: 0, requestKey: randomUUID() }, actor: { kind: 'user', id: user.id }, message: { type: 'text', body: 'confirmed outbound', mediaUrl: null, metadata: { fixture: true } }, preparedMedia: [], domainFences: [] };
    const intent = await db.$transaction(tx => outbound.reserveLocalOutboundInTransaction(tx, source, request, async () => true), { isolationLevel: 'ReadCommitted' });
    const dispatch = await db.$transaction(tx => outbound.beginDispatchInTransaction(tx, source, { intentId: intent.intent!.id, authorizeOrigin: async () => true }), { isolationLevel: 'ReadCommitted' });
    const result = await db.$transaction(tx => outbound.recordDispatchResultInTransaction(tx, { workspaceId, channelId: channel.id, token: dispatch.attempt!.token, resultKey: 'fixture', evidence: { transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: randomUUID(), remoteJid: request.destination, fromMe: true } } } }), { isolationLevel: 'ReadCommitted' });
    expect((await db.$transaction(tx => outbound.bindLocalOutboundInTransaction(tx, { workspaceId, channelId: channel.id, token: dispatch.attempt!.token, resultId: result.result!.id }), { isolationLevel: 'ReadCommitted' })).kind).toBe('bound');
    return { workspaceId, channel, user, contact, conversation, retired, messages, intent: intent.intent!, source, request };
  }
  const service = () => createConversationsService(db as unknown as PrismaLike);
  async function facts(workspaceId: string) {
    const where = { workspaceId };
    return Promise.all([db.ingressReceipt.findMany({ where }), db.ingressFrontier.findMany({ where }), db.ingressEventProgress.findMany({ where }), db.ingressEffect.findMany({ where }), db.outboundIntent.findMany({ where }), db.outboundAttempt.findMany({ where }), db.outboundResult.findMany({ where }), db.outboundBinding.findMany({ where }), db.canonicalMessageIdentity.findMany({ where }), db.canonicalObservation.findMany({ where })]);
  }
  async function routeApp(f: Awaited<ReturnType<typeof fixture>>, role: 'owner' | 'manager' | 'agent' = 'owner') {
    const app = Fastify({ logger: false });
    app.decorate('prisma', db);
    app.decorate('realtime', { publish: vi.fn(), addClient: vi.fn(), clientCount: vi.fn() });
    app.addHook('preHandler', async request => { request.talk = { workspaceId: f.workspaceId, role, clerkUserId: f.user.clerkUserId }; });
    await app.register(conversationsRoutes);
    return app;
  }
  async function resetRoute(f: Awaited<ReturnType<typeof fixture>>, role: 'owner' | 'manager' | 'agent' = 'owner') {
    const app = await routeApp(f, role);
    try { return await app.inject({ method: 'POST', url: `/conversations/${f.conversation.id}/reset` }); }
    finally { await app.close(); }
  }
  it('returns 200 while retaining the real FK-bound message UUIDs and every immutable ingress/outbound fact', async () => {
    const f = await fixture(), outside = await fixture();
    const before = await facts(f.workspaceId), outsideBefore = await facts(outside.workspaceId);
    const projectionBefore = await db.message.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { id: "asc" } });
    // This is the original production reset failure, with ordinary FK enforcement enabled.
    await expect(db.$transaction(async tx => {
      const where = { workspaceId: f.workspaceId, conversationId: f.conversation.id };
      await tx.aiAgentPendingReply.deleteMany({ where });
      await tx.aiAgentRun.deleteMany({ where });
      await tx.assistantConversationState.deleteMany({ where });
      await tx.assistantSuggestion.deleteMany({ where });
      await tx.conversationFollowup.deleteMany({ where });
      // The former reset still failed after removing operational FK dependencies.
      await tx.message.deleteMany({ where });
    })).rejects.toMatchObject({ code: 'P2003', meta: { constraint: 'ingress_progress_message_fkey' } });
    const response = await resetRoute(f);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ conversation: { id: f.conversation.id, contactId: f.contact.id, channelId: f.channel.id, lastMessage: null, lastMessageAt: null, lastMessagePreviewAt: null, lastMessagePreview: null, unreadCount: 0, activeAgentSessionStatus: null, status: 'open', aiControlStatus: 'agent_allowed', hiddenUntilReply: false }, context: { notes: [], tags: [] } });
    expect(await facts(f.workspaceId)).toEqual(before);
    const withoutResetFields = (row: typeof projectionBefore[number]) => { const { hiddenByReset: _, updatedAt: __, ...fact } = row; return fact; };
    expect((await db.message.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { id: "asc" } })).map(withoutResetFields)).toEqual(projectionBefore.map(withoutResetFields));
    expect(await facts(outside.workspaceId)).toEqual(outsideBefore);
    expect((await db.message.findMany({ where: { workspaceId: f.workspaceId } })).map(row => row.id).sort()).toEqual([f.messages[0]!.id, f.messages[1]!.id, f.intent.messageId].sort());
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, hiddenByReset: true } })).toBe(3);
    expect(await service().listMessages({ workspaceId: f.workspaceId, conversationId: f.conversation.id })).toEqual([]);
    const cards = await withLastMessages(db as unknown as PrismaLike, f.workspaceId, [response.json().conversation]);
    expect(cards[0]!.lastMessage).toBeNull();
    const target = await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } });
    const retired = await db.conversation.findUniqueOrThrow({ where: { id: f.retired.id } });
    expect(retired).toMatchObject({ retiredIntoConversationId: target.id, historyResetAt: target.historyResetAt, status: 'closed', aiControlStatus: 'human_controlled', hiddenUntilReply: true });
    expect(target.waitingDismissedAt).toBeNull();
    expect(await db.conversationPreviewOwner.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    for (const count of await Promise.all([db.aiAgentPendingReply.count({ where: { workspaceId: f.workspaceId } }), db.aiAgentRun.count({ where: { workspaceId: f.workspaceId } }), db.aiAgentSession.count({ where: { workspaceId: f.workspaceId } }), db.conversationFollowup.count({ where: { workspaceId: f.workspaceId } }), db.assistantConversationState.count({ where: { workspaceId: f.workspaceId } }), db.assistantSuggestion.count({ where: { workspaceId: f.workspaceId } }), db.conversationInboxTriage.count({ where: { workspaceId: f.workspaceId } }), db.campaignProspectingReservation.count({ where: { workspaceId: f.workspaceId } })])) expect(count).toBe(0);
    expect(await db.meetingReminder.findMany({ where: { workspaceId: f.workspaceId }, select: { status: true, lockedAt: true } })).toEqual([{ status: 'cancelled', lockedAt: null }, { status: 'cancelled', lockedAt: null }]);
    expect(await db.message.count({ where: { workspaceId: outside.workspaceId, hiddenByReset: true } })).toBe(0);
  });
  it('cannot reselect or refresh a hidden source into the empty inbox preview', async () => {
    const f = await fixture(); await resetRoute(f);
    const input = { conversationId: f.conversation.id, messageId: f.messages[0]!.id, preview: 'old delayed preview' };
    expect(await db.$transaction(tx => selectConversationPreviewInTransaction(tx, f.source, { ...input, selection: 'new_message' }))).toBe(false);
    expect(await db.$transaction(tx => refreshOwnedConversationPreviewInTransaction(tx, f.source, input))).toBe(false);
    expect(await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).toMatchObject({ lastMessageAt: null, lastMessagePreview: null, lastMessagePreviewAt: null, unreadCount: 0 });
    expect(await db.conversationPreviewOwner.count({ where: { conversationId: f.conversation.id } })).toBe(0);
  });
  it('keeps late historical inserts and updates hidden, including retired members, while new messages remain visible through repeated resets', async () => {
    const f = await fixture(); await resetRoute(f);
    const target = await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } });
    for (const conversationId of [f.conversation.id, f.retired.id]) {
      const late = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId, type: 'text', direction: 'inbound', body: 'late history', createdAt: new Date(target.historyResetAt!.getTime() - 1000) } });
      expect(late.hiddenByReset).toBe(true);
      expect((await db.message.update({ where: { id: late.id }, data: { hiddenByReset: false, createdAt: new Date(Date.now() + 1000), body: 'enriched' } })).hiddenByReset).toBe(true);
    }
    const fresh = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: f.conversation.id, type: 'text', direction: 'inbound', body: 'new inbound', status: 'delivered', createdAt: new Date(target.historyResetAt!.getTime() + 1) } });
    expect(fresh.hiddenByReset).toBe(false);
    expect((await service().listMessages({ workspaceId: f.workspaceId, conversationId: f.conversation.id })).map(row => row.id)).toEqual([fresh.id]);
    expect((await db.message.update({ where: { id: fresh.id }, data: { createdAt: new Date(target.historyResetAt!.getTime() - 1) } })).hiddenByReset).toBe(true);
    expect((await resetRoute(f)).statusCode).toBe(200);
    expect(await service().listMessages({ workspaceId: f.workspaceId, conversationId: f.conversation.id })).toEqual([]);
    expect((await db.message.update({ where: { id: f.messages[0]!.id }, data: { hiddenByReset: false, body: 'new enrichment' } })).hiddenByReset).toBe(true);
  });
  it('returns actionable 409 and rolls back every reset mutation for an unknown campaign send', async () => {
    const f = await fixture();
    await db.campaignProspectingReservation.update({ where: { workspaceId_conversationId: { workspaceId: f.workspaceId, conversationId: f.retired.id } }, data: { confirmedAt: null, status: 'sending' } });
    const before = await db.conversation.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { id: 'asc' } });
    const ledger = await facts(f.workspaceId);
    const response = await resetRoute(f);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CONVERSATION_RESET_DELIVERY_UNCONFIRMED', error: expect.any(String) });
    expect(await db.conversation.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await facts(f.workspaceId)).toEqual(ledger);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, hiddenByReset: true } })).toBe(0);
    expect(await db.campaignProspectingReservation.count({ where: { workspaceId: f.workspaceId } })).toBe(2);
  });
  it('rolls back all real operational mutations, reservation release and audit when the final reset audit fails', async () => {
    const f = await fixture();
    const snapshot = () => {
      const where = { workspaceId: f.workspaceId };
      return Promise.all([facts(f.workspaceId), db.conversation.findMany({ where, orderBy: { id: 'asc' } }),
        db.message.findMany({ where, orderBy: { id: 'asc' } }), db.aiAgentSession.findMany({ where, orderBy: { id: 'asc' } }),
        db.aiAgentRun.findMany({ where, orderBy: { id: 'asc' } }), db.aiAgentPendingReply.findMany({ where, orderBy: { id: 'asc' } }),
        db.contactNote.findMany({ where, orderBy: { id: 'asc' } }), db.conversationTag.findMany({ where, orderBy: { conversationId: 'asc' } }),
        db.assistantConversationState.findMany({ where, orderBy: { id: 'asc' } }), db.assistantSuggestion.findMany({ where, orderBy: { id: 'asc' } }),
        db.assistantReplySample.findMany({ where, orderBy: { id: 'asc' } }), db.conversationInboxTriage.findMany({ where, orderBy: { conversationId: 'asc' } }),
        db.conversationFollowup.findMany({ where, orderBy: { id: 'asc' } }), db.meetingReminder.findMany({ where, orderBy: { id: 'asc' } }),
        db.auditLog.findMany({ where, orderBy: { id: 'asc' } }), db.campaignProspectingReservation.findMany({ where, orderBy: { id: 'asc' } }),
        db.conversationPreviewOwner.findMany({ where, orderBy: { conversationId: 'asc' } })]);
    };
    const before = await snapshot();
    let reachedFinalAudit = false;
    const failingStore = {
      $transaction: (callback: Parameters<PrismaLike['$transaction']>[0], options: Parameters<PrismaLike['$transaction']>[1]) => db.$transaction(async tx => {
        const wrapped = new Proxy(tx, { get(target, property) {
          if (property === 'auditLog') return { create: async (args: Prisma.AuditLogCreateArgs) => {
            if (args.data.action === 'conversation.demo_reset') {
              expect(await tx.message.count({ where: { workspaceId: f.workspaceId, hiddenByReset: true } })).toBe(3);
              expect(await tx.campaignProspectingReservation.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
              expect(await tx.aiAgentSession.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
              reachedFinalAudit = true;
              throw Error('Injected final reset audit failure');
            }
            return tx.auditLog.create(args);
          } };
          return Reflect.get(target, property);
        } });
        return callback(wrapped as unknown as PrismaLike);
      }, options)
    };
    await expect(createConversationsService(failingStore as PrismaLike).resetConversation({ workspaceId: f.workspaceId,
      conversationId: f.conversation.id, actorUserId: f.user.id })).rejects.toThrow('Injected final reset audit failure');
    expect(reachedFinalAudit).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
  it('strictly advances the highest scoped reset marker even when it is ahead of the current clock', async () => {
    const f = await fixture();
    const targetBoundary = new Date(Date.now() + 60_000), retiredBoundary = new Date(targetBoundary.getTime() + 1000);
    await db.conversation.update({ where: { id: f.conversation.id }, data: { historyResetAt: targetBoundary } });
    await db.conversation.update({ where: { id: f.retired.id }, data: { historyResetAt: retiredBoundary } });
    const first = await resetRoute(f);
    expect(first.statusCode).toBe(200);
    expect(new Date(first.json().conversation.historyResetAt).getTime()).toBe(retiredBoundary.getTime() + 1);
    const second = await resetRoute(f);
    expect(new Date(second.json().conversation.historyResetAt).getTime()).toBe(retiredBoundary.getTime() + 2);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: f.retired.id } })).historyResetAt?.toISOString()).toBe(second.json().conversation.historyResetAt);
  });
  it('rejects hidden reply references before taking human control or creating another outbound', async () => {
    const f = await fixture();
    await resetRoute(f);
    const app = await routeApp(f);
    const where = { workspaceId: f.workspaceId };
    const conversationsBefore = await db.conversation.findMany({ where, orderBy: { id: 'asc' } });
    const messagesBefore = await db.message.findMany({ where, orderBy: { id: 'asc' } });
    const ledgerBefore = await facts(f.workspaceId);
    try {
      for (const replyToMessageId of [f.messages[0]!.id, f.intent.messageId]) {
        const response = await app.inject({ method: 'POST', url: `/conversations/${f.conversation.id}/messages`, payload: { body: 'requested quoted reply', replyToMessageId } });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
      }
    } finally { await app.close(); }
    expect(await db.conversation.findMany({ where, orderBy: { id: 'asc' } })).toEqual(conversationsBefore);
    expect(await db.message.findMany({ where, orderBy: { id: 'asc' } })).toEqual(messagesBefore);
    expect(await facts(f.workspaceId)).toEqual(ledgerBefore);
  });
  it('rejects hidden message IDs for edit/delete/recognition/transcription/forward without provider work', async () => {
    const f = await fixture();
    const audio = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: f.conversation.id, type: 'audio', direction: 'inbound', body: 'old audio', mediaUrl: 'data:audio/ogg;base64,YQ==' } });
    const unknown = await db.message.create({ data: { workspaceId: f.workspaceId, conversationId: f.conversation.id, type: 'system', direction: 'inbound', body: 'Mensagem não reconhecida', providerMessageId: randomUUID() } });
    await resetRoute(f);
    const app = await routeApp(f);
    const base = `/conversations/${f.conversation.id}/messages`;
    try {
      expect((await app.inject({ method: 'POST', url: `${base}/${f.intent.messageId}/edit`, payload: { body: 'replacement' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `${base}/${f.intent.messageId}/delete-for-everyone` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `${base}/${unknown.id}/recognize-contact` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `${base}/${audio.id}/transcription` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/conversations/${f.conversation.id}/forward`, payload: { messageIds: [f.intent.messageId], targetConversationIds: [f.retired.id] } })).statusCode).toBe(404);
    } finally { await app.close(); }
    expect((await db.message.findUniqueOrThrow({ where: { id: f.intent.messageId } })).body).toBe('confirmed outbound');
  });
  it.each(['manager', 'agent'] as const)('returns 403 for non-owner %s without changing messages', async role => {
    const f = await fixture(); const before = await facts(f.workspaceId);
    expect((await resetRoute(f, role)).statusCode).toBe(403);
    expect(await facts(f.workspaceId)).toEqual(before);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId, hiddenByReset: true } })).toBe(0);
  });
});
