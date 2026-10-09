import { createIdleBackoff } from './idle-backoff.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, type PrismaClient } from '@prisma/client';
import { reportFailure } from '../../observability/glitchtip.js';

/** Durable executor for `ingress_effects`. Rows are created in the same transaction as the Message
 * (stage 1B); this runner owns their lifecycle: pending -> running (lease) -> done | failed.
 * Handlers must be idempotent: a lease can expire while a slow handler is still running, in which case
 * the late result is discarded and the effect is run again by whoever claims it next. */

export type ClaimedEffect = {
  id: string;
  workspaceId: string;
  channelId: string;
  conversationId: string | null;
  messageId: string | null;
  kind: string;
  logicalKey: string;
  cause: Record<string, unknown>;
  frozen: Record<string, unknown>;
  attempts: number;
};

export type EffectOutcome =
  | { status: 'done'; result?: Prisma.InputJsonValue }
  /** Transient problem: run again later, with the runner's backoff unless `delayMs` is given. */
  | { status: 'retry'; errorCode: string; delayMs?: number }
  /** Permanent problem: the obligation is closed as failed, visibly and recoverably (see `requeue`). */
  | { status: 'failed'; errorCode: string; result?: Prisma.InputJsonValue };

export type EffectHandler = (effect: ClaimedEffect, context: { signal: AbortSignal }) => Promise<EffectOutcome>;

export type EffectRunnerOptions = {
  db: Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;
  workerId: string;
  handlers: Record<string, EffectHandler>;
  /** Only claim effects of these workspaces (staged rollouts, tests). Omitted = every workspace. */
  workspaceIds?: readonly string[];
  leaseMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => Date;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
};

