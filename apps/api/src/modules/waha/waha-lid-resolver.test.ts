import { describe, expect, it, vi } from 'vitest';
import { createWahaLidResolver, lidsIn } from './waha-lid-resolver.js';

describe('WAHA LID→phone lookup', () => {
  it('finds every LID an event mentions, bounded', () => {
    expect(lidsIn({ payload: { from: '123456789@lid', id: 'false_123456789@lid_ABC', participant: '987654321@lid' } })).toEqual(['123456789@lid', '987654321@lid']);
    expect(lidsIn({ from: '5547999990000@c.us' })).toEqual([]);
  });
  it('accepts only an answer for exactly that LID with a real phone, and caches it', async () => {
    const findPnByLid = vi.fn(async ({ lid }: { lid: string }) => lid === '111111@lid' ? { lid: '111111@lid', pn: '5547999990000@c.us' }
      : lid === '222222@lid' ? { lid: '333333@lid', pn: '5547999990001@c.us' } : { lid, pn: null });
    const resolver = createWahaLidResolver({ findPnByLid });
    expect(await resolver.resolve('s', { from: '111111@lid', to: '222222@lid', x: '444444@lid' })).toEqual([{ lid: '111111@lid', pn: '554799990000@s.whatsapp.net' }]);
    await resolver.resolve('s', { from: '111111@lid' });
    expect(findPnByLid).toHaveBeenCalledTimes(3); // the proven one came from cache the second time
  });
  it('treats errors as no proof and asks again later', async () => {
    let now = 0;
    const findPnByLid = vi.fn(async () => { throw new Error('down'); });
    const resolver = createWahaLidResolver({ findPnByLid }, { unknownTtlMs: 1000, now: () => now });
    expect(await resolver.resolve('s', { from: '111111@lid' })).toEqual([]);
    expect(await resolver.resolve('s', { from: '111111@lid' })).toEqual([]);
    expect(findPnByLid).toHaveBeenCalledTimes(1);
    now = 2000;
    await resolver.resolve('s', { from: '111111@lid' });
    expect(findPnByLid).toHaveBeenCalledTimes(2);
  });
});
