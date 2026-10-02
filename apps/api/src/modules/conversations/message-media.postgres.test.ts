import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IngressPrivateStore } from '../ingress/private-store.js';
import { createMessageMediaService, type ProviderFetcher } from './message-media.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

describe.skipIf(!databaseUrl)('durable message media on PostgreSQL', () => {
  let db: PrismaClient;
  let root: string;
  let store: IngressPrivateStore;
  const workspaces: string[] = [];
  let ogg: Buffer;

  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    root = await realpath(await mkdtemp(join(tmpdir(), 'talk-media-store-')));
    store = new IngressPrivateStore(root, 26 * 1024 * 1024);
    await store.initialize();
    const out = join(root, '..', `sine-${randomUUID()}.ogg`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', out]);
    const { readFile, rm: remove } = await import('node:fs/promises');
    ogg = await readFile(out); await remove(out);
  });
  afterAll(async () => {
    if (db) {
      for (const workspaceId of workspaces) {
        await db.message.deleteMany({ where: { workspaceId } }); await db.conversation.deleteMany({ where: { workspaceId } });
        await db.contact.deleteMany({ where: { workspaceId } }); await db.channel.deleteMany({ where: { workspaceId } });
      }
      await db.$disconnect();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function fixture(message: { type: 'audio' | 'image' | 'file'; mediaUrl?: string | null }) {
    const workspaceId = `media-${randomUUID()}`; workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const contact = await db.contact.create({ data: { workspaceId, phone: '15550001111' } });
    const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id } });
    const row = await db.message.create({ data: { workspaceId, conversationId: conversation.id, direction: 'inbound', type: message.type, body: 'x', mediaUrl: message.mediaUrl ?? null } });
    return { workspaceId, conversationId: conversation.id, messageId: row.id };
  }
  const service = (extra: Parameters<typeof createMessageMediaService>[0] extends infer T ? Partial<T> : never = {}) =>
    createMessageMediaService({ db, store, ...extra } as Parameters<typeof createMessageMediaService>[0]);
  const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
  const blobs = async () => (await readdir(root)).filter(name => name.endsWith('.blob')).length;

  it('stores an inline image once and serves identical bytes; a second run changes nothing', async () => {
    const f = await fixture({ type: 'image', mediaUrl: dataUrl('image/png', PNG) });
    const media = service();
    expect(await media.prepare(f)).toEqual({ state: 'stored', playback: 'not_applicable' });
    const before = await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } });
    expect(before).toMatchObject({ state: 'stored', sourceKind: 'inline', mimeType: 'image/png', sizeBytes: PNG.length, errorCode: null });
    const served = await media.read(f);
    expect(served?.mimeType).toBe('image/png');
    expect(served?.bytes.equals(PNG)).toBe(true);
    const count = await blobs();
    expect(await media.prepare(f)).toEqual({ state: 'stored', playback: 'not_applicable' });
    const after = await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } });
    expect(after.originalRef).toBe(before.originalRef);
    expect(after.attempts).toBe(2);
    expect(await blobs()).toBe(count);
  });

  it('keeps the original OGG untouched and serves an MP3 for playback', async () => {
    const f = await fixture({ type: 'audio', mediaUrl: dataUrl('audio/ogg', ogg) });
    const media = service();
    expect(await media.prepare(f)).toEqual({ state: 'stored', playback: 'ready' });
    const row = await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } });
    expect(row.playbackMimeType).toBe('audio/mpeg');
    expect(row.playbackRef).not.toBe(row.originalRef);
    expect((await media.read({ ...f, variant: 'original' }))?.bytes.equals(ogg)).toBe(true);
    const playback = await media.read(f);
    expect(playback?.mimeType).toBe('audio/mpeg');
    expect(playback?.bytes.subarray(0, 3).toString('latin1') === 'ID3' || playback?.bytes[0] === 0xff).toBe(true);
  });

  it('recovers through the provider when the stored URL is encrypted, sniffing the type when the provider omits it', async () => {
    const f = await fixture({ type: 'file', mediaUrl: 'https://mmg.whatsapp.net/file.enc?x=1' });
    const fetcher = vi.fn(async () => ({ bytes: new Uint8Array(PDF), mimeType: null }));
    const result = await service().prepare({ ...f, fetchers: [{ name: 'waha', fetch: fetcher }] });
    expect(result).toEqual({ state: 'stored', playback: 'not_applicable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } })).toMatchObject({ sourceKind: 'waha', mimeType: 'application/pdf' });
  });

  it('reports a limit instead of an opaque failure, and recovers when a later attempt fits', async () => {
    const f = await fixture({ type: 'file' });
    const huge: ProviderFetcherLike = { name: 'waha', fetch: async () => ({ bytes: new Uint8Array(25 * 1024 * 1024 + 1), mimeType: 'application/pdf' }) };
    expect(await service().prepare({ ...f, fetchers: [huge] })).toEqual({ state: 'limit_exceeded', errorCode: 'MEDIA_TOO_LARGE', retryable: false });
    expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } })).toMatchObject({ state: 'limit_exceeded', originalRef: null });
    expect(await service().read(f)).toBeNull();
    const ok: ProviderFetcherLike = { name: 'waha', fetch: async () => ({ bytes: new Uint8Array(PDF), mimeType: 'application/pdf' }) };
    expect((await service().prepare({ ...f, fetchers: [ok] })).state).toBe('stored');
  });

  it('treats a missing provider copy as retryable and an unsupported type as permanent', async () => {
    const pending = await fixture({ type: 'image' });
    expect(await service().prepare(pending)).toEqual({ state: 'unavailable', errorCode: 'MEDIA_UNAVAILABLE', retryable: true });
    expect(await service().prepare({ ...pending, fetchers: [{ name: 'evolution', fetch: async () => null }] })).toMatchObject({ state: 'unavailable', retryable: true });
    const bad = await fixture({ type: 'image' });
    const exe: ProviderFetcherLike = { name: 'waha', fetch: async () => ({ bytes: new Uint8Array([0x4d, 0x5a, 0, 0]), mimeType: 'application/x-msdownload' }) };
    expect(await service().prepare({ ...bad, fetchers: [exe] })).toEqual({ state: 'failed', errorCode: 'UNSUPPORTED_MEDIA_TYPE', retryable: false });
    expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: bad.messageId } })).toMatchObject({ state: 'failed', errorCode: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('resumes a failed playback conversion without asking the provider again', async () => {
    const f = await fixture({ type: 'audio' });
    const fetcher = vi.fn(async () => ({ bytes: new Uint8Array(ogg), mimeType: 'audio/ogg' }));
    const broken = service({ convertAudio: async () => { throw new Error('ffmpeg exploded'); } });
    expect(await broken.prepare({ ...f, fetchers: [{ name: 'waha', fetch: fetcher }] })).toEqual({ state: 'stored', playback: 'failed' });
    expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } })).toMatchObject({ state: 'stored', errorCode: 'PLAYBACK_FAILED', playbackRef: null });
    expect((await broken.read(f))?.bytes.equals(ogg)).toBe(true);
    expect(await service().prepare({ ...f, fetchers: [{ name: 'waha', fetch: fetcher }] })).toEqual({ state: 'stored', playback: 'ready' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } })).toMatchObject({ errorCode: null });
  });

  it('never serves another workspace’s media and detects tampered blobs', async () => {
    const f = await fixture({ type: 'image', mediaUrl: dataUrl('image/png', PNG) });
    const media = service();
    await media.prepare(f);
    expect(await media.read({ ...f, workspaceId: `media-${randomUUID()}` })).toBeNull();
    expect(await media.read({ ...f, conversationId: randomUUID() })).toBeNull();
    const row = await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, row.originalRef!), Buffer.from('tampered'), { mode: 0o600 });
    await expect(media.read(f)).rejects.toThrow(/integrity/i);
  });

  it('refuses to create media rows for messages that are not attachments', async () => {
    const f = await fixture({ type: 'image' });
    await db.message.update({ where: { id: f.messageId }, data: { type: 'text' } });
    expect(await service().prepare(f)).toEqual({ state: 'failed', errorCode: 'NOT_AN_ATTACHMENT', retryable: false });
    expect(await db.messageMedia.count({ where: { messageId: f.messageId } })).toBe(0);
  });
});
type ProviderFetcherLike = ProviderFetcher;
