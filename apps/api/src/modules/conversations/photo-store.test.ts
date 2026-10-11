import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPhotoStore } from './photo-store.js';
import { createInboxMediaService } from './inbox-media.js';

let root: string | null = null;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

describe('saved profile pictures', () => {
  it('keeps a picture per workspace and number', async () => {
    root = await mkdtemp(join(tmpdir(), 'photos-'));
    const store = createPhotoStore(root);
    await store.write('w1', '5547999990001', { bytes: Buffer.from('jpeg'), mimeType: 'image/jpeg' });
    expect(await store.read('w1', '5547999990001')).toMatchObject({ bytes: Buffer.from('jpeg'), mimeType: 'image/jpeg' });
    expect(await store.read('w2', '5547999990001')).toBeNull();
  });
  it('shows the saved picture when the provider cannot answer, and saves a fresh one when it can', async () => {
    root = await mkdtemp(join(tmpdir(), 'photos-'));
    const store = createPhotoStore(root);
    const prisma = { conversation: { findFirst: async () => ({ contact: { phone: '5547999990001' }, channel: { provider: 'evolution', providerKey: 'vendas-5' } }) } } as never;
    const resolve = async () => ({ bytes: Buffer.from('fresh'), mimeType: 'image/jpeg' }) as never;
    const up = createInboxMediaService({ prisma, client: { fetchProfilePicture: async () => 'https://pps.whatsapp.net/a.jpg' } as never, resolve, photos: store });
    expect((await up.photo('w', 'c'))?.bytes.toString()).toBe('fresh');
    // Make the copy look old so the provider is asked again, and the provider is down.
    const stale = { ...store, read: async (w: string, n: string) => { const saved = await store.read(w, n); return saved && { ...saved, savedAt: 0 }; } };
    const down = createInboxMediaService({ prisma, client: { fetchProfilePicture: async () => { throw new Error('closed'); } } as never, resolve, photos: stale });
    expect((await down.photo('w', 'c'))?.bytes.toString()).toBe('fresh');
  });
});
