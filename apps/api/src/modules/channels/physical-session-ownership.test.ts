import { describe, expect, it, vi } from 'vitest';
import { inspectPhysicalSessionOwnership } from './physical-session-ownership.js';

describe('read-only physical ownership preflight', () => {
  it('lists collisions, unverified instances and mismatched physical bindings without provider I/O or mutation', async () => {
    const db = { channel: { findMany: vi.fn(async () => [
      { id: 'a', workspaceId: 'a-w', provider: 'evolution', providerKey: 'shared', providerInstanceClaim: 'shared' },
      { id: 'b', workspaceId: 'b-w', provider: 'evolution', providerKey: 'shared', providerInstanceClaim: null }
    ]) }, channelConnection: { findMany: vi.fn(async () => [
      { workspaceId: 'a-w', channelId: 'a', provider: 'waha', sessionName: 'wa-shared' },
      { workspaceId: 'b-w', channelId: 'b', provider: 'waha', sessionName: 'wa-shared' },
      { workspaceId: 'a-w', channelId: 'a', provider: 'evolution', sessionName: 'other' }
    ]) } };
    const issues = await inspectPhysicalSessionOwnership(db as never);
    expect(issues.map(issue => issue.code).sort()).toEqual(['LOGICAL_SESSION_COLLISION', 'PHYSICAL_SESSION_COLLISION', 'PRIMARY_SESSION_MISMATCH', 'UNVERIFIED_INSTANCE']);
    expect(db.channel.findMany).toHaveBeenCalledTimes(1); expect(db.channelConnection.findMany).toHaveBeenCalledTimes(1);
  });
});
