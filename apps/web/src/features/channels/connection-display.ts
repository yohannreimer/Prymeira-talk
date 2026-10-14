import type { ChannelDto, ChannelQrResultDto, RealtimeEvent } from '@prymeira-talk/shared';
type QrUpdate = Extract<RealtimeEvent, { type: 'channel.qr_updated' }>['payload'];
const statusLabels = { connected: 'Conectado', connecting: 'Conectando', disconnected: 'Desconectado', failed: 'Falhou' };
const healthLabels = { unknown: 'Saúde não verificada', healthy: 'Saudável', degraded: 'Degradada', unhealthy: 'Indisponível' };

export function connectionDisplay(channel: Pick<ChannelDto, 'provider' | 'status' | 'connections'>) {
  if (channel.provider !== 'evolution') return [];
  return (['evolution', 'waha'] as const).map((provider) => {
    const connection = channel.connections?.find((record) => record.provider === provider);
    const status = connection?.status ?? (provider === 'evolution' ? channel.status : 'disconnected');
    const health = connection?.health ?? 'unknown';
    return {
      provider,
      label: provider === 'evolution' ? 'Evolution' : 'WAHA',
      connection,
      status,
      health,
      statusLabel: statusLabels[status],
      healthLabel: healthLabels[health],
      isActiveWriter: connection?.isActiveWriter === true
    };
  });
}

export function connectionCount(channel: Pick<ChannelDto, 'status' | 'connections'>) {
  const count = channel.connections ? channel.connections.filter((connection) => connection.status === 'connected').length : channel.status === 'connected' ? 1 : 0;
  return `${count} de 2 conectados`;
}
export function qrKey(qr: ChannelQrResultDto) { return `${qr.channel.id}:${qr.connectionId ?? qr.provider ?? 'evolution'}`; }
export function applyQrUpdate(current: ChannelQrResultDto | null, update: QrUpdate, now = Date.now()): ChannelQrResultDto | null {
  if (!current || current.channel.id !== update.channelId || Date.parse(update.expiresAt) <= now) return current;
  const provider = current.provider ?? 'evolution';
  if ((update.provider ?? 'evolution') !== provider || (update.connectionId && current.connectionId !== update.connectionId) || (provider === 'waha' && !update.connectionId)) return current;
  const currentTime = Date.parse(current.qr.issuedAt ?? current.qr.expiresAt);
  const updateTime = Date.parse(update.issuedAt ?? update.expiresAt);
  if (!Number.isFinite(updateTime) || (update.issuedAt && current.qr.issuedAt ? updateTime < currentTime : Date.parse(update.expiresAt) < Date.parse(current.qr.expiresAt))) return current;
  return { ...current, mode: 'real', qrCode: update.qrCode, qr: { payload: update.qrCode, expiresAt: update.expiresAt, issuedAt: update.issuedAt } };
}

/** One sentence for the top of the connections panel: is everything fine, or what should the person do. */
export function connectionSummary(channel: Pick<ChannelDto, 'provider' | 'status' | 'connections' | 'redundancyEnabled'>) {
  const entries = connectionDisplay(channel).filter((entry) => entry.provider === 'evolution' || channel.redundancyEnabled);
  const up = entries.filter((entry) => entry.status === 'connected');
  const shaky = up.some((entry) => entry.health === 'degraded' || entry.health === 'unhealthy');
  const count = `${up.length} de ${entries.length || 1} ${entries.length === 1 ? 'conexão ativa' : 'conexões ativas'}`;
  if (!entries.length || !up.length) return { tone: 'down' as const, count, title: 'WhatsApp desconectado',
    detail: 'Gere o QR Code da conexão principal e escaneie com o celular deste número.' };
  if (up.length < entries.length) return { tone: 'warning' as const, count, title: 'Uma conexão caiu',
    detail: 'As mensagens seguem pela outra conexão. Gere o QR Code da que caiu para religar.' };
  if (shaky) return { tone: 'warning' as const, count, title: 'Conexão instável', detail: 'As mensagens continuam, mas uma conexão está respondendo mal.' };
  return { tone: 'ok' as const, count, title: 'Tudo funcionando', detail: 'As mensagens estão chegando e saindo normalmente.' };
}
