import { describe, expect, it } from 'vitest';
import type { NormalizedMessagingEvent } from './normalized-event.js';
import { wellFormedPresentation, wellFormedText } from './well-formed-presentation.js';

describe('well formed display text', () => {
  it('preserves valid Unicode including emoji, pairs and literal escaped text', () => {
    const text = 'Olá 🧑🏽‍💻 😀 🇧🇷 e\u0301 \\ud800';
    expect(wellFormedText(text)).toBe(text);
    expect(wellFormedText(null)).toBeNull();
    expect(wellFormedText(undefined)).toBeUndefined();
  });
  it('replaces isolated high/low surrogates and NUL, preserving valid adjacent pairs', () => {
    expect(wellFormedText('\ud800\ud800\udc00\udc00\u0000')).toBe('�𐀀��');
    for (let code = 0xd800; code <= 0xdfff; code++) {
      expect(wellFormedText(`a${String.fromCharCode(code)}b`)).toBe('a�b');
    }
  });
  it('does not repair identity fields, mutate input, or introduce absent attachment fields', () => {
    const event = { kind: 'message', key: { rawId: '\ud800' }, context: { sessionName: '\ud800' },
      providerEventId: '\ud800', content: { body: '\ud800', preview: '\udfff', mediaUrl: '\ud800',
        quoted: { id: '\ud800', participant: '\ud800', body: '\ud800' },
        reaction: { targetId: '\ud800', emoji: '\udfff' }, pollVote: { targetId: '\ud800', options: ['\ud800'] },
        contactCards: [{ fullName: '\ud800', phoneNumber: '\ud800' }] },
      attachment: {}, pushName: '\ud800' } as unknown as NormalizedMessagingEvent;
    const snapshot = structuredClone(event), result = wellFormedPresentation(event);
    expect(result).toMatchObject({ key: event.kind === 'message' ? event.key : {}, context: event.context,
      providerEventId: '\ud800', pushName: '�', attachment: {}, content: { body: '�', preview: '�', mediaUrl: '\ud800',
        quoted: { id: '\ud800', participant: '\ud800', body: '�' },
        reaction: { targetId: '\ud800', emoji: '�' }, pollVote: { targetId: '\ud800', options: ['�'] },
        contactCards: [{ fullName: '�', phoneNumber: '\ud800' }] } });
    expect(event).toEqual(snapshot);
    expect(wellFormedPresentation(result)).toEqual(result);
    if (result.kind === 'message') expect(Object.keys(result.attachment)).toEqual([]);
  });
  it('repairs edit content while preserving action and target identity', () => {
    for (const patch of [{ field: 'body', body: '\ud800😀' }, { field: 'caption', caption: '\udfff' }] as const) {
      const event = { kind: 'edit', target: { nativeId: '\ud800' }, action: { nativeId: '\udfff' }, patch } as unknown as NormalizedMessagingEvent;
      expect(wellFormedPresentation(event)).toMatchObject({ target: event.kind === 'edit' ? event.target : {},
        action: event.kind === 'edit' ? event.action : {}, patch: patch.field === 'body' ? { field: 'body', body: '�😀' } : { field: 'caption', caption: '�' } });
    }
  });
});
