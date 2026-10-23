import type { PrismaClient } from '@prisma/client';
import type { MeetingScheduler } from '../agents/meeting-scheduler.js';
import type { createCtwaLifecycleService } from './ctwa-lifecycle.js';
import { lifecycleTrackingWorkspaces, resolveLifecycleConfig } from './ctwa-tracking-config.js';

/** Bounded read-only Calendar reconciliation. Cursor rotates across existing native conversations. */
export function createCtwaLifecycleRecovery(db: PrismaClient, input: { secret?: string; scheduler?: Pick<MeetingScheduler, 'confirmedBookings'>; service: ReturnType<typeof createCtwaLifecycleService>; intervalMs?: number; onDeferred?: () => void }) {
  const cursors = new Map<string, string>();
  let stopped = true, timer: ReturnType<typeof setInterval> | undefined, running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running || !input.scheduler?.confirmedBookings) return;
    running = (async () => {
      for (const workspaceId of lifecycleTrackingWorkspaces(input.secret)) {
        if (stopped) break;
        const config = resolveLifecycleConfig(input.secret, workspaceId)!;
        if (config.lifecycleEnabledAt * 1000 > Date.now()) continue;
        const cursor = cursors.get(workspaceId);
        const rows = await db.ctwaAttribution.findMany({ where: { workspaceId, sourceMode: 'live', conversation: { contact: { workspaceId, isGroup: false } } },
          orderBy: { id: 'asc' }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, conversationId: true }, take: 25 });
        if (rows.length < 25) cursors.delete(workspaceId); else cursors.set(workspaceId, rows[rows.length - 1]!.id);
        for (const conversationId of new Set(rows.map(row => row.conversationId))) {
          if (stopped) break;
          try {
            const existing = await db.ctwaConversionEvent.findFirst({ where: { workspaceId, conversationId, lifecycleSource: 'calendar_confirmed' }, select: { id: true } });
            if (existing) continue;
            const meetings = await input.scheduler!.confirmedBookings!({ conversationId, createdAfter: new Date(config.lifecycleEnabledAt * 1000) });
            for (const meeting of meetings) await input.service.confirmMeeting({ workspaceId, conversationId, eventId: meeting.eventId, createdAt: meeting.createdAt });
          } catch { input.onDeferred?.(); }
        }
      }
    })().catch(() => { input.onDeferred?.(); }).finally(() => { running = undefined; });
  };
  return {
    start() { if (!stopped) return; stopped = false; tick(); timer = setInterval(tick, input.intervalMs ?? 60000); timer.unref(); },
    async stop() { stopped = true; clearInterval(timer); await running; }
  };
}
