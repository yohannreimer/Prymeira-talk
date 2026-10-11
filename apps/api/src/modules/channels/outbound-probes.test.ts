import { describe, expect, it, vi } from 'vitest';
import { createDeliveryProbe } from './outbound-probes.js';
import type { ConnectionRef } from './outbound-router.js';

const since = new Date('2026-10-02T12:00:00Z');
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const conn = (provider: 'evolution' | 'waha'): ConnectionRef => ({ id: provider, provider, status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '1', lastHealthyAt: null, sessionName: `${provider}-session` });
const input = (provider: 'evolution' | 'waha', over: Record<string, unknown> = {}) => ({ connection: conn(provider), destination: '5547888880000', kind: 'text' as const, text: 'olá,  tudo bem?', since, ...over });

describe('delivery probe', () => {
  it('finds our own text in a WAHA chat by exact body (whitespace-insensitive), after the send began', async () => {
    const getMessages = vi.fn(async () => [
      { id: 'true_5547888880000@c.us_OLD', fromMe: true, body: 'olá, tudo bem?', timestamp: sec('2026-10-02T11:00:00Z') },
      { id: 'false_5547888880000@c.us_THEIRS', fromMe: false, body: 'olá, tudo bem?', timestamp: sec('2026-10-02T12:00:03Z') },
      { id: 'true_5547888880000@c.us_3EB0MINE', fromMe: true, body: 'olá, tudo bem?', timestamp: sec('2026-10-02T12:00:02Z') }
    ]);
    const probe = createDeliveryProbe({ waha: { getMessages } as never, history: null });
    expect(await probe(input('waha'))).toEqual({ found: true, providerMessageId: '3EB0MINE' });
    expect(getMessages).toHaveBeenCalledWith({ session: 'waha-session', chatId: '5547888880000@c.us', limit: 20 });
  });

  it('does not accept an older identical message, a customer message, or a different text', async () => {
    const probe = createDeliveryProbe({ waha: { getMessages: vi.fn(async () => [
      { id: 'true_x@c.us_OLD', fromMe: true, body: 'olá, tudo bem?', timestamp: sec('2026-10-02T11:00:00Z') },
      { id: 'false_x@c.us_THEIRS', fromMe: false, body: 'olá, tudo bem?', timestamp: sec('2026-10-02T12:00:03Z') },
      { id: 'true_x@c.us_OTHER', fromMe: true, body: 'outra coisa', timestamp: sec('2026-10-02T12:00:03Z') }
    ]) } as never, history: null });
    expect(await probe(input('waha'))).toEqual({ found: false, providerMessageId: null });
  });

  it('finds our text in the Evolution history of a direct chat, including extended text', async () => {
    const recentMessages = vi.fn(async () => [
      { key: { id: 'EVO-OLD', remoteJid: '5547888880000@s.whatsapp.net', fromMe: true }, messageTimestamp: sec('2026-10-02T11:00:00Z'), message: { conversation: 'olá, tudo bem?' } },
      { key: { id: 'EVO-MINE', remoteJid: '5547888880000@s.whatsapp.net', fromMe: true }, messageTimestamp: sec('2026-10-02T12:00:01Z'), message: { extendedTextMessage: { text: 'olá, tudo bem?' } } }
    ]);
    const probe = createDeliveryProbe({ waha: null, history: { recentMessages } as never });
    expect(await probe(input('evolution'))).toEqual({ found: true, providerMessageId: 'EVO-MINE' });
    expect(recentMessages).toHaveBeenCalledWith({ instanceName: 'evolution-session', remoteJid: '5547888880000@s.whatsapp.net', limit: 20 });
  });

  it.each([
    ['media', { kind: 'media', text: 'legenda' }],
    ['audio', { kind: 'audio', text: null }],
    ['contact card', { kind: 'contact', text: null }],
    ['empty text', { text: '' }]
  ])('cannot recognise a %s safely, so it answers unknown and leaves it for a person', async (_name, over) => {
    const getMessages = vi.fn(async () => []);
    const probe = createDeliveryProbe({ waha: { getMessages } as never, history: { recentMessages: vi.fn() } as never });
    expect(await probe(input('waha', over))).toBe('unknown');
    expect(await probe(input('evolution', over))).toBe('unknown');
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('answers unknown for an Evolution group chat or when the source is not configured', async () => {
    const probe = createDeliveryProbe({ waha: null, history: { recentMessages: vi.fn() } as never });
    expect(await probe(input('evolution', { destination: '123-456@g.us' }))).toBe('unknown');
    expect(await probe(input('waha'))).toBe('unknown');
    expect(await createDeliveryProbe({ waha: null, history: null })(input('evolution'))).toBe('unknown');
  });
});
