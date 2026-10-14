import type { Prisma, PrismaClient } from '@prisma/client';
import type { SendTextResult } from '../evolution/evolution.client.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { captureOutboundDomainFenceInTransaction, type OutboundDomainFence } from '../messaging/outbound-fences.js';
import { createOutboundIntents, type AuthorizeOutboundOrigin } from '../messaging/outbound-intents.js';
import { normalizeChatAddress } from '../messaging/whatsapp-identity.js';
import { createCanonicalStore } from '../messaging/canonical-store.js';

async function reconcileEarlyEchoes(tx: Prisma.TransactionClient, input: {
  workspaceId: string; channelId: string; intentId: string;
}) {
  const store = createCanonicalStore();
  const observations = await tx.canonicalObservation.findMany({ where: {
    workspaceId: input.workspaceId, channelId: input.channelId, state: 'held', reason: 'outbound_dispatch_ambiguity',
    resolutionEvidence: { path: ['intentIds'], array_contains: [input.intentId] }
  } });
  for (const observation of observations) await store.reprocessHeldMessageObservationInTransaction(tx, {
    workspaceId: input.workspaceId, channelId: input.channelId, observationId: observation.id
  });
}

export async function sendCanonicalProspectingText(input: {
  prisma: PrismaClient; workspaceId: string; channelId: string; messageId: string;
  connectionId: string; provider: 'evolution' | 'waha'; text: string; send: () => Promise<SendTextResult>;
}): Promise<SendTextResult> {
  const api = createOutboundIntents(), scope = { workspaceId: input.workspaceId, channelId: input.channelId };
  const authorize: AuthorizeOutboundOrigin = async (tx, origin) => {
    const reservation = await tx.campaignProspectingReservation.findUnique({ where: {
      workspaceId_conversationId: { workspaceId: input.workspaceId, conversationId: origin.conversationId }
    } });
    return !!reservation && origin.origin.kind === 'prospecting_delivery' && origin.origin.originId === reservation.id
      && origin.actor.kind === 'agent' && origin.actor.id === reservation.agentId;
  };
  const dispatch = await input.prisma.$transaction(async tx => {
    const source = await deriveTrustedMessagingContext(tx, { ...scope,
      authenticatedSource: { provider: input.provider, connectionId: input.connectionId }, mode: 'live', observedAt: new Date().toISOString() });
    const message = await tx.message.findFirstOrThrow({ where: { id: input.messageId,
      workspaceId: input.workspaceId, direction: 'outbound', type: 'text', status: 'pending' } });
    const conversation = await tx.conversation.findFirstOrThrow({ where: { ...scope, id: message.conversationId }, include: { contact: true } });
    const reservation = await tx.campaignProspectingReservation.findUniqueOrThrow({ where: {
      workspaceId_conversationId: { workspaceId: input.workspaceId, conversationId: conversation.id }
    } });
    if (message.body !== input.text || !conversation.activeAgentSessionId) throw new Error('Prospecting frozen reply changed');
    const destination = normalizeChatAddress(`${conversation.contact.phone}@s.whatsapp.net`);
    if (!destination) throw new Error('Prospecting destination invalid');
    const fences: OutboundDomainFence[] = [];
    for (const [kind, id] of [ ['conversation', conversation.id], ['prospecting_reservation', reservation.id],
      ['agent', reservation.agentId], ['session', conversation.activeAgentSessionId] ] as const) {
      const fence = await captureOutboundDomainFenceInTransaction(tx, input.workspaceId, kind, id);
      if (!fence) throw new Error(`Missing prospecting fence: ${kind}`);
      fences.push(fence);
    }
    const reserved = await api.reserveLocalOutboundInTransaction(tx, source, { conversationId: conversation.id, destination,
      existingMessageId: message.id, origin: { kind: 'prospecting_delivery', originId: reservation.id, actionOrdinal: 0, requestKey: message.id },
      actor: { kind: 'agent', id: reservation.agentId },
      message: { type: message.type, body: message.body, mediaUrl: message.mediaUrl, metadata: message.metadata as object },
      preparedMedia: [], domainFences: fences }, authorize);
    if (reserved.kind !== 'reserved' && reserved.kind !== 'existing') throw new Error(`Prospecting reserve blocked: ${reserved.kind}`);
    const started = await api.beginDispatchInTransaction(tx, source, { intentId: reserved.intent.id, authorizeOrigin: authorize });
    if (started.kind !== 'dispatch') throw new Error(`Prospecting dispatch blocked: ${started.kind}`);
    return started;
  }, { timeout: 15_000 });
  let sent: SendTextResult;
  try { sent = await input.send(); }
  catch (error) {
    await input.prisma.$transaction(tx => api.recordDispatchResultInTransaction(tx, { ...scope, token: dispatch.attempt.token,
      resultKey: 'provider_response', evidence: { transport: 'transport_error', status: null, bodyState: 'unavailable', raw: null } }));
    throw error;
  }
  const bound = await input.prisma.$transaction(async tx => {
    const result = await api.recordDispatchResultInTransaction(tx, { ...scope, token: dispatch.attempt.token,
      resultKey: 'provider_response', evidence: { transport: 'http', status: 200, bodyState: 'json', raw: sent.raw }, authorizeOrigin: authorize });
    if (result.kind !== 'recorded' && result.kind !== 'existing') throw new Error(`Prospecting result blocked: ${result.kind}`);
    const binding = await api.bindLocalOutboundInTransaction(tx, { ...scope, token: dispatch.attempt.token, resultId: result.result.id });
    if (binding.kind === 'bound') await reconcileEarlyEchoes(tx, { ...scope, intentId: dispatch.attempt.intentId });
    return binding;
  }, { timeout: 15_000 });
  if (bound.kind !== 'bound') throw new Error(`Prospecting binding requires review: ${bound.kind}`);
  return { ...sent, localMessageId: dispatch.messageId };
}

