import { describe, expect, it } from 'vitest';
import { formatPhone, sinceLabel } from './PlatformHealthPage';

describe('health board labels', () => {
  it('says how long ago in minutes, hours or days', () => {
    const now = Date.parse('2026-10-05T16:00:00Z');
    expect(sinceLabel(null, now)).toBe('nunca');
    expect(sinceLabel('2026-10-05T15:59:40Z', now)).toBe('agora');
    expect(sinceLabel('2026-10-05T15:48:00Z', now)).toBe('12 min');
    expect(sinceLabel('2026-10-05T13:00:00Z', now)).toBe('3 h');
    expect(sinceLabel('2026-10-01T16:00:00Z', now)).toBe('4 dias');
  });
  it('formats Brazilian numbers', () => {
    expect(formatPhone('554734353573')).toBe('(47) 3435-3573');
    expect(formatPhone('5547996035412')).toBe('(47) 99603-5412');
    expect(formatPhone(null)).toBe('sem número');
  });
});
