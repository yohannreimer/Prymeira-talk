import { describe, it, expect } from 'vitest';
import { mediaDataUrl } from './media-data-url';

describe('private media under production CSP', () => {
  it.each(['audio/mpeg', 'image/jpeg', 'application/pdf'])('preserves %s bytes without a blocked blob URL', async type => {
    const bytes = Uint8Array.from({ length: 35000 }, (_, i) => i % 256);
    const url = await mediaDataUrl(new Blob([bytes], { type }));
    expect(url.startsWith(`data:${type};base64,`)).toBe(true);
    expect(new Uint8Array(Buffer.from(url.split(',')[1], 'base64'))).toEqual(bytes);
  });
  it('uses a safe default MIME type', async () => {
    expect(await mediaDataUrl(new Blob([]))).toBe('data:application/octet-stream;base64,');
  });
});
