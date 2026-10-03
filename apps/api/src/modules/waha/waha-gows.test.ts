import { describe, expect, it } from 'vitest';
import { normalizeWahaEvent } from './waha-normalizer.js';
import { parseExactWahaResponse } from '../messaging/provider-exact.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
import { normalizeChatAddress } from '../messaging/whatsapp-identity.js';

const context: TrustedMessagingContext = { workspaceId: 'w', channelId: 'c', provider: 'waha', channelProvider: 'evolution', connectionId: 'physical', sessionName: 'session', lifecycleGeneration: 2, mode: 'live', observedAt: '2026-10-03T12:00:00.000Z' };
const PHONE = '5547999990000', CUS = `${PHONE}@c.us`, S = `${PHONE}@s.whatsapp.net`, GROUP = '120363000000000000@g.us';
/** What WAHA 2026.9.1 GOWS toWAMessage emits: `from` is always the chat, `_data` is whatsmeow's event (Go JSON names). */
function gows(input: { id: string; fromMe?: boolean; group?: boolean; sender?: string; body?: string; message: Record<string, unknown>; hasMedia?: boolean; media?: unknown }) {
  const fromMe = input.fromMe ?? false, chat = input.group ? GROUP : CUS, sender = input.sender ?? (input.group ? '5547888880000@c.us' : CUS);
  const id = input.group ? `${fromMe}_${chat}_${input.id}_${sender}` : `${fromMe}_${chat}_${input.id}`;
  return { id, timestamp: 1759500000, from: chat, fromMe, source: 'app', body: input.body ?? '', to: input.group ? sender : null, participant: input.group ? sender : null,
    hasMedia: input.hasMedia ?? false, media: input.media ?? null, ack: 2, location: null, vCards: [],
    _data: { Info: { Chat: input.group ? GROUP : S, Sender: input.group ? sender.replace('@c.us', '@s.whatsapp.net') : S, IsFromMe: fromMe, IsGroup: !!input.group, ID: input.id,
      PushName: 'Bia', Timestamp: '2026-10-03T10:00:00Z', Type: 'text' }, Message: input.message } };
}
const accepted = (payload: unknown, event = 'message.any') => {
  const result = normalizeWahaEvent(context, { id: 'evt', event, session: 'session', payload }, { verifiedLidMappings: [] });
  if (result.kind !== 'accepted') throw new Error(`expected accepted, got ${JSON.stringify(result)}`);
  return result.event;
};

