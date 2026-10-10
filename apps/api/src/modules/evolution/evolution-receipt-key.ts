import { string, type WhatsAppMessageKey } from '../messaging/whatsapp-identity.js';
/** Evolution 2.4's flat outbound ACK truncates `user:device@domain` to `user`.
 * This is incomplete evidence, never a phone/LID mapping. Only this exact receipt
 * shape may bypass the malformed-chat guard; resolution requires an established alias. */
export function isDomainlessEvolutionAck(name: string, data: Record<string, unknown>): boolean {
  const absent = (v: unknown) => v === undefined || v === null || v === '';
  return name === 'messages.update' && absent(data.key) && !!string(data.keyId)
    && typeof data.remoteJid === 'string' && /^\d{1,80}$/.test(data.remoteJid)
    && data.fromMe === true && (typeof data.status === 'string' || typeof data.status === 'number')
    && [data.participant, data.participantAlt, data.author, data.remoteJidAlt].every(absent);
}
export function isDomainlessEvolutionTarget(key: WhatsAppMessageKey): boolean {
  return key.identityFormat === 'whatsapp_stanza' && !!key.rawId && key.nativeId === key.rawId
    && key.chatAddress === null && key.direction === 'outbound' && key.senderParticipant === null
    && /^\d{1,80}$/.test(key.nativeChatAddress ?? '');
}
