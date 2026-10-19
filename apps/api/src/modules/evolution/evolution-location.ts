import { locationMapUrl, type MessageLocation } from '@prymeira-talk/shared';

// The website in a business place's `url` field is not necessarily a map.
export function extractLocation(message: unknown): MessageLocation | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const envelope = message as Record<string, unknown>;
  const live = envelope.liveLocationMessage;
  const value = live ?? envelope.locationMessage;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const coordinate = (value: unknown, limit: number): number | null =>
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
  const latitude = coordinate(raw.degreesLatitude, 90);
  const longitude = coordinate(raw.degreesLongitude, 180);
  const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) || null : null;
  return {
    latitude: longitude === null ? null : latitude,
    longitude: latitude === null ? null : longitude,
    name: text(raw.name, 200) ?? text(raw.caption, 200),
    address: text(raw.address, 1000),
    isLive: Boolean(live) || raw.isLive === true
  };
}

export function locationMessageBody(location: MessageLocation): string {
  return [location.isLive ? 'Localização compartilhada — Última posição recebida' : 'Localização compartilhada',
    location.name, location.address, locationMapUrl(location)].filter(Boolean).join('\n');
}
