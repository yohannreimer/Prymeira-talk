import { Prisma, type PrismaClient, type CtwaConversionEvent } from '@prisma/client';
import { z } from 'zod';
import { CtwaOperationError, ctwaEventData } from './ctwa-service.js';
import { hash, stableCtwaEventId } from './ctwa-payload.js';
import { resolveLifecycleConfig } from './ctwa-tracking-config.js';

export const manualSaleSchema = z.object({
  orderId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  valueCents: z.number().int().positive().max(100000000000000).refine(Number.isSafeInteger),
  currency: z.literal('BRL')
}).strict();
export function lifecycleReceipt(row: CtwaConversionEvent) {
  return { id: row.id, eventId: row.eventId, eventName: row.eventName, state: row.state,
    eventTime: row.eventTime, orderId: row.orderId ?? null, valueCents: row.valueCents == null ? null : Number(row.valueCents),
    currency: row.currency ?? null, responseCode: row.responseCode ?? null, outcomeCode: row.outcomeCode ?? null };
}

/** The only writer of trusted lifecycle provenance. Legacy prepare routes cannot grant it. */
export function createCtwaLifecycleService(db: PrismaClient, options: { secret?: string; now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  function activation(workspaceId: string) {
    const config = resolveLifecycleConfig(options.secret, workspaceId);
    if (!config || config.lifecycleEnabledAt * 1000 > now().getTime()) throw new CtwaOperationError('lifecycle_disabled', 403);
    return config.lifecycleEnabledAt * 1000;
  }
  async function nativeConversation(workspaceId: string, conversationId: string) {
    const conversation = await db.conversation.findFirst({ where: { workspaceId, id: conversationId }, select: { id: true, channelId: true, contact: { select: { workspaceId: true, isGroup: true } } } });
    if (!conversation || conversation.contact.workspaceId !== workspaceId || conversation.contact.isGroup) throw new CtwaOperationError('native_conversation_required', 404);
    return conversation;
  }
  async function attributionAt(workspaceId: string, conversationId: string, eventTime: Date) {
    const conversation = await nativeConversation(workspaceId, conversationId);
    const attribution = await db.ctwaAttribution.findFirst({ where: {
      workspaceId, channelId: conversation.channelId, conversationId, sourceMode: 'live', capturedAt: { lte: eventTime },
      events: { some: { eventName: 'LeadSubmitted', eventTime: { lte: eventTime } } }
    }, orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }] });
    if (!attribution) throw new CtwaOperationError('native_attribution_required', 409);
    return attribution;
  }
  const meetingWhere = (workspaceId: string, conversationId: string) => ({ workspaceId, conversationId, lifecycleSource: 'calendar_confirmed', eventName: 'QualifiedLead' });
  const saleWhere = (workspaceId: string, sourceReference: string) => ({ workspaceId, lifecycleSource: 'owner_manual', eventName: 'Purchase', sourceReference });
  function saleMatches(row: CtwaConversionEvent, input: { conversationId: string; userId: string; orderId: string; valueCents: number; currency: string }) {
    if (row.conversationId !== input.conversationId || row.confirmedBy !== input.userId || row.orderId !== input.orderId || Number(row.valueCents) !== input.valueCents || row.currency !== input.currency) throw new CtwaOperationError('sale_conflict');
    return lifecycleReceipt(row);
  }
  return {
    async status(workspaceId: string, conversationId: string) {
      const config = resolveLifecycleConfig(options.secret, workspaceId);
      if (!config || config.lifecycleEnabledAt * 1000 > now().getTime()) return { enabled: false, native: false, items: [] };
      try { await attributionAt(workspaceId, conversationId, now()); }
      catch (error) { if (error instanceof CtwaOperationError) return { enabled: true, native: false, items: [] }; throw error; }
      const rows = await db.ctwaConversionEvent.findMany({ where: { workspaceId, conversationId, lifecycleSource: { in: ['calendar_confirmed', 'owner_manual'] } }, orderBy: [{ eventTime: 'desc' }, { id: 'desc' }], take: 100 });
      return { enabled: true, native: true, items: rows.map(lifecycleReceipt) };
    },
    async confirmMeeting(input: { workspaceId: string; conversationId: string; eventId: string; createdAt?: string | null }) {
      const enabledAt = activation(input.workspaceId);
      const eventTime = new Date(input.createdAt ?? '');
      if (!input.eventId || input.eventId.length > 1024 || !Number.isFinite(eventTime.getTime()) || eventTime.getTime() < enabledAt || eventTime.getTime() > now().getTime()) throw new CtwaOperationError('invalid_calendar_confirmation');
      // Rebooking preserves the first confirmed conversation milestone, even after newer attribution.
      const where = meetingWhere(input.workspaceId, input.conversationId);
      const existing = await db.ctwaConversionEvent.findFirst({ where });
      if (existing) return lifecycleReceipt(existing);
      const attribution = await attributionAt(input.workspaceId, input.conversationId, eventTime);
      try {
        return lifecycleReceipt(await db.ctwaConversionEvent.create({ data: {
          ...ctwaEventData(attribution, 'QualifiedLead'), eventTime, lifecycleSource: 'calendar_confirmed', sourceReference: hash(input.eventId),
          leadEventId: stableCtwaEventId(input.workspaceId, attribution.channelId, attribution.id, 'LeadSubmitted')
        } }));
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const saved = await db.ctwaConversionEvent.findFirst({ where });
        if (!saved) throw new CtwaOperationError('meeting_conflict');
        return lifecycleReceipt(saved);
      }
    },
    async confirmSale(input: { workspaceId: string; conversationId: string; userId: string; role: string; orderId: string; valueCents: number; currency: string }) {
      const enabledAt = activation(input.workspaceId);
      if (input.role !== 'owner' || !input.userId || input.userId.length > 256) throw new CtwaOperationError('owner_required', 403);
      const details = manualSaleSchema.parse({ orderId: input.orderId, valueCents: input.valueCents, currency: input.currency });
      const where = saleWhere(input.workspaceId, hash(details.orderId));
      const existing = await db.ctwaConversionEvent.findFirst({ where });
      if (existing) return saleMatches(existing, input);
      // Legacy preparations/acceptances cannot be promoted or recreated under another channel.
      const prior = await db.ctwaConversionEvent.findFirst({ where: { workspaceId: input.workspaceId, eventName: 'Purchase', orderHash: hash(details.orderId) }, select: { id: true } });
      if (prior) {
        // A matching trusted sale can commit between the two reads; resolve its immutable receipt.
        const committed = await db.ctwaConversionEvent.findFirst({ where });
        if (committed) return saleMatches(committed, input);
        throw new CtwaOperationError('sale_conflict');
      }
      const eventTime = now();
      if (eventTime.getTime() < enabledAt) throw new CtwaOperationError('lifecycle_not_active', 403);
      const attribution = await attributionAt(input.workspaceId, input.conversationId, eventTime);
      try {
        return lifecycleReceipt(await db.ctwaConversionEvent.create({ data: {
          ...ctwaEventData(attribution, 'Purchase', { orderId: details.orderId, value: details.valueCents / 100, currency: details.currency }),
          // Construct DECIMAL from integer cents to avoid float arithmetic changing the persisted business fact.
          value: new Prisma.Decimal(details.valueCents).div(100), valueCents: BigInt(details.valueCents), eventTime,
          lifecycleSource: 'owner_manual', sourceReference: hash(details.orderId), confirmedBy: input.userId,
          leadEventId: stableCtwaEventId(input.workspaceId, attribution.channelId, attribution.id, 'LeadSubmitted')
        } }));
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const saved = await db.ctwaConversionEvent.findFirst({ where });
        if (!saved) throw new CtwaOperationError('sale_conflict');
        return saleMatches(saved, input);
      }
    }
  };
}
