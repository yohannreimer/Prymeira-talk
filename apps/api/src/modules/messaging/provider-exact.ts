import { normalizeChatAddress, parseWahaMessageKey, record, serialized, string, type WhatsAppMessageKey } from './whatsapp-identity.js';
import { gowsMessageToWpp } from '../waha/waha-gows.js';
export type MediaPurpose = 'serve' | 'process';
export const exactMediaLimit = (purpose: MediaPurpose) => (purpose === 'serve' ? 25 : 8) * 1024 * 1024;
export function completeProviderKey(key: WhatsAppMessageKey) {
  return !!key.nativeId && !!key.nativeChatAddress && !!normalizeChatAddress(key.chatAddress) && !!key.direction
    && (key.identityFormat === 'provider_native' ? key.rawId === null : !!key.rawId)
    && (key.chatAddress!.endsWith('@g.us') ? !!normalizeChatAddress(key.senderParticipant) && !!key.nativeSenderParticipant : key.senderParticipant === '');
}
/** Equivalence needs an explicit PN/LID pair, never digits, body or time. */
export function explicitAddressMatch(expected: string | null, native: string | null, alternate?: string) {
  if (expected === normalizeChatAddress(native)) return true;
  const a = normalizeChatAddress(native), b = normalizeChatAddress(alternate);
  return !!a && !!b && ((a.endsWith('@lid') && b.endsWith('@s.whatsapp.net')) || (b.endsWith('@lid') && a.endsWith('@s.whatsapp.net'))) && expected === b;
}
export function fullProviderKeyMatches(expected: WhatsAppMessageKey, actual: WhatsAppMessageKey, alternates?: { chat?: string; sender?: string }) {
  return completeProviderKey(expected) && completeProviderKey(actual)
    && expected.identityFormat === actual.identityFormat && expected.nativeId === actual.nativeId && expected.rawId === actual.rawId
    && expected.nativeChatAddress === actual.nativeChatAddress && expected.nativeSenderParticipant === actual.nativeSenderParticipant
    && expected.direction === actual.direction
    && explicitAddressMatch(expected.chatAddress, actual.nativeChatAddress, alternates?.chat)
    && (expected.senderParticipant === '' ? actual.senderParticipant === '' : explicitAddressMatch(expected.senderParticipant, actual.nativeSenderParticipant, alternates?.sender));
}

/** Validate every supplied native representation and envelope before an exact lookup
 * or dispatch response can certify a WAHA identity. Structured IDs without a
 * serialized member may be completed only by the matching outer serialized ID. */
export function parseExactWahaResponse(value: unknown): WhatsAppMessageKey | null {
  value = gowsMessageToWpp(value);
  const envelope = record(value), data = record(envelope._data);
  const nativeId = string(envelope.id) ?? string(record(envelope.id)._serialized);
  if (!nativeId) return null;
  const participants = [envelope.participant, envelope.author, data.participant, data.author,
    record(envelope.id).participant, record(data.id).participant].filter(v => v !== undefined && v !== null);
  const participant = participants[0];
  if (participants.some(v => serialized(v) !== serialized(participant))) return null;
  const expected = parseWahaMessageKey(nativeId, participant);
  if (!completeProviderKey(expected)) return null;
  for (const value of [envelope.id, data.id].filter(v => v !== undefined && v !== null)) {
    const actual = parseWahaMessageKey(value, participant);
    if (actual.nativeId === null && typeof value === 'object') actual.nativeId = nativeId;
    if (!fullProviderKeyMatches(expected, actual)) return null;
  }
  for (const fromMe of [envelope.fromMe, data.fromMe]) {
    if (fromMe !== undefined && fromMe !== null && (typeof fromMe !== 'boolean' || expected.direction !== (fromMe ? 'outbound' : 'inbound'))) return null;
  }
  for (const chat of [envelope.chatId, expected.direction === 'outbound' ? envelope.to : envelope.from, data.chatId]) {
    if (chat !== undefined && chat !== null && normalizeChatAddress(chat) !== expected.chatAddress) return null;
  }
  for (const author of participants) {
    if (expected.chatAddress?.endsWith('@g.us') && serialized(author) !== expected.nativeSenderParticipant) return null;
  }
  return expected;
}
