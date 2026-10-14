import { describe, expect, it } from 'vitest';
import { formatConversationCardDate } from './conversation-card-date';

describe('conversation card date', () => {
  const now = new Date(2026, 8, 1, 9, 0);

  it('uses local calendar days across a month boundary', () => {
    expect(formatConversationCardDate(new Date(2026, 8, 1, 14, 6).toISOString(), now)).toEqual({ day: 'Hoje', time: '14:06' });
    expect(formatConversationCardDate(new Date(2026, 7, 31, 23, 50).toISOString(), now)).toEqual({ day: 'Ontem', time: '23:50' });
    expect(formatConversationCardDate(new Date(2026, 7, 30, 16, 54).toISOString(), now)).toEqual({ day: '30/08', time: '16:54' });
  });
});
