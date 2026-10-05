// Source contract: WAHA 2026.9.1 src/core/engines/gows/session.gows.core.ts (toWAMessage, receiptToMessageAck,
// subscribeEngineEvents2) and waproto.ts. GOWS is WAHA's Go engine on whatsmeow (not Baileys, not a browser).
import { record, string } from '../messaging/whatsapp-identity.js';
import { interactiveMessageText } from '../messaging/interactive-content.js';

/**
 * WAHA's two qualified engines describe the same WhatsApp message differently. WPP puts WhatsApp Web's message
 * model in `_data`; GOWS puts whatsmeow's event (`_data.Info` + `_data.Message`, the WhatsApp protobuf with Go JSON
 * names). Talk's WAHA rules are written against the WPP shape, so a GOWS event is translated into it once, at the
 * edge, and everything after (identity rules, normalization, recertification of the stored raw) is engine-agnostic.
 * A WPP event, or anything that is not a GOWS event, passes through untouched, so either engine can be used.
 */
export function isGowsModel(value: unknown) {
  const data = record(value);
  return typeof data.Info === 'object' && data.Info !== null && !Array.isArray(data.Info);
}

/** lodash.camelCase for proto JSON keys, as WAHA's GoToJSWAProto does: URL→url, PTT→ptt, JPEGThumbnail→jpegThumbnail. */
function camel(key: string) {
  const words = key.match(/[A-Z]{2,}(?=[A-Z][a-z]|[0-9]|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [key];
  return words.map((word, index) => index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join('');
}
function camelDeep(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map(item => camelDeep(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [camel(key), camelDeep(item, depth + 1)]));
  return value;
}
function unwrap(message: Record<string, unknown>) {
  let current = message;
  for (let depth = 0; depth < 6; depth++) {
    const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage']
      .find(key => typeof record(current[key]).message === 'object');
    if (!wrapper) break;
    current = record(record(current[wrapper]).message);
  }
  return current;
}
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;

/** The WhatsApp Web style fields Talk reads (`type`, body, caption, media and location/contact details). */
function wppModel(payload: Record<string, unknown>, info: Record<string, unknown>, message: Record<string, unknown>) {
  const body = string(payload.body);
  // Business accounts often have no push name; WhatsApp then shows their verified name ("Minha Claro").
  const verified = record(record(info.VerifiedName).Details);
  const base = { notifyName: string(info.PushName) ?? string(verified.verifiedName) ?? string(verified.VerifiedName) ?? undefined };
  if (typeof message.conversation === 'string') return { ...base, type: 'chat', body: message.conversation };
  if (record(message.extendedTextMessage).text !== undefined) return { ...base, type: 'chat', body: string(record(message.extendedTextMessage).text) ?? body ?? '' };
  const media: Array<[string, string]> = [['imageMessage', 'image'], ['videoMessage', 'video'], ['ptvMessage', 'video'], ['audioMessage', 'audio'], ['documentMessage', 'document'], ['stickerMessage', 'sticker']];
  for (const [field, type] of media) {
    const m = record(message[field]);
    if (!message[field]) continue;
    return { ...base, type: type === 'audio' && m.ptt === true ? 'ptt' : type, body: '', isMedia: true,
      ...(string(m.caption) ? { caption: m.caption } : {}), ...(string(m.mimetype) ? { mimetype: m.mimetype } : {}), ...(string(m.fileName) ? { filename: m.fileName } : {}),
      ...(number(m.seconds) !== undefined ? { duration: number(m.seconds) } : {}), ...(number(m.width) !== undefined ? { width: number(m.width) } : {}),
      ...(number(m.height) !== undefined ? { height: number(m.height) } : {}), ...(number(m.fileLength) !== undefined ? { size: number(m.fileLength) } : {}),
      ...(number(m.pageCount) !== undefined ? { pageCount: number(m.pageCount) } : {}), ...(type === 'video' && typeof m.gifPlayback === 'boolean' ? { isGif: m.gifPlayback } : {}) };
  }
  for (const [field, type] of [['locationMessage', 'location'], ['liveLocationMessage', 'live_location']] as const) {
    if (!message[field]) continue;
    const m = record(message[field]);
    return { ...base, type, body: '', lat: number(m.degreesLatitude) ?? m.degreesLatitude, lng: number(m.degreesLongitude) ?? m.degreesLongitude,
      ...(string(m.name) ? { loc: m.name } : {}), ...(string(m.address) ? { comment: m.address } : {}), ...(type === 'live_location' ? { isLive: true } : {}) };
  }
  if (message.contactMessage) {
    const m = record(message.contactMessage);
    return { ...base, type: 'vcard', body: string(m.vcard) ?? '', vcardFormattedName: string(m.displayName) ?? undefined };
  }
  if (message.contactsArrayMessage) {
    const contacts = Array.isArray(record(message.contactsArrayMessage).contacts) ? record(message.contactsArrayMessage).contacts as unknown[] : [];
    return { ...base, type: 'multi_vcard', body: '', vcardList: contacts.map(c => ({ displayName: record(c).displayName, vcard: record(c).vcard })) };
  }
  // GOWS delivers the vote encrypted: it is a vote on that poll, options unknown.
  const pollTargetId = string(record(record(message.pollUpdateMessage).pollCreationMessageKey).id);
  if (pollTargetId) return { ...base, type: 'poll_vote', body: '', pollTargetId };
  // Business templates, buttons, lists, polls, events, invites: the text WhatsApp shows for them.
  const rich = interactiveMessageText(message);
  if (rich) return { ...base, type: 'chat', body: rich };
  // A type Talk does not render: no text is invented; it shows as unrecognized.
  return { ...base, type: Object.keys(message)[0] ?? 'unknown', body: '' };
}

/** A WAHA message payload (webhook `payload` or an item from the messages API) in the WPP shape. */
export function gowsMessageToWpp(value: unknown): Record<string, unknown> {
  const payload = record(value);
  if (!isGowsModel(payload._data)) return payload;
  const data = record(payload._data), info = record(data.Info);
  const message = unwrap(record(camelDeep(data.Message)));
  const fromMe = typeof info.IsFromMe === 'boolean' ? info.IsFromMe : payload.fromMe;
  // GOWS reports the chat as `from` for both directions; WPP's convention is chat in `from` (inbound) or `to` (ours).
  const chat = string(payload.from);
  return { ...withChatConvention(payload, fromMe, chat), fromMe,
    _data: { ...wppModel(payload, info, message), ...(chat ? { chatId: chat } : {}), ...(payload.participant ? { author: payload.participant } : {}) } };
}
function withChatConvention(payload: Record<string, unknown>, fromMe: unknown, chat: string | null) {
  const rest = { ...payload };
  delete rest.from; delete rest.to;
  return { ...rest, ...(fromMe === true ? { to: chat } : { from: chat }) };
}

/** A WAHA webhook envelope in the WPP shape (only the message events differ; session.status is the same). */
export function gowsEnvelopeToWpp(input: unknown): unknown {
  const envelope = record(input), payload = record(envelope.payload), event = string(envelope.event);
  if (!event || !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return input;
  if (event === 'message' || event === 'message.any') {
    if (!isGowsModel(payload._data)) return input;
    return { ...envelope, payload: gowsMessageToWpp(payload) };
  }
  if (event === 'message.edited') {
    if (!isGowsModel(payload._data)) return input;
    // The edit's own key is payload.id; editedMessageId is the original message's short id, scoped to the same chat.
    const translated = gowsMessageToWpp(payload);
    return { ...envelope, payload: { ...translated, _data: { chat: record(translated._data).chatId } } };
  }
  if (event === 'message.revoked') {
    const after = record(payload.after);
    if (!isGowsModel(payload._data) && !isGowsModel(after._data)) return input;
    return { ...envelope, payload: { after: string(after.id) ?? undefined, before: null, revokedMessageId: payload.revokedMessageId, _data: {} } };
  }
  if (event === 'message.ack' || event === 'message.ack.group') {
    const receipt = record(payload._data);
    if (!Array.isArray(receipt.MessageIDs) && typeof receipt.Chat !== 'string') return input;
    // Receipts for our own messages carry fromMe=true; the chat is GOWS' `from` either way.
    return { ...envelope, payload: { ...withChatConvention(payload, payload.fromMe, string(payload.from)), _data: {} } };
  }
  return input;
}
