import { randomUUID } from 'node:crypto';
import { Prisma, type Message, type PrismaClient } from '@prisma/client';

/** One persistent transcription job per audio message. The automatic path (agent/assistant) and the
 * manual button call `run`; whoever claims the job does the work once, everybody else waits for and
 * shares the result. The claim is a lease, so a crashed worker is replaced after `leaseMs`, and every
 * write is fenced by the claim token, so a worker that lost its lease cannot overwrite the new result.
 * The text lives in messages.body (existing readers rely on it); `metadata.transcription` marks it as
 * a finished transcription while the message stays an audio message. */

export type TranscriptionWork = { text: string; extraMessageData?: Prisma.MessageUpdateInput };
export type TranscriptionOutcome =
  | { status: 'completed'; text: string; message: Message | null }
  | { status: 'failed'; errorCode: string; message: Message | null }
  | { status: 'in_progress' };

type Db = Pick<PrismaClient, '$queryRaw' | '$transaction' | 'message' | 'messageMedia'>;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createMessageTranscriptionService(options: {
  db: Db;
  leaseMs?: number;
  /** How long a caller that did not win the claim waits for the winner before reporting `in_progress`. */
  waitMs?: number;
  pollMs?: number;
  now?: () => Date;
}) {
  const { db } = options;
  const leaseMs = options.leaseMs ?? 90_000;
  const waitMs = options.waitMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  const now = options.now ?? (() => new Date());

  async function claim(input: { workspaceId: string; conversationId: string; messageId: string; retryFailed: boolean }) {
    const token = randomUUID();
    const at = now();
    const rows = await db.$queryRaw<Array<{ transcription_token: string }>>`
      INSERT INTO message_media (message_id, workspace_id, conversation_id, transcription_state, transcription_token, transcription_lease_until, transcription_attempts)
      SELECT m.id, m.workspace_id, m.conversation_id, 'running', ${token}::uuid, ${new Date(at.getTime() + leaseMs)}, 1
      FROM messages m WHERE m.id = ${input.messageId}::uuid AND m.workspace_id = ${input.workspaceId} AND m.conversation_id = ${input.conversationId}::uuid AND m.type = 'audio'
      ON CONFLICT (message_id) DO UPDATE SET transcription_state = 'running', transcription_token = ${token}::uuid,
        transcription_lease_until = ${new Date(at.getTime() + leaseMs)}, transcription_attempts = message_media.transcription_attempts + 1,
        transcription_error_code = NULL, updated_at = ${at}
      WHERE message_media.transcription_state IS NULL
        OR (message_media.transcription_state = 'failed' AND ${input.retryFailed})
        OR (message_media.transcription_state = 'running' AND message_media.transcription_lease_until < ${at})
      RETURNING transcription_token`;
    return rows[0] ? token : null;
  }

  async function settled(input: { workspaceId: string; messageId: string }): Promise<TranscriptionOutcome | null> {
    const row = await db.messageMedia.findFirst({ where: { messageId: input.messageId, workspaceId: input.workspaceId } });
    if (row?.transcriptionState === 'completed') {
      const message = await db.message.findFirst({ where: { id: input.messageId, workspaceId: input.workspaceId } });
      return { status: 'completed', text: message?.body ?? '', message: null };
    }
    if (row?.transcriptionState === 'failed') return { status: 'failed', errorCode: row.transcriptionErrorCode ?? 'TRANSCRIPTION_FAILED', message: null };
    return null;
  }

  async function complete(input: { workspaceId: string; messageId: string; token: string }, result: TranscriptionWork) {
    return db.$transaction(async tx => {
      const fenced = await tx.messageMedia.updateMany({ where: { messageId: input.messageId, transcriptionToken: input.token, transcriptionState: 'running' },
        data: { transcriptionState: 'completed', transcriptionToken: null, transcriptionLeaseUntil: null, transcriptionErrorCode: null, transcribedAt: now(), updatedAt: now() } });
      if (fenced.count !== 1) return null;
      const current = await tx.message.findFirstOrThrow({ where: { id: input.messageId, workspaceId: input.workspaceId }, select: { metadata: true } });
      const metadata = typeof current.metadata === 'object' && current.metadata && !Array.isArray(current.metadata) ? current.metadata as Prisma.JsonObject : {};
      return tx.message.update({ where: { id: input.messageId }, data: { ...result.extraMessageData, body: result.text,
        metadata: { ...metadata, transcription: { status: 'completed', completedAt: now().toISOString() } } } });
    });
  }

  async function fail(input: { workspaceId: string; messageId: string; token: string }, errorCode: string, failureBody?: string) {
    return db.$transaction(async tx => {
      const fenced = await tx.messageMedia.updateMany({ where: { messageId: input.messageId, transcriptionToken: input.token, transcriptionState: 'running' },
        data: { transcriptionState: 'failed', transcriptionToken: null, transcriptionLeaseUntil: null, transcriptionErrorCode: errorCode, updatedAt: now() } });
      if (fenced.count !== 1) return null;
      return failureBody === undefined ? tx.message.findFirstOrThrow({ where: { id: input.messageId, workspaceId: input.workspaceId } })
        : tx.message.update({ where: { id: input.messageId }, data: { body: failureBody } });
    });
  }

  /** `retryFailed`: a user pressing the button again starts a new attempt; the automatic path does not
   * retry a failure by itself. `failureBody` is written to the message when the work fails. */
  async function run(input: { workspaceId: string; conversationId: string; messageId: string; retryFailed: boolean; failureBody?: string;
      work: () => Promise<TranscriptionWork> }): Promise<TranscriptionOutcome> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const token = await claim(input);
      if (token) {
        const fence = { workspaceId: input.workspaceId, messageId: input.messageId, token };
        let result: TranscriptionWork;
        try { result = await input.work(); }
        catch (error) {
          const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string' && /^[A-Z_]+$/.test((error as { code: string }).code)
            ? (error as { code: string }).code : 'TRANSCRIPTION_FAILED';
          const message = await fail(fence, code, input.failureBody);
          if (message) return { status: 'failed', errorCode: code, message };
          return (await settled(input)) ?? { status: 'in_progress' };
        }
        const message = await complete(fence, result);
        if (message) return { status: 'completed', text: result.text, message };
        // Lease lost while working: someone else owns the result now; do not overwrite it.
        return (await settled(input)) ?? { status: 'in_progress' };
      }
      const done = await settled(input);
      if (done) return done;
      // No claim and no row at all: the message is not an audio message of this conversation.
      if (!await db.messageMedia.findFirst({ where: { messageId: input.messageId, workspaceId: input.workspaceId }, select: { messageId: true } })) {
        return { status: 'failed', errorCode: 'NOT_AN_AUDIO', message: null };
      }
      if (Date.now() >= deadline) return { status: 'in_progress' };
      await sleep(pollMs);
    }
  }

  return { run };
}

export type MessageTranscriptionService = ReturnType<typeof createMessageTranscriptionService>;
