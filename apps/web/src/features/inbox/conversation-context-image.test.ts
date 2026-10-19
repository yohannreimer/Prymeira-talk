import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@prymeira-talk/shared';
import { selectRecentContextMessages } from './conversation-context-image';

function message(index: number, type: MessageDto['type'] = 'text', status: MessageDto['status'] = 'sent') {
  return { id: `message-${index}`, direction: 'inbound' as const, type, body: `Mensagem ${index}`, status, createdAt: '2026-09-28T12:00:00.000Z' };
}

describe('conversation context image', () => {
  it('keeps exactly the latest fourteen delivered customer-visible messages in order', () => {
    const messages = Array.from({ length: 17 }, (_, index) => message(index));
    messages.splice(15, 0, message(50, 'internal_note'), message(51, 'system'), message(52, 'text', 'failed'));
    const recent = selectRecentContextMessages(messages);
    expect(recent).toHaveLength(14);
    expect(recent[0]?.id).toBe('message-3');
    expect(recent.at(-1)?.id).toBe('message-16');
    expect(recent.some((item) => item.type === 'internal_note' || item.type === 'system' || item.status === 'failed')).toBe(false);
  });
});
