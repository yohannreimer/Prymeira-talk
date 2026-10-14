import { describe, expect, it, vi } from 'vitest';
import { createSourceMediaPreparer, mediaFetchers } from './media-prepare-handler.js';

const key = { identityFormat: 'whatsapp_stanza', nativeId: 'ID1', rawId: 'ID1', nativeChatAddress: 'x@s.whatsapp.net', chatAddress: 'x@s.whatsapp.net', direction: 'inbound', senderParticipant: '', nativeSenderParticipant: null } as const;

describe('media for messages that did not come through an ingress receipt', () => {
  it('asks the provider that received the message, and never a stored URL for WAHA', async () => {
    const waha = { mediaExact: vi.fn(async () => ({ kind: 'resolved' as const, bytes: Buffer.from('x'), message: { media: { mimetype: 'image/png' } } })) };
    const evolution = { fetchMedia: vi.fn(async () => 'data:image/jpeg;base64,eA==') };
    const fromWaha = mediaFetchers({ provider: 'waha', channelProvider: 'evolution', sessionName: 's', key, mimeType: null }, { waha: waha as never, evolution });
    expect(fromWaha.useStoredUrl).toBe(false);
    expect(await fromWaha.fetchers[0]!.fetch()).toMatchObject({ mimeType: 'image/png' });
    const fromEvolution = mediaFetchers({ provider: 'evolution', channelProvider: 'evolution', sessionName: 'inst', key, mimeType: null }, { waha: null, evolution });
    expect(fromEvolution.useStoredUrl).toBe(true);
    await fromEvolution.fetchers[0]!.fetch();
    expect(evolution.fetchMedia).toHaveBeenCalledWith({ instanceName: 'inst', id: 'ID1' });
  });
  it('when WAHA received it, the channel\'s Evolution is asked next by the same WhatsApp message id', async () => {
    const waha = { mediaExact: vi.fn(async () => ({ kind: 'missing' as const })) };
    const evolution = { fetchMedia: vi.fn(async () => 'data:image/jpeg;base64,eA==') };
    const { fetchers } = mediaFetchers({ provider: 'waha', channelProvider: 'evolution', sessionName: 's', key, mimeType: null }, { waha: waha as never, evolution }, 'evo-inst');
    expect(fetchers.map(f => f.name)).toEqual(['waha', 'evolution']);
    expect(await fetchers[0]!.fetch()).toBeNull();
    expect(await fetchers[1]!.fetch()).toEqual({ mediaUrl: 'data:image/jpeg;base64,eA==' });
    expect(evolution.fetchMedia).toHaveBeenCalledWith({ instanceName: 'evo-inst', id: 'ID1' });
    expect(mediaFetchers({ provider: 'waha', channelProvider: 'evolution', sessionName: 's', key, mimeType: null }, { waha: waha as never, evolution }).fetchers.map(f => f.name)).toEqual(['waha']);
  });
  it('hands the fetchers to the durable media service', async () => {
    const media = { prepare: vi.fn(async () => ({ state: 'stored' as const })) };
    const prepare = createSourceMediaPreparer({ media: media as never, waha: null, evolution: { fetchMedia: vi.fn() } });
    await prepare({ workspaceId: 'w', messageId: 'm', source: { provider: 'evolution', channelProvider: 'evolution', sessionName: 'inst', key, mimeType: null } });
    expect(media.prepare).toHaveBeenCalledWith({ workspaceId: 'w', messageId: 'm', fetchers: [expect.objectContaining({ name: 'evolution' })], useStoredUrl: true });
  });
});

// A Lottie sticker is a real message, but not a supported image attachment.
it('refuses known Lottie bytes before querying Evolution and without trusting a stored URL', async () => {
  const evolution = { fetchMedia: vi.fn() };
  const built = mediaFetchers({ provider: 'evolution', channelProvider: 'evolution', sessionName: 's', key, mimeType: 'application/was' }, { waha: null, evolution });
  expect(built.useStoredUrl).toBe(false);
  await expect(built.fetchers[0]!.fetch()).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  expect(evolution.fetchMedia).not.toHaveBeenCalled();
});
