import { describe, expect, it } from 'vitest';
import { locationMapUrl } from './location.js';

const location = { latitude: 0, longitude: 0, name: null, address: null, isLive: false };
describe('map links for shared locations', () => {
  it('accepts coordinates on the equator and prime meridian', () => {
    expect(locationMapUrl(location)).toBe('https://www.google.com/maps/search/?api=1&query=0%2C0');
  });
  it('falls back to a safely encoded address when coordinates are unavailable', () => {
    const url = locationMapUrl({ ...location, latitude: null, longitude: null, address: 'Rua A & B, 464' })!;
    expect(new URL(url).searchParams.get('query')).toBe('Rua A & B, 464');
  });
  it.each([{ latitude: 91 }, { longitude: -181 }, { latitude: NaN }, { longitude: Infinity }])('rejects invalid map coordinates %s', invalid => {
    expect(locationMapUrl({ ...location, ...invalid })).toBeNull();
  });
  it('does not create a map without a destination', () => {
    expect(locationMapUrl({ ...location, latitude: null, longitude: null })).toBeNull();
  });
});