type Row = {
  id: string; workspace_id: string; channel_id: string; conversation_id: string | null; message_id: string | null;
  kind: string; logical_key: string; cause: unknown; frozen: unknown; attempts: number;
};

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function effectBackoffMs(attempts: number, base: number, max: number) {
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

export function createEffectRunner(options: EffectRunnerOptions) {
  const { db, workerId, handlers } = options;
  const leaseMs = options.leaseMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 6;
  const baseBackoffMs = options.baseBackoffMs ?? 30_000;
  const maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
  const now = options.now ?? (() => new Date());
  const kinds = Object.keys(handlers);
  const scoped = options.workspaceIds !== undefined;
  const workspaceIds = [...(options.workspaceIds ?? [])];

  /** Claims one effect. A dependency (`frozen.dependsOn`, effect kinds of the same message) blocks the
   * effect until that dependency reached a terminal state; a missing dependency never blocks. A
   * `running` row whose lease expired is claimable again, so a crashed worker loses nothing. */
  async function claim(): Promise<ClaimedEffect | null> {
    if (!kinds.length || (scoped && !workspaceIds.length)) return null;
    const at = now();
    const rows = await db.$queryRaw<Row[]>`
      WITH next AS (
        SELECT e.id FROM ingress_effects e
        WHERE e.kind = ANY(${kinds}::text[])
          AND (NOT ${scoped} OR e.workspace_id = ANY(${workspaceIds}::text[]))
          AND ((e.state = 'pending' AND e.next_attempt_at <= ${at})
            OR (e.state = 'running' AND e.lease_until < ${at}))
          AND NOT EXISTS (
            SELECT 1 FROM ingress_effects d
            WHERE e.message_id IS NOT NULL AND d.message_id = e.message_id AND d.id <> e.id
              AND d.state IN ('pending','running')
              AND d.kind IN (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.frozen->'dependsOn') = 'array' THEN e.frozen->'dependsOn' ELSE '[]'::jsonb END)))
        ORDER BY e.created_at, e.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
      UPDATE ingress_effects e SET state = 'running', locked_by = ${workerId},
        lease_until = ${new Date(at.getTime() + leaseMs)}, attempts = e.attempts + 1
      FROM next WHERE e.id = next.id
      RETURNING e.id, e.workspace_id, e.channel_id, e.conversation_id, e.message_id, e.kind, e.logical_key, e.cause, e.frozen, e.attempts`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id, workspaceId: row.workspace_id, channelId: row.channel_id, conversationId: row.conversation_id,
      messageId: row.message_id, kind: row.kind, logicalKey: row.logical_key, cause: object(row.cause),
      frozen: object(row.frozen), attempts: row.attempts
    };
  }

  /** Every write is fenced by the lease holder: a worker that lost its lease changes nothing. */
  async function finish(effect: ClaimedEffect, outcome: EffectOutcome) {
    const at = now();
    const fence = Prisma.sql`id = ${effect.id}::uuid AND state = 'running' AND locked_by = ${workerId}`;
    if (outcome.status === 'done') {
      return db.$executeRaw`UPDATE ingress_effects SET state = 'done', completed_at = ${at}, locked_by = NULL, lease_until = NULL,
        last_error_code = NULL, result = ${outcome.result === undefined ? null : JSON.stringify(outcome.result)}::jsonb WHERE ${fence}`;
    }
    const exhausted = outcome.status === 'failed' || effect.attempts >= maxAttempts;
    if (exhausted) {
      const result = outcome.status === 'failed' && outcome.result !== undefined ? JSON.stringify(outcome.result) : null;
      return db.$executeRaw`UPDATE ingress_effects SET state = 'failed', completed_at = ${at}, locked_by = NULL, lease_until = NULL,
        last_error_code = ${outcome.errorCode}, result = ${result}::jsonb WHERE ${fence}`;
    }
    const delay = outcome.delayMs ?? effectBackoffMs(effect.attempts, baseBackoffMs, maxBackoffMs);
    return db.$executeRaw`UPDATE ingress_effects SET state = 'pending', locked_by = NULL, lease_until = NULL,
      next_attempt_at = ${new Date(at.getTime() + delay)}, last_error_code = ${outcome.errorCode} WHERE ${fence}`;
  }

  async function extendLease(effect: ClaimedEffect) {
    const changed = await db.$executeRaw`UPDATE ingress_effects SET lease_until = ${new Date(now().getTime() + leaseMs)}
      WHERE id = ${effect.id}::uuid AND state = 'running' AND locked_by = ${workerId}`;
    return changed === 1;
  }

  /** Runs at most one effect. Returns false when nothing was claimable. */
  async function runOnce(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    const effect = await claim();
    if (!effect) return false;
    let outcome: EffectOutcome;
    // Keeps the lease alive while the handler runs; stops being useful the moment the fence is lost.
    const heartbeat = setInterval(() => { void extendLease(effect).catch(() => undefined); }, Math.max(1_000, Math.floor(leaseMs / 3)));
    try {
      outcome = await handlers[effect.kind]!(effect, { signal });
    } catch (error) {
      reportFailure('effect_handler', error);
      options.logger?.warn({ err: error, effectId: effect.id, kind: effect.kind }, 'Effect handler threw');
      outcome = { status: 'retry', errorCode: 'HANDLER_THREW' };
    } finally { clearInterval(heartbeat); }
    const changed = await finish(effect, outcome);
    if (changed === 1 && outcome.status !== 'done' && (outcome.status === 'failed' || effect.attempts >= maxAttempts))
      reportFailure('effect_exhausted', { code: outcome.errorCode });
    if (changed !== 1) options.logger?.warn({ effectId: effect.id, kind: effect.kind }, 'Effect lease was lost; result discarded');
    return true;
  }

  /** Drains whatever is claimable now; returns how many effects ran. */
  async function drain(limit = 100, signal?: AbortSignal) {
    let ran = 0;
    while (ran < limit && !signal?.aborted && await runOnce(signal)) ran += 1;
    return ran;
  }

  /** Operator recovery for a `failed` effect: a new attempt budget, same logical effect (no duplicate). */
  async function requeue(effectId: string) {
    const changed = await db.$executeRaw`UPDATE ingress_effects SET state = 'pending', attempts = 0, next_attempt_at = ${now()},
      completed_at = NULL, last_error_code = NULL WHERE id = ${effectId}::uuid AND state = 'failed'`;
    return changed === 1;
  }

  return { claim, finish, extendLease, runOnce, drain, requeue };
}

/** Runs the runner until `signal` aborts: drains what is claimable, sleeps when idle, never throws. */
export function startEffectLoop(runner: { drain(limit?: number, signal?: AbortSignal): Promise<number> },
  options: { signal: AbortSignal; idleMs?: number; maxIdleMs?: number; onError?: (error: unknown) => void }) {
  const backoff = createIdleBackoff(options.idleMs ?? 1_000, options.maxIdleMs ?? 5_000);
  return (async () => {
    while (!options.signal.aborted) {
      let ran = 0;
      try { ran = await runner.drain(25, options.signal); } catch (error) { options.onError?.(error); }
      const idleMs = backoff.next(ran > 0);
      if (ran === 0) await delay(idleMs, undefined, { signal: options.signal }).catch(() => undefined);
    }
  })();
}
