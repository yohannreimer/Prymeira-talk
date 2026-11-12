import type { Channel, PrismaClient } from '@prisma/client';
import type { ChannelDto, ChannelQrResultDto, ExtensionAccount, ExtensionConnection } from '@prymeira-talk/shared';
import { AssistantError, resolveAssistantActor } from '../assistant/assistant-access.js';
import { normalizeChatAddress } from '../messaging/whatsapp-identity.js';
import { normalizePhoneForStorage } from '../contacts/phone-normalization.js';
import type { createChannelConnectionsService } from '../channels/channel-connections.js';
import type { createChannelsService } from '../channels/channels.service.js';

type Auth = Parameters<typeof resolveAssistantActor>[1];
type Options = {
  physical: Pick<ReturnType<typeof createChannelConnectionsService>, 'describe' | 'refresh' | 'ensurePrimary' | 'startQr'>;
  primary: Pick<ReturnType<typeof createChannelsService>, 'startQrSession'>;
  wahaEnabled: (workspaceId: string) => boolean;
  onChannel?: (channel: ChannelDto) => void;
  clearManualDisconnect?: (channelId: string) => void;
  now?: () => number;
};

/** Availability means one usable same-number connection, not two connected providers. */
export function extensionConnectionAvailable(channel: ChannelDto) {
  return channel.connections?.length
    ? channel.connections.some(c => c.status === 'connected' && c.eligible && c.health !== 'unhealthy')
    : channel.status === 'connected';
}