describe('WAHA GOWS engine events', () => {
  it('inbound text: identity, direction, body, push name and time', () => {
    const event = accepted(gows({ id: '3EB0A1', body: 'Oi', message: { conversation: 'Oi' } }));
    if (event.kind !== 'message') throw new Error();
    expect(event.key).toMatchObject({ direction: 'inbound', rawId: '3EB0A1', chatAddress: normalizeChatAddress(S) });
    expect(event.content).toMatchObject({ type: 'text', body: 'Oi' });
    expect(event.pushName).toBe('Bia');
    expect(event.order.timestampMs).toBe(1759500000_000);
  });
  it('our own message from the phone is outbound in the same chat', () => {
    const event = accepted(gows({ id: '3EB0A2', fromMe: true, body: 'tudo certo', message: { extendedTextMessage: { text: 'tudo certo' } } }));
    if (event.kind !== 'message') throw new Error();
    expect(event.key).toMatchObject({ direction: 'outbound', chatAddress: normalizeChatAddress(S) });
    expect(event.content.body).toBe('tudo certo');
  });
  it('group message keeps the sender, including our own messages in the group', () => {
    const inbound = accepted(gows({ id: 'G1', group: true, body: 'bom dia', message: { conversation: 'bom dia' } }));
    const ours = accepted(gows({ id: 'G2', group: true, fromMe: true, sender: '5547777770000@c.us', body: 'oi grupo', message: { conversation: 'oi grupo' } }));
    if (inbound.kind !== 'message' || ours.kind !== 'message') throw new Error();
    expect(inbound.key).toMatchObject({ chatAddress: GROUP, senderParticipant: normalizeChatAddress('5547888880000@s.whatsapp.net'), direction: 'inbound' });
    expect(ours.key).toMatchObject({ chatAddress: GROUP, direction: 'outbound' });
  });
  it('voice note, image with caption, document and location', () => {
    const voice = accepted(gows({ id: 'M1', hasMedia: true, message: { audioMessage: { PTT: true, seconds: 7, mimetype: 'audio/ogg; codecs=opus', URL: 'https://mmg.whatsapp.net/x' } } }));
    const image = accepted(gows({ id: 'M2', hasMedia: true, body: 'olha', message: { imageMessage: { caption: 'olha', mimetype: 'image/jpeg', width: 800, height: 600 } } }));
    const pdf = accepted(gows({ id: 'M3', hasMedia: true, message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'orcamento.pdf', mimetype: 'application/pdf' } } } } }));
    const place = accepted(gows({ id: 'M4', message: { locationMessage: { degreesLatitude: -26.9, degreesLongitude: -49.07, name: 'Loja' } } }));
    if (voice.kind !== 'message' || image.kind !== 'message' || pdf.kind !== 'message' || place.kind !== 'message') throw new Error();
    expect(voice.content.type).toBe('audio'); expect(voice.attachment).toMatchObject({ durationSeconds: 7 }); expect(voice.media).toMatchObject({ kind: 'audio', hasMedia: true });
    expect(image.content).toMatchObject({ type: 'image', body: 'olha' });
    expect(pdf.content).toMatchObject({ type: 'file', body: 'orcamento.pdf' });
    expect(place.content.location).toMatchObject({ latitude: -26.9, longitude: -49.07, name: 'Loja' });
  });
  it('receipts, edits and revokes', () => {
    const receipt = accepted({ id: `true_${CUS}_3EB0A2`, from: CUS, to: null, participant: null, fromMe: true, ack: 3, ackName: 'READ', _data: { Chat: S, Sender: S, MessageIDs: ['3EB0A2'], Type: 'read', IsFromMe: false } }, 'message.ack');
    expect(receipt).toMatchObject({ kind: 'receipt', status: 'read', target: { rawId: '3EB0A2', direction: 'outbound' } });
    const edit = accepted({ ...gows({ id: 'E1', fromMe: true, body: 'corrigido', message: { protocolMessage: { type: 14, key: { ID: '3EB0A2' } } } }), editedMessageId: '3EB0A2' }, 'message.edited');
    expect(edit).toMatchObject({ kind: 'edit', target: { rawId: '3EB0A2' }, patch: { field: 'body', body: 'corrigido' } });
    const after = gows({ id: 'R1', message: { protocolMessage: { type: 0, key: { ID: '3EB0A1' } } } });
    const revoke = accepted({ after, before: null, revokedMessageId: '3EB0A1', _data: after._data }, 'message.revoked');
    expect(revoke).toMatchObject({ kind: 'revoke', target: { rawId: '3EB0A1' } });
  });
  it('exact lookups (media) accept GOWS messages, including our own in groups', () => {
    expect(parseExactWahaResponse(gows({ id: 'G2', group: true, fromMe: true, sender: '5547777770000@c.us', message: { conversation: 'x' } }))).toMatchObject({ rawId: 'G2', direction: 'outbound', chatAddress: GROUP });
  });
  it('reactions and replies', () => {
    const reaction = accepted({ id: `false_${CUS}_R9`, from: CUS, fromMe: false, participant: null, timestamp: 1759500000, reaction: { text: '👍', messageId: `true_${CUS}_3EB0A2` } }, 'message.reaction');
    expect(reaction).toMatchObject({ kind: 'message', key: { rawId: 'R9', direction: 'inbound' }, content: { type: 'system', reaction: { targetId: '3EB0A2', emoji: '👍' } } });
    const reply = accepted({ ...gows({ id: 'Q2', body: 'sim', message: { extendedTextMessage: { text: 'sim' } } }), replyTo: { id: '3EB0A2', participant: CUS, body: 'vai hoje?' } });
    if (reply.kind !== 'message') throw new Error();
    expect(reply.content.quoted).toEqual({ id: '3EB0A2', participant: CUS, body: 'vai hoje?' });
  });
  it('WPP events are untouched (fallback engine)', () => {
    const event = accepted({ id: `false_${CUS}_W1`, from: CUS, fromMe: false, body: 'Hello', timestamp: 123, _data: { type: 'chat', body: 'Hello' } });
    expect(event).toMatchObject({ kind: 'message', content: { body: 'Hello' } });
  });
});
