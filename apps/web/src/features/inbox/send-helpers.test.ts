import { describe, expect, it } from 'vitest';
import { normalizeRecipientPhone } from './send-helpers';

describe('manual WhatsApp recipients', () => {
  it('normalizes Brazilian local and country-code numbers like the contact database', () => {
    expect(normalizeRecipientPhone('(47) 99139-6920')).toBe('554791396920');
    expect(normalizeRecipientPhone('+55 47 99139-6920')).toBe('554791396920');
    expect(normalizeRecipientPhone('554791396920')).toBe('554791396920');
  });

  it('rejects incomplete numbers before they can enter a send review', () => {
    expect(normalizeRecipientPhone('479139692')).toBeNull();
    expect(normalizeRecipientPhone('123')).toBeNull();
  });
});
