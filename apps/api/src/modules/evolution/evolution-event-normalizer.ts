import type { AddressMappingEvidence, MediaSourceDescriptor, NormalizationResult, SourceOrder, TrustedMessagingContext } from '../messaging/normalized-event.js';
import { normalizeChatAddress, record, string, type WhatsAppMessageKey } from '../messaging/whatsapp-identity.js';
import { attachmentPresentation, extractMessageContent, extractMessageEdit, extractPushName, extractQrCode, isEditProtocolType, mapEvolutionMessageStatus, normalizeEvolutionEvent, unwrapMessage } from './evolution-normalizer.js';
import { extractEncryptedMessageEdit, isEncryptedControlEnvelope } from './evolution-message-edit.js';

function keyOf(value: unknown): WhatsAppMessageKey {
  const key = record(value), chatAddress = normalizeChatAddress(key.remoteJid);
  const participant = normalizeChatAddress(key.participant);
  // Evolution transports both Baileys keys and native Meta wamid IDs, even on bridge channels.
  const providerNative = string(key.id)?.startsWith('wamid.') === true;
  return { identityFormat: providerNative ? 'provider_native' : 'whatsapp_stanza', nativeId: string(key.id), nativeChatAddress: string(key.remoteJid), nativeSenderParticipant: string(key.participant), rawId: providerNative ? null : string(key.id), chatAddress,
    direction: typeof key.fromMe === 'boolean' ? key.fromMe ? 'outbound' : 'inbound' : null,
    senderParticipant: chatAddress && !chatAddress.endsWith('@g.us') ? '' : participant?.endsWith('@g.us') ? null : participant };
}
function mapping(first: unknown, second: unknown, role: AddressMappingEvidence['role']): AddressMappingEvidence[] {
  const a = normalizeChatAddress(first), b = normalizeChatAddress(second);
  const lid = a?.endsWith('@lid') ? a : b?.endsWith('@lid') ? b : null;
  const pn = a?.endsWith('@s.whatsapp.net') ? a : b?.endsWith('@s.whatsapp.net') ? b : null;
  return lid && pn ? [{ role, lid, pn, source: role === 'chat' ? 'evolution.remoteJidAlt' : 'evolution.participantAlt' }] : [];
}
function order(value: unknown, seconds = false): SourceOrder {
  const n = typeof value === 'number' ? value : null;
  return { timestampMs: n !== null && Number.isFinite(n) && n >= 0 && n <= (seconds ? 8.64e12 : 8.64e15) ? n * (seconds ? 1000 : 1) : null, sequence: null };
}
/** Shared adapter is opt-in for the canonical writer. Legacy handlers keep their existing helpers. */
export function normalizeEvolutionWebhook(context: TrustedMessagingContext, input: unknown): NormalizationResult {
  const envelope = record(input), data = record(envelope.data);
  const name = string(envelope.event);
  if (context.provider !== 'evolution' || !name) return { kind: 'invalid', reason: 'invalid_envelope' };
  const eventName = normalizeEvolutionEvent(name);
  const rawKey = record(data.key), key = keyOf(rawKey);
  const base = { context: { ...context }, providerEventId: string(envelope.id), providerEventType: name, addressMappings: [
    ...mapping(rawKey.remoteJid, rawKey.remoteJidAlt, 'chat'),
    ...mapping(rawKey.participant ?? data.participant, rawKey.participantAlt, 'sender')
  ] };
  if (eventName === 'connection.update') {
    const state = data.state ?? data.status;
    const status = state === 'open' || state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : ['close', 'closed', 'disconnected'].includes(String(state)) ? 'disconnected' : 'failed';
    return { kind: 'accepted', event: { ...base, kind: 'control', control: 'connection', status } };
  }
  if (eventName === 'qrcode.updated') {
    const qrCode = extractQrCode(data);
    return qrCode ? { kind: 'accepted', event: { ...base, kind: 'control', control: 'qr', qrCode } } : { kind: 'invalid', reason: 'missing_qr' };
  }
  const message = record(unwrapMessage(data.message));
  const protocol = record(message.protocolMessage);
  const encrypted = extractEncryptedMessageEdit(data);
  if (encrypted) {
    const target = keyOf(record(message.secretEncryptedMessage).targetMessageKey);
    return { kind: 'accepted', event: { ...base, kind: 'encrypted_edit', target, action: key,
      encrypted: { ivBase64: encrypted.iv.toString('base64'), payloadBase64: encrypted.payload.toString('base64'), senderJids: encrypted.senderJids }, order: order(null) } };
  }
  if (isEncryptedControlEnvelope(data)) return { kind: 'ignored', reason: 'unsupported_encrypted_control' };
  const edit = extractMessageEdit(data, eventName);
  if (edit) {
    const target = isEditProtocolType(protocol.type) ? keyOf(protocol.key) : keyOf({ ...rawKey, id: edit.targetId });
    // Legacy messages.edited may supply only the target key; do not relabel it as an action.
    return { kind: 'accepted', event: { ...base, kind: 'edit', target, action: isEditProtocolType(protocol.type) ? key : keyOf(null),
      content: { type: 'text', body: edit.body, preview: edit.body, mediaUrl: null }, order: order(protocol.timestampMs) } };
  }
  if (eventName === 'messages.edited' || isEditProtocolType(protocol.type)) return { kind: 'invalid', reason: 'invalid_edit' };
  if (eventName === 'messages.delete' || protocol.type === 0 || protocol.type === 'REVOKE') {
    const target = eventName === 'messages.delete' ? keyOf(data.key ?? data) : keyOf(protocol.key);
    if (!target.nativeId) return { kind: 'invalid', reason: 'invalid_revoke' };
    return { kind: 'accepted', event: { ...base, kind: 'revoke', target, action: eventName === 'messages.delete' ? keyOf(null) : key, order: order(protocol.timestampMs) } };
  }
  if (eventName === 'messages.update' || eventName === 'send.message') {
    if (typeof data.status !== 'string' && typeof data.status !== 'number') return { kind: 'invalid', reason: 'invalid_receipt' };
    // Baileys WAProto WebMessageInfo.Status: ERROR=0, PLAYED=5. Keep legacy route mapping unchanged.
    const status = String(data.status) === '5' ? 'read' : String(data.status) === '0' ? 'failed' : mapEvolutionMessageStatus(data.status as string | number | undefined);
    const target = keyOf({ ...rawKey, id: rawKey.id ?? data.keyId ?? data.id ?? data.messageId });
    return status && target.nativeId ? { kind: 'accepted', event: { ...base, kind: 'receipt', target, status, providerStatus: data.status, recipient: null, order: order(null) } } : { kind: 'invalid', reason: 'invalid_receipt' };
  }
  if (eventName !== 'messages.upsert') return { kind: 'ignored', reason: 'unsupported_event' };
  if (!key.nativeId || !key.chatAddress || !key.direction) return { kind: 'invalid', reason: 'invalid_message_key' };
  if (key.chatAddress.endsWith('@g.us') && !key.senderParticipant) key.senderParticipant = normalizeChatAddress(data.participant);
  const content = extractMessageContent(data.message, data.messageType);
  const kinds = { audioMessage: 'audio', imageMessage: 'image', stickerMessage: 'sticker', videoMessage: 'video', documentMessage: 'document' } as const;
  const kind = Object.entries(kinds).find(([name]) => message[name] !== undefined)?.[1];
  const media: MediaSourceDescriptor | null = kind ? { kind, hasMedia: true, url: content.mediaUrl, state: content.mediaUrl ? 'available' : 'pending' } : null;
  return { kind: 'accepted', event: { ...base, kind: 'message', key, content, attachment: attachmentPresentation(data.message), media,
    currentRevision: null, pushName: extractPushName(data), source: null, order: order(data.messageTimestamp, true) } };
}
