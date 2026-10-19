import { describe, expect, it } from 'vitest';
import type { ConversationDto, MessageDto } from '@prymeira-talk/shared';
import { canForward, conversationMatches, displayPhone, forwardSelectionSummary, forwardSummary } from './ForwardDialog';
import { missingLabel, withoutLabel } from './QuickReplyFill';

const message = (patch: Partial<MessageDto>) => ({ id: 'm1', type: 'text', direction: 'inbound', status: 'delivered', body: 'Oi', ...patch }) as MessageDto;
const conversation = (patch: Partial<ConversationDto>) => ({ id: 'c1', contactId: 'k1', contactName: 'Jackson Cappelli', contactPhone: '5547999990001', ...patch }) as ConversationDto;

describe('forwarding', () => {
  it('forwards text and files, never reactions, deleted, unsent, maps or cards', () => {
    expect(canForward(message({}))).toBe(true);
    expect(canForward(message({ type: 'audio', body: 'Áudio recebido' }))).toBe(true);
    expect(canForward(message({ deletedAt: '2026-10-04T00:00:00.000Z' }))).toBe(false);
    expect(canForward(message({ direction: 'outbound', status: 'failed' }))).toBe(false);
    expect(canForward(message({ reaction: { targetWhatsappId: 'x', emoji: '👍' } }))).toBe(false);
    expect(canForward(message({ contactCards: [{ fullName: 'A', phoneNumber: '5547999463048' }] }))).toBe(true);
    expect(canForward(message({ contactCards: [{ fullName: 'A', phoneNumber: null }] }))).toBe(false);
    expect(canForward(message({ type: 'system' }))).toBe(false);
  });
  it('summarizes what goes out', () => {
    expect(forwardSummary(message({ type: 'image', attachment: { caption: 'Planta' } }))).toBe('Foto · Planta');
    expect(forwardSummary(message({ type: 'file', attachment: { fileName: 'orcamento.pdf' } }))).toBe('orcamento.pdf');
    expect(forwardSummary(message({ type: 'file', attachment: { mimeType: 'video/mp4' } }))).toBe('Vídeo');
    expect(forwardSummary(message({ type: 'audio' }))).toBe('Áudio');
    expect(forwardSummary(message({ contactCards: [{ fullName: 'Mamãe linda', phoneNumber: '1' }] }))).toBe('Contato · Mamãe linda');
    expect(forwardSelectionSummary([message({}), message({ id: 'm2' }), message({ id: 'm3' })])).toBe('3 mensagens');
  });
  it('finds a conversation by name without accents or by part of the number', () => {
    expect(conversationMatches(conversation({ contactName: 'Mamãe linda' }), 'mamae')).toBe(true);
    expect(conversationMatches(conversation({}), '(47) 99999')).toBe(true);
    expect(conversationMatches(conversation({}), 'maria')).toBe(false);
    expect(displayPhone('5547999990001')).toBe('+55 47 99999-0001');
  });
  it('names what a quick reply lacks', () => {
    expect([missingLabel(['primeiro_nome']), withoutLabel(['primeiro_nome'])]).toEqual(['o nome', 'Sem nome']);
    expect([missingLabel(['empresa', 'nome']), withoutLabel(['empresa', 'nome'])]).toEqual(['o nome e a empresa', 'Sem esses dados']);
  });
});
