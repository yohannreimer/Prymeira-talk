import { Prisma, type PrismaClient, type CtwaAttribution } from '@prisma/client';
import type { NormalizedMessagingEvent } from '../messaging/normalized-event.js';
import type { CanonicalStoreResult } from '../messaging/canonical-store.js';
import { validCtwa } from '../waha/waha-ctwa.js';
import {
  buildCtwaPayload, hash, purchaseSchema, resolveCtwaConfig, stableCtwaEventId,
  type ConversionName
} from './ctwa-payload.js';

type Tx = Prisma.TransactionClient;
type Purchase = { orderId: string; value: number; currency: string };

export function ctwaEventData(attribution: CtwaAttribution, name: ConversionName, purchase?: Purchase) {
  const businessKey = purchase ? hash(purchase.orderId) : 'once';
  return {
    workspaceId: attribution.workspaceId,
    channelId: attribution.channelId,
    conversationId: attribution.conversationId,
    messageId: attribution.messageId,
    attributionId: attribution.id,
    eventName: name,
    businessKey,
    eventId: stableCtwaEventId(attribution.workspaceId, attribution.channelId, attribution.id, name, businessKey),
    ...(purchase ? {
      ...purchase, orderHash: hash(purchase.orderId), value: new Prisma.Decimal(purchase.value)
    } : {})
  };
}

/** Called only after accepted canonical persistence, including cross-provider duplicates. Optional metadata cannot abort messaging. */
export async function captureCtwaInTransaction(tx: Tx, event: NormalizedMessagingEvent, result: CanonicalStoreResult) {
  if (event.kind !== 'message' || event.context.provider !== 'waha' || event.key.direction !== 'inbound'
    || !event.key.chatAddress || !/@(?:c\.us|s\.whatsapp\.net|lid)$/.test(event.key.chatAddress)
    || result.outcome === 'held' || !result.messageId || !result.conversationId) return;
  const context = validCtwa(event.ctwa);
  if (!context) return;
  await tx.$executeRawUnsafe('SAVEPOINT ctwa_capture');
  try {
    const { workspaceId, channelId, mode } = event.context;
    const clickHash = hash(context.ctwaClid);
    const inserted = await tx.ctwaAttribution.createMany({
      data: [{
        workspaceId, channelId, conversationId: result.conversationId,
        messageId: result.messageId, clickHash, ...context, sourceMode: mode
      }],
      skipDuplicates: true
    });
    if (inserted.count && mode === 'live') {
      const attribution = await tx.ctwaAttribution.findUniqueOrThrow({
        where: { workspaceId_channelId_clickHash: { workspaceId, channelId, clickHash } }
      });
      const timestamp = event.order.timestampMs;
      const eventTime = new Date(typeof timestamp === 'number' && Number.isFinite(timestamp)
        && timestamp >= 0 && timestamp <= 8.64e15 ? timestamp : event.context.observedAt);
      if (Number.isFinite(eventTime.getTime())) {
        await tx.ctwaConversionEvent.create({ data: { ...ctwaEventData(attribution, 'LeadSubmitted'), eventTime } });
      }
    }
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT ctwa_capture');
  } catch {
    // No payload, token, click ID or conversation content is logged. Optional-storage failure preserves canonical work.
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT ctwa_capture');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT ctwa_capture');
  }
}

export class CtwaOperationError extends Error {
  constructor(readonly reason: string, readonly status = 409) { super(reason); }
}

