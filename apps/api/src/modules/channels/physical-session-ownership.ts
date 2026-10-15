import type { PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'channel' | 'channelConnection'>;
export interface PhysicalOwnershipIssue {
  code: 'LOGICAL_SESSION_COLLISION' | 'PHYSICAL_SESSION_COLLISION' | 'UNVERIFIED_INSTANCE' | 'PRIMARY_SESSION_MISMATCH';
  provider: string;
  sessionName: string;
  owners: Array<{ workspaceId: string; channelId: string }>;
}

/** Read-only rollout preflight. It never contacts a provider or changes an ownership claim.
 * An operator must verify the remote instance/webhook and the intended tenant before any
 * existing instance is attested; naming conventions or a local row are insufficient proof. */
export async function inspectPhysicalSessionOwnership(db: Db): Promise<PhysicalOwnershipIssue[]> {
  const [channels, connections] = await Promise.all([
    db.channel.findMany({ select: { id: true, workspaceId: true, provider: true, providerKey: true, providerInstanceClaim: true } }),
    db.channelConnection.findMany({ select: { workspaceId: true, channelId: true, provider: true, sessionName: true } })
  ]);
  const issues: PhysicalOwnershipIssue[] = [];
  const logical = new Map<string, typeof channels>();
  for (const channel of channels) {
    const group = logical.get(channel.providerKey) ?? [];
    group.push(channel); logical.set(channel.providerKey, group);
    if (channel.provider === 'evolution' && channel.providerInstanceClaim !== channel.providerKey) issues.push({
      code: 'UNVERIFIED_INSTANCE', provider: 'evolution', sessionName: channel.providerKey,
      owners: [{ workspaceId: channel.workspaceId, channelId: channel.id }]
    });
  }
  for (const [sessionName, owners] of logical) if (owners.length > 1) issues.push({
    code: 'LOGICAL_SESSION_COLLISION', provider: 'evolution', sessionName,
    owners: owners.map(channel => ({ workspaceId: channel.workspaceId, channelId: channel.id }))
  });
  const physical = new Map<string, typeof connections>();
  for (const connection of connections) {
    const key = `${connection.provider}:${connection.sessionName}`, group = physical.get(key) ?? [];
    group.push(connection); physical.set(key, group);
    const channel = channels.find(channel => channel.workspaceId === connection.workspaceId && channel.id === connection.channelId);
    if (connection.provider === 'evolution' && channel?.providerKey !== connection.sessionName) issues.push({
      code: 'PRIMARY_SESSION_MISMATCH', provider: connection.provider, sessionName: connection.sessionName,
      owners: [{ workspaceId: connection.workspaceId, channelId: connection.channelId }]
    });
  }
  for (const owners of physical.values()) if (owners.length > 1) issues.push({
    code: 'PHYSICAL_SESSION_COLLISION', provider: owners[0]!.provider, sessionName: owners[0]!.sessionName,
    owners: owners.map(connection => ({ workspaceId: connection.workspaceId, channelId: connection.channelId }))
  });
  return issues;
}
