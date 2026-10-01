import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/** rawHeaders is necessary: Node may coalesce duplicate authentication headers. */
export function singleHeader(request: FastifyRequest, name: string): string | null {
  const raw = request.raw.rawHeaders;
  let found: string | null = null;
  for (let i = 0; i < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) {
    if (found !== null) return null;
    found = raw[i + 1] ?? null;
  }
  return found;
}
export function secretMatches(actual: string | null, expected: string) {
  return !!actual && !!expected && timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}
export function signatureMatches(actual: string | null, bytes: Buffer, secret: string, algorithm: 'sha256' | 'sha512') {
  const size = algorithm === 'sha512' ? 128 : 64;
  if (!secret || !actual || !new RegExp(`^[0-9a-f]{${size}}$`, 'i').test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), createHmac(algorithm, secret).update(bytes).digest());
}
export function authenticateWaha(request: FastifyRequest, bytes: Buffer, secret: string) {
  // WAHA pinned 55a7d78e WebhookPlugin.sender uses exactly these two headers.
  return singleHeader(request, 'x-webhook-hmac-algorithm') === 'sha512'
    && signatureMatches(singleHeader(request, 'x-webhook-hmac'), bytes, secret, 'sha512');
}