export function createCtwaService(db: PrismaClient, options: {
  secret?: string; fetch?: typeof fetch; timeoutMs?: number;
} = {}) {
  const transport = options.fetch ?? fetch;
  return {
    async list(workspaceId: string, filter: { channelId?: string; conversationId?: string; limit?: number } = {}) {
      return db.ctwaAttribution.findMany({
        where: {
          workspaceId,
          ...(filter.channelId ? { channelId: filter.channelId } : {}),
          ...(filter.conversationId ? { conversationId: filter.conversationId } : {})
        },
        orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
        take: Math.min(100, Math.max(1, filter.limit ?? 50)),
        select: {
          id: true, channelId: true, conversationId: true, messageId: true,
          adId: true, sourceMode: true, capturedAt: true,
          events: {
            orderBy: [{ eventTime: 'desc' }, { id: 'desc' }], take: 50,
            select: {
              id: true, eventId: true, eventName: true, orderId: true,
              value: true, currency: true, eventTime: true, state: true,
              attemptCount: true, attemptedAt: true, completedAt: true,
              responseCode: true, eventsReceived: true, outcomeCode: true
            }
          }
        }
      });
    },
    async prepare(workspaceId: string, attributionId: string, name: 'QualifiedLead' | 'Purchase', purchase?: Purchase) {
      const details = name === 'Purchase' ? purchaseSchema.parse(purchase) : undefined;
      const attribution = await db.ctwaAttribution.findFirst({ where: { workspaceId, id: attributionId } });
      if (!attribution) throw new CtwaOperationError('not_found', 404);
      const data = ctwaEventData(attribution, name, details);
      const key = { workspaceId, attributionId, eventName: name, businessKey: data.businessKey };
      // Concurrent repeats preserve the first immutable business value/time and never reparent.
      const prepared = await db.ctwaConversionEvent.upsert({
        where: { workspaceId_attributionId_eventName_businessKey: key }, update: {}, create: data
      }).catch(async error => {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const existing = await db.ctwaConversionEvent.findUnique({
          where: { workspaceId_attributionId_eventName_businessKey: key }
        });
        if (!existing) throw new CtwaOperationError('order_conflict');
        return existing;
      });
      if (details && (prepared.orderId !== details.orderId || prepared.currency !== details.currency
        || Number(prepared.value) !== details.value)) throw new CtwaOperationError('order_conflict');
      return { id: prepared.id, eventId: prepared.eventId, state: prepared.state };
    },
    async dispatch(workspaceId: string, eventId: string) {
      const config = resolveCtwaConfig(options.secret, workspaceId);
      if (!config) throw new CtwaOperationError('sending_disabled');
      const event = await db.ctwaConversionEvent.findFirst({
        where: { workspaceId, id: eventId }, include: { attribution: true }
      });
      if (!event) throw new CtwaOperationError('not_found', 404);
      if (!['pending_validation', 'failed'].includes(event.state)) throw new CtwaOperationError('not_dispatchable');
      const payload = buildCtwaPayload({
        workspaceId, channelId: event.channelId, attributionId: event.attributionId,
        ctwaClid: event.attribution.ctwaClid, name: event.eventName as ConversionName,
        eventTime: event.eventTime,
        ...(event.orderId ? { orderId: event.orderId, value: Number(event.value), currency: event.currency! } : {})
      }, config);
      const claim = await db.ctwaConversionEvent.updateMany({
        where: { workspaceId, id: eventId, state: event.state, attemptCount: event.attemptCount },
        data: {
          state: 'sending', attemptCount: { increment: 1 }, attemptedAt: new Date(),
          completedAt: null, outcomeCode: null, responseCode: null, eventsReceived: null
        }
      });
      if (claim.count !== 1) throw new CtwaOperationError('not_dispatchable');
      // A crash after claim remains sending. No transaction or canonical lock spans this I/O.
      let state = 'unknown', outcomeCode = 'network_or_timeout';
      let responseCode: number | null = null, eventsReceived: number | null = null;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 10000);
      try {
        const response = await transport(`https://graph.facebook.com/v23.0/${config.datasetId}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.accessToken}` },
          body: JSON.stringify(payload), signal: abort.signal, redirect: 'error'
        });
        responseCode = response.status;
        const reader = response.body?.getReader();
        let text = '', size = 0;
        if (reader) {
          const decoder = new TextDecoder();
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65536) {
              await reader.cancel();
              throw new Error('bounded_response');
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        }
        const body: unknown = JSON.parse(text);
        const record = body && typeof body === 'object' && !Array.isArray(body)
          ? body as Record<string, unknown> : {};
        if (response.ok && record.events_received === 1) {
          state = 'accepted';
          eventsReceived = 1;
          outcomeCode = 'meta_accepted_not_attribution';
        } else if (response.status >= 400 && response.status < 500
          && record.error && typeof record.error === 'object') {
          state = 'failed';
          outcomeCode = 'meta_rejected';
        } else {
          outcomeCode = 'ambiguous_response';
        }
      } catch {
        // Remote bodies/errors can echo tokens or user data; never expose or log them.
      } finally {
        clearTimeout(timer);
      }
      await db.ctwaConversionEvent.updateMany({
        where: { workspaceId, id: eventId, state: 'sending' },
        data: { state, outcomeCode, responseCode, eventsReceived, completedAt: new Date() }
      });
      return { id: eventId, state, outcomeCode, responseCode, eventsReceived };
    }
  };
}
