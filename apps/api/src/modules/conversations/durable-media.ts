import { isAbsolute } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { IngressPrivateStore } from '../ingress/private-store.js';
import { createMessageMediaService } from './message-media.js';
import { createMessageTranscriptionService } from './message-transcription.js';
import { MAX_SERVE_MEDIA_BYTES } from './media-policy.js';

/** Opt-in: when TALK_MEDIA_STORE_PATH is not configured the app keeps the legacy media path untouched. */
export async function createDurableMedia(input: { prisma: PrismaClient; root: string }) {
  if (!isAbsolute(input.root)) throw new Error('TALK_MEDIA_STORE_PATH must be an absolute path');
  // A little headroom: the store caps the blob, the media service enforces the 25 MiB serve limit.
  const store = new IngressPrivateStore(input.root, MAX_SERVE_MEDIA_BYTES + 1024 * 1024);
  await store.initialize();
  return {
    store,
    media: createMessageMediaService({ db: input.prisma, store }),
    transcriptions: createMessageTranscriptionService({ db: input.prisma })
  };
}
export type DurableMedia = Awaited<ReturnType<typeof createDurableMedia>>;
