import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocationMessage } from './LocationMessage';

const location = { name: 'Grupo Villefer', address: 'R. Landmann, 464, Joinville', latitude: -26.254, longitude: -48.875, isLive: false };

describe('shared location in the inbox', () => {
  it('shows the business name, address and a link to its coordinates', () => {
    const html = renderToStaticMarkup(<LocationMessage location={location} />);
    expect(html).toContain('Grupo Villefer');
    expect(html).toContain(location.address);
    expect(html).toContain('Abrir no mapa');
    expect(html).toContain('https://www.google.com/maps/search/?api=1&amp;query=-26.254%2C-48.875');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('Última posição recebida');
  });
  it('describes a live location as the last received position', () => {
    expect(renderToStaticMarkup(<LocationMessage location={{ ...location, isLive: true }} />)).toContain('Última posição recebida');
  });
  it('keeps a location without a map visible and escapes received labels', () => {
    const html = renderToStaticMarkup(<LocationMessage location={{ ...location, name: '<script>test</script>', address: null, latitude: null, longitude: null }} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('shows a fallback when no coordinates or address were received', () => {
    const html = renderToStaticMarkup(<LocationMessage location={{ ...location, name: null, address: null, latitude: null, longitude: null }} />);
    expect(html).toContain('Localização compartilhada');
    expect(html).not.toContain('<a ');
  });
});
