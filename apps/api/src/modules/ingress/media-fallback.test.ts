import type { PrismaClient } from '@prisma/client';
import { it, expect, vi } from 'vitest';
import { eligibleEvolutionMediaInstance } from './media-fallback.js';
it('permits a proven same-number fallback and rejects unavailable, pairing and different-number sources', async () => {
  const primary = { provider: 'evolution', sessionName: 'fixture', status: 'connected', eligible: true, lifecycleGeneration: 0, verifiedPhoneNumber: '15550001111' };
  const secondary = { provider: 'waha', lifecycleGeneration: 0, verifiedPhoneNumber: '15550001111' };
  let rows = [primary, secondary];
  const db = { message: { findFirst: vi.fn(async () => ({ conversation: { channelId: 'fixture' } })) }, channelConnection: { findMany: vi.fn(async () => rows) } } as unknown as PrismaClient;
  expect(await eligibleEvolutionMediaInstance(db, 'fixture', 'fixture')).toBe('fixture');
  for (const changes of [{ eligible: false }, { status: 'disconnected' }, { lifecycleGeneration: 1 }, { verifiedPhoneNumber: '15559999999' }]) {
    rows = [{ ...primary, ...changes }, secondary];
    expect(await eligibleEvolutionMediaInstance(db, 'fixture', 'fixture')).toBeNull();
  }
});
