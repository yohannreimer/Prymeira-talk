import { describe, expect, it } from 'vitest';
import type { ChannelConnectionDto, ChannelQrResultDto, RealtimeEvent } from '@prymeira-talk/shared';
import { applyQrUpdate, connectionCount, connectionDisplay, connectionSummary, qrKey } from './connection-display';
type Update = Extract<RealtimeEvent, { type: 'channel.qr_updated' }>['payload'];
const connection: ChannelConnectionDto = { id: 'primary', channelId: 'channel', provider: 'evolution', sessionName: 'primary', status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: null, isActiveWriter: true, lastCheckedAt: null };
const qr: ChannelQrResultDto = { mode: 'real', channel: { id: 'channel', workspaceId: 'workspace', provider: 'evolution', providerKey: 'primary', phoneNumber: null, displayName: null, status: 'connected', createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' }, connectionId: 'primary', provider: 'evolution', qrCode: 'old', qr: { payload: 'old', issuedAt: '2026-09-30T12:00:00.000Z', expiresAt: '2026-09-30T12:01:00.000Z' } };
describe('physical connection display state', () => {
  it('shares provider status, health and sender labels between list and drawer', () => {
    expect(connectionDisplay({ ...qr.channel, connections: [
      { ...connection, health: 'degraded', isActiveWriter: false },
      { ...connection, id: 'secondary', provider: 'waha', isActiveWriter: true }
    ] })).toMatchObject([
      { provider: 'evolution', label: 'Evolution', statusLabel: 'Conectado', healthLabel: 'Degradada', isActiveWriter: false },
      { provider: 'waha', label: 'WAHA', statusLabel: 'Conectado', healthLabel: 'Saudável', isActiveWriter: true }
    ]);
    expect(connectionDisplay({ ...qr.channel, provider: 'meta_cloud' })).toEqual([]);
  });
  it('counts connected degraded sessions separately from eligibility and distinguishes QR keys', () => {
    expect(connectionCount({ status: 'connected', connections: [connection, { ...connection, id: 'secondary', provider: 'waha', health: 'degraded', eligible: false }] })).toBe('2 de 2 conectados');
    expect(connectionCount({ status: 'disconnected', connections: [] })).toBe('0 de 2 conectados');
    expect(connectionCount({ status: 'connected' })).toBe('1 de 2 conectados');
    expect(qrKey(qr)).not.toBe(qrKey({ ...qr, connectionId: 'secondary', provider: 'waha' }));
  });
  it('rejects stale, expired, other-channel and other-connection updates including unidentified WAHA events', () => {
    const event: Update = { channelId: 'channel', connectionId: 'primary', provider: 'evolution', qrCode: 'new', issuedAt: '2026-09-30T12:00:20.000Z', expiresAt: '2026-09-30T12:01:20.000Z' };
    const now = Date.parse('2026-09-30T12:00:30.000Z');
    expect(applyQrUpdate(qr, event, now)?.qrCode).toBe('new');
    const invalid: Partial<Update>[] = [{ connectionId: 'secondary' }, { channelId: 'other' }, { provider: 'waha', connectionId: undefined }, { issuedAt: '2026-09-30T11:59:50.000Z' }, { expiresAt: '2026-09-30T12:00:20.000Z' }];
    for (const change of invalid) expect(applyQrUpdate(qr, { ...event, ...change }, now)).toBe(qr);
  });
});

describe('connections panel summary', () => {
  const conn = (provider: 'evolution' | 'waha', status: string, health = 'healthy') => ({ id: provider, channelId: 'c', provider, sessionName: provider, status, health, verifiedPhoneNumber: null, eligible: true, isActiveWriter: false, lastCheckedAt: null }) as never;
  it('says everything is fine, that one connection fell, or that WhatsApp is disconnected', () => {
    expect(connectionSummary({ provider: 'evolution', status: 'connected', redundancyEnabled: true, connections: [conn('evolution', 'connected'), conn('waha', 'connected')] }))
      .toMatchObject({ tone: 'ok', title: 'Tudo funcionando', count: '2 de 2 conexões ativas' });
    expect(connectionSummary({ provider: 'evolution', status: 'connected', redundancyEnabled: true, connections: [conn('evolution', 'connected'), conn('waha', 'disconnected')] }))
      .toMatchObject({ tone: 'warning', title: 'Uma conexão caiu' });
    expect(connectionSummary({ provider: 'evolution', status: 'disconnected', redundancyEnabled: false, connections: [conn('evolution', 'disconnected')] }))
      .toMatchObject({ tone: 'down', title: 'WhatsApp desconectado', count: '0 de 1 conexão ativa' });
    expect(connectionSummary({ provider: 'evolution', status: 'connected', redundancyEnabled: false, connections: [conn('evolution', 'connected', 'degraded')] }))
      .toMatchObject({ tone: 'warning', title: 'Conexão instável' });
  });
});
