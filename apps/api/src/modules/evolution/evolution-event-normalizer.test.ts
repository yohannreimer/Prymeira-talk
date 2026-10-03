import { describe, expect, it } from 'vitest';
import { normalizeEvolutionWebhook } from './evolution-event-normalizer.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
const context: TrustedMessagingContext = { workspaceId: 'w', channelId: 'c', provider: 'evolution', channelProvider: 'evolution', connectionId: 'physical', sessionName: 'bridge', lifecycleGeneration: 0, mode: 'history', observedAt: '2026-09-30T12:00:00Z' };
const key = { id: 'A_B', remoteJid: '777@lid', remoteJidAlt: '5547999990000@s.whatsapp.net', fromMe: false };
function normalize(data: unknown, event = 'MESSAGES_UPSERT') {
  const result = normalizeEvolutionWebhook(context, { event, instance: 'untrusted', data, metadata: { workspaceId: 'foreign' } });
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') throw new Error('Expected event');
  return result.event;
}
describe('Evolution shared event adapter', () => {
  it("recognizes WhatsApp's default animated (lottie) stickers, keeping the quoted reply", () => {
    // Shape observed in production (Evolution 2.4): the sticker is wrapped in lottieStickerMessage.message.
    const sticker = normalize({ key, messageType: 'lottieStickerMessage', message: { messageContextInfo: {}, lottieStickerMessage: { message: { stickerMessage: {
      mimetype: 'application/was', isAnimated: true, isLottie: true,
      contextInfo: { stanzaId: 'Q9', participant: '230794412974089@lid', quotedMessage: { conversation: 'Eu vou ser teu sócio' } } } } } } });
    if (sticker.kind !== 'message') throw new Error('Expected message');
    expect(sticker.content).toMatchObject({ type: 'image', body: 'Figurinha recebida', preview: 'Figurinha recebida' });
    expect(sticker.content.quoted).toEqual({ id: 'Q9', participant: '230794412974089@lid', body: 'Eu vou ser teu sócio' });
    expect(sticker.media).toMatchObject({ kind: 'sticker', hasMedia: true });
  });
  it('keeps the quoted message of a reply and the target of a reaction', () => {
    const reply = normalize({ key, message: { extendedTextMessage: { text: 'sim', contextInfo: { stanzaId: 'Q1', participant: '5547888880000@s.whatsapp.net', quotedMessage: { conversation: 'vai hoje?' } } } } });
    if (reply.kind !== 'message') throw new Error();
    expect(reply.content.quoted).toEqual({ id: 'Q1', participant: '5547888880000@s.whatsapp.net', body: 'vai hoje?' });
    const reaction = normalize({ key: { ...key, id: 'R1' }, message: { reactionMessage: { key: { id: 'T1', remoteJid: key.remoteJid, fromMe: true }, text: '😂' } } });
    if (reaction.kind !== 'message') throw new Error();
    expect(reaction.content).toMatchObject({ type: 'system', body: 'Reagiu com 😂', reaction: { targetId: 'T1', emoji: '😂' } });
    const removed = normalize({ key: { ...key, id: 'R2' }, message: { reactionMessage: { key: { id: 'T1' }, text: '' } } });
    if (removed.kind !== 'message') throw new Error();
    expect(removed.content.reaction).toEqual({ targetId: 'T1', emoji: null });
  });
  it('preserves trusted bridge/history context and only explicit PN/LID evidence', () => {
    const result = normalize({ key, message: { conversation: 'hello' }, pushName: 'Alice' });
    expect(result.context).toEqual(context);
    expect(result.kind).toBe('message');
    expect(result.addressMappings).toEqual([{ role: 'chat', lid: '777@lid', pn: '554799990000@s.whatsapp.net', source: 'evolution.remoteJidAlt' }]);
    if (result.kind !== 'message') return;
    expect(result.key).toMatchObject({ rawId: 'A_B', chatAddress: '777@lid', senderParticipant: '' });
    expect(result.content).toMatchObject({ type: 'text', body: 'hello' });
  });
  it.each([
    ['audioMessage', { seconds: 0 }, 'audio', 'audio', 'Áudio recebido'],
    ['audioMessage', { ptt: true, seconds: 3 }, 'audio', 'audio', 'Áudio recebido'],
    ['imageMessage', { caption: 'Foto pendente' }, 'image', 'image', 'Foto pendente'],
    ['videoMessage', { caption: 'Vídeo pendente' }, 'video', 'file', 'Vídeo pendente'],
    ['documentMessage', { fileName: 'report.pdf', caption: 'Legenda' }, 'document', 'file', 'report.pdf'],
    ['stickerMessage', {}, 'sticker', 'image', 'Figurinha recebida']
  ])('preserves pending %s content independently of URL and MIME', (field, payload, kind, type, body) => {
    const result = normalize({ key, message: { [field as string]: payload } });
    if (result.kind !== 'message') throw new Error('Expected message');
    expect(result.content).toMatchObject({ type, body, preview: body, mediaUrl: null });
    expect(result.media).toEqual({ kind, hasMedia: true, url: null, state: 'pending' });
    expect(result.attachment).not.toHaveProperty('mimeType');
    if (field === 'audioMessage') expect(result.attachment.durationSeconds).toBe((payload as { seconds: number }).seconds);
    if (field === 'documentMessage') expect(result.attachment).toMatchObject({ fileName: 'report.pdf', caption: 'Legenda' });
  });
  it.each([
    ['audioMessage', 'audio', 'Áudio recebido'], ['imageMessage', 'image', 'Imagem recebida'],
    ['videoMessage', 'file', 'Vídeo recebido'], ['documentMessage', 'file', 'Arquivo recebido'],
    ['stickerMessage', 'image', 'Figurinha recebida']
  ])('preserves an explicit pending %s type without a media record', (messageType, type, body) => {
    const result = normalize({ key, messageType });
    if (result.kind !== 'message') throw new Error('Expected message');
    expect(result.content).toMatchObject({ type, body, preview: body });
    expect(result.media).toMatchObject({ hasMedia: true, url: null, state: 'pending' });
  });
  it('retains existing available attachment content and metadata', () => {
    const result = normalize({ key, message: { documentMessage: { url: 'https://media.example/report.pdf', mimetype: 'application/pdf', fileName: 'report.pdf', caption: 'Legenda' } } });
    if (result.kind !== 'message') throw new Error('Expected message');
    expect(result.content).toMatchObject({ type: 'file', body: 'report.pdf', mediaUrl: 'https://media.example/report.pdf' });
    expect(result.attachment).toEqual({ fileName: 'report.pdf', caption: 'Legenda', mimeType: 'application/pdf' });
    expect(result.media?.state).toBe('available');
  });
  it('retains Meta bridge native IDs without asserting a WhatsApp stanza', () => {
    const bridge = { ...context, channelProvider: 'meta' as const, connectionId: null };
    const result = normalizeEvolutionWebhook(bridge, { event: 'MESSAGES_UPSERT', data: { key: { ...key, id: 'wamid.opaque' }, message: { conversation: 'hello' } } });
    if (result.kind !== 'accepted' || result.event.kind !== 'message') throw new Error('Expected bridge message');
    expect(result.event.key).toMatchObject({ nativeId: 'wamid.opaque', rawId: null, identityFormat: 'provider_native' });
  });
  it('classifies real Baileys keys independently of the logical Meta bridge channel', () => {
    const result = normalizeEvolutionWebhook({ ...context, channelProvider: 'meta', connectionId: null }, { event: 'MESSAGES_UPSERT', data: { key, message: { conversation: 'hello' } } });
    if (result.kind !== 'accepted' || result.event.kind !== 'message') throw new Error('Expected bridge message');
    expect(result.event.key).toMatchObject({ identityFormat: 'whatsapp_stanza', rawId: 'A_B' });
  });
  it('keeps group sender distinct from quoted participant or contact card number', () => {
    const result = normalize({ key: { ...key, remoteJidAlt: undefined, remoteJid: '123-456@g.us', participant: '888@lid', participantAlt: '5547999990000@s.whatsapp.net' }, message: { conversation: 'hello', contextInfo: { participant: '999@lid' } } });
    expect(result.addressMappings).toEqual([{ role: 'sender', lid: '888@lid', pn: '554799990000@s.whatsapp.net', source: 'evolution.participantAlt' }]);
    if (result.kind !== 'message') throw new Error('Expected message');
    expect(result.key.senderParticipant).toBe('888@lid');
  });
  it('retains explicit target PN/LID proof without confusing the control action author', () => {
    const group='123-456@g.us', targetPn='15550003333@s.whatsapp.net', actorPn='15550004444@s.whatsapp.net', lid='777@lid';
    const result=normalize({key:{id:'REVOKE',remoteJid:group,fromMe:false,participant:actorPn},message:{protocolMessage:{type:0,key:{id:'ORIGINAL',remoteJid:group,fromMe:false,participant:lid,participantAlt:targetPn}}}});
    expect(result).toMatchObject({kind:'revoke',target:{senderParticipant:lid},action:{senderParticipant:actorPn},addressMappings:[{role:'sender',lid,pn:targetPn,source:'evolution.participantAlt'}]});
  });
  it('preserves complete edit target separately from action and explicit source timestamp', () => {
    const result = normalize({ key: { ...key, id: 'EDIT', fromMe: true }, message: { protocolMessage: { type: 14, key, timestampMs: 123456, editedMessage: { conversation: 'edited' } } } });
    if (result.kind !== 'edit') throw new Error('Expected edit');
    expect(result.target).toMatchObject({ rawId: 'A_B', direction: 'inbound' });
    expect(result.action).toMatchObject({ rawId: 'EDIT', direction: 'outbound' });
    expect(result.order.timestampMs).toBe(123456);
    expect(result.patch).toEqual({ field: 'body', body: 'edited' });
    expect(result).not.toHaveProperty('content');
  });
  it('emits revoke control instead of phantom system message', () => {
    const result = normalize({ key: { ...key, id: 'REVOKE' }, message: { protocolMessage: { type: 0, key } } });
    expect(result.kind).toBe('revoke');
    if (result.kind === 'revoke') expect(result.target.rawId).toBe('A_B');
  });
  it.each([[0, 'failed'], [1, 'pending'], [2, 'sent'], [3, 'delivered'], [4, 'read'], [5, 'read']])('maps receipt %s to %s without invented target scope', (status, expected) => {
    const result = normalize({ id: 'A_B', status }, 'MESSAGES_UPDATE');
    if (result.kind !== 'receipt') throw new Error('Expected receipt');
    expect(result.status).toBe(expected);
    expect(result.providerStatus).toBe(status);
    expect(result.target).toMatchObject({ rawId: 'A_B', chatAddress: null, direction: null, senderParticipant: null });
  });
  it('extracts connection and QR controls', () => {
    expect(normalize({ state: 'open' }, 'CONNECTION_UPDATE')).toMatchObject({ kind: 'control', control: 'connection', status: 'connected' });
    expect(normalize({ qrcode: { base64: 'qr-value' } }, 'QRCODE_UPDATED')).toMatchObject({ kind: 'control', control: 'qr', qrCode: 'qr-value' });
  });
  it.each([{ toString: null }, { toString: { nested: true } }, ['connected'], 42, null].map(state => ({ state })))('returns invalid for malformed connection state $state without claiming health', ({ state }) => {
    expect(normalizeEvolutionWebhook(context, { event: 'CONNECTION_UPDATE', data: { state } })).toEqual({ kind: 'invalid', reason: 'invalid_connection_state' });
    expect(normalizeEvolutionWebhook(context, { event: 'CONNECTION_UPDATE', data: { status: state } })).toEqual({ kind: 'invalid', reason: 'invalid_connection_state' });
  });
  it('rejects object receipt status before reaching the legacy primitive status mapper', () => {
    expect(normalizeEvolutionWebhook(context, { event: 'MESSAGES_UPDATE', data: { id: 'A_B', status: { toString: null } } })).toEqual({ kind: 'invalid', reason: 'invalid_receipt' });
  });
  it('retains encrypted edit as deferred control and never a phantom message', () => {
    const result = normalize({ key: { ...key, id: 'ACTION' }, message: { secretEncryptedMessage: { secretEncType: 2, targetMessageKey: key, encIv: Buffer.alloc(12).toString('base64'), encPayload: Buffer.alloc(40).toString('base64') } } });
    expect(result.kind).toBe('encrypted_edit');
    if (result.kind === 'encrypted_edit') expect(result.target.rawId).toBe('A_B');
  });
  it('rejects invalid message keys and ignores unknown events', () => {
    expect(normalizeEvolutionWebhook(context, { event: 'MESSAGES_UPSERT', data: { key: { id: 'A' } } }).kind).toBe('invalid');
    expect(normalizeEvolutionWebhook(context, { event: 'CONTACTS_UPDATE', data: {} }).kind).toBe('ignored');
  });
});
