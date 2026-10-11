import { describe, expect, it, vi } from 'vitest';
import { createOutboundRouter } from './outbound-router.js';

function router(evolutionStatus: 'connected' | 'disconnected', base: Record<string, unknown>) {
  const db = {
    channel: { findFirst: vi.fn(async () => ({ id: 'c', workspaceId: 'w', redundancyEnabled: true, activeConnectionId: 'b' })) },
    channelConnection: { findMany: vi.fn(async () => [
      { id: 'a', provider: 'evolution', status: evolutionStatus, health: 'unknown', eligible: evolutionStatus === 'connected', verifiedPhoneNumber: '554734353573', lastHealthyAt: null, sessionName: 'evo' },
      { id: 'b', provider: 'waha', status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '554734353573', lastHealthyAt: new Date(), sessionName: 'waha-geral' }]) }
  };
  const waha = { sendText: vi.fn(), sendMedia: vi.fn(), sendVoice: vi.fn(), sendContact: vi.fn(),
    getContactProfilePicture: vi.fn(async () => ({ profilePictureURL: 'https://pps.whatsapp.net/waha.jpg' })),
    getGroup: vi.fn(async () => ({ subject: 'Jlle Padel' })),
    checkNumber: vi.fn(async ({ phone }: { phone: string }) => ({ numberExists: phone.endsWith('1'), chatId: `${phone}@c.us` })) };
  return { waha, client: createOutboundRouter({ base: base as never, waha: waha as never, db: db as never, journal: {} as never }) };
}

describe('reads through either session', () => {
  it('asks WAHA for pictures, groups and numbers while Evolution is down', async () => {
    const evolution = { fetchProfilePicture: vi.fn(), getGroupInfo: vi.fn(), checkWhatsappNumbersAvailability: vi.fn() };
    const { client, waha } = router('disconnected', evolution);
    expect(await client.fetchProfilePicture!({ instanceName: 'evo', number: '5547999990001' })).toBe('https://pps.whatsapp.net/waha.jpg');
    expect(waha.getContactProfilePicture).toHaveBeenCalledWith({ session: 'waha-geral', contactId: '5547999990001@c.us' });
    expect(await client.getGroupInfo!({ instanceName: 'evo', groupJid: '1203@g.us' })).toEqual({ subject: 'Jlle Padel' });
    expect((await client.checkWhatsappNumbersAvailability!({ instanceName: 'evo', numbers: ['5547999990001', '5547999990002'] })).numbers)
      .toEqual([{ phone: '5547999990001', available: true, jid: '5547999990001@s.whatsapp.net' }, { phone: '5547999990002', available: false, jid: '5547999990002@s.whatsapp.net' }]);
    expect(evolution.fetchProfilePicture).not.toHaveBeenCalled();
  });
  it('keeps Evolution first while it is up, and falls back to WAHA when it fails', async () => {
    const evolution = { fetchProfilePicture: vi.fn().mockResolvedValueOnce('https://pps.whatsapp.net/evo.jpg').mockRejectedValueOnce(new Error('timeout')) };
    const { client } = router('connected', evolution);
    expect(await client.fetchProfilePicture!({ instanceName: 'evo', number: '5547999990001' })).toBe('https://pps.whatsapp.net/evo.jpg');
    expect(await client.fetchProfilePicture!({ instanceName: 'evo', number: '5547999990001' })).toBe('https://pps.whatsapp.net/waha.jpg');
  });
});
