import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { decodeVoiceRecording, prepareVoiceRecording } from './outbound-audio.js';
import { createEvolutionClient } from '../evolution/evolution.client.js';
import { createConversationsService, type PrismaLike } from './conversations.service.js';
function wav() {
  const samples = 8000; const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / 16000) * 3000), 44 + i * 2);
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}
describe('voice recording validation and transport', () => {
  it('normalizes negative browser WebM timestamps before publishing an Ogg voice message', async () => {
    const webm = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { timeout: 10000 });
    const result = await prepareVoiceRecording(`data:audio/webm;base64,${webm.toString('base64')}`, 'audio/webm');
    const bytes = Buffer.from(result.mediaUrl.split(',')[1], 'base64');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', 'pipe:0'], { input: bytes, timeout: 10000 }).toString());
    expect(Number(probe.streams[0].start_time)).toBeGreaterThanOrEqual(0);
    expect(probe.streams[0]).toMatchObject({ codec_name: 'opus', channels: 1, sample_rate: '48000' });
  });
  it('converts actual synthetic audio to Opus and records it on the owning conversation', async () => {
    const sendAudio = vi.fn().mockResolvedValue({ providerMessageId: 'voice-provider', raw: {} }); const sendMedia = vi.fn();
    const conversation = { id: 'conv', workspaceId: 'workspace', contact: { phone: '5511999990000' }, channel: { provider: 'evolution', providerKey: 'own-instance' } };
    const create = vi.fn().mockImplementation(async ({ data }) => ({ ...data, id: 'voice', createdAt: new Date() }));
    const prisma = { conversation: { findUnique: vi.fn().mockResolvedValue(conversation), update: vi.fn().mockResolvedValue(conversation) }, message: { create } };
    const service = createConversationsService(prisma as unknown as PrismaLike, { evolution: { mode: 'real', webhookSecret: 'fixture', publicWebhookUrl: vi.fn(), localWebhookUrl: vi.fn(), client: { createInstance: vi.fn(), connectInstance: vi.fn(), setWebhook: vi.fn(), sendText: vi.fn(), sendMedia, sendAudio } } });
    const result = await service.createPendingOutboundMessage({ workspaceId: 'workspace', conversationId: 'conv', sentByUserId: null, attachment: { fileName: 'audio.wav', mimetype: 'audio/wav', mediaUrl: wav() } });
    expect(prisma.conversation.findUnique.mock.calls[0][0].where).toEqual({ workspaceId_id: { workspaceId: 'workspace', id: 'conv' } });
    expect(sendMedia).not.toHaveBeenCalled(); expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(sendAudio.mock.calls[0][0]).toMatchObject({ instanceName: 'own-instance', number: '5511999990000' });
    expect(result.message.type).toBe('audio'); expect(result.message.status).toBe('sent'); expect(result.message.mediaUrl).toMatch(/^data:audio\/ogg;base64,T2dnUw/);
    expect(result.message.attachment?.durationSeconds).toBeGreaterThan(0.4);
  });
  it('rejects voice on unsupported channels before sending or storing anything', async () => {
    const create = vi.fn(); const prisma = { conversation: { findUnique: vi.fn().mockResolvedValue({ id: 'conv', channel: { provider: 'meta_cloud' } }) }, message: { create } };
    const service = createConversationsService(prisma as unknown as PrismaLike);
    await expect(service.createPendingOutboundMessage({ workspaceId: 'workspace', conversationId: 'conv', sentByUserId: null, attachment: { fileName: 'audio.wav', mimetype: 'audio/wav', mediaUrl: wav() } })).rejects.toMatchObject({ code: 'AUDIO_CHANNEL_NOT_SUPPORTED' });
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects URLs, unsupported containers and excessive files', () => {
    expect(() => decodeVoiceRecording('https://example.com/a.ogg', 'audio/ogg')).toThrow();
    expect(() => decodeVoiceRecording('data:text/html;base64,YQ==', 'audio/ogg')).toThrow();
    expect(() => decodeVoiceRecording('data:audio/ogg;base64,' + Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'), 'audio/ogg')).toThrow();
  });
  it('preserves valid binary data and chooses the explicit demuxer', () => {
    const result = decodeVoiceRecording('data:audio/webm;codecs=opus;base64,GkXfow==', 'audio/webm;codecs=opus');
    expect(result.demuxer).toBe('matroska'); expect(result.bytes).toEqual(Buffer.from([26, 69, 223, 163]));
  });
  it('rejects invalid bytes without claiming a voice message was created', async () => {
    await expect(prepareVoiceRecording('data:audio/ogg;base64,YQ==', 'audio/ogg')).rejects.toThrow();
  });
  it('uses the voice endpoint, not document upload, with local Opus encoding', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: { id: 'voice-1' } }), { status: 200 }));
    const client = createEvolutionClient({ baseUrl: 'https://example.com', apiKey: 'fixture', fetch });
    const result = await client.sendAudio!({ instanceName: 'instance one', number: '5511999990000', audio: 'data:audio/ogg;base64,T2dnUw==' });
    expect(fetch.mock.calls[0][0]).toBe('https://example.com/message/sendWhatsAppAudio/instance%20one');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ number: '5511999990000', audio: 'T2dnUw==', encoding: false });
    expect(result.providerMessageId).toBe('voice-1');
  });
});