export function createExtensionConnectionService(db: PrismaClient, options: Options) {
  const now = options.now ?? Date.now;
  // Multiple panels share one probe. QR jobs below are ephemeral, never persisted or logged.
  const probes = new Map<string, Promise<ChannelDto>>();
  const qrJobs = new Map<string, { promise: Promise<ExtensionConnection>; value?: ExtensionConnection }>();
  const keyFor = (workspaceId: string, channelId: string) => JSON.stringify([workspaceId, channelId]);
  const available = (channel: ChannelDto) => extensionConnectionAvailable({ ...channel,
    connections: channel.connections?.map(c => c.provider === 'waha' && !options.wahaEnabled(channel.workspaceId) ? { ...c, eligible: false } : c) });
  async function bounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer!); }
  }
  async function resolve(auth: Auth, account: ExtensionAccount) {
    const actor = await resolveAssistantActor(db, auth);
    const self = normalizeChatAddress(account.selfAddress);
    if (!self?.endsWith('@s.whatsapp.net')) throw new AssistantError('EXTENSION_IDENTITY_UNAVAILABLE', 'Entre no WhatsApp Web com um número identificável.');
    const channel = await db.channel.findFirst({ where: { workspaceId: actor.workspaceId, id: account.channelId, archivedAt: null } });
    if (!channel) throw new AssistantError('EXTENSION_CHANNEL_NOT_FOUND', 'Canal não disponível para esta conta.', 404);
    if (!channel.verifiedMessagingPhoneNumber || normalizePhoneForStorage(channel.verifiedMessagingPhoneNumber) !== self.split('@')[0])
      throw new AssistantError('EXTENSION_NUMBER_MISMATCH', 'O número do WhatsApp Web é diferente do canal selecionado.');
    return { actor, channel };
  }
  async function observe(channel: Channel, force = false) {
    let dto = await options.physical.describe(channel);
    if (channel.provider !== 'evolution') return dto;
    const key = keyFor(channel.workspaceId, channel.id);
    const pending = probes.get(key);
    if (pending) return pending;
    const records = dto.connections ?? [];
    const due = records.filter(c => (c.provider === 'evolution' || (channel.redundancyEnabled && options.wahaEnabled(channel.workspaceId)))
      && (force || !c.lastCheckedAt || now() - Date.parse(c.lastCheckedAt) >= (available(dto) ? 15_000 : 4_000)));
    if (!due.length && records.length) return dto;
    const work = (async () => {
      const connections = records.length ? due : [await options.physical.ensurePrimary(channel)];
      for (const connection of connections) {
        try { await options.physical.refresh({ workspaceId: channel.workspaceId, channelId: channel.id, connectionId: connection.id }); }
        catch { /* Provider failures are persisted by the existing probe service. Do not log QR or server errors. */ }
      }
      const current = await db.channel.findFirst({ where: { workspaceId: channel.workspaceId, id: channel.id, archivedAt: null } });
      if (!current) throw new AssistantError('EXTENSION_CHANNEL_NOT_FOUND', 'Canal não disponível para esta conta.', 404);
      dto = await options.physical.describe(current);
      options.onChannel?.(dto);
      return dto;
    })();
    probes.set(key, work);
    try { return await work; } finally { if (probes.get(key) === work) probes.delete(key); }
  }
  function result(channel: ChannelDto, role: Auth['role']): ExtensionConnection {
    return { channelId: channel.id, phoneNumber: channel.phoneNumber!, available: available(channel),
      canReconnect: role !== 'agent' && channel.provider === 'evolution', qr: null };
  }
  const operations = {
    async status(auth: Auth, account: ExtensionAccount) {
      const { actor, channel } = await resolve(auth, account);
      const observed = await bounded(observe(channel), 5_000);
      // A probe must never replace the number used to authorize this operation.
      const current = await resolve(auth, account);
      const dto = observed ?? await options.physical.describe(current.channel);
      const status = result(dto, actor.role);
      const job = qrJobs.get(keyFor(actor.workspaceId, channel.id));
      return { ...status, ...(!status.available && (!observed || (job && !job.value)) ? { pending: true } : {}) };
    },
    async reconnect(auth: Auth, account: ExtensionAccount) {
      let { actor, channel } = await resolve(auth, account);
      if (actor.role === 'agent') throw new AssistantError('EXTENSION_RECONNECT_FORBIDDEN', 'Peça a um gestor para reconectar este número.', 403);
      if (channel.provider !== 'evolution') throw new AssistantError('EXTENSION_RECONNECT_UNSUPPORTED', 'Este canal precisa ser reconectado pelo responsável no Talk.', 409);
      const dto = await observe(channel, true);
      ({ actor, channel } = await resolve(auth, account));
      if (available(dto)) return result(dto, actor.role);
      const secondary = channel.redundancyEnabled && options.wahaEnabled(actor.workspaceId)
        ? dto.connections?.find(c => c.provider === 'waha') : null;
      // Prefer an already-enabled reserve; never enable a provider or log out a session here.
      let qr: ChannelQrResultDto;
      if (secondary) {
        try { qr = await options.physical.startQr({ workspaceId: actor.workspaceId, channelId: channel.id, connectionId: secondary.id }); }
        catch (error) {
          const code = (error as { code?: string }).code;
          if (code === 'WAHA_QR_PENDING') throw new AssistantError('EXTENSION_QR_PENDING', 'A conexão está iniciando. Aguarde a atualização do QR code.', 503);
          if (['WAHA_SESSION_CONFLICT', 'PHYSICAL_CONNECTION_CONFLICT', 'LIFECYCLE_IN_PROGRESS', 'PHONE_MISMATCH'].includes(code ?? '')) throw error;
          qr = await options.primary.startQrSession({ workspaceId: actor.workspaceId, channelId: channel.id });
        }
      } else qr = await options.primary.startQrSession({ workspaceId: actor.workspaceId, channelId: channel.id });
      await resolve(auth, account);
      const current = await db.channel.findFirst({ where: { workspaceId: actor.workspaceId, id: channel.id, archivedAt: null } });
      if (!current) throw new AssistantError('EXTENSION_CHANNEL_NOT_FOUND', 'Canal não disponível para esta conta.', 404);
      const latest = await options.physical.describe(current);
      if (available(latest)) return result(latest, actor.role);
      if (qr.mode !== 'real' || qr.channel.id !== channel.id || qr.channel.workspaceId !== actor.workspaceId || !qr.connectionId || !qr.provider || !qr.qrCode
        || !latest.connections?.some(c => c.id === qr.connectionId && c.provider === qr.provider)
        || normalizePhoneForStorage(qr.channel.phoneNumber ?? '') !== normalizePhoneForStorage(channel.verifiedMessagingPhoneNumber!)
        || !Number.isFinite(Date.parse(qr.qr.expiresAt)) || Date.parse(qr.qr.expiresAt) <= now())
        throw new AssistantError('EXTENSION_QR_UNAVAILABLE', 'Não foi possível obter um QR code válido para este número. Tente novamente.', 503);
      options.clearManualDisconnect?.(channel.id);
      options.onChannel?.(qr.channel);
      return { ...result(latest, actor.role), qr: { connectionId: qr.connectionId, provider: qr.provider, code: qr.qrCode, expiresAt: qr.qr.expiresAt } };
    }
  };
  return {
    status: operations.status,
    async reconnect(auth: Auth, account: ExtensionAccount): Promise<ExtensionConnection> {
      const { actor, channel } = await resolve(auth, account);
      if (actor.role === 'agent') throw new AssistantError('EXTENSION_RECONNECT_FORBIDDEN', 'Peça a um gestor para reconectar este número.', 403);
      const key = keyFor(actor.workspaceId, channel.id);
      let job = qrJobs.get(key);
      if (job?.value && (!job.value.qr || Date.parse(job.value.qr.expiresAt) <= now() + 2_000)) { qrJobs.delete(key); job = undefined; }
      if (!job) {
        job = { promise: operations.reconnect(auth, account) };
        qrJobs.set(key, job);
        const current = job;
        // A slow provider keeps one in-flight operation. Retain its current QR only until expiry,
        // so retrying after an HTTP timeout cannot restart that session or lose the issued code.
        void current.promise.then(value => {
          current.value = value;
          const ttl = value.qr ? Math.max(0, Date.parse(value.qr.expiresAt) - now()) : 0;
          const timer = setTimeout(() => { if (qrJobs.get(key) === current) qrJobs.delete(key); }, ttl);
          timer.unref();
        }, () => { if (qrJobs.get(key) === current) qrJobs.delete(key); });
      }
      const value = job.value ?? await bounded(job.promise, 8_000);
      const current = await resolve(auth, account);
      const latestDto = await options.physical.describe(current.channel);
      const latest = result(latestDto, actor.role);
      if (latest.available) return latest;
      if (value?.qr && Date.parse(value.qr.expiresAt) > now()) {
        if (!latestDto.connections?.some(c => c.id === value.qr!.connectionId && c.provider === value.qr!.provider)
          || (value.qr.provider === 'waha' && (!current.channel.redundancyEnabled || !options.wahaEnabled(actor.workspaceId)))) {
          qrJobs.delete(key);
          throw new AssistantError('EXTENSION_QR_UNAVAILABLE', 'A conexão mudou. Toque em Reconectar para atualizar o QR code.', 409);
        }
        return value;
      }
      return { ...latest, pending: true };
    }
  };
}
