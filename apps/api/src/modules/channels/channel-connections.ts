import { createHash } from 'node:crypto';
import type { Channel, ChannelConnection, Prisma, PrismaClient } from '@prisma/client';
import type { ChannelDto, ChannelOperationResultDto, ChannelQrResultDto } from '@prymeira-talk/shared';
import type { EvolutionRuntime } from '../evolution/evolution-runtime.js';
import { WahaClientError, type WahaRuntime, type WahaSession } from '../waha/waha.client.js';
import { toChannelDto } from './channel-dto.js';

export class ConnectionServiceError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); this.name = 'ConnectionServiceError'; }
}
type Scope = { workspaceId: string; channelId: string };
type ConnectionScope = Scope & { connectionId: string };
export type ConnectionPrisma = Pick<PrismaClient, 'channel' | 'channelConnection' | '$transaction'>;
type ConnectionTransaction = Pick<Prisma.TransactionClient, 'channel' | 'channelConnection'>;
export type ConnectionLifecycle = { channel: Channel; connection: ChannelConnection };
function lifecycleInProgress(connection: ChannelConnection) { return connection.lifecycleGeneration % 2 === 1; }
type Options = { waha?: WahaRuntime; evolution?: EvolutionRuntime };

/** Hash the full tenant and channel IDs: truncated workspace slugs can collide. */
export function wahaSessionName(workspaceId: string, channelId: string) {
  return `talk-${createHash('sha256').update(JSON.stringify([workspaceId, channelId])).digest('hex').slice(0, 48)}`;
}
export function normalizeWhatsappPhone(value: string | null | undefined): string | null {
  if (!value || value.includes('@lid') || value.includes('@g.us')) return null;
  const phone = value.split('@')[0]!.split(':')[0]!.replace(/\D/g, '');
  return /^\d{8,15}$/.test(phone) ? phone : null;
}
function assertWahaOwnership(session: WahaSession, record: ChannelConnection) {
  if (session.name !== record.sessionName || session.config?.metadata?.workspaceId !== record.workspaceId || session.config?.metadata?.channelId !== record.channelId) {
    throw new ConnectionServiceError('WAHA_SESSION_CONFLICT', 'Esta sessão WAHA não pertence a este canal.', 409);
  }
  if (session.engine?.engine !== 'WPP' && !(session.status === 'STOPPED' && !session.engine?.engine)) {
    throw new ConnectionServiceError('WAHA_ENGINE_UNSUPPORTED', 'A sessão WAHA exige o engine WPP qualificado.', 503);
  }
}

