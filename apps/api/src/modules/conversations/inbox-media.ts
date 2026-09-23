import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { EvolutionClient } from '../evolution/evolution.client.js';
import { resolveAgentMedia, type AgentMediaPolicy } from '../agents/agent-media-resolver.js';
import { prepareAudioPlayback } from '../agents/audio-transcription.js';
import { renderPdfPreview } from './pdf-preview.js';

type Media = { bytes: Buffer; mimeType: string; pageCount?: number };
const images = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const audio = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/opus', 'audio/webm', 'video/webm']);
const documents = new Set(['application/pdf', 'video/mp4', 'video/webm', 'video/quicktime', 'application/octet-stream', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain']);
const photoPolicy: AgentMediaPolicy = { kind: 'image', maxBytes: 2 * 1024 * 1024, allowedMimeTypes: images };

/** Memory-only, tenant-scoped, bounded cache. No changes to AI state, message bodies or sends. */
export function createInboxMediaService(options: {
  prisma: Pick<PrismaClient, 'conversation' | 'message'>;
  client?: Pick<EvolutionClient, 'fetchMedia' | 'fetchProfilePicture'> | null;
  resolve?: typeof resolveAgentMedia;
  convert?: typeof prepareAudioPlayback;
  renderPdf?: typeof renderPdfPreview;
}) {
  const resolve = options.resolve ?? resolveAgentMedia;
  const convert = options.convert ?? prepareAudioPlayback;
  const cache = new Map<string, { value: Media | null; expires: number }>();
  const pending = new Map<string, Promise<Media | null>>();
  let cacheBytes = 0;
  let running = 0;
  const queue: Array<() => void> = [];
  async function cached(key: string, work: () => Promise<Media | null>): Promise<Media | null> {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (pending.has(key)) return pending.get(key)!;
    if (queue.length >= 32) throw new Error('MEDIA_BUSY');
    const job = (async () => {
      if (running >= 2) await new Promise<void>(resolve => queue.push(resolve));
      else running++;
      try {
        const value = await work();
        const previous = cache.get(key);
        if (previous) { cacheBytes -= previous.value?.bytes.length ?? 0; cache.delete(key); }
        cache.set(key, { value, expires: Date.now() + (value ? 15 * 60_000 : 60_000) });
        cacheBytes += value?.bytes.length ?? 0;
        while (cacheBytes > 64 * 1024 * 1024 || cache.size > 256) {
          const oldest = cache.keys().next().value!;
          cacheBytes -= cache.get(oldest)?.value?.bytes.length ?? 0;
          cache.delete(oldest);
        }
        return value;
      } finally { const next = queue.shift(); if (next) next(); else running--; }
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  }
  async function conversation(workspaceId: string, id: string) {
    const result = await options.prisma.conversation.findFirst({
      where: { workspaceId, id },
      select: { contact: { select: { phone: true } }, channel: { select: { provider: true, providerKey: true } } }
    });
    if (!result) throw new Error('NOT_FOUND');
    return result;
  }
  return {
    async preview(workspaceId: string, conversationId: string, messageId: string, page: number): Promise<Media> {
      if (!Number.isInteger(page) || page < 1 || page > 2000) throw new Error('INVALID_PDF_PAGE');
      const media = await this.media(workspaceId, conversationId, messageId);
      if (media.mimeType !== 'application/pdf') throw new Error('INVALID_PDF');
      const fingerprint = createHash('sha256').update(media.bytes).digest('hex');
      return (await cached(`pdf:${workspaceId}:${conversationId}:${messageId}:${fingerprint}:${page}`, () => (options.renderPdf ?? renderPdfPreview)(media.bytes, page)))!;
    },
    async media(workspaceId: string, conversationId: string, messageId: string): Promise<Media> {
      const owner = await conversation(workspaceId, conversationId);
      const message = await options.prisma.message.findFirst({ where: { id: messageId, conversationId, workspaceId },
        select: { type: true, mediaUrl: true, providerMessageId: true } });
      if (!message || !['audio', 'image', 'file'].includes(message.type)) throw new Error('NOT_FOUND');
      const fingerprint = createHash('sha256').update(message.mediaUrl ?? '').digest('hex');
      const key = `${workspaceId}:${conversationId}:${messageId}:${fingerprint}`;
      const policy: AgentMediaPolicy = { kind: message.type === 'audio' ? 'audio' : message.type === 'image' ? 'image' : 'document',
        maxBytes: 25 * 1024 * 1024, allowedMimeTypes: message.type === 'audio' ? audio : message.type === 'image' ? images : documents };
      return (await cached(key, async () => {
        let resolved: Media;
        try {
          if (/\.enc(?:\?|$)/i.test(message.mediaUrl ?? '')) throw new Error('ENCRYPTED_MEDIA');
          resolved = await resolve({ mediaUrl: message.mediaUrl, policy });
        }
        catch {
          if (owner.channel.provider !== 'evolution' || !message.providerMessageId || !options.client?.fetchMedia) throw new Error('MEDIA_UNAVAILABLE');
          const mediaUrl = await options.client.fetchMedia({ instanceName: owner.channel.providerKey, id: message.providerMessageId });
          resolved = await resolve({ mediaUrl, policy });
        }
        return message.type === 'audio' ? convert(resolved) : { bytes: resolved.bytes,
          mimeType: resolved.bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : resolved.mimeType };
      }))!;
    },
    async photo(workspaceId: string, conversationId: string) {
      const owner = await conversation(workspaceId, conversationId);
      if (owner.channel.provider !== 'evolution' || !options.client?.fetchProfilePicture) return null;
      return cached(`photo:${workspaceId}:${conversationId}:${owner.channel.providerKey}`, async () => {
        const url = await options.client!.fetchProfilePicture!({ instanceName: owner.channel.providerKey, number: owner.contact.phone });
        if (!url) return null;
        const media = await resolve({ mediaUrl: url, policy: photoPolicy });
        return { bytes: media.bytes, mimeType: media.mimeType };
      });
    }
  };
}
