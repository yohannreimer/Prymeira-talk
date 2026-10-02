import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { createInboxMediaService } from './inbox-media.js';
import { conversationsRoutes } from './conversations.routes.js';
import { resolveAgentMedia } from '../agents/agent-media-resolver.js';

function setup() {
  const conversation = { id: 'c', contact: { phone: '5511999999999' }, channel: { provider: 'evolution', providerKey: 'instance' } };
  const prisma = { conversation: { findFirst: vi.fn().mockResolvedValue(conversation) },
    message: { findFirst: vi.fn().mockResolvedValue({ id: 'm', type: 'audio', mediaUrl: 'data:audio/ogg;base64,YQ==', providerMessageId: 'provider-m' }) },
    contact: { findFirst: vi.fn().mockResolvedValue({ phone: '5511999999999', avatarUrl: null }) },
    channel: { findFirst: vi.fn().mockResolvedValue(null) }, $executeRaw: vi.fn().mockResolvedValue(1) };
  const resolve = vi.fn().mockResolvedValue({ bytes: Buffer.from('ogg'), mimeType: 'audio/ogg', source: 'data_url' });
  const convert = vi.fn().mockResolvedValue({ bytes: Buffer.from('mp3'), mimeType: 'audio/mpeg' });
  const profile = vi.fn().mockResolvedValue('https://pps.whatsapp.net/photo.jpg');
  const fetchMedia = vi.fn().mockResolvedValue('data:audio/ogg;base64,YQ==');
  const renderPdf = vi.fn().mockResolvedValue({ bytes: Buffer.from('png'), mimeType: 'image/png', pageCount: 2 });
  const service = createInboxMediaService({ prisma: prisma as unknown as PrismaClient, client: { fetchProfilePicture: profile, fetchMedia }, resolve, convert, renderPdf });
  return { service, prisma, resolve, convert, profile, renderPdf, fetchMedia };
}

describe('inbox media with a durable private copy', () => {
  it('serves the durable copy without touching providers, and falls back when it is absent or unreadable', async () => {
    const { prisma, resolve, convert, fetchMedia } = setup();
    const read = vi.fn().mockResolvedValueOnce({ bytes: Buffer.from('durable'), mimeType: 'audio/mpeg' }).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('integrity'));
    const service = createInboxMediaService({ prisma: prisma as unknown as PrismaClient, client: { fetchMedia, fetchProfilePicture: vi.fn() }, resolve, convert, durable: { read } });
    const hit = await service.media('w', 'c', 'm1');
    expect(hit).toEqual({ bytes: Buffer.from('durable'), mimeType: 'audio/mpeg' });
    expect(resolve).not.toHaveBeenCalled(); expect(convert).not.toHaveBeenCalled();
    expect((await service.media('w', 'c', 'm2')).mimeType).toBe('audio/mpeg');
    expect((await service.media('w', 'c', 'm3')).mimeType).toBe('audio/mpeg');
    expect(convert).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith({ workspaceId: 'w', conversationId: 'c', messageId: 'm1' });
  });
});

