import { createHash } from 'node:crypto';
import { normalizePhoneForStorage } from '../contacts/phone-normalization.js';

export type MessageDirection = 'inbound' | 'outbound';
/** Null fields are unresolved, never permission to search outside the caller's scope. */
export interface WhatsAppMessageKey {
  identityFormat: 'whatsapp_stanza' | 'provider_native';
  nativeId: string | null;
  nativeChatAddress: string | null;
  nativeSenderParticipant: string | null;
  rawId: string | null;
  chatAddress: string | null;
  direction: MessageDirection | null;
  /** Empty for direct chats, null for a group whose sender is unknown. */
  senderParticipant: string | null;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
export function serialized(value: unknown): string | null { return string(value) ?? string(record(value)._serialized); }

/** Never feed LID digits to phone normalization. */
export function normalizeChatAddress(value: unknown): string | null {
  const address = serialized(value);
  if (!address || address.length > 100) return null;
  if (/^\d+@lid$/.test(address) || /^\d+(?:-\d+)?@g\.us$/.test(address)) return address;
  const phone = /^(\d{8,15})@(c\.us|s\.whatsapp\.net)$/.exec(address)?.[1];
  return phone ? `${normalizePhoneForStorage(phone)}@s.whatsapp.net` : null;
}

/** WPP's split('_') helper truncates stanza IDs. Only the prefix and proven suffix are removed. */
export function parseWahaMessageKey(value: unknown, explicitParticipant?: unknown): WhatsAppMessageKey {
  const key = record(value);
  const nativeId = serialized(value);
  const structuredChat = normalizeChatAddress(key.remote ?? key.remoteJid);
  const participant = normalizeChatAddress(key.participant ?? explicitParticipant);
  const sender = participant?.endsWith('@g.us') ? null : participant;
  if (string(key.id) && structuredChat) {
    return { identityFormat: 'whatsapp_stanza', nativeId, nativeChatAddress: serialized(key.remote ?? key.remoteJid), nativeSenderParticipant: serialized(key.participant ?? explicitParticipant), rawId: string(key.id), chatAddress: structuredChat,
      direction: typeof key.fromMe === 'boolean' ? key.fromMe ? 'outbound' : 'inbound' : null,
      senderParticipant: structuredChat.endsWith('@g.us') ? sender : '' };
  }
  const match = nativeId && /^(true|false)_([^_]+)_(.+)$/.exec(nativeId);
  const chatAddress = match ? normalizeChatAddress(match[2]) : null;
  if (!match || !chatAddress) return { identityFormat: 'whatsapp_stanza', nativeId, nativeChatAddress: null, nativeSenderParticipant: null, rawId: nativeId && !/^(true|false)_/.test(nativeId) ? nativeId : null, chatAddress: null, direction: null, senderParticipant: null };
  let rawId: string | null = match[3]!;
  const suffix = /_([^_]+@(?:lid|c\.us|s\.whatsapp\.net))$/.exec(rawId);
  if (suffix) {
    // Without independent participant evidence this could be part of the raw stanza.
    rawId = sender && normalizeChatAddress(suffix[1]) === sender ? rawId.slice(0, -suffix[0].length) || null : null;
  }
  return { identityFormat: 'whatsapp_stanza', nativeId, nativeChatAddress: match[2]!, nativeSenderParticipant: serialized(explicitParticipant), rawId, chatAddress, direction: match[1] === 'true' ? 'outbound' : 'inbound', senderParticipant: chatAddress.endsWith('@g.us') ? sender : '' };
}

export function canonicalMessageTuple(input: {
  workspaceId: string; channelId: string; chatIdentityId: string;
  rawId: string; direction: MessageDirection; senderParticipant: string;
}) {
  const tuple = [input.workspaceId, input.channelId, input.chatIdentityId, input.rawId, input.direction, input.senderParticipant] as const;
  // The future store must retain and compare this tuple on a hash match.
  return { tuple, hash: createHash('sha256').update(JSON.stringify(tuple)).digest('hex') };
}
