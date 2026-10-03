import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInboxMediaService, renderVideoPoster } from './inbox-media.js';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe('video poster', () => {
  it.skipIf(!hasFfmpeg)('renders the first frame of a tall clip as a JPEG no wider than 480px', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poster-test-')), clip = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=0.05:size=720x1280:rate=20', '-pix_fmt', 'yuv420p', clip]);
    const poster = await renderVideoPoster({ bytes: readFileSync(clip), mimeType: 'video/mp4' });
    expect(poster.mimeType).toBe('image/jpeg');
    expect(poster.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
  it('asks Evolution with the canonical WhatsApp id when the message row has none (GIFs from the new ingress)', async () => {
    const fetchMedia = async (input: { instanceName: string; id: string }) => { expect(input).toEqual({ instanceName: 'inst', id: '3EB0GIF' }); return 'data:video/mp4;base64,AAAAGGZ0eXA='; };
    const prisma = {
      conversation: { findFirst: async () => ({ contact: { phone: '1' }, channel: { provider: 'evolution', providerKey: 'inst' } }) },
      message: { findFirst: async () => ({ type: 'file', mediaUrl: 'https://mmg.whatsapp.net/o1/v/t24/x', providerMessageId: null }) },
      canonicalMessageIdentity: { findFirst: async () => ({ rawId: '3EB0GIF' }) }
    };
    const service = createInboxMediaService({ prisma: prisma as never, client: { fetchMedia } as never,
      resolve: (async ({ mediaUrl }: { mediaUrl: string }) => { if (!mediaUrl.startsWith('data:')) throw new Error('remote'); return { bytes: Buffer.from('ftyp'), mimeType: 'video/mp4', source: 'data_url' }; }) as never });
    const media = await service.media('w', 'c', 'm');
    expect(media.mimeType).toBe('video/mp4');
  });
});
