import { describe, expect, it } from 'vitest';
import { normalizeChatAddress } from './whatsapp-identity.js';
import { validateEvolutionIdentityDeclarations, validateWahaIdentityDeclarations } from './identity-declarations.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import { normalizeWahaEvent } from '../waha/waha-normalizer.js';
import type { TrustedMessagingContext } from './normalized-event.js';
const context: TrustedMessagingContext = { workspaceId: 'w', channelId: 'c', provider: 'evolution', channelProvider: 'evolution', connectionId: 'conn', sessionName: 's', lifecycleGeneration: 0, mode: 'live', observedAt: '2026-10-09T12:00:00Z' };
const ack = (sender = '700001:12@lid') => ({ event: 'message.ack', payload: { id: 'true_700001@lid_TARGET', from: '700001@lid', fromMe: true, ack: 3, _data: { Chat: '700001@lid', Sender: sender, MessageSender: '', MessageIDs: ['TARGET'], IsFromMe: false, IsGroup: false } } });
describe('qualified device receipts', () => {
  it('normalizes a qualified device without changing its address namespace', () => {
    expect(normalizeChatAddress('700001:12@lid')).toBe('700001@lid');
    expect(normalizeChatAddress('15550001111:12@s.whatsapp.net')).toBe('15550001111@s.whatsapp.net');
    for (const value of ['700001', '700001:12', '700001:x@lid', '700001:12@lid.evil', '120-100:12@g.us']) expect(normalizeChatAddress(value)).toBeNull();
  });
  it('accepts the GOWS device ACK while conserving its raw bytes and target role', () => {
    const input = ack(), original = structuredClone(input);
    expect(validateWahaIdentityDeclarations(input)).toBeNull();
    const result = normalizeWahaEvent({ ...context, provider: 'waha' }, input);
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') expect(result.event).toMatchObject({ kind: 'receipt', target: { rawId: 'TARGET', chatAddress: '700001@lid', direction: 'outbound' } });
    expect(input).toEqual(original);
  });
  it('still rejects genuinely different ACK recipients', () => {
    const input = ack();
    Object.assign(input.payload, { participant: '700002@lid' });
    expect(validateWahaIdentityDeclarations(input)).toBe('contradictory_sender_declarations');
  });
  it('retains the domain-less Evolution ACK as incomplete instead of inventing a phone', () => {
    const input = { event: 'messages.update', data: { keyId: 'TARGET', remoteJid: '700001', fromMe: true, status: 'READ', participant: '' } };
    const original = structuredClone(input);
    expect(validateEvolutionIdentityDeclarations(input)).toBeNull();
    const result = normalizeEvolutionWebhook(context, input);
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') expect(result.event).toMatchObject({ kind: 'receipt', target: { nativeChatAddress: '700001', chatAddress: null, rawId: 'TARGET', direction: 'outbound' } });
    expect(input).toEqual(original);
  });
  it.each([{ fromMe: false }, { keyId: undefined }, { participant: '700002@lid' }, { key: { id: 'TARGET', remoteJid: '700002@lid', fromMe: true } }])('does not weaken other Evolution declarations: %j', extra => {
    expect(validateEvolutionIdentityDeclarations({ event: 'messages.update', data: { keyId: 'TARGET', remoteJid: '700001', fromMe: true, status: 'READ', ...extra } })).not.toBeNull();
  });
  it('still refuses a domain-less new message', () => {
    expect(normalizeEvolutionWebhook(context, { event: 'messages.upsert', data: { key: { id: 'TARGET', remoteJid: '700001', fromMe: false }, message: { conversation: 'hello' } } }).kind).toBe('invalid');
  });
});
