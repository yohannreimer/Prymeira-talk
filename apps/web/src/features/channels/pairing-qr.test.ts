import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { decodePairingQrPixels, isWhatsappPairingQr } from './qr-display';

const key = 'A'.repeat(43) + '=';
const pairing = `2@synthetic-reference-for-tests,${key},${key},${key}`;
function pixels(payload: string) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const scale = 5, margin = 4, size = (qr.modules.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < qr.modules.size; y++) for (let x = 0; x < qr.modules.size; x++) {
    if (!qr.modules.get(y, x)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const offset = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
      data.set([0, 80, 190, 255], offset); // A real blue QR, not a mocked decoder result.
    }
  }
  return { data, size };
}
describe('WhatsApp pairing readiness', () => {
  it('accepts legacy Evolution/WAHA pairing and the linked-devices format', () => {
    expect(isWhatsappPairingQr(pairing)).toBe(true);
    expect(isWhatsappPairingQr(`https://wa.me/settings/linked_devices#${pairing},1`)).toBe(true);
  });
  it.each(['https://example.com/setup', 'waiting', '2@qr-payload', `2@synthetic-reference-for-tests,bad,${key},${key}`, `${pairing},https://example.com`])('rejects non-pairing content: %s', (value) => {
    expect(isWhatsappPairingQr(value)).toBe(false);
  });
  it('decodes a legitimate blue pairing QR', () => {
    const { data, size } = pixels(pairing);
    expect(decodePairingQrPixels(data, size, size)).toBe(pairing);
  });
  it('withholds a real blue QR encoding an unrelated setup page', () => {
    const { data, size } = pixels('https://example.com/setup');
    expect(decodePairingQrPixels(data, size, size)).toBeNull();
  });
  it('rejects blank and invalid pixel data', () => {
    expect(decodePairingQrPixels(new Uint8ClampedArray(64).fill(255), 4, 4)).toBeNull();
  });
});
