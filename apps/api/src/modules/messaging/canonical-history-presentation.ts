import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { InboundMediaResult } from '../agents/inbound-media.js';
import type { NormalizedMessagingEvent } from './normalized-event.js';
import { presentationMediaUrl, presentationMetadata } from './canonical-presentation.js';
import { json } from './canonical-values.js';
import { normalizeChatAddress } from './whatsapp-identity.js';
type MessageEvent = Extract<NormalizedMessagingEvent, { kind: 'message' }>;
/** Trusted presentation only. It never supplies an identity, actor, status, body,
 * operational eligibility, edit marker or conversation permission. Prepared media
 * must already have passed the caller's media/authentication/size policies. */
export interface CanonicalPresentationOptions {
  createdAt?: Date;
  ingestedAt?: Date;
  history?: { originalType?: string; batchId?: string; from?: string; to?: string; mediaStatus?: 'recovered' | 'processed' | 'unread' | 'unavailable' };
  groupSender?: { jid: string; name: string | null };
  preparedMedia?: { mediaUrl: string; result?: InboundMediaResult };
}
function date(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Invalid presentation timestamp');
  return value;
}
export function newCanonicalMessagePresentation(event: MessageEvent, options: CanonicalPresentationOptions = {}) {
  for (const field of Object.keys(options)) if (!['createdAt', 'ingestedAt', 'history', 'groupSender', 'preparedMedia'].includes(field)) throw new Error('Protected presentation field');
  if (event.context.mode !== 'history' && (options.history || options.createdAt || options.ingestedAt)) throw new Error('Historical presentation requires history mode');
  const id = randomUUID();
  const createdAt = options.createdAt ? date(options.createdAt) : event.order.timestampMs === null ? undefined : date(new Date(event.order.timestampMs));
  if (event.context.mode === 'history' && !createdAt) throw new Error('Historical timestamp required');
  const metadata: Record<string, unknown> = presentationMetadata(event);
  if (event.context.mode === 'history') {
    const history: Record<string, unknown> = { source: event.context.provider, channelId: event.context.channelId };
    for (const field of ['originalType', 'batchId', 'from', 'to', 'mediaStatus'] as const) {
      const value = options.history?.[field];
      if (value !== undefined) {
        if (typeof value !== 'string') throw new Error('Invalid history presentation');
        history[field] = value;
      }
    }
    metadata.historyImport = history;
  }
  if (options.groupSender) {
    if (!event.key.chatAddress?.endsWith('@g.us') || !normalizeChatAddress(options.groupSender.jid)) throw new Error('Invalid group sender presentation');
    // Display is separate from canonical identity; this label supplies no mapping evidence.
    metadata.groupSender = { jid: options.groupSender.jid.slice(0, 100), name: options.groupSender.name?.slice(0, 120) ?? null };
  } else if (event.key.chatAddress?.endsWith('@g.us') && event.key.senderParticipant) {
    metadata.groupSender = { jid: event.key.senderParticipant, name: event.pushName };
  }
  let mediaUrl = presentationMediaUrl(event);
  if (options.preparedMedia) {
    if (!['audio', 'image', 'file'].includes(event.content.type)) throw new Error('Prepared media requires media content');
    mediaUrl = presentationMediaUrl({ ...event, content: { ...event.content, mediaUrl: options.preparedMedia.mediaUrl }, media: null });
    if (!mediaUrl) throw new Error('Invalid prepared media URL');
    const incoming = options.preparedMedia.result;
    if (incoming) {
      if (!['processed', 'failed'].includes(incoming.status) || !['image', 'audio', 'document'].includes(incoming.kind)) throw new Error('Invalid prepared media result');
      const result: Record<string, unknown> = { status: incoming.status, kind: incoming.kind };
      for (const field of ['fileName', 'mimeType', 'source', 'extractedText', 'errorCode', 'fallback'] as const) if (typeof incoming[field] === 'string') result[field] = incoming[field];
      if (typeof incoming.pages === 'number' && Number.isFinite(incoming.pages)) result.pages = incoming.pages;
      const sourceHash = createHash('sha256').update(JSON.stringify([id, event.content.type, mediaUrl])).digest('hex');
      metadata.assistantMedia = { sourceHash, result };
      delete metadata.canonicalPreparation;
    }
  }
  return { id, mediaUrl, metadata: json(metadata), ...(createdAt ? { createdAt } : {}),
    ...(event.context.mode === 'history' ? { ingestedAt: options.ingestedAt ? date(options.ingestedAt) : createdAt } : {}) } satisfies Partial<Prisma.MessageUncheckedCreateInput>;
}
