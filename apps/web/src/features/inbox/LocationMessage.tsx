import { locationMapUrl, type MessageLocation } from '@prymeira-talk/shared';
import { MapPin } from 'lucide-react';
import './location-message.css';

export function LocationMessage({ location }: { location: MessageLocation }) {
  const mapUrl = locationMapUrl(location);
  return <div className="talk-shared-location">
    <strong><MapPin size={16} aria-hidden="true" /> {location.name ?? 'Localização compartilhada'}</strong>
    {location.address ? <span>{location.address}</span> : null}
    {location.isLive ? <small>Última posição recebida</small> : null}
    {mapUrl ? <a href={mapUrl} target="_blank" rel="noopener noreferrer">Abrir no mapa</a> : <small>Localização sem coordenadas ou endereço</small>}
  </div>;
}