describe('inbox media without AI or sending', () => {
  it.each([['image', 'image/png'], ['file', 'video/mp4']] as const)('serves an already stored 26 MiB inline %s through the authenticated media route', async (type, mimeType) => {
    const bytes = Buffer.alloc(26 * 1024 * 1024, 97);
    const { prisma } = setup();
    prisma.message.findFirst.mockResolvedValue({ id: 'm', type, mediaUrl: `data:${mimeType};base64,${bytes.toString('base64')}` });
    const app = Fastify({ logger: false });
    app.decorate('prisma', prisma as never);
    app.addHook('preHandler', async request => { request.talk = { workspaceId: 'w', role: 'agent' }; });
    await app.register(conversationsRoutes);
    try {
      const response = await app.inject({ method: 'GET', url: '/conversations/00000000-0000-4000-8000-000000000001/messages/00000000-0000-4000-8000-000000000002/media' });
      expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain(mimeType);
      expect(response.rawPayload.equals(bytes)).toBe(true);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
        workspaceId: 'w', conversationId: '00000000-0000-4000-8000-000000000001', id: '00000000-0000-4000-8000-000000000002'
      } }));
      prisma.conversation.findFirst.mockResolvedValue(null);
      const denied = await app.inject({ method: 'GET', url: '/conversations/00000000-0000-4000-8000-000000000001/messages/00000000-0000-4000-8000-000000000002/media' });
      expect(denied.statusCode).toBe(404); expect(prisma.message.findFirst).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
  it.each([['audio', 'audio/ogg'], ['file', 'application/pdf']] as const)('keeps the 25 MiB limit for stored %s %s', async (type, mimeType) => {
    const { prisma } = setup();
    prisma.message.findFirst.mockResolvedValue({ id: 'm', type, mediaUrl: `data:${mimeType};base64,${Buffer.alloc(26 * 1024 * 1024, 97).toString('base64')}` });
    const service = createInboxMediaService({ prisma: prisma as unknown as PrismaClient });
    await expect(service.media('w', 'c', 'm')).rejects.toThrow('MEDIA_UNAVAILABLE');
  });
  it('keeps provider recovery and remote visual downloads bounded at 25 MiB', async () => {
    const { prisma, fetchMedia } = setup();
    const policies: number[] = [];
    const resolve = vi.fn(async (input: Parameters<typeof resolveAgentMedia>[0]) => {
      policies.push(input.policy.maxBytes);
      if (input.mediaUrl?.startsWith('data:')) return resolveAgentMedia(input);
      return resolveAgentMedia({ ...input, resolveHost: async () => ['8.8.8.8'], fetchImpl: vi.fn().mockResolvedValue(new Response('', {
        headers: { 'content-type': 'image/png', 'content-length': String(26 * 1024 * 1024) }
      })) });
    });
    const inline = `data:image/png;base64,${Buffer.alloc(26 * 1024 * 1024, 97).toString('base64')}`;
    fetchMedia.mockResolvedValue(inline);
    const service = createInboxMediaService({ prisma: prisma as unknown as PrismaClient, client: { fetchMedia }, resolve });
    prisma.message.findFirst.mockResolvedValue({ id: 'm', type: 'image', mediaUrl: 'https://public.example.test/image.png', providerMessageId: 'provider-m' });
    await expect(service.media('w', 'c', 'm')).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    expect(policies).toEqual([25 * 1024 * 1024, 25 * 1024 * 1024]);
    expect(fetchMedia).toHaveBeenCalledOnce();
    policies.length = 0;
    prisma.message.findFirst.mockResolvedValue({ id: 'm', type: 'image', mediaUrl: 'data:image/png;base64,invalid!', providerMessageId: 'provider-m' });
    await expect(service.media('w', 'c', 'm')).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    expect(policies[1]).toBe(25 * 1024 * 1024);
  });
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
  it('loads a saved contact photo through the workspace channel and persists its URL', async () => {
    const { service, prisma, profile, resolve } = setup();
    resolve.mockResolvedValue({ bytes: Buffer.from('jpg'), mimeType: 'image/jpeg', source: 'remote' });
    const photo = await service.photoForContact('w', 'contact-1');
    expect(photo?.mimeType).toBe('image/jpeg');
    expect(prisma.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 'w', id: 'contact-1' }
    }));
    expect(profile).toHaveBeenCalledWith({ instanceName: 'instance', number: '5511999999999' });
    expect(prisma.$executeRaw).toHaveBeenCalled();
    prisma.contact.findFirst.mockResolvedValue(null);
    await expect(service.photoForContact('other', 'contact-1')).rejects.toThrow('NOT_FOUND');
    expect(profile).toHaveBeenCalledTimes(1);
  });
});
