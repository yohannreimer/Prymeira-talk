import { describe, expect, it } from 'vitest';
import { messageDayLabel, threadPlacement } from './thread-layout';

const now = new Date(2026, 9, 4, 18, 0);
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).toISOString();
const m = (direction: 'inbound' | 'outbound', createdAt: string, senderJid?: string) => ({ direction, createdAt, senderJid, senderName: null, type: 'text' as const });

describe('thread layout', () => {
  it('names the day like WhatsApp', () => {
    expect(messageDayLabel(at(4, 9), now)).toBe('Hoje');
    expect(messageDayLabel(at(3, 23), now)).toBe('Ontem');
    expect(messageDayLabel(at(30, 10).replace('2026-10', '2026-09'), now)).toMatch(/^[A-ZÁÉÍÓÚ]/);
    expect(messageDayLabel(new Date(2026, 8, 1, 10).toISOString(), now)).toBe('1 de setembro');
    expect(messageDayLabel(new Date(2025, 11, 24, 10).toISOString(), now)).toBe('24/12/2025');
  });
  it('groups consecutive messages of the same author, never across days', () => {
    const thread = [m('inbound', at(3, 10)), m('inbound', at(4, 9)), m('inbound', at(4, 9)), m('outbound', at(4, 10)), m('outbound', at(4, 10))];
    expect(thread.map((_m, i) => threadPlacement(thread, i, false))).toEqual([
      { newDay: true, startsRun: true, endsRun: true },
      { newDay: true, startsRun: true, endsRun: false },
      { newDay: false, startsRun: false, endsRun: true },
      { newDay: false, startsRun: true, endsRun: false },
      { newDay: false, startsRun: false, endsRun: true }
    ]);
  });
  it('in a group, each participant starts a new run', () => {
    const thread = [m('inbound', at(4, 9), 'a@s'), m('inbound', at(4, 9), 'b@s'), m('inbound', at(4, 9), 'b@s')];
    expect(thread.map((_m, i) => threadPlacement(thread, i, true).startsRun)).toEqual([true, true, false]);
  });
});
