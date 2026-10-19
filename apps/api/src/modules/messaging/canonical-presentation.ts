import type { Message, Prisma } from '@prisma/client';
import type { MessageEditPatch, NormalizedMessagingEvent } from './normalized-event.js';
import { record } from './whatsapp-identity.js';

type MessageEvent = Extract<NormalizedMessagingEvent, { kind: 'message' }>;
const missing = (value: unknown) => value === undefined || value === null;
export function presentationMediaUrl(event: MessageEvent) {
  const value = event.content.mediaUrl;
  if (!value || event.media?.state === 'failed') return null;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return value;
    // Existing Evolution presentation may contain normalized inlined media.
    if (event.context.provider === 'evolution' && /^data:(image|audio|video|application)\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  } catch { /* source remains private in its observation */ }
  return null;
}
export function presentationMetadata(event: MessageEvent) {
  const attachment: Record<string, unknown> = {};
  for (const name of ['caption', 'mimeType', 'fileName'] as const) {
    const value = event.attachment[name];
    if (typeof value === 'string') attachment[name] = value;
  }
  for (const name of ['durationSeconds', 'width', 'height', 'sizeBytes', 'pageCount'] as const) {
    const value = event.attachment[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) attachment[name] = value;
  }
  if (typeof event.attachment.isGif === 'boolean') attachment.isGif = event.attachment.isGif;
  // The WhatsApp stanza id lets replies and reactions find this message, and lets Talk revoke it.
  const whatsapp = event.key.rawId ? { whatsapp: { id: event.key.rawId, fromMe: event.key.direction === 'outbound',
    ...(event.key.senderParticipant ? { participant: event.key.senderParticipant } : {}) } } : {};
  return { attachment, ...whatsapp, ...(event.content.contactCards ? { contactCards: event.content.contactCards } : {}),
    ...(event.content.location ? { location: event.content.location } : {}),
    ...(event.content.quoted ? { quoted: event.content.quoted } : {}),
    ...(event.content.reaction ? { reaction: event.content.reaction } : {}),
    ...(event.content.pollVote ? { pollVote: event.content.pollVote } : {}),
    ...(event.media?.hasMedia ? { canonicalPreparation: { status: 'pending' } } : {}) };
}
/** Compare factual cards/location independently of summary labels and media.
 * The returned candidate is optional: reserved local Messages use only conflict. */
export function mergeStructuredContent(metadata: Record<string, unknown>, incoming: Pick<MessageEvent['content'], 'contactCards' | 'location'>,
  equal: (a: unknown, b: unknown) => boolean) {
  const data: Record<string, unknown> = {};
  let conflict = false;
  if (incoming.location) {
    const location = { ...record(metadata.location) };
    for (const [key, value] of Object.entries(incoming.location)) {
      if (missing(location[key])) location[key] = value;
      else if (!missing(value) && !equal(location[key], value)) conflict = true;
    }
    data.location = location;
  }
  if (incoming.contactCards) {
    if (!Array.isArray(metadata.contactCards) || !metadata.contactCards.length) data.contactCards = incoming.contactCards;
    else if (metadata.contactCards.length !== incoming.contactCards.length) conflict = true;
    else {
      data.contactCards = metadata.contactCards.map((raw, index) => {
        const card = record(raw), candidate = incoming.contactCards![index]!;
        if (card.fullName !== candidate.fullName || (!missing(card.phoneNumber) && !missing(candidate.phoneNumber) && card.phoneNumber !== candidate.phoneNumber)) { conflict = true; return card; }
        return { ...card, phoneNumber: card.phoneNumber ?? candidate.phoneNumber };
      });
    }
  }
  return { data, conflict };
}
/** Only missing fields of a proven same revision may enrich presentation. All source
 * descriptors stay in private observations, including failed/pending provider media. */
export function enrichPresentation(stored: Message, event: MessageEvent, equal: (a: unknown, b: unknown) => boolean) {
  const metadata = record(stored.metadata), next = { ...metadata }, incoming = presentationMetadata(event);
  const attachment = { ...record(metadata.attachment) };
  const structured = mergeStructuredContent(metadata, incoming, equal);
  let conflict = structured.conflict;
  for (const [key, value] of Object.entries(incoming.attachment)) {
    if (missing(attachment[key])) attachment[key] = value;
    else if (!equal(attachment[key], value)) conflict = true;
  }
  next.attachment = attachment;
  Object.assign(next, structured.data);
  if (incoming.canonicalPreparation && missing(metadata.canonicalPreparation) && !metadata.assistantMedia && !metadata.transcription) next.canonicalPreparation = incoming.canonicalPreparation;
  const data: Prisma.MessageUpdateInput = {};
  const mediaUrl = presentationMediaUrl(event);
  if (stored.mediaUrl === null && mediaUrl !== null) data.mediaUrl = mediaUrl;
  if (stored.body === null && event.content.body !== null) data.body = event.content.body;
  else if (stored.type === 'text' && !incoming.location && !incoming.contactCards && event.content.body !== null && stored.body !== event.content.body) conflict = true;
  // These exact placeholders are presentation, not message identity or edit order.
  if (!metadata.transcription && !metadata.assistantMedia && ['Imagem recebida', 'Vídeo recebido', 'Arquivo recebido'].includes(stored.body ?? '') && typeof attachment.caption === 'string' && attachment.caption) data.body = attachment.caption;
  if (!equal(metadata, next)) data.metadata = JSON.parse(JSON.stringify(next));
  return { data, conflict };
}

/** Build one candidate across the bounded snapshot page before any write. Only
 * absent metadata is accumulated; body/caption belongs to the certified patch and
 * media URLs/prepared artifacts stay owned by the existing Message. Persisting the
 * candidate with that patch makes compatible claims visible to the next page. */
export function prepareSnapshotFields(stored: Message, snapshots: readonly MessageEvent[], patch: MessageEditPatch | null,
  equal: (a: unknown, b: unknown) => boolean, { supersedeContent = false } = {}) {
  let candidate: Message = { ...stored, ...(patch?.field === 'body' ? { body: patch.body } : {}),
    metadata: patch?.field === 'caption' ? { ...record(stored.metadata), attachment: { ...record(record(stored.metadata).attachment), caption: patch.caption } } as Prisma.JsonValue : stored.metadata };
  for (const snapshot of snapshots) {
    if (candidate.type !== snapshot.content.type) return { conflict: true, message: stored };
    const compared = supersedeContent && patch?.field === 'body' ? { ...snapshot, content: { ...snapshot.content, body: patch.body } }
      : supersedeContent && patch?.field === 'caption' ? { ...snapshot, attachment: { ...snapshot.attachment, caption: patch.caption } } : snapshot;
    const { data, conflict } = enrichPresentation(candidate, compared, equal);
    if (conflict) return { conflict: true, message: stored };
    if (data.metadata) candidate = { ...candidate, metadata: data.metadata as Prisma.JsonValue };
  }
  return { conflict: false, message: candidate };
}
export function snapshotFieldConflict(stored: Message, snapshot: MessageEvent, patch: MessageEditPatch | null,
  equal: (a: unknown, b: unknown) => boolean) {
  return prepareSnapshotFields(stored, [snapshot], patch, equal).conflict;
}