/** Reserve the campaign's message before I/O so an early echo is held until
 * its authenticated provider response binds to this exact message UUID. */
export async function sendCanonicalCampaignText(input: {
  prisma: PrismaClient; workspaceId: string; channelId: string;
  recipientId: string; leaseToken: string; connectionId: string; provider: 'evolution' | 'waha';
  text: string; send: () => Promise<SendTextResult>;
}): Promise<SendTextResult> {
  const api = createOutboundIntents();
  const scope = { workspaceId: input.workspaceId, channelId: input.channelId };
  const authorize: AuthorizeOutboundOrigin = async (tx, origin) => !!await tx.campaignRecipient.findFirst({
    where: { ...scope, id: input.recipientId, leaseToken: input.leaseToken, status: 'in_flight',
      campaign: { status: { in: ['scheduled', 'sending'] } } }
  }) && origin.origin.kind === 'campaign_recipient' && origin.origin.originId === input.recipientId;
  const dispatch = await input.prisma.$transaction(async tx => {
    const source = await deriveTrustedMessagingContext(tx, { ...scope,
      authenticatedSource: { provider: input.provider, connectionId: input.connectionId },
      mode: 'live', observedAt: new Date().toISOString() });
    const recipient = await tx.campaignRecipient.findFirstOrThrow({ where: {
      ...scope, id: input.recipientId, leaseToken: input.leaseToken, status: 'in_flight'
    }, include: { campaign: true } });
    const reservation = await tx.campaignProspectingReservation.findUnique({ where: {
      workspaceId_recipientId: { workspaceId: input.workspaceId, recipientId: recipient.id }
    } });
    const conversation = reservation ? await tx.conversation.findUniqueOrThrow({ where: { id: reservation.conversationId } })
      : await tx.conversation.findUniqueOrThrow({ where: { workspaceId_channelId_contactId: {
        ...scope, contactId: recipient.contactId!
      } } });
    const snapshot = recipient.contactSnapshot as Record<string, unknown> | null;
    if (snapshot?.message !== input.text) throw new Error('Campaign frozen message changed');
    const destination = normalizeChatAddress(`${recipient.phoneSnapshot}@s.whatsapp.net`);
    if (!destination) throw new Error('Campaign destination invalid');
    const fences: OutboundDomainFence[] = [];
    const identities: Array<[OutboundDomainFence['kind'], string]> = [
      ['conversation', conversation.id], ['campaign_recipient', recipient.id],
      ['campaign', recipient.campaignId], ['campaign_throttle', input.channelId]
    ];
    if (reservation) identities.push(['prospecting_reservation', reservation.id], ['agent', reservation.agentId]);
    for (const [kind, id] of identities) {
      const fence = await captureOutboundDomainFenceInTransaction(tx, input.workspaceId, kind, id);
      if (!fence) throw new Error(`Missing campaign fence: ${kind}`);
      fences.push(fence);
    }
    const reserved = await api.reserveLocalOutboundInTransaction(tx, source, {
      conversationId: conversation.id, destination,
      origin: { kind: 'campaign_recipient', originId: recipient.id, actionOrdinal: 0, requestKey: `campaign:${recipient.id}` },
      actor: reservation ? { kind: 'agent', id: reservation.agentId } : { kind: 'automation', id: recipient.campaignId },
      message: { type: 'text', body: input.text, mediaUrl: null, metadata: { source: 'campaign', recipientId: recipient.id } },
      preparedMedia: [], domainFences: fences
    }, authorize);
    if (reserved.kind !== 'reserved' && reserved.kind !== 'existing') throw new Error(`Campaign reserve blocked: ${reserved.kind}`);
    const started = await api.beginDispatchInTransaction(tx, source, { intentId: reserved.intent.id, authorizeOrigin: authorize });
    if (started.kind !== 'dispatch') throw new Error(`Campaign dispatch blocked: ${started.kind}`);
    return started;
  }, { timeout: 15_000 });
  let sent: SendTextResult;
  try { sent = await input.send(); }
  catch (error) {
    await input.prisma.$transaction(tx => api.recordDispatchResultInTransaction(tx, { ...scope,
      token: dispatch.attempt.token, resultKey: 'provider_response',
      evidence: { transport: 'transport_error', status: null, bodyState: 'unavailable', raw: null }
    }));
    throw error;
  }
  const binding = await input.prisma.$transaction(async tx => {
    const recorded = await api.recordDispatchResultInTransaction(tx, { ...scope,
      token: dispatch.attempt.token, resultKey: 'provider_response',
      evidence: { transport: 'http', status: 200, bodyState: 'json', raw: sent.raw }, authorizeOrigin: authorize });
    if (recorded.kind !== 'recorded' && recorded.kind !== 'existing') throw new Error(`Campaign result blocked: ${recorded.kind}`);
    const bound = await api.bindLocalOutboundInTransaction(tx, { ...scope,
      token: dispatch.attempt.token, resultId: recorded.result.id });
    if (bound.kind === 'bound') await reconcileEarlyEchoes(tx, { ...scope, intentId: dispatch.attempt.intentId });
    return bound;
  }, { timeout: 15_000 });
  if (binding.kind !== 'bound') throw new Error(`Campaign binding requires review: ${binding.kind}`);
  return { ...sent, localMessageId: dispatch.messageId };
}
