import type { PrismaClient } from '@prisma/client';
import { AgentMediaError, resolveAgentMedia } from '../agents/agent-media-resolver.js';
import { prepareAudioPlayback } from '../agents/audio-transcription.js';
import type { IngressPrivateStore } from '../ingress/private-store.js';
import { isAttachmentType, isEncryptedWhatsappUrl, MAX_SERVE_MEDIA_BYTES, servePolicy, type AttachmentMessageType } from './media-policy.js';

/** Durable, provider-independent copy of a message attachment. Originals and the audio playback
 * derivative live in the private store (never in the queue, never behind a provider URL, which
 * expires); `message_media` keeps only references and digests. Everything here is resumable:
 * calling `prepare` again continues from whatever is already stored. */

/** A way to ask the provider again for the bytes. Evolution answers with a data URL, WAHA with bytes. */
export type ProviderMedia = { mediaUrl: string } | { bytes: Uint8Array; mimeType: string | null } | null;
export type ProviderFetcher = { name: string; fetch(): Promise<ProviderMedia> };

export type PrepareResult =
  | { state: 'stored'; playback: 'ready' | 'failed' | 'not_applicable' }
  | { state: 'limit_exceeded' | 'unavailable' | 'failed'; errorCode: string; retryable: boolean };

type Db = Pick<PrismaClient, 'message' | 'messageMedia'>;

const sniffers: Array<[string, (b: Buffer) => boolean]> = [
  ['application/pdf', b => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/gif', b => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['audio/ogg', b => b.subarray(0, 4).toString('latin1') === 'OggS'],
  ['audio/mpeg', b => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)],
  ['video/mp4', b => b.subarray(4, 8).toString('latin1') === 'ftyp']
];
const normalizeMime = (value: string | null | undefined) => value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
function sniffMime(bytes: Buffer) { return sniffers.find(([, test]) => test(bytes))?.[0] ?? null; }

function classify(error: unknown): { state: 'limit_exceeded' | 'unavailable' | 'failed'; errorCode: string; retryable: boolean } {
  if (error instanceof AgentMediaError) {
    if (error.code === 'MEDIA_TOO_LARGE') return { state: 'limit_exceeded', errorCode: error.code, retryable: false };
    if (error.code === 'MEDIA_TIMEOUT' || error.code === 'MEDIA_UNAVAILABLE') return { state: 'unavailable', errorCode: error.code, retryable: true };
    return { state: 'failed', errorCode: error.code, retryable: false };
  }
  return { state: 'unavailable', errorCode: 'MEDIA_UNAVAILABLE', retryable: true };
}

