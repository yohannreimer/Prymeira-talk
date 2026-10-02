import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMessageTranscriptionService } from './message-transcription.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('shared transcription job on PostgreSQL', () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => {
    const target = new URL(databaseUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/messaging_test') throw new Error('Only the owned local messaging_test database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => {
    if (!db) return;
    for (const workspaceId of workspaces) {
      await db.message.deleteMany({ where: { workspaceId } }); await db.conversation.deleteMany({ where: { workspaceId } });
      await db.contact.deleteMany({ where: { workspaceId } }); await db.channel.deleteMany({ where: { workspaceId } });
    }
    await db.$disconnect();
  });
  async function fixture(type: 'audio' | 'text' = 'audio', body = 'Áudio recebido') {
    const workspaceId = `transcribe-${randomUUID()}`; workspaces.push(workspaceId);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const contact = await db.contact.create({ data: { workspaceId, phone: '15550001111' } });
    const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id } });
    const message = await db.message.create({ data: { workspaceId, conversationId: conversation.id, direction: 'inbound', type, body, metadata: { keep: 'me' } } });
    return { workspaceId, conversationId: conversation.id, messageId: message.id };
  }
  const service = (extra: Partial<Parameters<typeof createMessageTranscriptionService>[0]> = {}) => createMessageTranscriptionService({ db, pollMs: 10, waitMs: 3_000, ...extra });
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  it('runs the work once for eight concurrent callers and shares the text; the message stays audio', async () => {
    const f = await fixture();
    let calls = 0;
    const work = async () => { calls += 1; await sleep(120); return { text: 'olá, quero 10 chapas' }; };
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => service().run({ ...f, retryFailed: false, work })));
    expect(calls).toBe(1);
    expect(outcomes.every(o => o.status === 'completed' && o.text === 'olá, quero 10 chapas')).toBe(true);
    expect(outcomes.filter(o => o.status === 'completed' && o.message).length).toBe(1);
    const message = await db.message.findUniqueOrThrow({ where: { id: f.messageId } });
    expect(message).toMatchObject({ type: 'audio', body: 'olá, quero 10 chapas', metadata: { keep: 'me', transcription: { status: 'completed' } } });
    expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } })).toMatchObject({ transcriptionState: 'completed', transcriptionAttempts: 1, transcriptionToken: null });
    const again = vi.fn(async () => ({ text: 'never' }));
    expect(await service().run({ ...f, retryFailed: true, work: again })).toMatchObject({ status: 'completed', text: 'olá, quero 10 chapas' });
    expect(again).not.toHaveBeenCalled();
  });

  it('records a failure once, keeps it for the automatic path and lets the manual retry start over', async () => {
    const f = await fixture();
    const first = await service().run({ ...f, retryFailed: false, failureBody: 'Não foi possível transcrever este áudio.',
      work: async () => { throw Object.assign(new Error('x'), { code: 'MEDIA_TOO_LARGE' }); } });
    expect(first).toMatchObject({ status: 'failed', errorCode: 'MEDIA_TOO_LARGE' });
    expect(await db.message.findUniqueOrThrow({ where: { id: f.messageId } })).toMatchObject({ body: 'Não foi possível transcrever este áudio.' });
    const auto = vi.fn(async () => ({ text: 'x' }));
    expect(await service().run({ ...f, retryFailed: false, work: auto })).toMatchObject({ status: 'failed', errorCode: 'MEDIA_TOO_LARGE' });
    expect(auto).not.toHaveBeenCalled();
    const retried = await service().run({ ...f, retryFailed: true, work: async () => ({ text: 'agora foi' }) });
    expect(retried).toMatchObject({ status: 'completed', text: 'agora foi' });
    expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } })).toMatchObject({ transcriptionState: 'completed', transcriptionAttempts: 2, transcriptionErrorCode: null });
  });

  it('replaces a worker whose lease expired and discards that worker’s late result', async () => {
    const f = await fixture();
    let clock = new Date();
    const slow = service({ leaseMs: 1_000, now: () => clock });
    let release!: () => void;
    const late = slow.run({ ...f, retryFailed: false, work: () => new Promise(resolve => { release = () => resolve({ text: 'late result' }); }) });
    await sleep(100);
    clock = new Date(clock.getTime() + 5_000);
    const takeover = await service({ leaseMs: 1_000, now: () => clock }).run({ ...f, retryFailed: false, work: async () => ({ text: 'fresh result' }) });
    expect(takeover).toMatchObject({ status: 'completed', text: 'fresh result' });
    release();
    expect(await late).toMatchObject({ status: 'completed', text: 'fresh result', message: null });
    expect(await db.message.findUniqueOrThrow({ where: { id: f.messageId } })).toMatchObject({ body: 'fresh result' });
    expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: f.messageId } })).toMatchObject({ transcriptionAttempts: 2 });
  });

  it('reports in_progress to a caller that gives up waiting, without starting a second job', async () => {
    const f = await fixture();
    let release!: () => void;
    const owner = service().run({ ...f, retryFailed: false, work: () => new Promise(resolve => { release = () => resolve({ text: 'done' }); }) });
    await sleep(100);
    const impatient = vi.fn(async () => ({ text: 'dup' }));
    expect(await service({ waitMs: 150 }).run({ ...f, retryFailed: true, work: impatient })).toEqual({ status: 'in_progress' });
    expect(impatient).not.toHaveBeenCalled();
    release();
    expect(await owner).toMatchObject({ status: 'completed', text: 'done' });
  });

  it('refuses a message that is not an audio of that conversation', async () => {
    const text = await fixture('text', 'hello');
    const work = vi.fn(async () => ({ text: 'x' }));
    expect(await service().run({ ...text, retryFailed: true, work })).toEqual({ status: 'failed', errorCode: 'NOT_AN_AUDIO', message: null });
    const audio = await fixture();
    expect(await service().run({ ...audio, conversationId: randomUUID(), retryFailed: true, work })).toMatchObject({ status: 'failed', errorCode: 'NOT_AN_AUDIO' });
    expect(work).not.toHaveBeenCalled();
    expect(await db.messageMedia.count({ where: { messageId: { in: [text.messageId, audio.messageId] } } })).toBe(0);
  });
});
