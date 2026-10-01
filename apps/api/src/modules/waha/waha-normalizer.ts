import { usedWahaAddressMappings, validateWahaIdentityDeclarations } from '../messaging/identity-declarations.js';
import type { MessageEditPatch, NormalizationResult, SourceOrder, TrustedMessagingContext } from '../messaging/normalized-event.js';
import { normalizeChatAddress, parseWahaMessageKey, record, serialized, string, type WhatsAppMessageKey } from '../messaging/whatsapp-identity.js';
import { wahaContent } from './waha-content.js';

const unknownOrder: SourceOrder = { timestampMs: null, sequence: null };
function messageOrder(value: unknown): SourceOrder {
  return { timestampMs: typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e12 ? value * 1000 : null, sequence: null };
}
function scopedTarget(value: unknown, chat: unknown): WhatsAppMessageKey {
  const target = parseWahaMessageKey(value);
  // Only chat scope can be borrowed from the envelope; never its action sender/direction.
  return { ...target, chatAddress: target.chatAddress ?? normalizeChatAddress(chat) };
}
/** Pure WPP adapter, grounded in WAHA commit 55a7d78e3feaf24280fd2a16177ad6187202ea00.
 * Authentication, DB lifecycle fencing, LID lookup and media I/O belong to the caller.
 */
