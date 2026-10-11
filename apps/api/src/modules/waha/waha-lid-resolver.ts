import { normalizeChatAddress } from '../messaging/whatsapp-identity.js';
import type { WahaClient } from './waha.client.js';

export type LidMapping = { lid: string; pn: string };

/** Every LID an event mentions (chat, sender, serialized ids), bounded. */
export function lidsIn(input: unknown, max = 5): string[] {
  const text = JSON.stringify(input ?? null);
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(\d{6,20})@lid\b/g)) {
    found.add(`${match[1]}@lid`);
    if (found.size >= max) break;
  }
  return [...found];
}

/**
 * WAHA's own LID→phone mapping (`GET /api/{session}/lids/{lid}`, WAHA 2026.9.1; the WPP engine reads it from the
 * session's PN/LID table). This is the "verified lookup" the identity rules accept for WAHA, which carries no
 * phone/LID pair in its events. Only an answer for exactly the requested LID with a real phone counts; anything
 * else (unknown, error, timeout) is simply no proof, which is today's behaviour. Answers are cached per session.
 */
export function createWahaLidResolver(client: Pick<WahaClient, 'findPnByLid'>, options: { ttlMs?: number; unknownTtlMs?: number; maxEntries?: number; now?: () => number } = {}) {
  const cache = new Map<string, { pn: string | null; until: number }>();
  const now = options.now ?? Date.now, ttl = options.ttlMs ?? 6 * 60 * 60_000, unknownTtl = options.unknownTtlMs ?? 60_000, max = options.maxEntries ?? 10_000;
  async function lookup(session: string, lid: string): Promise<string | null> {
    const key = `${session}\n${lid}`, cached = cache.get(key);
    if (cached && cached.until > now()) return cached.pn;
    let pn: string | null = null;
    try {
      const answer = await client.findPnByLid({ session, lid });
      const answeredLid = normalizeChatAddress(answer?.lid ?? null), phone = normalizeChatAddress(answer?.pn ?? null);
      if (answeredLid === lid && phone?.endsWith('@s.whatsapp.net')) pn = phone;
    } catch { /* no proof */ }
    if (cache.size >= max) cache.delete(cache.keys().next().value!);
    cache.set(key, { pn, until: now() + (pn ? ttl : unknownTtl) });
    return pn;
  }
  return {
    lookup,
    async resolve(session: string, input: unknown): Promise<LidMapping[]> {
      const mappings: LidMapping[] = [];
      for (const lid of lidsIn(input)) {
        const pn = await lookup(session, lid);
        if (pn) mappings.push({ lid, pn });
      }
      return mappings;
    }
  };
}
export type WahaLidResolver = ReturnType<typeof createWahaLidResolver>;
