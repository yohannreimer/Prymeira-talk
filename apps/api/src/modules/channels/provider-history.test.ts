import { describe, expect, it, vi } from 'vitest';
import type { ChannelConnection, PrismaClient } from '@prisma/client';
import { pairedConnections, recoverGapsSweep } from './provider-history.js';

const connection = (overrides: Partial<ChannelConnection> = {}) => ({
  id: 'evo', workspaceId: 'fixture', channelId: 'channel', provider: 'evolution',
  status: 'connected', eligible: true, lifecycleGeneration: 0,
  verifiedPhoneNumber: '5547999998888', lastHealthyAt: new Date(), ...overrides
} as ChannelConnection);
const database = (rows: ChannelConnection[]) => ({ channelConnection: { findMany: vi.fn(async () => rows) } } as unknown as PrismaClient);

describe('provider recovery eligibility', () => {
  it('does not repeatedly query an Evolution connection known to be unavailable', async () => {
    const db = database([connection({ eligible: false, lastError: 'PROVIDER_UNAVAILABLE' })]);
    expect(await pairedConnections(db, {})).toEqual([]);
    const recentChats = vi.fn();
    expect(await recoverGapsSweep(db, { evolution: { recentChats, recentMessages: vi.fn() } })).toEqual({ recovered: 0 });
    expect(recentChats).not.toHaveBeenCalled();
  });
  it('keeps a usable primary eligible for recovery', async () => {
    const primary = connection();
    expect(await pairedConnections(database([primary]), {})).toEqual([primary]);
  });
  it('retains the primary identity proof for a healthy WAHA even when Evolution is unavailable', async () => {
    const primary = connection({ eligible: false });
    const waha = connection({ id: 'wa', provider: 'waha' });
    expect(await pairedConnections(database([primary, waha]), {})).toEqual([waha]);
  });
  it('does not read an ineligible or differently paired WAHA', async () => {
    const primary = connection();
    const unavailable = connection({ id: 'wa', provider: 'waha', eligible: false });
    const different = connection({ id: 'other', provider: 'waha', verifiedPhoneNumber: '5511999997777' });
    expect(await pairedConnections(database([primary, unavailable, different]), {})).toEqual([primary]);
  });
});
