import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createInboxMediaService } from './inbox-media.js';

function setup() {
  const conversation = { id: 'c', contact: { phone: '5511999999999' }, channel: { provider: 'evolution', providerKey: 'instance' } };
  const prisma = { conversation: { findFirst: vi.fn().mockResolvedValue(conversation) }, message: { findFirst: vi.fn().mockResolvedValue({ id: 'm', type: 'audio', mediaUrl: 'data:audio/ogg;base64,YQ==', providerMessageId: 'provider-m' }) } };
  const resolve = vi.fn().mockResolvedValue({ bytes: Buffer.from('ogg'), mimeType: 'audio/ogg', source: 'data_url' });
  const convert = vi.fn().mockResolvedValue({ bytes: Buffer.from('mp3'), mimeType: 'audio/mpeg' });
  const profile = vi.fn().mockResolvedValue('https://pps.whatsapp.net/photo.jpg');
  const fetchMedia = vi.fn().mockResolvedValue('data:audio/ogg;base64,YQ==');
  const renderPdf = vi.fn().mockResolvedValue({ bytes: Buffer.from('png'), mimeType: 'image/png', pageCount: 2 });
  const service = createInboxMediaService({ prisma: prisma as unknown as PrismaClient, client: { fetchProfilePicture: profile, fetchMedia }, resolve, convert, renderPdf });
  return { service, prisma, resolve, convert, profile, renderPdf, fetchMedia };
}

describe('inbox media without AI or sending', () => {
  it('recovers unavailable media through the owning Evolution channel', async () => {
    const { service, resolve, fetchMedia } = setup();
    resolve.mockRejectedValueOnce(new Error('MEDIA_UNAVAILABLE'));
    expect((await service.media('w', 'c', 'm')).mimeType).toBe('audio/mpeg');
    expect(fetchMedia).toHaveBeenCalledExactlyOnceWith({ instanceName: 'instance', id: 'provider-m' });
  });
  it('renders PDF pages only after ownership validation and rejects invalid page numbers', async () => {
    const { service, prisma, resolve, renderPdf } = setup();
    prisma.message.findFirst.mockResolvedValue({ type: 'file', mediaUrl: 'data:application/pdf;base64,YQ==' });
    resolve.mockResolvedValue({ bytes: Buffer.from('%PDF-test'), mimeType: 'application/pdf' });
    expect((await service.preview('w','c','m',2)).pageCount).toBe(2);
    await service.preview('w','c','m',2);
    expect(renderPdf).toHaveBeenCalledTimes(1);
    await expect(service.preview('w','c','m',0)).rejects.toThrow('INVALID_PDF_PAGE');
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(service.preview('other','c','m',2)).rejects.toThrow('NOT_FOUND');
    expect(renderPdf).toHaveBeenCalledTimes(1);
  });
  it('converts voice notes independently of transcription and reuses the bounded cache', async () => {
    const { service, prisma, convert } = setup();
    expect(await service.media('w', 'c', 'm')).toEqual({ bytes: Buffer.from('mp3'), mimeType: 'audio/mpeg' });
    await service.media('w', 'c', 'm');
    expect(convert).toHaveBeenCalledTimes(1);
    expect(prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'm', conversationId: 'c', workspaceId: 'w' } }));
  });
  it('checks ownership before cached bytes and never queries the provider for a foreign conversation', async () => {
    const { service, prisma, profile, resolve } = setup();
    await service.media('w', 'c', 'm');
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(service.media('other', 'c', 'm')).rejects.toThrow('NOT_FOUND');
    await expect(service.photo('other', 'c')).rejects.toThrow('NOT_FOUND');
    expect(profile).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('keeps image bytes unchanged and never calls an audio converter for images', async () => {
    const { service, prisma, resolve, convert } = setup();
    prisma.message.findFirst.mockResolvedValue({ id: 'm', type: 'image', mediaUrl: 'data:image/png;base64,YQ==' });
    resolve.mockResolvedValue({ bytes: Buffer.from('png'), mimeType: 'image/png', source: 'data_url' });
    expect((await service.media('w', 'c', 'm')).mimeType).toBe('image/png');
    expect(convert).not.toHaveBeenCalled();
  });
  it('uses the conversation channel for profile photos and retries unavailable photos after one minute', async () => {
    const { service, profile, resolve } = setup();
    vi.useFakeTimers();
    try {
      resolve.mockResolvedValue({ bytes: Buffer.from('jpg'), mimeType: 'image/jpeg', source: 'remote' });
      profile.mockResolvedValueOnce(null).mockResolvedValueOnce('https://pps.whatsapp.net/photo.jpg');
      expect(await service.photo('w', 'c')).toBeNull();
      expect(await service.photo('w', 'c')).toBeNull();
      expect(profile).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_001);
      expect((await service.photo('w', 'c'))?.mimeType).toBe('image/jpeg');
      expect(profile).toHaveBeenCalledTimes(2);
      expect(profile).toHaveBeenCalledWith({ instanceName: 'instance', number: '5511999999999' });
    } finally { vi.useRealTimers(); }
  });
  it('does not fetch avatars from non-Evolution channels', async () => {
    const { service, prisma, profile } = setup();
    prisma.conversation.findFirst.mockResolvedValue({ contact: { phone: '5511999999999' }, channel: { provider: 'meta_cloud' } });
    expect(await service.photo('w', 'c')).toBeNull();
    expect(profile).not.toHaveBeenCalled();
  });
});
