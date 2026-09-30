import { describe, expect, it } from 'vitest';
import { normalizeChatAddress, parseWahaMessageKey, canonicalMessageTuple } from './whatsapp-identity.js';

describe('WhatsApp identity boundaries', () => {
  it('normalizes PN with existing Brazil rules and preserves LID/group namespaces', () => {
    expect(normalizeChatAddress('5547999990000@c.us')).toBe('554799990000@s.whatsapp.net');
    expect(normalizeChatAddress('123456789123456@lid')).toBe('123456789123456@lid');
    expect(normalizeChatAddress('123-456@g.us')).toBe('123-456@g.us');
    for (const value of ['me', '123@broadcast', 'x@s.whatsapp.net', 'abc123', '123@lid.evil']) expect(normalizeChatAddress(value)).toBeNull();
  });
  it.each(['A_B', 'A_B_C', 'A_in', 'A_out', 'A_self', 'A_participant'])('retains the entire stanza %s', rawId => {
    expect(parseWahaMessageKey(`false_5547999990000@c.us_${rawId}`)).toMatchObject({ rawId, chatAddress: '554799990000@s.whatsapp.net', direction: 'inbound', senderParticipant: '' });
  });
  it('prefers the structured key over lossy native serialization', () => {
    expect(parseWahaMessageKey({ id: 'A_B_C', remote: { _serialized: '123-456@g.us' }, fromMe: true, participant: { _serialized: '777@lid' }, _serialized: 'true_123-456@g.us_A_B_C_777@lid' })).toMatchObject({ rawId: 'A_B_C', senderParticipant: '777@lid', direction: 'outbound' });
  });
  it('strips only an independently supplied and validated participant suffix', () => {
    expect(parseWahaMessageKey('false_123-456@g.us_A_B_777@lid', '777@lid')).toMatchObject({ rawId: 'A_B', senderParticipant: '777@lid' });
    expect(parseWahaMessageKey('false_123-456@g.us_A_B_777@lid')).toMatchObject({ rawId: null, nativeId: 'false_123-456@g.us_A_B_777@lid', senderParticipant: null });
    expect(parseWahaMessageKey('false_123-456@g.us_A_B')).toMatchObject({ rawId: 'A_B', senderParticipant: null });
  });
  it('retains exact native addresses separately from canonical PN spelling', () => {
    expect(parseWahaMessageKey({ id: 'A_B', remote: '5547999990000@c.us', fromMe: false })).toMatchObject({ nativeChatAddress: '5547999990000@c.us' });
  });
  it('keeps raw target aliases unresolved without inventing scope', () => {
    expect(parseWahaMessageKey('A_B')).toMatchObject({ nativeId: 'A_B', rawId: 'A_B', chatAddress: null, direction: null, senderParticipant: null });
  });
  it('hashes the complete stable tuple without delimiter collisions or content dedup', () => {
    const base = { workspaceId: 'w', channelId: 'c', chatIdentityId: 'chat', rawId: 'A_B', direction: 'inbound' as const, senderParticipant: '' };
    const result = canonicalMessageTuple(base);
    expect(result.tuple).toEqual(['w', 'c', 'chat', 'A_B', 'inbound', '']);
    for (const change of [{ workspaceId: 'w2' }, { channelId: 'c2' }, { chatIdentityId: 'chat2' }, { rawId: 'A' }, { direction: 'outbound' as const }, { senderParticipant: '777@lid' }]) expect(canonicalMessageTuple({ ...base, ...change }).hash).not.toBe(result.hash);
  });
});
