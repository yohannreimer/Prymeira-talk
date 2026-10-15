import { describe, expect, it, vi } from 'vitest';
import { createOutboundRouter, OutboundUncertainError } from './outbound-router.js';
import { createDeliveryProbe } from './outbound-probes.js';

const phone = '551188880001';
const resolved = '12345678901234@lid';
function fixture() {
  const connection = { id: 'wa', provider: 'waha', status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '554700000000', sessionName: 'wa-session' };
  const db = { channel: { findFirst: vi.fn().mockResolvedValue({ id: 'c', workspaceId: 'w', redundancyEnabled: true, activeConnectionId: 'wa' }) },
    channelConnection: { findMany: vi.fn().mockResolvedValue([{ ...connection, id: 'evo', provider: 'evolution', status: 'disconnected' }, connection]) } };
  const journal = { begin: vi.fn().mockResolvedValue('dispatch'), recordAttempt: vi.fn(), accept: vi.fn(), fail: vi.fn(), markUncertain: vi.fn() };
  const base = { sendText: vi.fn(), sendMedia: vi.fn(), sendAudio: vi.fn(), sendContact: vi.fn() };
  const sent = { providerMessageId: 'true_12345678901234@lid_SENT', raw: { id: 'true_12345678901234@lid_SENT' } };
  const waha = { checkNumber: vi.fn().mockResolvedValue({ numberExists: true, chatId: resolved, pn: '5511988880001@c.us' }),
    sendText: vi.fn(async (_input: { chatId: string }) => sent), sendMedia: vi.fn().mockResolvedValue(sent), sendVoice: vi.fn().mockResolvedValue(sent), sendContact: vi.fn().mockResolvedValue(sent),
    getMessages: vi.fn().mockResolvedValue([]) };
  const client = createOutboundRouter({ db: db as never, journal: journal as never, base: base as never, waha, probeDelayMs: 0,
    probe: createDeliveryProbe({ waha, history: null }) });
  return { client, waha, base, journal };
}

describe('WAHA destination identity', () => {
  it('sends the AI reply to the provider identity, not the phone with the ninth digit removed', async () => {
    const { client, waha, journal } = fixture();
    waha.sendText.mockImplementation(async input => {
      if (input.chatId !== resolved) throw Object.assign(new Error('no LID found for phone from server'), { statusCode: 500 });
      return { providerMessageId: 'SENT', raw: { id: 'true_12345678901234@lid_SENT' } };
    });
    await expect(client.sendText({ instanceName: 'evo', number: phone, text: 'resposta' })).resolves.toMatchObject({ providerMessageId: 'SENT' });
    expect(waha.checkNumber).toHaveBeenCalledWith({ session: 'wa-session', phone });
    expect(waha.sendText).toHaveBeenCalledTimes(1);
    expect(journal.markUncertain).not.toHaveBeenCalled();
  });

  it('uses the resolved identity for quoted replies, media, voice and contact cards', async () => {
    const { client, waha } = fixture();
    await client.sendText({ instanceName: 'evo', number: phone, text: 'sim', quoted: { id: 'Q', fromMe: false, participant: null, body: 'oi' } });
    expect(waha.sendText).toHaveBeenCalledWith(expect.objectContaining({ chatId: resolved, replyTo: `false_${resolved}_Q` }));
    await client.sendMedia({ instanceName: 'evo', number: phone, mediatype: 'image', mimetype: 'image/png', media: 'cG5n', fileName: 'a.png' });
    await client.sendAudio!({ instanceName: 'evo', number: phone, audio: 'b2dn' });
    await client.sendContact!({ instanceName: 'evo', number: phone, contact: [{ fullName: 'Equipe', phoneNumber: '554700000000' }] });
    for (const send of [waha.sendMedia, waha.sendVoice, waha.sendContact]) expect(send).toHaveBeenCalledWith(expect.objectContaining({ chatId: resolved }));
  });

  it.each(['1203-456@g.us', '12345678901234@lid', '5511988880001@c.us'])('preserves an explicit chat identity: %s', async number => {
    const { client, waha } = fixture();
    await client.sendText({ instanceName: 'evo', number, text: 'resposta' });
    expect(waha.checkNumber).not.toHaveBeenCalled();
    expect(waha.sendText).toHaveBeenCalledWith(expect.objectContaining({ chatId: number }));
  });

  it.each(['lookup unavailable', 'not registered', 'different phone', 'invalid address'])('does not send or create an uncertain dispatch when %s', async scenario => {
    const { client, waha, journal, base } = fixture();
    if (scenario === 'lookup unavailable') waha.checkNumber.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    if (scenario === 'not registered') waha.checkNumber.mockResolvedValue({ numberExists: false } as never);
    if (scenario === 'different phone') waha.checkNumber.mockResolvedValue({ numberExists: true, chatId: resolved, pn: '5547999999999@c.us' });
    if (scenario === 'invalid address') waha.checkNumber.mockResolvedValue({ numberExists: true, chatId: 'bad', pn: '5511988880001@c.us' });
    await expect(client.sendText({ instanceName: 'evo', number: phone, text: 'resposta' })).rejects.toMatchObject({ code: 'WAHA_DESTINATION_UNRESOLVED' });
    expect(waha.sendText).not.toHaveBeenCalled();
    expect(base.sendText).not.toHaveBeenCalled();
    expect(journal.fail).toHaveBeenCalled();
    expect(journal.markUncertain).not.toHaveBeenCalled();
  });

  it('probes the resolved chat after a timeout and still never retries the send', async () => {
    const { client, waha, journal } = fixture();
    waha.sendText.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    await expect(client.sendText({ instanceName: 'evo', number: phone, text: 'resposta' })).rejects.toBeInstanceOf(OutboundUncertainError);
    expect(waha.getMessages).toHaveBeenCalledWith({ session: 'wa-session', chatId: resolved, limit: 20 });
    expect(waha.sendText).toHaveBeenCalledTimes(1);
    expect(journal.markUncertain).toHaveBeenCalledTimes(1);
  });
});
