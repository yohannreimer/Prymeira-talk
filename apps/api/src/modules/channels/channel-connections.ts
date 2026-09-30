import { createHash } from 'node:crypto';
import type { Channel, ChannelConnection, PrismaClient } from '@prisma/client';
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
  async function ensurePrimary(channel: Channel) {
    const primary = await prisma.channelConnection.upsert({
      where: { workspaceId_channelId_provider: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'evolution' } },
      create: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, status: channel.status, eligible: channel.status === 'connected' },
      update: {}
    });
    if (!channel.activeConnectionId) {
      await prisma.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data: { activeConnectionId: primary.id } });
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
        eligible: record.eligible, isActiveWriter: record.id === writer,
        lastCheckedAt: record.lastCheckedAt?.toISOString() ?? null, lastError: record.lastError ?? null
      }))
    };
  }
  async function result(channel: Channel): Promise<ChannelOperationResultDto> { return { mode: options.evolution?.mode ?? 'real', channel: await describe(channel) }; }
  async function markFailure(record: ChannelConnection, error: string) {
    await prisma.channelConnection.update({ where: whereId(record), data: { health: 'unhealthy', eligible: false, lastCheckedAt: new Date(), failureStartedAt: record.failureStartedAt ?? new Date(), consecutiveFailures: { increment: 1 }, lastError: error } });
  }
  function confirmedPrimaryPhone(primary: ChannelConnection, secondary: ChannelConnection, currentSecondaryPhone: string | null) {
    const phone = normalizeWhatsappPhone(primary.verifiedPhoneNumber);
    // Missing owner data is not evidence of a changed identity. Reuse only a positive
    // pairing proof, matching both persisted identities and WAHA's current owner.
    return secondary.lastHealthyAt && phone && phone === secondary.verifiedPhoneNumber && phone === currentSecondaryPhone ? phone : null;
  }
  async function revalidateSecondary(channel: Channel, primaryPhone: string | null) {
    const secondary = await prisma.channelConnection.findFirst({ where: { workspaceId: channel.workspaceId, channelId: channel.id, provider: 'waha' } });
    if (!secondary || secondary.status !== 'connected' || (primaryPhone && primaryPhone === secondary.verifiedPhoneNumber)) return;
    await prisma.channelConnection.update({ where: whereId(secondary), data: { eligible: false, health: 'degraded', lastHealthyAt: null, lastError: primaryPhone ? 'PHONE_MISMATCH' : 'PRIMARY_PHONE_UNVERIFIED' } });
  }
  async function refresh(input: ConnectionScope): Promise<ChannelOperationResultDto> {
    const { channel, connection } = await getConnection(input);
    const now = new Date();
    if (connection.provider === 'evolution') {
      const client = options.evolution?.client;
      if (options.evolution?.mode === 'real' && client?.getConnectionState && client.getInstanceIdentity) {
        try {
          const state = await client.getConnectionState({ instanceName: connection.sessionName });
          const phone = state === 'open' ? normalizeWhatsappPhone(await client.getInstanceIdentity({ instanceName: connection.sessionName })) : null;
          await prisma.channelConnection.update({ where: whereId(connection), data: { status: state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected', health: state === 'open' && phone ? 'healthy' : 'unknown', ...(phone ? { verifiedPhoneNumber: phone } : {}), eligible: state === 'open', lastCheckedAt: now, ...(phone ? { lastHealthyAt: now, consecutiveFailures: 0, failureStartedAt: null, lastError: null } : {}) } });
          if (phone) await revalidateSecondary(channel, phone);
        } catch { await markFailure(connection, 'PROVIDER_UNAVAILABLE'); }
      }
      return result(channel);
    }
    if (!channel.redundancyEnabled) throw new ConnectionServiceError('REDUNDANCY_DISABLED', 'Habilite a redundância antes de conectar WAHA.', 409);
    try {
      const client = await qualifiedClient();
      const session = await client.getSession({ session: connection.sessionName });
      assertWahaOwnership(session, connection);
      const status = session.status === 'WORKING' ? 'connected' : session.status === 'STOPPED' ? 'disconnected' : session.status === 'FAILED' ? 'failed' : 'connecting';
      const me = status === 'connected' ? await client.getMe({ session: connection.sessionName }) : null;
      const phone = normalizeWhatsappPhone(me?.id);
      const primary = await ensurePrimary(channel);
      // Verify the actual Evolution session, never a manually entered display phone.
      let primaryPhone: string | null = null;
      if (options.evolution?.client?.getInstanceIdentity) {
        try {
          const observedPhone = normalizeWhatsappPhone(await options.evolution.client.getInstanceIdentity({ instanceName: primary.sessionName }));
          primaryPhone = observedPhone ?? confirmedPrimaryPhone(primary, connection, phone);
          await prisma.channelConnection.update({ where: whereId(primary), data: { ...(observedPhone ? { verifiedPhoneNumber: observedPhone } : {}), lastCheckedAt: now } });
        } catch {
          // A failed primary probe must not disable a confirmed alternative. lastHealthyAt
          // is only set for WAHA after both actual identities matched and restrictions passed.
          primaryPhone = confirmedPrimaryPhone(primary, connection, phone);
          await markFailure(primary, 'PROVIDER_UNAVAILABLE');
        }
      }
      const restricted = me?.reachoutTimelock?.isActive || me?.messageCapping?.cappingStatus === 'CAPPED';
      const reason = status !== 'connected' ? null : !primaryPhone ? 'PRIMARY_PHONE_UNVERIFIED' : !phone ? 'PHONE_UNVERIFIED' : phone !== primaryPhone ? 'PHONE_MISMATCH' : restricted ? 'ACCOUNT_RESTRICTED' : null;
      await prisma.channelConnection.update({ where: whereId(connection), data: {
        status, verifiedPhoneNumber: phone, health: status === 'connected' ? reason ? 'degraded' : 'healthy' : status === 'failed' ? 'unhealthy' : 'unknown',
        eligible: status === 'connected' && reason === null, lastCheckedAt: now, lastError: reason,
        ...(reason === 'PHONE_MISMATCH' || reason === 'PHONE_UNVERIFIED' || (status === 'connected' && connection.lastHealthyAt && phone !== connection.verifiedPhoneNumber) ? { lastHealthyAt: null } : {}),
        ...(status === 'connected' ? { connectedAt: connection.connectedAt ?? now } : {}),
        ...(reason === null && status === 'connected' ? { lastHealthyAt: now, consecutiveFailures: 0, failureStartedAt: null } : {})
      } });
    } catch (error) {
      await markFailure(connection, error instanceof ConnectionServiceError ? error.code : 'PROVIDER_UNAVAILABLE');
      if (error instanceof ConnectionServiceError) throw error;
    }
    return result(channel);
  }
  async function stopSecondary(channel: Channel, connection: ChannelConnection, logout: boolean) {
    const primary = await ensurePrimary(channel);
    // Fence new sends before touching the remote secondary session. Disable keeps its identity for reuse.
    await prisma.$transaction(async (tx) => {
      if (channel.activeConnectionId === connection.id) await tx.channel.update({ where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } }, data: { activeConnectionId: primary.id } });
      await tx.channelConnection.update({ where: whereId(connection), data: { eligible: false } });
    });
    const client = await qualifiedClient();
    try {
      const remote = await client.getSession({ session: connection.sessionName });
      assertWahaOwnership(remote, connection);
      if (logout) await client.logoutSession({ session: connection.sessionName });
      await client.stopSession({ session: connection.sessionName });
    } catch (error) {
      if (!(error instanceof WahaClientError && error.statusCode === 404)) {
        await markFailure(connection, error instanceof ConnectionServiceError ? error.code : 'PROVIDER_UNAVAILABLE'); throw error;
      }
    }
    await prisma.channelConnection.update({ where: whereId(connection), data: { status: 'disconnected', health: 'unknown', verifiedPhoneNumber: logout ? null : connection.verifiedPhoneNumber, ...(logout ? { lastHealthyAt: null } : {}), eligible: false, disconnectedAt: new Date(), lastError: null } });
  }
  return {
    describe, ensurePrimary, refresh, getConnection,
    async setRedundancy(input: Scope & { enabled: boolean }): Promise<ChannelOperationResultDto> {
      const channel = await getChannel(input);
      if (input.enabled) wahaClient();
      const primary = await ensurePrimary(channel);
      if (input.enabled) {
        const active = channel.activeConnectionId ? await prisma.channelConnection.findFirst({ where: { workspaceId: input.workspaceId, channelId: input.channelId, id: channel.activeConnectionId } }) : null;
        await prisma.channelConnection.upsert({ where: { workspaceId_channelId_provider: { workspaceId: input.workspaceId, channelId: input.channelId, provider: 'waha' } }, create: { workspaceId: input.workspaceId, channelId: input.channelId, provider: 'waha', sessionName: wahaSessionName(input.workspaceId, input.channelId) }, update: {} });
        const updated = await prisma.channel.update({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.channelId } }, data: { redundancyEnabled: true, activeConnectionId: active?.id ?? primary.id } });
        return result(updated);
      }
      const updated = await prisma.channel.update({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.channelId } }, data: { redundancyEnabled: false, activeConnectionId: primary.id } });
      const secondary = await prisma.channelConnection.findFirst({ where: { workspaceId: input.workspaceId, channelId: input.channelId, provider: 'waha' } });
      if (secondary) await stopSecondary(updated, secondary, false);
      return result(updated);
    },
    async startQr(input: ConnectionScope): Promise<ChannelQrResultDto> {
      const { channel, connection } = await getConnection(input);
      if (connection.provider !== 'waha') throw new ConnectionServiceError('USE_EVOLUTION_QR', 'Use o QR Evolution para esta conexão.', 400);
      if (!channel.redundancyEnabled) throw new ConnectionServiceError('REDUNDANCY_DISABLED', 'Habilite a redundância antes de conectar WAHA.', 409);
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
      if (session.status === 'FAILED') { await client.stopSession({ session: connection.sessionName }); session = { ...session, status: 'STOPPED' }; }
      if (session.status === 'STOPPED') await client.startSession({ session: connection.sessionName });
      await prisma.channelConnection.update({ where: whereId(connection), data: { status: 'connecting', health: 'unknown', eligible: false, verifiedPhoneNumber: null, lastHealthyAt: null, lastError: null } });
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
      return { mode: 'real', channel: await describe(channel), connectionId: connection.id, provider: 'waha', qrCode, qr: { payload: qrCode, expiresAt, issuedAt: issuedAt.toISOString() } };
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
      const client = await qualifiedClient();
      try { assertWahaOwnership(await client.getSession({ session: secondary.sessionName }), secondary); await client.deleteSession({ session: secondary.sessionName }); }
      catch (error) { if (!(error instanceof WahaClientError && error.statusCode === 404)) throw error; }
    }
  };
}
