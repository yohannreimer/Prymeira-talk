import { record } from '../messaging/whatsapp-identity.js';
export type CtwaContext = { ctwaClid: string; adId?: string };
const pick = (node: Record<string, unknown>, ...keys: string[]) => keys.map(key => node[key]).find(value => value !== undefined);
export function validCtwa(value: unknown): CtwaContext | null {
  const node = record(value), click = node.ctwaClid;
  if (typeof click !== 'string' || click.length < 1 || click.length > 2048 || !/^[\x21-\x7e]+$/.test(click)) return null;
  const ad = node.adId;
  if (ad !== undefined && (typeof ad !== 'string' || !/^\d{1,64}$/.test(ad))) return null;
  return { ctwaClid: click, ...(ad === undefined ? {} : { adId: ad as string }) };
}
/** Deliberately bounded path traversal, never a recursive search through quoted messages or arbitrary metadata. */
export function extractWahaCtwa(input: unknown): CtwaContext | null {
  const envelope = record(input), payload = record(envelope.payload), data = record(payload._data);
  if (!['message', 'message.any'].includes(String(envelope.event))) return null;
  const info = record(data.Info ?? data.info);
  const fromMe = pick(info, 'IsFromMe', 'isFromMe') ?? payload.fromMe;
  const chat = pick(info, 'Chat', 'chat') ?? payload.from;
  if (fromMe !== false || typeof chat !== 'string' || !/@(?:c\.us|s\.whatsapp\.net|lid)$/.test(chat) || pick(info, 'IsGroup', 'isGroup') === true) return null;
  let message = record(data.Message ?? data.message);
  const wrappers = ['ephemeralMessage', 'EphemeralMessage', 'viewOnceMessage', 'ViewOnceMessage', 'viewOnceMessageV2', 'ViewOnceMessageV2', 'viewOnceMessageV2Extension', 'ViewOnceMessageV2Extension', 'documentWithCaptionMessage', 'DocumentWithCaptionMessage'];
  for (let depth = 0; depth < 6; depth++) {
    const wrapper = wrappers.find(key => message[key] !== undefined);
    if (!wrapper) break;
    const node = record(message[wrapper]); message = record(node.message ?? node.Message);
  }
  const fields = ['extendedTextMessage', 'ExtendedTextMessage', 'imageMessage', 'ImageMessage', 'videoMessage', 'VideoMessage', 'audioMessage', 'AudioMessage', 'documentMessage', 'DocumentMessage', 'stickerMessage', 'StickerMessage', 'interactiveMessage', 'InteractiveMessage', 'buttonsResponseMessage', 'ButtonsResponseMessage', 'listResponseMessage', 'ListResponseMessage'];
  const contexts = fields.filter(key => message[key] !== undefined).map(key => {
    const body = record(message[key]); return record(body.contextInfo ?? body.ContextInfo);
  });
  // WPP's own message context is also supported; quotedMsg is intentionally inaccessible.
  if (!data.Message && !data.message) contexts.push(record(data.contextInfo ?? data.ContextInfo));
  const candidates = contexts.flatMap(context => {
    const ad = record(context.externalAdReply ?? context.ExternalAdReply);
    const click = pick(ad, 'ctwaClid', 'CtwaClid', 'CTWAClid');
    const adId = pick(ad, 'adId', 'AdId', 'AdID', 'sourceId', 'sourceID', 'SourceId', 'SourceID');
    const candidate = validCtwa({ ctwaClid: click, ...(adId === undefined || adId === '' ? {} : { adId }) });
    return candidate ? [candidate] : [];
  });
  if (!candidates.length || candidates.some(value => value.ctwaClid !== candidates[0]!.ctwaClid || value.adId !== candidates[0]!.adId)) return null;
  return candidates[0]!;
}
