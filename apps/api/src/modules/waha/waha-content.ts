// Source contracts: WAHA 55a7d78e3feaf24280fd2a16177ad6187202ea00 session.wpp.core.ts toWAMessage;
// WA-JS be5a182c3ad7ad152674c0a087088b32b8a289da src/whatsapp/models/MsgModel.ts.
import { locationMapUrl } from '@prymeira-talk/shared';
import type { AttachmentPresentation, MediaSourceDescriptor, NormalizedContent } from '../messaging/normalized-event.js';
import { record, string } from '../messaging/whatsapp-identity.js';
import { parseContactCard } from '../messaging/contact-card.js';

function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function coordinate(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max ? value : null;
}
function mediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null; } catch { return null; }
}
/** WPP 2026.9.1 sets top-level location/vCards null: typed raw fields are authoritative. */
export function wahaContent(payload: Record<string, unknown>, raw = record(payload._data)): {
  content: NormalizedContent; attachment: AttachmentPresentation; media: MediaSourceDescriptor | null;
} {
  const type = string(raw.type);
  const nativeMedia = record(payload.media);
  const mimeType = string(nativeMedia.mimetype) ?? string(raw.mimetype);
  const caption = string(raw.caption);
  const fileName = string(nativeMedia.filename) ?? string(raw.filename);
  const attachment: AttachmentPresentation = {
    ...(mimeType ? { mimeType } : {}), ...(caption ? { caption } : {}), ...(fileName ? { fileName } : {}),
    ...(typeof raw.isGif === 'boolean' ? { isGif: raw.isGif } : {})
  };
  for (const [target, value] of Object.entries({ durationSeconds: raw.duration, width: raw.width, height: raw.height, sizeBytes: raw.size, pageCount: raw.pageCount })) {
    const number = nonnegative(value);
    if (number !== undefined) Object.assign(attachment, { [target]: number });
  }
  let media: MediaSourceDescriptor | null = null;
  const text = (body: string, messageType: NormalizedContent['type'] = 'text'): NormalizedContent => ({ type: messageType, body, preview: body, mediaUrl: media?.url ?? null });
  if (type === 'location' || type === 'live_location') {
    const lat = coordinate(raw.lat, 90), lng = coordinate(raw.lng, 180);
    const location = { latitude: lng === null ? null : lat, longitude: lat === null ? null : lng,
      name: string(raw.loc)?.slice(0, 200) ?? null, address: string(raw.comment)?.slice(0, 1000) ?? null,
      isLive: raw.isLive === true || type === 'live_location' };
    const body = [location.isLive ? 'Localização compartilhada — Última posição recebida' : 'Localização compartilhada', location.name, location.address, locationMapUrl(location)].filter(Boolean).join('\n');
    return { content: { ...text(body), location }, attachment, media };
  }
  if (type === 'vcard' || type === 'multi_vcard') {
    const cards = type === 'multi_vcard' && Array.isArray(raw.vcardList) ? raw.vcardList.slice(0, 50) : [{ displayName: raw.vcardFormattedName, vcard: raw.body }];
    const contactCards = cards.map(parseContactCard).filter((value): value is NonNullable<typeof value> => value !== null);
    const body = contactCards.length === 1 ? `Contato compartilhado: ${contactCards[0]!.fullName}${contactCards[0]!.phoneNumber ? ` (${contactCards[0]!.phoneNumber})` : ''}` : `${contactCards.length} contatos compartilhados`;
    return { content: { ...text(body), contactCards }, attachment, media };
  }
  const mediaKinds: Record<string, MediaSourceDescriptor['kind']> = { ptt: 'audio', audio: 'audio', image: 'image', sticker: 'sticker', video: 'video', document: 'document' };
  const kind = type && Object.hasOwn(mediaKinds, type) ? mediaKinds[type] : undefined;
  if (kind || payload.hasMedia === true || raw.isMedia === true || raw.isMMS === true || mimeType) {
    // clientUrl/mediaUrl in WPP may point to WhatsApp encrypted content, never a download descriptor.
    const url = mediaUrl(nativeMedia.url);
    media = { kind: kind ?? 'unknown', hasMedia: true, url, state: nativeMedia.error ? 'failed' : url ? 'available' : 'pending',
      ...(nativeMedia.error ? { errorCode: 'provider_media_unavailable' as const } : {}) };
    const body = kind === 'audio' ? 'Áudio recebido' : kind === 'sticker' ? 'Figurinha recebida' : kind === 'image' ? caption ?? 'Imagem recebida' : kind === 'video' ? caption ?? 'Vídeo recebido' : kind === 'document' ? fileName ?? caption ?? 'Arquivo recebido' : 'Mensagem não reconhecida';
    return { content: text(body, kind === 'audio' ? 'audio' : kind === 'image' || kind === 'sticker' ? 'image' : kind === 'video' || kind === 'document' ? 'file' : 'system'), attachment, media };
  }
  const body = string(raw.body) ?? string(payload.body);
  return { content: body && (!type || type === 'chat') ? text(body) : text('Mensagem não reconhecida', 'system'), attachment, media };
}
