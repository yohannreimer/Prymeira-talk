import { validateEvolutionIdentityDeclarations } from '../messaging/identity-declarations.js';
import type { AddressMappingEvidence, MediaSourceDescriptor, NormalizationResult, NormalizedContent, SourceOrder, TrustedMessagingContext } from '../messaging/normalized-event.js';
import { normalizeChatAddress, record, string, type WhatsAppMessageKey } from '../messaging/whatsapp-identity.js';
import { attachmentPresentation, extractMessageContent, extractMessageEdit, extractPushName, extractQrCode, hasRecordPath, isEditProtocolType, mapEvolutionMessageStatus, normalizeEvolutionEvent, unwrapMessage } from './evolution-normalizer.js';
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
/** Baileys puts the replied-to message in the content's contextInfo (stanzaId, participant, quotedMessage);
 * Evolution 2.x may also lift it to data.contextInfo. */
export function quotedOf(message: Record<string, unknown>, data: Record<string, unknown>) {
  const contexts = [record(data.contextInfo), ...Object.values(message).map(value => record(record(value).contextInfo))];
  const context = contexts.find(candidate => string(candidate.stanzaId));
  if (!context) return null;
  const quotedMessage = context.quotedMessage && typeof context.quotedMessage === 'object' ? context.quotedMessage : null;
  const quotedContent = quotedMessage ? extractMessageContent(quotedMessage, undefined) : null;
  return { id: string(context.stanzaId)!, participant: string(context.participant),
    body: quotedContent && quotedContent.type !== 'system' ? quotedContent.body?.slice(0, 500) ?? null : null };
}
/** A reactionMessage: the reacted message's stanza id and the emoji (null = removed). */
export function reactionOf(message: Record<string, unknown>) {
  const reaction = record(message.reactionMessage), targetId = string(record(reaction.key).id);
  return targetId ? { targetId, emoji: string(reaction.text) } : null;
}
/** A pollUpdateMessage: the poll's stanza id and the options picked. Evolution decrypts the vote into
 * vote.selectedOptions; without it the vote is still a vote (options unknown), never an unreadable message. */
