import { normalizeChatAddress, type WhatsAppMessageKey } from './whatsapp-identity.js';
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