export function createChannelConnectionsService(prisma: ConnectionPrisma, options: Options = {}) {
  function wahaClient() {
    if (!options.waha?.enabled || !options.waha.client) throw new ConnectionServiceError('WAHA_DISABLED', 'WAHA ainda não foi habilitado após qualificação.', 503);
    return options.waha.client;
  }
  async function qualifiedClient() {
    const client = wahaClient();
    const server = await client.getVersion();
    if (server.engine !== 'WPP') throw new ConnectionServiceError('WAHA_ENGINE_UNSUPPORTED', 'O servidor WAHA exige o engine WPP qualificado.', 503);
    if (server.version !== '2026.9.1') throw new ConnectionServiceError('WAHA_VERSION_UNSUPPORTED', 'O servidor WAHA exige a versão 2026.9.1 qualificada.', 503);
    return client;
  }
  async function getChannel(input: Scope): Promise<Channel> {
    const channel = await prisma.channel.findFirst({ where: { workspaceId: input.workspaceId, id: input.channelId } });
    if (!channel) throw new ConnectionServiceError('CHANNEL_NOT_FOUND', 'Canal não encontrado.', 404);
    if (channel.provider !== 'evolution') throw new ConnectionServiceError('CHANNEL_PROVIDER_UNSUPPORTED', 'Redundância é disponível para canais Evolution.', 400);
    return channel;
  }
  async function getConnection(input: ConnectionScope) {
    const channel = await getChannel(input);
    const connection = await prisma.channelConnection.findFirst({ where: { workspaceId: input.workspaceId, channelId: input.channelId, id: input.connectionId } });
    if (!connection) throw new ConnectionServiceError('CONNECTION_NOT_FOUND', 'Conexão não encontrada neste canal.', 404);
    return { channel, connection };
  }
  const whereId = (record: ChannelConnection) => ({ workspaceId_id: { workspaceId: record.workspaceId, id: record.id } });
  async function ensurePrimary(channel: Channel, db: ConnectionTransaction = prisma) {
    const primary = await db.channelConnection.upsert({
      where: { workspaceId_channelId_provider: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'evolution' } },
      create: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, status: channel.status, eligible: channel.status === 'connected' },
      update: {}
    });
    if (!channel.activeConnectionId) {
      await db.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data: { activeConnectionId: primary.id } });
    }
    return primary;
  }
  async function describe(channel: Channel): Promise<ChannelDto> {
    if (channel.provider !== 'evolution') return toChannelDto(channel);
    const records = await prisma.channelConnection.findMany({ where: { workspaceId: channel.workspaceId, channelId: channel.id }, orderBy: { provider: 'asc' } });
    // Never expose an active writer from another tenant/channel, even if a scalar was corrupted.
    const writer = records.find((record) => record.id === channel.activeConnectionId && (record.provider === 'evolution' || channel.redundancyEnabled))?.id ?? null;
    return {
      ...toChannelDto(channel), redundancyEnabled: channel.redundancyEnabled ?? false,
      redundancyAvailable: options.waha?.enabled === true && options.waha.client !== null,
      activeConnectionId: writer, connectionTotal: 2,
      connectedCount: records.filter((record) => record.status === 'connected').length,
      connections: records.map((record) => ({
        id: record.id, channelId: record.channelId, provider: record.provider, sessionName: record.sessionName,
        status: record.status, health: record.health, verifiedPhoneNumber: record.verifiedPhoneNumber ?? null,
        eligible: record.eligible && !lifecycleInProgress(record), isActiveWriter: record.id === writer,
        lastCheckedAt: record.lastCheckedAt?.toISOString() ?? null, lastError: record.lastError ?? null
      }))
    };
  }
  async function result(channel: Channel): Promise<ChannelOperationResultDto> { return { mode: options.evolution?.mode ?? 'real', channel: await describe(channel) }; }
  // Contract for future webhook/recovery workers: increment this channel's persisted
  // generation before any physical session lifecycle I/O, then guard every resulting
  // observation (including primary owner and secondary proof) with the same CAS.
  // A no-op arithmetic UPDATE still locks the persisted channel row. Lifecycle
  // increments use that same lock, making the version check and all probe writes atomic.
  async function commitProbe(channel: Channel, generation: number, write: (tx: ConnectionTransaction) => Promise<void>) {
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.channel.updateMany({ where: { workspaceId: channel.workspaceId, id: channel.id, connectionLifecycleGeneration: generation }, data: { connectionLifecycleGeneration: { increment: 0 } } });
      if (claimed.count !== 1) return false;
      await write(tx);
      return true;
    });
  }
  // Physical lifecycle results use their own connection token so parallel QR or
  // logout on the other provider does not cancel this session's operation.
  // Odd connection generations mean I/O is in progress; even generations are idle.
  // Probes and the future writer/router must reject odd generations. Recovery must
  // explicitly recover an abandoned odd token, never qualify it via a health probe
  // or allow an ordinary QR/logout request to replace a still-running operation.
  async function commitLifecycle(operation: ConnectionLifecycle, write: (tx: ConnectionTransaction) => Promise<void>, complete = true) {
    const { channel, connection } = operation;
    return prisma.$transaction(async (tx) => {
      const claimedChannel = await tx.channel.updateMany({ where: { workspaceId: channel.workspaceId, id: channel.id }, data: { connectionLifecycleGeneration: { increment: 0 } } });
      if (claimedChannel.count !== 1) return false;
      const claimedConnection = await tx.channelConnection.updateMany({ where: { workspaceId: connection.workspaceId, channelId: channel.id, id: connection.id, lifecycleGeneration: connection.lifecycleGeneration }, data: { lifecycleGeneration: { increment: 0 } } });
      if (claimedConnection.count !== 1) return false;
      await write(tx);
      if (complete) {
        // Discard probes begun during I/O and any duplicate completion of this token.
        await tx.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data: { connectionLifecycleGeneration: { increment: 1 } } });
        await tx.channelConnection.update({ where: whereId(connection), data: { lifecycleGeneration: { increment: 1 } } });
      }
      return true;
    });
  }
  async function beginConnectionLifecycle(channel: Channel, connection: ChannelConnection, write?: (tx: ConnectionTransaction, current: Channel) => Promise<void>): Promise<ConnectionLifecycle> {
    return prisma.$transaction(async (tx) => {
      const locked = await tx.channel.updateMany({ where: { workspaceId: channel.workspaceId, id: channel.id }, data: { connectionLifecycleGeneration: { increment: 0 } } });
      if (locked.count !== 1) throw new ConnectionServiceError('CHANNEL_NOT_FOUND', 'Canal não encontrado.', 404);
      const persisted = await tx.channelConnection.findFirst({ where: { workspaceId: connection.workspaceId, channelId: channel.id, id: connection.id } });
      if (!persisted) throw new ConnectionServiceError('CONNECTION_NOT_FOUND', 'Conexão não encontrada neste canal.', 404);
      if (lifecycleInProgress(persisted)) throw new ConnectionServiceError('LIFECYCLE_IN_PROGRESS', 'Esta conexão já possui uma operação em andamento. Aguarde a conclusão.', 409);
      const current = await tx.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data: { connectionLifecycleGeneration: { increment: 1 } } });
      const currentConnection = await tx.channelConnection.update({ where: whereId(connection), data: { lifecycleGeneration: { increment: 1 } } });
      if (write) await write(tx, current);
      return { channel: current, connection: currentConnection };
    });
  }
  async function beginLifecycle(channel: Channel, write?: (tx: ConnectionTransaction, updated: Channel) => Promise<void>) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data: { connectionLifecycleGeneration: { increment: 1 } } });
      if (write) await write(tx, updated);
      return updated;
    });
  }
  async function advanceObservationGeneration(tx: ConnectionTransaction, channel: Channel) {
    await tx.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data: { connectionLifecycleGeneration: { increment: 1 } } });
  }
  function superseded() { return new ConnectionServiceError('LIFECYCLE_SUPERSEDED', 'A conexão mudou durante esta operação. Atualize o canal.', 409); }
  async function markFailure(tx: ConnectionTransaction, record: ChannelConnection, error: string) {
    await tx.channelConnection.update({ where: whereId(record), data: { health: 'unhealthy', eligible: false, lastCheckedAt: new Date(), failureStartedAt: record.failureStartedAt ?? new Date(), consecutiveFailures: { increment: 1 }, lastError: error } });
  }
  async function failProbe(channel: Channel, generation: number, record: ChannelConnection, error: string) {
    return commitProbe(channel, generation, async (tx) => {
      await markFailure(tx, record, error);
      await advanceObservationGeneration(tx, channel);
    });
  }
  function confirmedPrimaryPhone(primary: ChannelConnection, secondary: ChannelConnection, currentSecondaryPhone: string | null) {
    const phone = normalizeWhatsappPhone(primary.verifiedPhoneNumber);
    // Missing owner data is not evidence of a changed identity. Reuse only a positive
    // pairing proof, matching both persisted identities and WAHA's current owner.
    return secondary.lastHealthyAt && phone && phone === secondary.verifiedPhoneNumber && phone === currentSecondaryPhone ? phone : null;
  }
  async function revalidateSecondary(tx: ConnectionTransaction, channel: Channel, primaryPhone: string | null) {
    const secondary = await tx.channelConnection.findFirst({ where: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'waha' } });
    if (!secondary || (primaryPhone && primaryPhone === secondary.verifiedPhoneNumber)) return false;
    await tx.channelConnection.update({ where: whereId(secondary), data: { eligible: false, health: secondary.status === 'connected' ? 'degraded' : secondary.health, lastHealthyAt: null, lastError: primaryPhone ? 'PHONE_MISMATCH' : 'PRIMARY_PHONE_UNVERIFIED' } });
    return true;
  }
  async function refresh(input: ConnectionScope): Promise<ChannelOperationResultDto> {
    const { channel, connection } = await getConnection(input);
    if (lifecycleInProgress(connection)) return result(await getChannel(input));
    const generation = channel.connectionLifecycleGeneration;
    const now = new Date();
    if (connection.provider === 'evolution') {
      const client = options.evolution?.client;
      if (options.evolution?.mode === 'real' && client?.getConnectionState && client.getInstanceIdentity) {
        try {
          const state = await client.getConnectionState({ instanceName: connection.sessionName });
          const phone = state === 'open' ? normalizeWhatsappPhone(await client.getInstanceIdentity({ instanceName: connection.sessionName })) : null;
          await commitProbe(channel, generation, async (tx) => {
            await tx.channelConnection.update({ where: whereId(connection), data: { status: state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected', health: state === 'open' && phone ? 'healthy' : 'unknown', ...(phone ? { verifiedPhoneNumber: phone } : {}), eligible: state === 'open', lastCheckedAt: now, ...(phone ? { lastHealthyAt: now, consecutiveFailures: 0, failureStartedAt: null, lastError: null } : {}) } });
            const revoked = phone ? await revalidateSecondary(tx, channel, phone) : false;
            if (state !== 'open' || (phone && phone !== connection.verifiedPhoneNumber) || revoked) await advanceObservationGeneration(tx, channel);
          });
        } catch { await failProbe(channel, generation, connection, 'PROVIDER_UNAVAILABLE'); }
      }
      return result(await getChannel(input));
    }
    if (!channel.redundancyEnabled) throw new ConnectionServiceError('REDUNDANCY_DISABLED', 'Habilite a redundância antes de conectar WAHA.', 409);
    const primary = await prisma.channelConnection.findFirst({ where: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'evolution' } });
    if (!primary) throw new ConnectionServiceError('CONNECTION_NOT_FOUND', 'Conexão Evolution não encontrada neste canal.', 409);
    if (lifecycleInProgress(primary)) return result(await getChannel(input));
    try {
      const client = await qualifiedClient();
      const session = await client.getSession({ session: connection.sessionName });
      assertWahaOwnership(session, connection);
      const status = session.status === 'WORKING' ? 'connected' : session.status === 'STOPPED' ? 'disconnected' : session.status === 'FAILED' ? 'failed' : 'connecting';
      const me = status === 'connected' ? await client.getMe({ session: connection.sessionName }) : null;
      const phone = normalizeWhatsappPhone(me?.id);
      // Verify the actual Evolution session, never a manually entered display phone.
      let primaryPhone: string | null = null;
      let observedPhone: string | null = null;
      let primaryFailed = false;
      if (options.evolution?.client?.getInstanceIdentity) {
        try {
          observedPhone = normalizeWhatsappPhone(await options.evolution.client.getInstanceIdentity({ instanceName: primary.sessionName }));
          primaryPhone = observedPhone ?? confirmedPrimaryPhone(primary, connection, phone);
        } catch {
          // A failed primary probe must not disable a confirmed alternative. lastHealthyAt
          // is only set for WAHA after both actual identities matched and restrictions passed.
          primaryPhone = confirmedPrimaryPhone(primary, connection, phone);
          primaryFailed = true;
        }
      }
      const restricted = me?.reachoutTimelock?.isActive || me?.messageCapping?.cappingStatus === 'CAPPED';
      const reason = status !== 'connected' ? null : !primaryPhone ? 'PRIMARY_PHONE_UNVERIFIED' : !phone ? 'PHONE_UNVERIFIED' : phone !== primaryPhone ? 'PHONE_MISMATCH' : restricted ? 'ACCOUNT_RESTRICTED' : null;
      const eligible = status === 'connected' && reason === null;
      const revokeProof = reason === 'PHONE_MISMATCH' || reason === 'PHONE_UNVERIFIED' || Boolean(status === 'connected' && connection.lastHealthyAt && phone !== connection.verifiedPhoneNumber);
      await commitProbe(channel, generation, async (tx) => {
        if (primaryFailed) await markFailure(tx, primary, 'PROVIDER_UNAVAILABLE');
        else if (options.evolution?.client?.getInstanceIdentity) {
          await tx.channelConnection.update({ where: whereId(primary), data: { ...(observedPhone ? { verifiedPhoneNumber: observedPhone } : {}), lastCheckedAt: now } });
        }
        await tx.channelConnection.update({ where: whereId(connection), data: {
          status, verifiedPhoneNumber: phone, health: status === 'connected' ? reason ? 'degraded' : 'healthy' : status === 'failed' ? 'unhealthy' : 'unknown',
          eligible, lastCheckedAt: now, lastError: reason,
          ...(revokeProof ? { lastHealthyAt: null } : {}),
          ...(status === 'connected' ? { connectedAt: connection.connectedAt ?? now } : {}),
          ...(eligible ? { lastHealthyAt: now, consecutiveFailures: 0, failureStartedAt: null } : {})
        } });
        // A newer identity or protective observation invalidates every older probe,
        // so it cannot restore a revoked proof, restriction or disconnected state.
        if (phone !== connection.verifiedPhoneNumber || revokeProof || !eligible || primaryFailed || (observedPhone && observedPhone !== primary.verifiedPhoneNumber)) await advanceObservationGeneration(tx, channel);
      });
    } catch (error) {
      await failProbe(channel, generation, connection, error instanceof ConnectionServiceError ? error.code : 'PROVIDER_UNAVAILABLE');
      if (error instanceof ConnectionServiceError) throw error;
    }
    return result(await getChannel(input));
  }
  async function stopSecondary(channel: Channel, connection: ChannelConnection, logout: boolean, disable = false) {
    // Revoke proof before remote I/O, even when the remote stop subsequently fails.
    const operation = await beginConnectionLifecycle(channel, connection, async (tx, current) => {
      const primary = await ensurePrimary(current, tx);
      if (disable) await tx.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data: { redundancyEnabled: false, activeConnectionId: primary.id } });
      else if (current.activeConnectionId === connection.id) await tx.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data: { activeConnectionId: primary.id } });
      await tx.channelConnection.update({ where: whereId(connection), data: { eligible: false, lastHealthyAt: null, ...(logout ? { verifiedPhoneNumber: null } : {}) } });
    });
    try {
      const client = await qualifiedClient();
      const remote = await client.getSession({ session: connection.sessionName });
      assertWahaOwnership(remote, connection);
      if (logout) await client.logoutSession({ session: connection.sessionName });
      await client.stopSession({ session: connection.sessionName });
    } catch (error) {
      if (!(error instanceof WahaClientError && error.statusCode === 404)) {
        await commitLifecycle(operation, (tx) => markFailure(tx, connection, error instanceof ConnectionServiceError ? error.code : 'PROVIDER_UNAVAILABLE')); throw error;
      }
    }
    await commitLifecycle(operation, async (tx) => {
      await tx.channelConnection.update({ where: whereId(connection), data: { status: 'disconnected', health: 'unknown', verifiedPhoneNumber: logout ? null : connection.verifiedPhoneNumber, lastHealthyAt: null, eligible: false, disconnectedAt: new Date(), lastError: null } });
    });
  }
  return {
    describe, ensurePrimary, refresh, getConnection,
    async finishPrimaryLifecycle(operation: ConnectionLifecycle) { await commitLifecycle(operation, async () => {}); },
    async beginPrimaryLifecycle(channel: Channel) {
      const primary = await prisma.channelConnection.findFirst({ where: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'evolution' } }) ?? await ensurePrimary(channel);
      return beginConnectionLifecycle(channel, primary, async (tx, current) => {
        await ensurePrimary(current, tx);
        await tx.channelConnection.update({ where: whereId(primary), data: { eligible: false, health: 'unknown', verifiedPhoneNumber: null, lastHealthyAt: null } });
        await revalidateSecondary(tx, channel, null);
      });
    },
    async completePrimaryLifecycle(operation: ConnectionLifecycle, data: Prisma.ChannelUpdateInput) {
      const { channel, connection: primary } = operation;
      const committed = await commitLifecycle(operation, async (tx) => {
        const updated = await tx.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data });
        await tx.channelConnection.update({ where: whereId(primary), data: { status: updated.status, eligible: updated.status === 'connected', health: 'unknown', ...(updated.status === 'disconnected' ? { verifiedPhoneNumber: null, disconnectedAt: new Date() } : {}) } });
      });
      if (!committed) throw superseded();
      return getChannel({ workspaceId: channel.workspaceId, channelId: channel.id });
    },
    async setRedundancy(input: Scope & { enabled: boolean }): Promise<ChannelOperationResultDto> {
      const channel = await getChannel(input);
      if (input.enabled) wahaClient();
      if (input.enabled) {
        await beginLifecycle(channel, async (tx, current) => {
          const secondary = await tx.channelConnection.findFirst({ where: { workspaceId: input.workspaceId, channelId: input.channelId, provider: 'waha' } });
          if (secondary && lifecycleInProgress(secondary)) throw new ConnectionServiceError('LIFECYCLE_IN_PROGRESS', 'Esta conexão já possui uma operação em andamento. Aguarde a conclusão.', 409);
          const primary = await ensurePrimary(current, tx);
          const active = current.activeConnectionId ? await tx.channelConnection.findFirst({ where: { workspaceId: input.workspaceId, channelId: input.channelId, id: current.activeConnectionId } }) : null;
          await tx.channelConnection.upsert({ where: { workspaceId_channelId_provider: { workspaceId: input.workspaceId, channelId: input.channelId, provider: 'waha' } }, create: { workspaceId: input.workspaceId, channelId: input.channelId, provider: 'waha', sessionName: wahaSessionName(input.workspaceId, input.channelId) }, update: {} });
          await tx.channel.update({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.channelId } }, data: { redundancyEnabled: true, activeConnectionId: active?.id ?? primary.id } });
        });
        return result(await getChannel(input));
      }
      const secondary = await prisma.channelConnection.findFirst({ where: { workspaceId: input.workspaceId, channelId: input.channelId, provider: 'waha' } });
      if (secondary) await stopSecondary(channel, secondary, false, true);
      else {
        const primary = await ensurePrimary(channel);
        await prisma.channel.update({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.channelId } }, data: { redundancyEnabled: false, activeConnectionId: primary.id, connectionLifecycleGeneration: { increment: 1 } } });
      }
      return result(await getChannel(input));
    },
    async startQr(input: ConnectionScope): Promise<ChannelQrResultDto> {
      const { channel, connection } = await getConnection(input);
      if (connection.provider !== 'waha') throw new ConnectionServiceError('USE_EVOLUTION_QR', 'Use o QR Evolution para esta conexão.', 400);
      if (!channel.redundancyEnabled) throw new ConnectionServiceError('REDUNDANCY_DISABLED', 'Habilite a redundância antes de conectar WAHA.', 409);
      const operation = await beginConnectionLifecycle(channel, connection, async (tx) => { await tx.channelConnection.update({ where: whereId(connection), data: { eligible: false } }); });
      try {
        const client = await qualifiedClient();
        let session: WahaSession;
        try { session = await client.getSession({ session: connection.sessionName }); }
        catch (error) {
          if (!(error instanceof WahaClientError && error.statusCode === 404)) throw error;
          await client.createSession({ session: connection.sessionName, workspaceId: input.workspaceId, channelId: input.channelId });
          session = await client.getSession({ session: connection.sessionName });
        }
        assertWahaOwnership(session, connection);
        if (session.status === 'WORKING') throw new ConnectionServiceError('WAHA_ALREADY_LINKED', 'WAHA já está conectado. Atualize o status ou desconecte para gerar outro QR.', 409);
        const revoked = await commitLifecycle(operation, async (tx) => {
          await tx.channelConnection.update({ where: whereId(connection), data: { status: 'connecting', health: 'unknown', eligible: false, verifiedPhoneNumber: null, lastHealthyAt: null, lastError: null } });
        }, false);
        if (!revoked) throw superseded();
        if (session.status === 'FAILED') { await client.stopSession({ session: connection.sessionName }); session = { ...session, status: 'STOPPED' }; }
        if (session.status === 'STOPPED') await client.startSession({ session: connection.sessionName });
        const issuedAt = new Date();
        let qrCode: string | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { qrCode = await client.getQr({ session: connection.sessionName }); break; }
          catch (error) {
            if (!(error instanceof WahaClientError && error.statusCode === 422)) throw error;
            if (attempt === 2) throw new ConnectionServiceError('WAHA_QR_PENDING', 'A sessão WAHA está iniciando. Aguarde a atualização do QR Code.', 503);
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        if (!qrCode) throw new ConnectionServiceError('WAHA_QR_PENDING', 'A sessão WAHA está iniciando.', 503);
        // A WAHA QR can rotate every 20 seconds; never present it as valid for five minutes.
        const expiresAt = new Date(issuedAt.getTime() + 20_000).toISOString();
        if (!await commitLifecycle(operation, async () => {})) throw superseded();
        return { mode: 'real', channel: await describe(await getChannel(input)), connectionId: connection.id, provider: 'waha', qrCode, qr: { payload: qrCode, expiresAt, issuedAt: issuedAt.toISOString() } };
      } finally { await commitLifecycle(operation, async () => {}); }
    },
    async disconnect(input: ConnectionScope): Promise<ChannelOperationResultDto> {
      const { channel, connection } = await getConnection(input);
      if (connection.provider !== 'waha') throw new ConnectionServiceError('USE_EVOLUTION_DISCONNECT', 'Use a operação Evolution para esta conexão.', 400);
      await stopSecondary(channel, connection, true);
      return result(await getChannel(input));
    },
    async deleteSecondary(channel: Channel) {
      const secondary = await prisma.channelConnection.findFirst({ where: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'waha' } });
      if (!secondary) return;
      const operation = await beginConnectionLifecycle(channel, secondary);
      try { const client = await qualifiedClient(); assertWahaOwnership(await client.getSession({ session: secondary.sessionName }), secondary); await client.deleteSession({ session: secondary.sessionName }); }
      catch (error) { if (!(error instanceof WahaClientError && error.statusCode === 404)) throw error; }
      finally { await commitLifecycle(operation, async () => {}); }
    }
  };
}
