import type { Prisma } from '@prisma/client';
import type { TrustedMessagingContext } from './normalized-event.js';
import { record } from './whatsapp-identity.js';

export class StaleMessagingSourceError extends Error {
  readonly code = 'stale_source';
  constructor(message = 'Stale messaging source; explicit recertification required') { super(message); this.name = 'StaleMessagingSourceError'; }
}
export type MessagingProvider = TrustedMessagingContext['provider'];
/** DB/authentication adapter: call only after verifying the transport credential and
 * selecting the configured workspace/channel. Never pass webhook metadata here.
 * The transaction boundary rechecks this snapshot before any domain access. */
export async function deriveTrustedMessagingContext(tx: Prisma.TransactionClient, input: {
  workspaceId: string; channelId: string;
  authenticatedSource: { provider: 'evolution' | 'waha'; connectionId: string } |
    { provider: 'evolution'; connectionId: null; sessionName: string } |
    { provider: 'meta_official'; connectionId: null; phoneNumberId: string };
  mode: TrustedMessagingContext['mode']; observedAt: string;
}): Promise<TrustedMessagingContext> {
  const channel = await tx.channel.findFirst({ where: { workspaceId: input.workspaceId, id: input.channelId } });
  if (!channel) throw new StaleMessagingSourceError('Invalid channel scope');
  const source = input.authenticatedSource;
  const common = { workspaceId: input.workspaceId, channelId: input.channelId, mode: input.mode, observedAt: input.observedAt };
  let result: TrustedMessagingContext;
  if (source.connectionId !== null) {
    const connection = await tx.channelConnection.findFirst({ where: { workspaceId: input.workspaceId, channelId: input.channelId, id: source.connectionId, provider: source.provider } });
    if (!connection || channel.provider !== 'evolution') throw new StaleMessagingSourceError('Invalid connection scope');
    result = { ...common, channelProvider: 'evolution', provider: source.provider, connectionId: connection.id, sessionName: connection.sessionName, lifecycleGeneration: connection.lifecycleGeneration };
  } else if (source.provider === 'meta_official') {
    result = { ...common, channelProvider: 'meta', provider: 'meta_official', connectionId: null, phoneNumberId: source.phoneNumberId, sessionName: source.phoneNumberId, lifecycleGeneration: channel.connectionLifecycleGeneration };
  } else {
    result = { ...common, channelProvider: 'meta', provider: 'evolution', connectionId: null, sessionName: source.sessionName, lifecycleGeneration: channel.connectionLifecycleGeneration };
  }
  await assertCurrentMessagingSource(tx, result);
  return Object.freeze(result);
}

/** No writes. Caller owns the canonical boundary when this check protects writes. */
export async function assertCurrentMessagingSource(tx: Prisma.TransactionClient, c: TrustedMessagingContext) {
  const channel = await tx.channel.findFirst({ where: { workspaceId: c.workspaceId, id: c.channelId } });
  if (!channel || channel.provider !== (c.channelProvider === 'meta' ? 'meta_cloud' : 'evolution')) throw new StaleMessagingSourceError('Invalid channel scope');
  if (c.provider === 'waha' && (channel.provider !== 'evolution' || !c.connectionId)) throw new StaleMessagingSourceError('Invalid WAHA scope');
  if (!Number.isSafeInteger(c.lifecycleGeneration) || c.lifecycleGeneration < 0 || !c.sessionName) throw new StaleMessagingSourceError();
  if (c.connectionId !== null) {
    if (String(c.provider) === 'meta_official' || channel.provider !== 'evolution') throw new StaleMessagingSourceError('Invalid connection scope');
    const connection = await tx.channelConnection.findFirst({ where: { workspaceId: c.workspaceId, channelId: c.channelId, id: c.connectionId, provider: c.provider } });
    if (!connection) throw new StaleMessagingSourceError('Invalid connection scope');
    if (connection.lifecycleGeneration % 2 !== 0 || connection.lifecycleGeneration !== c.lifecycleGeneration || connection.sessionName !== c.sessionName) throw new StaleMessagingSourceError();
  } else {
    if (channel.provider !== 'meta_cloud' || channel.connectionLifecycleGeneration !== c.lifecycleGeneration) throw new StaleMessagingSourceError();
    const config = await tx.integrationConfig.findUnique({ where: { workspaceId_provider: { workspaceId: c.workspaceId, provider: 'meta_cloud' } } });
    const settings = record(config?.settings);
    if (config?.mode !== 'real' || settings.enabled !== true) throw new StaleMessagingSourceError('Inactive Meta source');
    const configured = (key: string) => typeof settings[key] === 'string' ? (settings[key] as string).trim() : '';
    if (c.provider === 'meta_official') {
      if (!configured('wabaId') || !configured('accessToken')) throw new StaleMessagingSourceError('Inactive official Meta source');
      if (settings.connectionMode === 'evolution_official' || !c.phoneNumberId || configured('phoneNumberId') !== c.phoneNumberId || channel.providerKey !== c.phoneNumberId || c.sessionName !== c.phoneNumberId) throw new StaleMessagingSourceError('Invalid official Meta source');
    } else if (c.provider !== 'evolution' || settings.connectionMode !== 'evolution_official' || !configured('evolutionBaseUrl') || !configured('evolutionApiKey') || configured('evolutionInstanceName') !== c.sessionName) throw new StaleMessagingSourceError('Invalid Evolution bridge source');
  }
  return channel.provider;
}
