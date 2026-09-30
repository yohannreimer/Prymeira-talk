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
  it('preserves trusted bridge/history context and only explicit PN/LID evidence', () => {
    const result = normalize({ key, message: { conversation: 'hello' }, pushName: 'Alice' });
    expect(result.context).toEqual(context);
    expect(result.kind).toBe('message');
    expect(result.addressMappings).toEqual([{ role: 'chat', lid: '777@lid', pn: '554799990000@s.whatsapp.net', source: 'evolution.remoteJidAlt' }]);
    if (result.kind !== 'message') return;
    expect(result.key).toMatchObject({ rawId: 'A_B', chatAddress: '777@lid', senderParticipant: '' });
    expect(result.content).toMatchObject({ type: 'text', body: 'hello' });
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
    const result = normalize({ key: { ...key, remoteJid: '123-456@g.us', participant: '888@lid', participantAlt: '5547999990000@s.whatsapp.net' }, message: { conversation: 'hello', contextInfo: { participant: '999@lid' } } });
    expect(result.addressMappings).toEqual([{ role: 'sender', lid: '888@lid', pn: '554799990000@s.whatsapp.net', source: 'evolution.participantAlt' }]);
    if (result.kind !== 'message') throw new Error('Expected message');
    expect(result.key.senderParticipant).toBe('888@lid');
  });
  it('preserves complete edit target separately from action and explicit source timestamp', () => {
    const result = normalize({ key: { ...key, id: 'EDIT', fromMe: true }, message: { protocolMessage: { type: 14, key, timestampMs: 123456, editedMessage: { conversation: 'edited' } } } });
    if (result.kind !== 'edit') throw new Error('Expected edit');
    expect(result.target).toMatchObject({ rawId: 'A_B', direction: 'inbound' });
    expect(result.action).toMatchObject({ rawId: 'EDIT', direction: 'outbound' });
    expect(result.order.timestampMs).toBe(123456);
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
