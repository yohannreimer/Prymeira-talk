import { z } from 'zod';
import type { ChannelConnection } from '@prisma/client';
import { historyDigest } from './history-memory-budget.js';

export const RECOVERY_WINDOW_MS = 5 * 60_000;
export const RECOVERY_OVERLAP_MS = 10 * 60_000;
export const RECENT_WINDOW_MS = 15 * 86400_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryCursorSchema = z.object({
  version: z.literal(1), generation: z.number().int().nonnegative(), checkpoint: z.string().datetime().nullable(),
  from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), offset: z.number().int().min(0).max(100_000),
  pages: z.array(digest).max(2000), previousPages: z.array(digest).max(2000).nullable(), changedPasses: z.number().int().nonnegative()
});
export type RecoveryCursor = z.infer<typeof recoveryCursorSchema>;
const lane = z.object({ cursor: recoveryCursorSchema.nullable(), nextAttemptAt: z.number().nonnegative().finite(), failures: z.number().int().nonnegative() });
const lanesSchema = z.object({
  version: z.literal(2), owner: digest, generation: z.number().int().nonnegative(), disconnectAt: z.string().datetime().nullable(),
  recentFromAt: z.number().nonnegative().finite(), recentThroughAt: z.string().datetime().nullable(), recent: lane, backlog: lane
});
export type RecoveryLanes = z.infer<typeof lanesSchema>;
export type RecoveryLane = 'recent' | 'backlog';

/** A second continuity boundary, never a claim that the intervening old backlog was verified. */
export function recoveryLanes(connection: ChannelConnection, now: number): RecoveryLanes | null {
  const raw = connection.historyRecoveryCursor;
  const version = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.version : undefined;
  if (version !== undefined && version !== 1 && version !== 2) throw new Error('HISTORY_CURSOR_INVALID');
  const checkpoint = connection.recoveredThroughAt?.getTime();
  const untrackedOutage = checkpoint === undefined && connection.disconnectedAt
    && connection.disconnectedAt.getTime() < now - 30 * 60_000;
  if (version !== 2 && (checkpoint ?? now - 15 * 60_000) >= now - 30 * 60_000 && !untrackedOutage) return null;
  const owner = historyDigest([connection.sessionName, connection.verifiedPhoneNumber]);
  const disconnectAt = connection.disconnectedAt?.toISOString() ?? null;
  if (version === 2) {
    const parsed = lanesSchema.safeParse(raw);
    if (!parsed.success) throw new Error('HISTORY_CURSOR_INVALID');
    const state = parsed.data;
    if (state.owner === owner) {
      if (state.generation !== connection.lifecycleGeneration) {
        // Restart pages under current physical proof, never move the certified recent boundary.
        state.recent.cursor = null; state.backlog.cursor = null; state.recent.nextAttemptAt = 0;
      }
      if (state.disconnectAt !== disconnectAt) state.recent.nextAttemptAt = 0;
      state.generation = connection.lifecycleGeneration; state.disconnectAt = disconnectAt;
      return state;
    }
  }
  const old = recoveryCursorSchema.safeParse(raw);
  const from = Math.max(0, checkpoint ?? 0, now - RECENT_WINDOW_MS,
    Math.min(connection.disconnectedAt?.getTime() ?? now - 15 * 60_000, now - 15 * 60_000));
  return {
    version: 2, owner, generation: connection.lifecycleGeneration, disconnectAt, recentFromAt: from, recentThroughAt: null,
    recent: { cursor: null, nextAttemptAt: 0, failures: 0 },
    backlog: { cursor: old.success ? old.data : null, nextAttemptAt: connection.historyRecoveryNextAttemptAt?.getTime() ?? 0, failures: connection.historyRecoveryFailures }
  };
}

export function dueRecoveryLane(state: RecoveryLanes, now: number): RecoveryLane | null {
  if (state.recent.nextAttemptAt <= now) return 'recent';
  if (state.backlog.nextAttemptAt <= now) return 'backlog';
  return null;
}
export const nextRecoveryAttempt = (state: RecoveryLanes) => new Date(Math.min(state.recent.nextAttemptAt, state.backlog.nextAttemptAt));