export function pollVoteOf(message: Record<string, unknown>) {
  const update = record(message.pollUpdateMessage), targetId = string(record(update.pollCreationMessageKey).id);
  if (!targetId) return null;
  const selected = record(update.vote).selectedOptions;
  const options = Array.isArray(selected) ? selected.filter((option): option is string => typeof option === 'string').slice(0, 12) : null;
  return { targetId, options };
}
export function pollVoteBody(options: string[] | null) {
  return options === null ? 'Votou na enquete' : options.length ? `Votou em: ${options.join(', ')}` : 'Removeu o voto';
}
/** Shared adapter is opt-in for the canonical writer. Legacy handlers keep their existing helpers. */
export function normalizeEvolutionWebhook(context: TrustedMessagingContext, input: unknown): NormalizationResult {
  const envelope = record(input), data = record(envelope.data);
  const name = string(envelope.event);
  if (context.provider !== 'evolution' || !name) return { kind: 'invalid', reason: 'invalid_envelope' };
  const contradiction = validateEvolutionIdentityDeclarations(input);
  if (contradiction) return { kind: 'invalid', reason: contradiction };
  const eventName = normalizeEvolutionEvent(name);
  const rawKey = record(data.key), key = keyOf({ ...rawKey, participant: rawKey.participant ?? data.participant });
  const base = { context: { ...context }, providerEventId: string(envelope.id), providerEventType: name, addressMappings: [
    ...mapping(rawKey.remoteJid, rawKey.remoteJidAlt, 'chat'),
    ...mapping(rawKey.participant ?? data.participant, rawKey.participantAlt, 'sender'),
    ...mapping(data.participant ?? rawKey.participant, data.participantAlt, 'sender')
  ] };
  if (eventName === 'connection.update') {
    const state = data.state ?? data.status;
    if (typeof state !== 'string') return { kind: 'invalid', reason: 'invalid_connection_state' };
    const status = state === 'open' || state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : ['close', 'closed', 'disconnected'].includes(state) ? 'disconnected' : 'failed';
    // On open Evolution names the logged-in account (wuid): the number this session really is.
    const phone = status === 'connected' ? /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(string(data.wuid) ?? '')?.[1] ?? null : null;
    return { kind: 'accepted', event: { ...base, kind: 'control', control: 'connection', status, ...(phone ? { phone } : {}) } };
  }
  if (eventName === 'qrcode.updated') {
    const qrCode = extractQrCode(data);
    return qrCode ? { kind: 'accepted', event: { ...base, kind: 'control', control: 'qr', qrCode } } : { kind: 'invalid', reason: 'missing_qr' };
  }
  const message = record(unwrapMessage(data.message));
  const protocol = record(message.protocolMessage);
  const encrypted = extractEncryptedMessageEdit(data);
  // A supported target's explicit alternate is its own proof, never the action author's.
  const targets = [...(isEditProtocolType(protocol.type) || protocol.type === 0 || protocol.type === 'REVOKE' ? [protocol.key] : []),
    ...(encrypted ? [record(message.secretEncryptedMessage).targetMessageKey] : [])];
  for (const target of targets) {
    const native = record(target);
    for (const evidence of [...mapping(native.remoteJid, native.remoteJidAlt, 'chat'), ...mapping(native.participant, native.participantAlt, 'sender')])
      if (!base.addressMappings.some(e => e.role === evidence.role && e.lid === evidence.lid && e.pn === evidence.pn)) base.addressMappings.push(evidence);
  }
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
      patch: { field: 'body', body: edit.body }, order: order(protocol.timestampMs) } };
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
    // Evolution 2.x sends the receipt flat (keyId, remoteJid, fromMe on data, no data.key). Those are the provider's own
    // fields for the acked message, so they scope it like a key would; data.messageId is Evolution's row id, a last resort.
    const flat = Object.keys(rawKey).length ? rawKey : { remoteJid: data.remoteJid, fromMe: data.fromMe, participant: data.participant };
    const target = keyOf({ ...flat, id: rawKey.id ?? data.keyId ?? data.id ?? data.messageId });
    return status && target.nativeId ? { kind: 'accepted', event: { ...base, kind: 'receipt', target, status, providerStatus: data.status, recipient: null, order: order(null) } } : { kind: 'invalid', reason: 'invalid_receipt' };
  }
  if (eventName !== 'messages.upsert') return { kind: 'ignored', reason: 'unsupported_event' };
  if (!key.nativeId || !key.chatAddress || !key.direction) return { kind: 'invalid', reason: 'invalid_message_key' };
  if (key.chatAddress.endsWith('@g.us') && !key.senderParticipant) key.senderParticipant = normalizeChatAddress(data.participant);
  let content: NormalizedContent = extractMessageContent(data.message, data.messageType);
  const kinds = { audioMessage: 'audio', imageMessage: 'image', stickerMessage: 'sticker', videoMessage: 'video', documentMessage: 'document' } as const;
  const mediaField = (Object.keys(kinds) as Array<keyof typeof kinds>).find(name => hasRecordPath(message, [name]))
    ?? (typeof data.messageType === 'string' && Object.hasOwn(kinds, data.messageType) ? data.messageType as keyof typeof kinds : null);
  const kind = mediaField ? kinds[mediaField] : undefined;
  // The legacy helper intentionally requires URL/MIME for several media types.
  // New canonical observations retain a known media type while download data is pending.
  if (kind && content.type === 'system' && content.body === 'Mensagem não reconhecida') {
    const payload = record(message[mediaField!]);
    const caption = string(payload.caption);
    const body = kind === 'audio' ? 'Áudio recebido' : kind === 'sticker' ? 'Figurinha recebida'
      : kind === 'image' ? caption ?? 'Imagem recebida' : kind === 'video' ? caption ?? 'Vídeo recebido'
      : string(payload.fileName) ?? caption ?? 'Arquivo recebido';
    content = { ...content, type: kind === 'audio' ? 'audio' : kind === 'image' || kind === 'sticker' ? 'image' : 'file', body, preview: body };
  }
  const reaction = reactionOf(message);
  if (reaction) content = { ...content, reaction };
  const pollVote = pollVoteOf(message);
  if (pollVote) content = { type: 'system', body: pollVoteBody(pollVote.options), preview: pollVoteBody(pollVote.options), mediaUrl: null, pollVote };
  const quoted = quotedOf(message, data);
  if (quoted) content = { ...content, quoted };
  const media: MediaSourceDescriptor | null = kind ? { kind, hasMedia: true, url: content.mediaUrl, state: content.mediaUrl ? 'available' : 'pending' } : null;
  return { kind: 'accepted', event: { ...base, kind: 'message', key, content, attachment: attachmentPresentation(data.message), media,
    currentRevision: null, pushName: extractPushName(data), source: null, order: order(data.messageTimestamp, true) } };
}
