import { describe, expect, it } from 'vitest';
import { normalizeWahaEvent } from './waha-normalizer.js';
import { validateWahaIdentityDeclarations } from '../messaging/identity-declarations.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
const context = { provider: 'waha', channelProvider: 'evolution', workspaceId: 'fixture', channelId: 'fixture', mode: 'live' } as TrustedMessagingContext;
const group = '123-456@g.us', original = '111111111111@lid', recipient = '222222222222@lid';
const receipt = { event: 'message.ack.group', payload: { id: `false_${group}_TARGET_${original}`, from: group, to: recipient, participant: recipient, fromMe: false, ack: 3,
  _data: { Chat: group, Sender: recipient, MessageSender: original, MessageIDs: ['OTHER', 'TARGET'], IsFromMe: false } } };
describe('qualified GOWS ACK roles and non-conversation frames', () => {
  it('keeps the original group-message author separate from the person acknowledging it', () => {
    expect(validateWahaIdentityDeclarations(receipt)).toBeNull();
    expect(normalizeWahaEvent(context, receipt)).toMatchObject({ kind: 'accepted', event: { kind: 'receipt', target: { rawId: 'TARGET', senderParticipant: original, chatAddress: group, direction: 'inbound' }, recipient } });
  });
  it('still holds contradictory recipient, target author and chat evidence', () => {
    expect(validateWahaIdentityDeclarations({ ...receipt, payload: { ...receipt.payload, participant: '333333333333@lid' } })).toBe('contradictory_sender_declarations');
    expect(validateWahaIdentityDeclarations({ ...receipt, payload: { ...receipt.payload, _data: { ...receipt.payload._data, MessageSender: '333333333333@lid' } } })).toBe('contradictory_sender_declarations');
    expect(validateWahaIdentityDeclarations({ ...receipt, payload: { ...receipt.payload, _data: { ...receipt.payload._data, Chat: '999-888@g.us' } } })).toBe('contradictory_chat_declarations');
  });
  it.each(['status@broadcast', '123456@newsletter'])('conserves %s as an ignored frame, without treating its sender as a chat', chat => {
    const input = { event: 'message.any', payload: { id: `false_${chat}_NOTICE_${original}`, from: chat, to: original, participant: original, fromMe: false, _data: { Info: { Chat: chat, Sender: original, ID: 'NOTICE', IsFromMe: false }, Message: { conversation: 'fixture' } } } };
    expect(validateWahaIdentityDeclarations(input)).toBeNull();
    expect(normalizeWahaEvent(context, input)).toMatchObject({ kind: 'ignored', reason: chat === 'status@broadcast' ? 'non_conversation_status' : 'non_conversation_newsletter' });
    expect(normalizeWahaEvent(context, { ...input, payload: { ...input.payload, from: '15550001111@c.us' } })).toMatchObject({ kind: 'invalid', reason: 'contradictory_chat_declarations' });
  });
});
