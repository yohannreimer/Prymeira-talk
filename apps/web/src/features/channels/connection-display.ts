import type { ChannelDto, ChannelQrResultDto, RealtimeEvent } from '@prymeira-talk/shared';
type QrUpdate = Extract<RealtimeEvent, { type: 'channel.qr_updated' }>['payload'];
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
