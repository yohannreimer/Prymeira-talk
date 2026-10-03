import { describe, expect, it } from 'vitest';
import { isEncryptedWhatsappUrl } from './media-policy.js';

describe('isEncryptedWhatsappUrl', () => {
  it("treats WhatsApp's CDN as encrypted even without a .enc suffix (GIFs and videos from Evolution)", () => {
    expect(isEncryptedWhatsappUrl('https://mmg.whatsapp.net/o1/v/t24/f2/m234/AQMIz_oSy3?ccb=9-4&oh=x')).toBe(true);
    expect(isEncryptedWhatsappUrl('https://media-gru1-1.cdn.whatsapp.net/v/t62/abc')).toBe(true);
    expect(isEncryptedWhatsappUrl('https://example.test/file.enc?x=1')).toBe(true);
  });
  it('leaves readable sources alone', () => {
    expect(isEncryptedWhatsappUrl('http://waha:3000/api/files/session/abc.mp4')).toBe(false);
    expect(isEncryptedWhatsappUrl('https://notwhatsapp.net.example/x')).toBe(false);
    expect(isEncryptedWhatsappUrl('data:video/mp4;base64,YQ==')).toBe(false);
    expect(isEncryptedWhatsappUrl(null)).toBe(false);
  });
});