export function normalizeWahaEvent(context: TrustedMessagingContext, input: unknown, enrichment?: {
  /** Results from the caller's bounded, authenticated WAHA LID lookup; never webhook metadata. */
  verifiedLidMappings: ReadonlyArray<{ lid: string; pn: string }>;
}): NormalizationResult {
  const envelope = record(input), payload = record(envelope.payload);
  const eventName = string(envelope.event);
  if (context.provider !== 'waha' || String(context.channelProvider) === 'meta' || !eventName || !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return { kind: 'invalid', reason: 'invalid_envelope' };
  const verifiedMappings = (enrichment?.verifiedLidMappings ?? []).flatMap(({lid,pn}) => (['chat','sender'] as const).map(role => ({role,lid,pn,source:'waha.lid_lookup' as const})));
  const contradiction = validateWahaIdentityDeclarations(input, verifiedMappings);
  if (contradiction) return { kind: 'invalid', reason: contradiction };
  const base = { context: { ...context }, providerEventId: string(envelope.id), providerEventType: eventName, addressMappings: usedWahaAddressMappings(input, verifiedMappings) };
  const raw = record(payload._data);
  const participantOf = (model: Record<string, unknown>) => model.author ?? model.participant ?? payload.participant ?? payload.author ?? record(model.id).participant ?? record(payload.id).participant;
  const parsedKey = (value: unknown, participant?: unknown) => {
    const key = parseWahaMessageKey(value, participant);
    const native = serialized(value), suffix = native && /^(?:true|false)_[^_]+_.+_([^_]+@(?:lid|c\.us|s\.whatsapp\.net))$/.exec(native);
    const author = normalizeChatAddress(participant), nativeAuthor = suffix && normalizeChatAddress(suffix[1]);
    if (key.rawId === null && author && nativeAuthor && verifiedMappings.some(m => m.role === 'sender' && ((normalizeChatAddress(m.lid) === author && normalizeChatAddress(m.pn) === nativeAuthor) || (normalizeChatAddress(m.pn) === author && normalizeChatAddress(m.lid) === nativeAuthor)))) {
      const proven = parseWahaMessageKey(value, suffix![1]);
      return {...proven, senderParticipant: proven.chatAddress?.endsWith('@g.us') ? author : '', nativeSenderParticipant: serialized(participant)};
    }
    return key;
  };
  if (eventName === 'session.status') {
    const statuses = { WORKING: 'connected', STARTING: 'connecting', SCAN_QR_CODE: 'connecting', STOPPED: 'disconnected', FAILED: 'failed', PASSKEY_REQUIRED: 'connecting', PASSKEY_CONFIRMATION_REQUIRED: 'connecting' } as const;
    const status = typeof payload.status === 'string' && Object.hasOwn(statuses, payload.status) ? statuses[payload.status as keyof typeof statuses] : null;
    return status ? { kind: 'accepted', event: { ...base, kind: 'control', control: 'connection', status } } : { kind: 'invalid', reason: 'invalid_session_status' };
  }
  if (eventName === 'message.edited') {
    const tuple = Array.isArray(payload._data) ? payload._data : null;
    const msg = record(tuple ? tuple[2] : raw.msg ?? raw.message);
    if (msg.type !== undefined && typeof msg.type !== 'string') return { kind: 'invalid', reason: 'invalid_edit_type' };
    const originalKey = tuple ? tuple[1] : raw.id;
    const chat = tuple ? tuple[0] : raw.chat;
    const candidateAction = parsedKey(msg.latestEditMsgKey ?? payload.id, participantOf(raw) ?? msg.author ?? msg.participant);
    const target = scopedTarget(originalKey ?? payload.editedMessageId, chat ?? candidateAction.nativeChatAddress);
    const action = !msg.latestEditMsgKey && candidateAction.rawId === target.rawId && candidateAction.chatAddress === target.chatAddress
      ? parseWahaMessageKey(null) : candidateAction;
    if (action.rawId) action.nativeId = action.nativeId ?? string(payload.id);
    // WPP media body may contain original bytes. WAHA normalizes media body from caption.
    const mediaEdit = payload.hasMedia === true || msg.isMedia === true || msg.isMMS === true
      || string(msg.mimetype) !== null || ['image', 'video', 'document', 'audio', 'ptt', 'sticker'].includes(msg.type ?? '');
    const caption = typeof msg.caption === 'string' ? msg.caption : typeof payload.body === 'string' ? payload.body : null;
    const body = mediaEdit ? null : string(msg.body) ?? string(payload.body);
    const patch: MessageEditPatch | null = mediaEdit
      ? caption === null ? null : { field: 'caption', caption }
      : body === null ? null : { field: 'body', body };
    if ((!target.rawId && !target.nativeId) || !patch) return { kind: 'invalid', reason: 'invalid_edit' };
    return { kind: 'accepted', event: { ...base, kind: 'edit', target, action, patch, order: { ...unknownOrder } } };
  }
  if (eventName === 'message.revoked') {
    // WPP before/after are short keys; raw refId/id retain full target/action identity.
    const actionParticipant = participantOf(raw);
    const action = parsedKey(raw.id ?? payload.after ?? payload.id, actionParticipant);
    const target = scopedTarget(raw.refId ?? payload.before ?? payload.revokedMessageId, action.nativeChatAddress);
    if (!target.rawId && !target.nativeId) return { kind: 'invalid', reason: 'invalid_revoke' };
    return { kind: 'accepted', event: { ...base, kind: 'revoke', target, action, order: { ...unknownOrder } } };
  }
  if (eventName === 'message.ack' || eventName === 'message.ack.group') {
    const model = Array.isArray(payload._data) ? record(payload._data[0]) : raw;
    const statuses = new Map<unknown, 'failed' | 'pending' | 'sent' | 'delivered' | 'read'>([[-1, 'failed'], [0, 'pending'], [1, 'sent'], [2, 'delivered'], [3, 'read'], [4, 'read']]);
    const status = statuses.get(payload.ack);
    const target = parsedKey(model.id ?? payload.id, participantOf(model));
    target.nativeId = string(payload.id) ?? target.nativeId;
    if (!status || (!target.nativeId && !target.rawId)) return { kind: 'invalid', reason: 'invalid_receipt' };
    return { kind: 'accepted', event: { ...base, kind: 'receipt', target, status, providerStatus: payload.ack as number,
      recipient: normalizeChatAddress(model.sender), order: { ...unknownOrder } } };
  }
  if (eventName !== 'message' && eventName !== 'message.any') return { kind: 'ignored', reason: 'unsupported_event' };
  if (!string(payload.id) || (payload.fromMe !== undefined && typeof payload.fromMe !== 'boolean')) return { kind: 'invalid', reason: 'invalid_message_key' };
  const participant = participantOf(raw);
  const key = parsedKey(raw.id ?? payload.id, participant);
  // Always keep the exact native API identifier as an alias, even when a structured key is stronger.
  key.nativeId = string(payload.id) ?? key.nativeId;
  if (!key.chatAddress) {
    key.nativeChatAddress = serialized(raw.chatId ?? (payload.fromMe === true ? payload.to : payload.fromMe === false ? payload.from : null));
    key.chatAddress = normalizeChatAddress(key.nativeChatAddress);
    if (key.chatAddress && !key.chatAddress.endsWith('@g.us')) key.senderParticipant = '';
  }
  if (!key.direction && typeof payload.fromMe === 'boolean') key.direction = payload.fromMe ? 'outbound' : 'inbound';
  if (!key.chatAddress || (!key.nativeId && !key.rawId)) return { kind: 'invalid', reason: 'invalid_message_key' };
  const sender = record(raw.sender);
  return { kind: 'accepted', event: { ...base, kind: 'message', key, ...wahaContent(payload),
    currentRevision: raw.latestEditMsgKey ? parseWahaMessageKey(raw.latestEditMsgKey) : null,
    pushName: string(raw.notifyName) ?? string(sender.pushname) ?? string(sender.pushName),
    source: string(payload.source), order: messageOrder(payload.timestamp ?? raw.timestamp ?? raw.t) } };
}