export function createMessageMediaService(options: {
  db: Db;
  store: IngressPrivateStore;
  resolve?: typeof resolveAgentMedia;
  convertAudio?: typeof prepareAudioPlayback;
}) {
  const { db, store } = options;
  const resolve = options.resolve ?? resolveAgentMedia;
  const convertAudio = options.convertAudio ?? prepareAudioPlayback;

  async function acquire(type: AttachmentMessageType, mediaUrl: string | null, fetchers: ProviderFetcher[]) {
    const policy = servePolicy(type);
    const errors: ReturnType<typeof classify>[] = [];
    const attempts: Array<() => Promise<{ bytes: Buffer; mimeType: string; sourceKind: string }>> = [];
    if (mediaUrl && !isEncryptedWhatsappUrl(mediaUrl)) {
      attempts.push(async () => {
        const media = await resolve({ mediaUrl, policy });
        return { bytes: media.bytes, mimeType: media.mimeType, sourceKind: media.source === 'data_url' ? 'inline' : 'remote' };
      });
    }
    for (const fetcher of fetchers) {
      attempts.push(async () => {
        const provided = await fetcher.fetch();
        if (!provided) throw new AgentMediaError('MEDIA_UNAVAILABLE', 'Provider has no media for this message.');
        if ('mediaUrl' in provided) {
          const media = await resolve({ mediaUrl: provided.mediaUrl, policy });
          return { bytes: media.bytes, mimeType: media.mimeType, sourceKind: fetcher.name };
        }
        if (provided.bytes.byteLength > policy.maxBytes) throw new AgentMediaError('MEDIA_TOO_LARGE', 'Inbound media exceeds the size limit.');
        const bytes = Buffer.from(provided.bytes);
        let mimeType = normalizeMime(provided.mimeType);
        if (!mimeType || mimeType === 'application/octet-stream') mimeType = sniffMime(bytes) ?? mimeType;
        if (!policy.allowedMimeTypes.has(mimeType)) throw new AgentMediaError('UNSUPPORTED_MEDIA_TYPE', 'Inbound media type is unsupported.');
        return { bytes, mimeType, sourceKind: fetcher.name };
      });
    }
    for (const attempt of attempts) {
      try { return { ok: true as const, media: await attempt() }; } catch (error) { errors.push(classify(error)); }
    }
    // Nothing worked: a size problem is the most useful thing to tell the operator, then a transient
    // one (worth retrying), and only then a permanent one. No source at all is treated as transient
    // because a provider can publish the file after the message event.
    const limit = errors.find(e => e.state === 'limit_exceeded');
    const transient = errors.find(e => e.retryable);
    return { ok: false as const, failure: limit ?? transient ?? errors[0] ?? { state: 'unavailable' as const, errorCode: 'MEDIA_UNAVAILABLE', retryable: true } };
  }

  /** `useStoredUrl: false` for sources whose saved URL belongs to the provider (WAHA): it is internal and
   * temporary, so only an authenticated, scoped provider fetch may supply the bytes. */
  async function prepare(input: { workspaceId: string; messageId: string; fetchers?: ProviderFetcher[]; useStoredUrl?: boolean }): Promise<PrepareResult> {
    const message = await db.message.findFirst({ where: { id: input.messageId, workspaceId: input.workspaceId },
      select: { id: true, conversationId: true, type: true, mediaUrl: true } });
    if (!message || !isAttachmentType(message.type)) return { state: 'failed', errorCode: 'NOT_AN_ATTACHMENT', retryable: false };
    const where = { messageId: message.id };
    const row = await db.messageMedia.upsert({ where,
      create: { messageId: message.id, workspaceId: input.workspaceId, conversationId: message.conversationId, attempts: 1 },
      update: { attempts: { increment: 1 } } });

    let originalRef = row.state === 'stored' ? row.originalRef : null;
    let original: { bytes: Buffer; mimeType: string } | null = null;
    if (!originalRef) {
      const result = await acquire(message.type, input.useStoredUrl === false ? null : message.mediaUrl, input.fetchers ?? []);
      if (!result.ok) {
        await db.messageMedia.update({ where, data: { state: result.failure.state, errorCode: result.failure.errorCode, updatedAt: new Date() } });
        return result.failure;
      }
      original = { bytes: result.media.bytes, mimeType: result.media.mimeType };
      const saved = await store.put(original.bytes);
      await db.messageMedia.update({ where, data: { state: 'stored', sourceKind: result.media.sourceKind, mimeType: original.mimeType,
        sizeBytes: original.bytes.length, sha256: saved.digest, originalRef: saved.ref, errorCode: null, updatedAt: new Date() } });
      originalRef = saved.ref;
    }
    if (message.type !== 'audio') return { state: 'stored', playback: 'not_applicable' };

    const current = await db.messageMedia.findUniqueOrThrow({ where });
    if (current.playbackRef) return { state: 'stored', playback: 'ready' };
    try {
      const source = original ?? { bytes: await store.read(current.originalRef!, current.sha256!), mimeType: current.mimeType! };
      const playback = await convertAudio({ bytes: source.bytes, mimeType: source.mimeType });
      if (playback.bytes.length > MAX_SERVE_MEDIA_BYTES) throw new AgentMediaError('MEDIA_TOO_LARGE', 'Playback exceeds the size limit.');
      const saved = await store.put(Buffer.from(playback.bytes));
      await db.messageMedia.update({ where, data: { playbackRef: saved.ref, playbackSha256: saved.digest, playbackMimeType: playback.mimeType, errorCode: null, updatedAt: new Date() } });
      return { state: 'stored', playback: 'ready' };
    } catch {
      // The original is safe; only the derivative is missing, so a later attempt resumes from here.
      await db.messageMedia.update({ where, data: { errorCode: 'PLAYBACK_FAILED', updatedAt: new Date() } });
      return { state: 'stored', playback: 'failed' };
    }
  }

  /** Bytes for the authenticated endpoint. Null when nothing durable exists yet (caller falls back). */
  async function read(input: { workspaceId: string; conversationId: string; messageId: string; variant?: 'original' | 'playback' }) {
    const row = await db.messageMedia.findFirst({ where: { messageId: input.messageId, workspaceId: input.workspaceId, conversationId: input.conversationId, state: 'stored' } });
    if (!row?.originalRef || !row.sha256 || !row.mimeType) return null;
    if (input.variant !== 'original' && row.playbackRef && row.playbackSha256) {
      return { bytes: await store.read(row.playbackRef, row.playbackSha256), mimeType: row.playbackMimeType ?? 'audio/mpeg', variant: 'playback' as const };
    }
    const bytes = await store.read(row.originalRef, row.sha256);
    return { bytes, mimeType: row.mimeType === 'application/octet-stream' && sniffMime(bytes) === 'application/pdf' ? 'application/pdf' : row.mimeType, variant: 'original' as const,
      sourceKind: row.sourceKind };
  }

  return { prepare, read };
}

export type MessageMediaService = ReturnType<typeof createMessageMediaService>;
