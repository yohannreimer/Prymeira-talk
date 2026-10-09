import { record, string } from '../messaging/whatsapp-identity.js';

/** Status/newsletter frames have their own chat namespace. All supplied chat anchors must agree; a client chat
 * mixed with a non-conversation key remains held. Sender/recipient addresses are not conversation anchors. */
export function wahaNonConversationKind(input: unknown): 'non_conversation_status' | 'non_conversation_newsletter' | null {
  const envelope = record(input), payload = record(envelope.payload), raw = record(payload._data), info = record(raw.Info);
  if (!['message', 'message.any'].includes(String(envelope.event))) return null;
  const anchors: unknown[] = [info.Chat, raw.chatId, payload.chatId];
  for (const key of [payload.id, raw.id]) {
    const structured = record(key);
    anchors.push(structured.remote ?? structured.remoteJid);
    const serialized = typeof key === 'string' ? key : string(structured._serialized);
    const match = serialized && /^(?:true|false)_([^_]+)_/.exec(serialized);
    if (match) anchors.push(match[1]);
  }
  // GOWS from is always the chat. WPP uses from for inbound and to for outbound.
  anchors.push(info.Chat ? payload.from : payload.fromMe === true ? payload.to : payload.from);
  const supplied = anchors.filter(value => value !== undefined && value !== null && value !== '');
  const chat = supplied[0];
  if (typeof chat !== 'string' || supplied.length < 2 || supplied.some(value => value !== chat)) return null;
  if (chat === 'status@broadcast') return 'non_conversation_status';
  if (/^[0-9]+@newsletter$/.test(chat)) return 'non_conversation_newsletter';
  return null;
}
