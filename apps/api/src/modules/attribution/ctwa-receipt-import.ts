import type { PrismaClient, IngressReceipt } from '@prisma/client';
import { z } from 'zod';
import { IngressPrivateStore } from '../ingress/private-store.js';
import type { ReceiptPayload } from '../ingress/normalization.js';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { equal } from '../messaging/canonical-values.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
import { record } from '../messaging/whatsapp-identity.js';
import { validateWahaIdentityDeclarations } from '../messaging/identity-declarations.js';
import { normalizeWahaEvent } from '../waha/waha-normalizer.js';
import { validCtwa } from '../waha/waha-ctwa.js';
import { ctwaEventData } from './ctwa-service.js';
import { hash } from './ctwa-payload.js';

export class CtwaReceiptImportError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function requireFact(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new CtwaReceiptImportError(reason);
}
export const ctwaReceiptImportInput = z.object({
  workspaceId: z.string().min(1).max(256), receiptId: z.uuid(),
  eventIndex: z.number().int().nonnegative(), apply: z.boolean().default(false)
}).strict();

/** Historical attribution proof only. No ingress replay, messaging writes, effects,
 * current-provider recertification or Meta transport. Both immutable blobs are
 * verified before the workspace boundary; SQL evidence is re-read under it. */
export async function prepareCtwaReceipt(db: PrismaClient, files: IngressPrivateStore,
  input: z.input<typeof ctwaReceiptImportInput>) {
  const { workspaceId, receiptId, eventIndex, apply } = ctwaReceiptImportInput.parse(input);
  const receipt = await db.ingressReceipt.findFirst({ where: { id: receiptId, workspaceId } });
  requireFact(receipt, 'receipt_not_found');
  const { acceptedFacts: _facts, ...source } = record(receipt.source);
  requireFact(receipt.stageVersion === 1 && receipt.authentication === 'waha_raw_hmac_sha512'
    && /^[a-f0-9]{64}$/.test(receipt.authenticatedDigest)
    && source.provider === 'waha' && source.channelProvider === 'evolution' && source.mode === 'live'
    && source.workspaceId === workspaceId && source.channelId === receipt.channelId
    && z.uuid().safeParse(source.connectionId).success && typeof source.sessionName === 'string' && !!source.sessionName
    && Number.isSafeInteger(source.lifecycleGeneration) && Number(source.lifecycleGeneration) >= 0
    && typeof source.observedAt === 'string' && Number.isFinite(Date.parse(source.observedAt)), 'invalid_receipt_source');
  let raw: unknown, payload: ReceiptPayload;
  try {
    raw = JSON.parse((await files.read(receipt.rawRef, receipt.rawDigest)).toString('utf8'));
    payload = JSON.parse((await files.read(receipt.eventRef, receipt.eventDigest)).toString('utf8'));
  } catch { throw new CtwaReceiptImportError('invalid_receipt_blobs'); }
  requireFact(payload.version === 1 && Array.isArray(payload.events) && payload.events.length === receipt.eventCount
    && eventIndex < receipt.eventCount, 'invalid_event_index');
  const stored = payload.events[eventIndex];
  requireFact(stored?.kind === 'accepted' && stored.event.kind === 'message'
    && equal(stored.event.context, source), 'invalid_stored_event');
  const context = source as unknown as TrustedMessagingContext;
  // Re-normalize the original envelope, never a hand-built native key or caller mapping.
  // A receipt requiring external LID enrichment is conservatively refused here.
  requireFact(!validateWahaIdentityDeclarations(raw, []), 'invalid_native_declarations');
  requireFact(record(raw).session === context.sessionName, 'native_session_mismatch');
  const fresh = normalizeWahaEvent(context, raw);
  requireFact(fresh.kind === 'accepted' && fresh.event.kind === 'message', 'invalid_native_event');
  const event = fresh.event, key = event.key;
  requireFact(equal(key, stored.event.key) && key.identityFormat === 'whatsapp_stanza'
    && !!key.rawId && !!key.nativeId && key.direction === 'inbound'
    && !!key.chatAddress && /@(?:c\.us|s\.whatsapp\.net|lid)$/.test(key.chatAddress)
    && key.senderParticipant === '' && !event.content.reaction && !event.content.pollVote, 'native_key_mismatch');
  const ctwa = validCtwa(event.ctwa);
  requireFact(ctwa, 'missing_native_ctwa');
  const timestamp = event.order.timestampMs;
  const eventTime = new Date(typeof timestamp === 'number' && Number.isFinite(timestamp)
    && timestamp >= 0 && timestamp <= 8.64e15 ? timestamp : context.observedAt);
  requireFact(Number.isFinite(eventTime.getTime()), 'invalid_event_time');
  return db.$transaction(async tx => {
    await enterCanonicalWorkspaceTransaction(tx, workspaceId);
    const persisted = await tx.ingressReceipt.findUnique({ where: { id: receiptId } });
    requireFact(persisted && sameReceipt(persisted, receipt), 'receipt_changed');
    const scope = { workspaceId, channelId: receipt.channelId };
    const progress = await tx.ingressEventProgress.findUnique({ where: { receiptId_eventIndex: { receiptId, eventIndex } } });
    requireFact(progress && progress.workspaceId === workspaceId && progress.channelId === receipt.channelId
      && progress.state === 'applied' && progress.messageId && progress.conversationId && progress.observationId,
    'event_not_applied');
    const observation = await tx.canonicalObservation.findFirst({ where: { ...scope, id: progress.observationId,
      provider: 'waha', connectionId: context.connectionId, sessionName: context.sessionName, kind: 'message', state: 'resolved' } });
    const observed = record(observation?.payload);
    const expectedReceiptTuple = [context.provider, context.connectionId, context.sessionName, event.providerEventType,
      event.providerEventId ? 'provider_event_id' : 'ingress', event.providerEventId ?? `${receiptId}:${eventIndex}`];
    requireFact(observation?.identityId && equal(observation.receiptTuple, expectedReceiptTuple)
      && observed.kind === 'message' && equal(observed.key, key), 'canonical_key_mismatch');
    const identity = await tx.canonicalMessageIdentity.findFirst({ where: { ...scope, id: observation.identityId,
      messageId: progress.messageId, conversationId: progress.conversationId, direction: 'inbound', state: 'active' } });
    requireFact(identity && identity.rawId === key.rawId && identity.identityFormat === key.identityFormat, 'canonical_identity_mismatch');
    const message = await tx.message.findFirst({ where: { workspaceId, id: progress.messageId,
      conversationId: progress.conversationId, direction: 'inbound', hiddenByReset: false,
      conversation: { is: { ...scope, id: progress.conversationId, contact: { is: { isGroup: false } } } } } });
    requireFact(message, 'message_not_eligible');
    const clickKey = { ...scope, clickHash: hash(ctwa.ctwaClid) };
    let attribution = await tx.ctwaAttribution.findUnique({ where: { workspaceId_channelId_clickHash: clickKey } });
    requireFact(!attribution || (attribution.messageId === message.id && attribution.conversationId === message.conversationId
      && attribution.ctwaClid === ctwa.ctwaClid), 'click_scope_conflict');
    const messageAttribution = await tx.ctwaAttribution.findFirst({ where: { ...scope, messageId: message.id } });
    requireFact(!messageAttribution || (messageAttribution.clickHash === clickKey.clickHash
      && messageAttribution.ctwaClid === ctwa.ctwaClid), 'message_click_conflict');
    if (apply && !attribution) attribution = await tx.ctwaAttribution.create({ data: {
      ...clickKey, conversationId: message.conversationId, messageId: message.id, ...ctwa, sourceMode: 'live'
    } });
    const existing = attribution ? await tx.ctwaConversionEvent.findUnique({ where: {
      workspaceId_attributionId_eventName_businessKey: { workspaceId, attributionId: attribution.id,
        eventName: 'LeadSubmitted', businessKey: 'once' }
    } }) : null;
    if (apply && attribution && !existing) await tx.ctwaConversionEvent.create({
      data: { ...ctwaEventData(attribution, 'LeadSubmitted'), eventTime }
    });
    return { apply, attributionExists: !!attribution, eventExists: !!existing || apply,
      wouldCreateAttribution: !apply && !attribution, wouldCreateEvent: !apply && !existing,
      state: existing?.state ?? 'pending_validation', eventTime: (existing?.eventTime ?? eventTime).toISOString() };
  }, { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 5000 });
}

function sameReceipt(a: IngressReceipt, b: IngressReceipt) {
  return a.workspaceId === b.workspaceId && a.channelId === b.channelId && equal(a.source, b.source)
    && a.authentication === b.authentication && a.authenticatedDigest === b.authenticatedDigest
    && a.rawRef === b.rawRef && a.rawDigest === b.rawDigest && a.eventRef === b.eventRef
    && a.eventDigest === b.eventDigest && a.eventCount === b.eventCount && a.stageVersion === b.stageVersion;
}
