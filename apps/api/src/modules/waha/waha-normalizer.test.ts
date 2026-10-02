import { describe, expect, it } from 'vitest';
import { normalizeWahaEvent } from './waha-normalizer.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
const context: TrustedMessagingContext = { workspaceId: 'w', channelId: 'c', provider: 'waha', channelProvider: 'evolution', connectionId: 'physical', sessionName: 'session', lifecycleGeneration: 2, mode: 'live', observedAt: '2026-09-30T12:00:00.000Z' };
const nativeId = 'false_5547999990000@c.us_A_B_C';
function message(raw: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return { id: 'event', event: 'message.any', session: 'spoof', metadata: { workspaceId: 'other' }, payload: { id: nativeId, from: '5547999990000@c.us', fromMe: false, body: 'Hello', timestamp: 123, _data: { type: 'chat', body: 'Hello', ...raw }, ...payload } };
}
function event(input: unknown) {
  const result = normalizeWahaEvent(context, input);
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') throw new Error('Expected accepted event');
  return result.event;
}
function content(input: unknown) {
  const result = event(input);
  if (result.kind !== 'message') throw new Error('Expected message');
  return result;
}
describe('WAHA 2026.9.1 WPP normalization', () => {
  it.each(['e2e_notification', 'notification_template', 'ciphertext', 'call_log', 'protocol', 'gp2'])('ignores WhatsApp notice %s instead of creating an unrecognized inbound message', type => {
    expect(normalizeWahaEvent(context, message({ type, body: '' }, { body: '' }))).toEqual({ kind: 'ignored', reason: 'provider_system_notice' });
  });
  it('ignores raw notifications whatever their type', () => {
    expect(normalizeWahaEvent(context, message({ type: 'chat', isNotification: true }))).toEqual({ kind: 'ignored', reason: 'provider_system_notice' });
  });
  it('uses trusted context only, retains exact native ID and ignores source app/api as echo evidence', () => {
    const result = content(message({}, { source: 'api' }));
    expect(result.context).toEqual(context);
    expect(result.providerEventType).toBe('message.any');
    expect(result.key).toMatchObject({ nativeId, rawId: 'A_B_C', direction: 'inbound', senderParticipant: '' });
    expect(result.content).toMatchObject({ type: 'text', body: 'Hello' });
    expect(result.source).toBe('api');
    expect(result).not.toHaveProperty('isTalkEcho');
  });
  it.each(['ptt', 'audio'])('preserves %s as audio with Opus MIME and zero duration', type => {
    const result = content(message({ type, mimetype: 'audio/ogg; codecs=opus', duration: 0 }, { hasMedia: true, media: { url: null } }));
    expect(result.content.type).toBe('audio');
    expect(result.attachment).toMatchObject({ mimeType: 'audio/ogg; codecs=opus', durationSeconds: 0 });
    expect(result.media).toMatchObject({ hasMedia: true, url: null, state: 'pending' });
  });
  it.each([undefined, -1, NaN, Infinity, '3'])('does not invent an invalid/missing duration %s', duration => {
    expect(content(message({ type: 'audio', duration })).attachment).not.toHaveProperty('durationSeconds');
  });
  it.each([
    ['image', 'image', 'Legenda', 'image/jpeg'], ['sticker', 'image', 'Figurinha recebida', 'image/webp'],
    ['video', 'file', 'Legenda', 'video/mp4'], ['document', 'file', 'report.pdf', 'application/pdf']
  ])('presents %s compatibly while preserving caption and filename separately', (type, expectedType, body, mimetype) => {
    const result = content(message({ type, caption: 'Legenda', mimetype, filename: type === 'document' ? 'report.pdf' : undefined, duration: 3 }));
    expect(result.content).toMatchObject({ type: expectedType, body });
    expect(result.attachment).toMatchObject({ caption: 'Legenda', mimeType: mimetype });
    if (type === 'document') expect(result.attachment.fileName).toBe('report.pdf');
  });
  it('does not use WPP clientUrl as a media download URL or expose stack details', () => {
    const result = content(message({ type: 'image', clientUrl: 'https://untrusted/opaque', mimetype: 'image/jpeg' }, { hasMedia: true, mediaUrl: 'https://untrusted/opaque', media: { url: null, error: { error: 'Download failed', details: 'SECRET STACK' } } }));
    expect(result.media).toMatchObject({ url: null, state: 'failed', errorCode: 'provider_media_unavailable' });
    expect(JSON.stringify(result)).not.toContain('SECRET STACK');
  });
  it('keeps unknown media unknown rather than understood text', () => {
    const result = content(message({ type: 'mystery', mimetype: 'application/x-unknown' }, { hasMedia: true, body: 'opaque bytes' }));
    expect(result.content.type).toBe('system');
    expect(result.media?.kind).toBe('unknown');
  });
  it('recovers WPP location 0/0 with top-level location null', () => {
    const result = content(message({ type: 'location', lat: 0, lng: 0, loc: 'Place', comment: 'Entry', isLive: true, clientUrl: 'https://not-a-map' }, { location: null }));
    expect(result.content.location).toEqual({ latitude: 0, longitude: 0, name: 'Place', address: 'Entry', isLive: true });
    expect(result.content.body).not.toContain('not-a-map');
    expect(content(message({ type: 'location', lat: Infinity, lng: 10 })).content.location).toMatchObject({ latitude: null, longitude: null });
  });
  it.each(['vcard', 'multi_vcard'])('recovers %s without using shared card numbers as sender evidence', type => {
    const card = 'BEGIN:VCARD\nFN:Someone Else\nTEL;waid=5511988887777:+55 11 98888-7777\nEND:VCARD';
    const result = content(message({ type, body: card, vcardFormattedName: 'Someone Else', vcardList: [{ displayName: 'Someone Else', vcard: card }] }, { vCards: null }));
    expect(result.content.contactCards).toEqual([{ fullName: 'Someone Else', phoneNumber: '5511988887777' }]);
    expect(result.addressMappings).toEqual([]);
    expect(result.key.chatAddress).toBe('554799990000@s.whatsapp.net');
  });
  it('uses group author LID as sender, never recipients, mentions, quoted, or vCard numbers', () => {
    const result = content(message({ author: { _serialized: '777@lid' }, recipients: ['999@lid'], quotedParticipant: '888@lid', sender: { pushname: 'Alice' } }, { id: 'false_123-456@g.us_A_B_777@lid', from: '123-456@g.us', participant: '777@lid' }));
    expect(result.key).toMatchObject({ rawId: 'A_B', chatAddress: '123-456@g.us', senderParticipant: '777@lid' });
    expect(result.pushName).toBe('Alice');
    expect(result.addressMappings).toEqual([]);
  });
  it.each(['object', 'tuple'])('separates full edit target from action in %s WPP payload', shape => {
    const original = { id: 'A_B_C', remote: '123-456@g.us', fromMe: false, participant: '777@lid', _serialized: 'false_123-456@g.us_A_B_C_777@lid' };
    const msg = { body: 'edited', latestEditMsgKey: { id: 'EDIT_2', remote: '123-456@g.us', fromMe: false, participant: '777@lid' }, t: 456 };
    const raw = shape === 'object' ? { chat: '123-456@g.us', id: original, msg } : ['123-456@g.us', original, msg];
    const result = event({ event: 'message.edited', payload: { id: 'false_123-456@g.us_EDIT_2_777@lid', editedMessageId: 'A', body: 'edited', _data: raw } });
    expect(result.kind).toBe('edit');
    if (result.kind !== 'edit') return;
    expect(result.target.rawId).toBe('A_B_C');
    expect(result.action.rawId).toBe('EDIT_2');
    expect(result.action.nativeId).toBe('false_123-456@g.us_EDIT_2_777@lid');
    expect(result.patch).toEqual({ field: 'body', body: 'edited' });
    expect(result).not.toHaveProperty('content');
    expect(result.order.timestampMs).toBeNull();
  });
  it.each(['image', 'video', 'document'])('normalizes %s caption edits without carrying original media bytes or replacement fields', type => {
    const result = event({ event: 'message.edited', payload: { id: 'false_5547999990000@c.us_EDIT_2', body: 'Legenda corrigida', hasMedia: true, media: { url: 'https://waha.example/api/files/existing' }, _data: { id: nativeId, msg: { type, isMedia: true, body: '/9j/4AAQSkZJRgABAQ', caption: 'Legenda corrigida', filename: 'original.pdf', latestEditSenderTimestampMs: 987654321, latestEditMsgKey: { id: 'EDIT_2', remote: '5547999990000@c.us', fromMe: false } } } } });
    if (result.kind !== 'edit') throw new Error('Expected caption edit');
    expect(result.patch).toEqual({ field: 'caption', caption: 'Legenda corrigida' });
    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('attachment');
    expect(result).not.toHaveProperty('media');
    expect(JSON.stringify(result)).not.toContain('/9j/');
    expect(result.order).toEqual({ timestampMs: null, sequence: null });
  });
  it.each(['image', 'video', 'document'])('retains an empty %s caption as explicit removal', type => {
    const result = event({ event: 'message.edited', payload: { id: 'false_5547999990000@c.us_EDIT_2', body: '', hasMedia: true, _data: { id: nativeId, msg: { type, body: '/9j/opaque-original', caption: '' } } } });
    if (result.kind !== 'edit') throw new Error('Expected caption edit');
    expect(result.patch).toEqual({ field: 'caption', caption: '' });
  });
  it('uses WAHA normalized media body when WPP raw caption is absent, never raw body', () => {
    const result = event({ event: 'message.edited', payload: { id: 'false_5547999990000@c.us_EDIT_2', body: 'Legenda normalizada', hasMedia: true, editedMessageId: 'A_B_C', _data: { msg: { type: 'image', body: '/9j/opaque-original' } } } });
    if (result.kind !== 'edit') throw new Error('Expected caption edit');
    expect(result.patch).toEqual({ field: 'caption', caption: 'Legenda normalizada' });
  });
  it('rejects a media edit without any caption evidence instead of using raw bytes', () => {
    expect(normalizeWahaEvent(context, { event: 'message.edited', payload: { id: 'false_5547999990000@c.us_EDIT_2', hasMedia: true, editedMessageId: 'A_B_C', _data: { msg: { type: 'image', body: '/9j/opaque-original' } } } }).kind).toBe('invalid');
  });
  it('separates revoke refId target from action, even when before/after short keys are lossy', () => {
    const result = event({ event: 'message.revoked', payload: { revokedMessageId: 'A', before: { id: 'A', remoteJid: '5547999990000@c.us', fromMe: false }, after: { id: 'R', remoteJid: '5547999990000@c.us', fromMe: true }, _data: { id: 'true_5547999990000@c.us_REVOKE_2', refId: nativeId } } });
    expect(result.kind).toBe('revoke');
    if (result.kind !== 'revoke') return;
    expect(result.target.rawId).toBe('A_B_C');
    expect(result.action.rawId).toBe('REVOKE_2');
  });
  it('does not label the original id as an edit action when WPP lacks an edit key', () => {
    const result = event({ event: 'message.edited', payload: { id: nativeId, editedMessageId: 'A_B_C', body: 'edited', _data: { chat: '5547999990000@c.us', id: nativeId, msg: { id: nativeId, body: 'edited' } } } });
    if (result.kind !== 'edit') throw new Error('Expected edit');
    expect(result.action.rawId).toBeNull();
  });
  it('does not inherit content kinds from Object.prototype', () => {
    const result = content(message({ type: 'constructor' }, { hasMedia: true }));
    expect(result.media?.kind).toBe('unknown');
    expect(result.content.type).toBe('system');
  });
  it('does not infer raw-only target direction/participant from edit action', () => {
    const result = event({ event: 'message.edited', payload: { id: 'true_123-456@g.us_EDIT', from: '123-456@g.us', participant: '777@lid', editedMessageId: 'A_B', body: 'edited' } });
    if (result.kind !== 'edit') throw new Error('expected edit');
    expect(result.target).toMatchObject({ rawId: 'A_B', chatAddress: '123-456@g.us', direction: null, senderParticipant: null });
  });
  it('scopes a raw outbound edit target to the action chat, not the account from address', () => {
    const result = event({ event: 'message.edited', payload: { id: 'true_5547999990000@c.us_EDIT_2', from: '5511999990000@c.us', to: '5547999990000@c.us', fromMe: true, editedMessageId: 'A_B', body: 'edited' } });
    if (result.kind !== 'edit') throw new Error('Expected edit');
    expect(result.target).toMatchObject({ chatAddress: '554799990000@s.whatsapp.net', direction: null, senderParticipant: null });
  });
  it('keeps edit chat unresolved when both target and action are raw IDs', () => {
    const result = event({ event: 'message.edited', payload: { id: 'EDIT_2', from: '5511999990000@c.us', editedMessageId: 'A_B', body: 'edited' } });
    if (result.kind !== 'edit') throw new Error('Expected edit');
    expect(result.target.chatAddress).toBeNull();
  });
  it('keeps revoke chat unresolved when both target and action are raw IDs', () => {
    const result = event({ event: 'message.revoked', payload: { _data: { id: 'REVOKE_2', refId: 'A_B', from: '5511999990000@c.us' } } });
    if (result.kind !== 'revoke') throw new Error('Expected revoke');
    expect(result.target.chatAddress).toBeNull();
  });
  it.each([[-1, 'failed'], [0, 'pending'], [1, 'sent'], [2, 'delivered'], [3, 'read'], [4, 'read']])('maps ACK %s to %s with recipient separate from sender', (ack, status) => {
    const result = event({ event: 'message.ack.group', payload: { id: 'true_123-456@g.us_A_B_777@lid', participant: '777@lid', ack, _data: [{ id: { id: 'A_B', remote: '123-456@g.us', fromMe: true, participant: '777@lid' }, author: '777@lid', sender: '888@lid' }, ack] } });
    expect(result.kind).toBe('receipt');
    if (result.kind !== 'receipt') return;
    expect(result.status).toBe(status);
    expect(result.providerStatus).toBe(ack);
    expect(result.target.senderParticipant).toBe('777@lid');
    expect(result.target.nativeId).toBe('true_123-456@g.us_A_B_777@lid');
    expect(result.recipient).toBe('888@lid');
  });
  it('retains a proven current edit key on message upserts for later reconciliation', () => {
    const result = content(message({ latestEditMsgKey: { id: 'EDIT_2', remote: '5547999990000@c.us', fromMe: false } }));
    expect(result.currentRevision?.rawId).toBe('EDIT_2');
  });
  it('accepts caller verified LID evidence only for the actual chat or sender', () => {
    const input = message({}, { id: 'false_777@lid_A_B', from: '777@lid', metadata: { lid: '777@lid', pn: '5547999990000@c.us' } });
    expect(content(input).addressMappings).toEqual([]);
    const result = normalizeWahaEvent(context, input, { verifiedLidMappings: [{ lid: '777@lid', pn: '5547999990000@c.us' }, { lid: '999@lid', pn: '5511999990000@c.us' }] });
    if (result.kind !== 'accepted') throw new Error('Expected event');
    expect(result.event.addressMappings).toEqual([{ role: 'chat', lid: '777@lid', pn: '554799990000@s.whatsapp.net', source: 'waha.lid_lookup' }]);
  });
  it('retains a full group stanza when native PN and declared LID agree through verified lookup', () => {
    const input = message({author:'777@lid'}, {id:'false_123-456@g.us_A_B_15550003333@s.whatsapp.net',from:'123-456@g.us',participant:'777@lid'});
    expect(normalizeWahaEvent(context,input)).toMatchObject({kind:'invalid',reason:'contradictory_sender_declarations'});
    const result = normalizeWahaEvent(context,input,{verifiedLidMappings:[{lid:'777@lid',pn:'15550003333@s.whatsapp.net'}]});
    expect(result).toMatchObject({kind:'accepted',event:{kind:'message',key:{rawId:'A_B',senderParticipant:'777@lid',nativeSenderParticipant:'777@lid'},addressMappings:[{role:'sender',lid:'777@lid',pn:'15550003333@s.whatsapp.net',source:'waha.lid_lookup'}]}});
  });
  it('retains verified nested edit sender proof for a later raw-guarded receipt', () => {
    const group='123-456@g.us', pn='15550003333@s.whatsapp.net', lid='777@lid';
    const input={event:'message.edited',payload:{id:`false_${group}_EDIT_${pn}`,participant:pn,_data:{id:{id:'ORIGINAL',remote:group,fromMe:false,participant:pn},author:pn,msg:{body:'changed',author:pn,participantAlt:lid,latestEditMsgKey:{id:'EDIT',remote:group,fromMe:false,participant:pn}}}}};
    expect(normalizeWahaEvent(context,input)).toMatchObject({kind:'invalid',reason:'contradictory_sender_declarations'});
    expect(normalizeWahaEvent(context,input,{verifiedLidMappings:[{lid,pn}]})).toMatchObject({kind:'accepted',event:{kind:'edit',target:{senderParticipant:pn},action:{senderParticipant:pn},addressMappings:[{role:'sender',lid,pn,source:'waha.lid_lookup'}]}});
  });
  it('does not accept inherited object properties as session states', () => {
    for (const status of ['__proto__', 'constructor', 'toString']) expect(normalizeWahaEvent(context, { event: 'session.status', payload: { status } }).kind).toBe('invalid');
  });
  it('preserves valid media URL and discards invalid dimensions and sizes', () => {
    const result = content(message({ type: 'image', width: -5, height: Infinity, size: '999', pageCount: -1 }, { media: { url: 'https://waha.example/api/files/a.jpg' } }));
    expect(result.media).toMatchObject({ state: 'available', url: 'https://waha.example/api/files/a.jpg' });
    for (const key of ['width', 'height', 'sizeBytes', 'pageCount']) expect(result.attachment).not.toHaveProperty(key);
  });
  it('rejects WAHA observations for a logical Meta channel', () => {
    expect(normalizeWahaEvent({ ...context, channelProvider: 'meta' } as unknown as TrustedMessagingContext, message()).kind).toBe('invalid');
  });
  it('does not choose from/to for a raw message id without proven direction', () => {
    expect(normalizeWahaEvent(context, message({}, { id: 'A_B', fromMe: undefined, from: '5511999990000@c.us', to: '5547999990000@c.us' })).kind).toBe('invalid');
  });
  it.each([[false, '551199990000@s.whatsapp.net', 'inbound'], [true, '554799990000@s.whatsapp.net', 'outbound']])('uses only the proven %s direction for raw-id chat fallback', (fromMe, chatAddress, direction) => {
    const result = content(message({}, { id: 'A_B', fromMe, from: '5511999990000@c.us', to: '5547999990000@c.us' }));
    expect(result.key).toMatchObject({ rawId: 'A_B', chatAddress, direction });
  });
  it('accepts independent raw.chatId evidence while leaving absent direction unresolved', () => {
    const result = content(message({ chatId: '777@lid' }, { id: 'A_B', fromMe: undefined, from: '5511999990000@c.us' }));
    expect(result.key).toMatchObject({ chatAddress: '777@lid', direction: null });
  });
  it('uses a structured key independently of absent top-level direction', () => {
    const result = content(message({ id: { id: 'A_B', remote: '777@lid', fromMe: true } }, { id: 'native-observation', fromMe: undefined, from: '5511999990000@c.us' }));
    expect(result.key).toMatchObject({ rawId: 'A_B', chatAddress: '777@lid', direction: 'outbound' });
  });
  it.each([{ author: '777@lid' }, { participant: '777@lid' }])('uses explicit revoke author evidence for the action only: %j', evidence => {
    const result = event({ event: 'message.revoked', payload: { ...('participant' in evidence ? evidence : {}), _data: { ...('author' in evidence ? evidence : {}), id: 'true_123-456@g.us_REVOKE_2_777@lid', refId: 'A_B' } } });
    if (result.kind !== 'revoke') throw new Error('Expected revoke');
    expect(result.action).toMatchObject({ rawId: 'REVOKE_2', direction: 'outbound', senderParticipant: '777@lid' });
    expect(result.target).toMatchObject({ rawId: 'A_B', direction: null, senderParticipant: null });
  });
  it.each([{ toString: null }, { toString: { nested: true } }, ['image'], 42, null].map(type => ({ type })))('returns invalid for a malformed WPP edit type $type without coercing JSON objects', ({ type }) => {
    const input = { event: 'message.edited', payload: { id: 'false_5547999990000@c.us_EDIT_2', body: 'edited', editedMessageId: 'A_B_C', _data: { msg: { type, body: 'edited' } } } };
    expect(normalizeWahaEvent(context, input)).toEqual({ kind: 'invalid', reason: 'invalid_edit_type' });
  });
  it('normalizes session control without phantom messages', () => {
    expect(event({ event: 'session.status', payload: { status: 'WORKING' } })).toMatchObject({ kind: 'control', control: 'connection', status: 'connected' });
  });
  it('rejects malformed envelopes and does not create messages for unsupported events', () => {
    for (const value of [null, {}, { event: 'message', payload: null }, message({}, { id: null }), message({}, { fromMe: 'false' })]) expect(normalizeWahaEvent(context, value).kind).toBe('invalid');
    expect(normalizeWahaEvent(context, { event: 'presence.update', payload: {} }).kind).toBe('ignored');
    expect(normalizeWahaEvent(context, { event: 'message.ack', payload: { id: nativeId, ack: 99 } }).kind).toBe('invalid');
  });
});
