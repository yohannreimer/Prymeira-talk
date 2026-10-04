import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PrismaClient } from '@prisma/client';
import type { EvolutionClient } from '../evolution/evolution.client.js';
import { resolveAgentMedia, type AgentMediaPolicy } from '../agents/agent-media-resolver.js';
import { prepareAudioPlayback } from '../agents/audio-transcription.js';
import { renderPdfPreview } from './pdf-preview.js';
import type { MessageMediaService } from './message-media.js';

type Media = { bytes: Buffer; mimeType: string; pageCount?: number };
import { audioMimeTypes as audio, documentMimeTypes as documents, imageMimeTypes as images, isEncryptedWhatsappUrl, MAX_SERVE_MEDIA_BYTES } from './media-policy.js';
const photoPolicy: AgentMediaPolicy = { kind: 'image', maxBytes: 2 * 1024 * 1024, allowedMimeTypes: images };

/** Memory-only, tenant-scoped, bounded cache. No changes to AI state, message bodies or sends. */
export function createInboxMediaService(options: {
  prisma: Pick<PrismaClient, 'conversation' | 'message' | 'contact' | 'channel' | '$executeRaw'> & Partial<Pick<PrismaClient, 'canonicalMessageIdentity'>>;
  client?: Pick<EvolutionClient, 'fetchMedia' | 'fetchProfilePicture'> | null;
  resolve?: typeof resolveAgentMedia;
  convert?: typeof prepareAudioPlayback;
  renderPdf?: typeof renderPdfPreview;
  renderPoster?: (video: Media) => Promise<Media>;
  /** Durable private copy, when the deployment has one. It wins over any provider fetch; a missing or
   * unreadable copy falls back to the legacy path, so enabling it can never make an attachment disappear. */
  durable?: Pick<MessageMediaService, 'read'> | null;
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
    async photoForContact(workspaceId: string, contactId: string) {
      const contact = await options.prisma.contact.findFirst({
        where: { workspaceId, id: contactId }, select: { phone: true, avatarUrl: true }
      });
      if (!contact) throw new Error('NOT_FOUND');
      const conversationChannel = await options.prisma.conversation.findFirst({
        where: { workspaceId, contactId, channel: { provider: 'evolution' } },
        orderBy: { updatedAt: 'desc' },
        select: { channel: { select: { providerKey: true } } }
      });
      const fallbackChannel = conversationChannel ? null : await options.prisma.channel.findFirst({
        where: { workspaceId, provider: 'evolution', status: { in: ['connected', 'connecting'] } },
        orderBy: { updatedAt: 'desc' }, select: { providerKey: true }
      });
      const providerKey = conversationChannel?.channel.providerKey ?? fallbackChannel?.providerKey;
      return cached(`contact-photo:${workspaceId}:${contactId}:${providerKey ?? ''}`, async () => {
        let freshUrl: string | null = null;
        if (providerKey && options.client?.fetchProfilePicture) {
          try { freshUrl = await options.client.fetchProfilePicture({ instanceName: providerKey, number: contact.phone }); }
          catch { /* A saved picture may still be available. */ }
        }
        const url = freshUrl ?? contact.avatarUrl;
        if (!url) return null;
        try {
          const media = await resolve({ mediaUrl: url, policy: photoPolicy });
          if (freshUrl && freshUrl !== contact.avatarUrl) {
            await options.prisma.$executeRaw`UPDATE contacts SET avatar_url = ${freshUrl} WHERE workspace_id = ${workspaceId} AND id = ${contactId}::uuid`.catch(() => undefined);
          }
          return { bytes: media.bytes, mimeType: media.mimeType };
        } catch { return null; }
      });
    },
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
      if (options.durable) {
        try {
          const read = await options.durable.read({ workspaceId, conversationId, messageId });
          // A copy downloaded straight from WhatsApp's CDN is still encrypted (videos and documents were let through
          // as octet-stream): it is not the file, so the provider is asked instead.
          const stored = read && !(read.sourceKind === 'remote' && isEncryptedWhatsappUrl(message.mediaUrl)) ? read : null;
          // An audio without a playback derivative (conversion failed earlier) is converted on demand.
          if (stored && !(message.type === 'audio' && stored.variant === 'original')) return { bytes: stored.bytes, mimeType: stored.mimeType };
          if (stored) return (await cached(`durable-audio:${workspaceId}:${conversationId}:${messageId}`, async () => convert({ bytes: stored.bytes, mimeType: stored.mimeType })))!;
        } catch { /* corrupted or missing blob: serve through the legacy path instead */ }
      }
      const fingerprint = createHash('sha256').update(message.mediaUrl ?? '').digest('hex');
      const key = `${workspaceId}:${conversationId}:${messageId}:${fingerprint}`;
      const policy: AgentMediaPolicy = { kind: message.type === 'audio' ? 'audio' : message.type === 'image' ? 'image' : 'document',
        maxBytes: MAX_SERVE_MEDIA_BYTES, allowedMimeTypes: message.type === 'audio' ? audio : message.type === 'image' ? images : documents };
      const storedMime = /^data:([^;,]+);base64,/i.exec(message.mediaUrl ?? '')?.[1].trim().toLowerCase();
      const storedVisual = storedMime && (message.type === 'image' && images.has(storedMime) ||
        message.type === 'file' && storedMime.startsWith('video/') && documents.has(storedMime));
      // These stored visuals were displayed directly before compact history reads.
      // The raw URL bounds their decoded bytes; provider/remote recovery keeps its limit.
      const storedPolicy = storedVisual ? { ...policy, maxBytes: Math.max(policy.maxBytes, Math.ceil(message.mediaUrl!.length * 3 / 4)) } : policy;
      return (await cached(key, async () => {
        let resolved: Media;
        try {
          if (isEncryptedWhatsappUrl(message.mediaUrl)) throw new Error('ENCRYPTED_MEDIA');
          resolved = await resolve({ mediaUrl: message.mediaUrl, policy: storedPolicy });
        }
        catch {
          // Messages written by the canonical ingress keep the WhatsApp id on their identity, not on the message row.
          const whatsappId = message.providerMessageId || (await options.prisma.canonicalMessageIdentity?.findFirst({
            where: { workspaceId, messageId }, select: { rawId: true } }).catch(() => null))?.rawId;
          if (owner.channel.provider !== 'evolution' || !whatsappId || !options.client?.fetchMedia) throw new Error('MEDIA_UNAVAILABLE');
          const mediaUrl = await options.client.fetchMedia({ instanceName: owner.channel.providerKey, id: whatsappId });
          resolved = await resolve({ mediaUrl, policy });
        }
        return message.type === 'audio' ? convert(resolved) : { bytes: resolved.bytes,
          mimeType: resolved.bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : resolved.mimeType };
      }))!;
    },
    /** The video's first frame as a small JPEG, so the bubble shows the clip like WhatsApp before anyone plays it. */
    async poster(workspaceId: string, conversationId: string, messageId: string): Promise<Media> {
      const video = await this.media(workspaceId, conversationId, messageId);
      if (!video.mimeType.startsWith('video/')) throw new Error('NOT_A_VIDEO');
      const fingerprint = createHash('sha256').update(video.bytes).digest('hex');
      return (await cached(`poster:${workspaceId}:${conversationId}:${messageId}:${fingerprint}`, () => (options.renderPoster ?? renderVideoPoster)(video)))!;
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
    },
    /** The WhatsApp picture of a number shared in a contact card, read through the conversation's channel. */
    async photoForPhone(workspaceId: string, conversationId: string, phone: string) {
      const owner = await conversation(workspaceId, conversationId);
      const number = phone.replace(/\D/g, '');
      if (owner.channel.provider !== 'evolution' || number.length < 8 || !options.client?.fetchProfilePicture) return null;
      return cached(`card-photo:${workspaceId}:${owner.channel.providerKey}:${number}`, async () => {
        const url = await options.client!.fetchProfilePicture!({ instanceName: owner.channel.providerKey, number });
        if (!url) return null;
        const media = await resolve({ mediaUrl: url, policy: photoPolicy });
        return { bytes: media.bytes, mimeType: media.mimeType };
      });
    },
    /** The connected number's own WhatsApp picture, shown on voice notes we sent. */
    async channelPhoto(workspaceId: string, channelId: string) {
      const channel = await options.prisma.channel.findFirst({
        where: { workspaceId, id: channelId }, select: { provider: true, providerKey: true, phoneNumber: true }
      });
      if (!channel) throw new Error('NOT_FOUND');
      const number = channel.phoneNumber?.replace(/\D/g, '');
      if (channel.provider !== 'evolution' || !number || !options.client?.fetchProfilePicture) return null;
      return cached(`channel-photo:${workspaceId}:${channelId}:${channel.providerKey}`, async () => {
        const url = await options.client!.fetchProfilePicture!({ instanceName: channel.providerKey, number });
        if (!url) return null;
        const media = await resolve({ mediaUrl: url, policy: photoPolicy });
        return { bytes: media.bytes, mimeType: media.mimeType };
      });
    }
  };
}

const run = promisify(execFile);
/** ffmpeg (already in the API image for voice notes) reads the clip once and writes a ≤480px JPEG of its first frame. */
export async function renderVideoPoster(video: Media): Promise<Media> {
  const directory = await mkdtemp(join(tmpdir(), 'talk-poster-'));
  try {
    const source = join(directory, 'video'), target = join(directory, 'poster.jpg');
    await writeFile(source, video.bytes);
    const frame = (seek: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...seek, '-i', source, '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '5', target], { timeout: 20_000 });
    // A clip shorter than the seek point has no frame there; its very first frame is used instead.
    await frame(['-ss', '0.1']).catch(() => frame([]));
    const bytes = await readFile(target);
    if (!bytes.length) throw new Error('POSTER_FAILED');
    return { bytes, mimeType: 'image/jpeg' };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
