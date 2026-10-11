import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@prymeira-talk/shared';
import { mentionNames, parsePixKey, parsePoll, threadWithReactions, withMentionNames } from './message-threading';

const base = { conversationId: 'c', type: 'text', body: '', status: 'delivered', createdAt: '2026-10-05T12:00:00Z' } as const;
const msg = (over: Partial<MessageDto>) => ({ ...base, id: Math.random().toString(36), direction: 'inbound', ...over }) as MessageDto;

describe('polls and Pix keys', () => {
  it('counts one current vote per person on the poll and hides the votes', () => {
    const poll = msg({ whatsappId: 'POLL1', body: '📊 Enquete: Quem joga\n○ Sim\n○ Não' });
    const thread = threadWithReactions([poll,
      msg({ senderJid: 'a@lid', type: 'system', pollVote: { targetWhatsappId: 'POLL1', options: ['Sim'] } }),
      msg({ senderJid: 'b@lid', type: 'system', pollVote: { targetWhatsappId: 'POLL1', options: ['Sim'] } }),
      msg({ senderJid: 'a@lid', type: 'system', pollVote: { targetWhatsappId: 'POLL1', options: ['Não'] } }),
      msg({ direction: 'outbound', type: 'system', pollVote: { targetWhatsappId: 'POLL1', options: ['Não'] } }),
      msg({ senderJid: 'c@lid', type: 'system', pollVote: { targetWhatsappId: 'POLL1', options: null } })]);
    expect(thread.visible).toEqual([poll]);
    const tally = thread.polls.get('POLL1')!;
    expect(tally.voters).toBe(4);
    expect(tally.options.get('Sim')).toEqual({ count: 1, mine: false });
    expect(tally.options.get('Não')).toEqual({ count: 2, mine: true });
    expect(parsePoll(poll.body)).toEqual({ title: 'Quem joga', options: ['Sim', 'Não'] });
    expect(parsePoll('Oi')).toBeNull();
  });
  it('finds the key of a shared Pix key and nothing in ordinary text', () => {
    expect(parsePixKey('💠 Chave Pix\nMALAH GESTORA FINANCEIRA\nE-mail: financeiro@villefer.com.br')).toBe('financeiro@villefer.com.br');
    expect(parsePixKey('Desconto: 5% no PIX')).toBeNull();
  });
  it('draws a group mention as the name Talk knows for that sender', () => {
    const names = mentionNames([msg({ senderJid: '230794412974089@lid', senderName: 'Yohann' }), msg({ senderJid: '5547@lid', senderName: '5547' })]);
    expect(withMentionNames('@230794412974089 ??', names)).toBe('@Yohann ??');
    expect(withMentionNames('@99999999 oi', names)).toBe('@99999999 oi');
  });
});
