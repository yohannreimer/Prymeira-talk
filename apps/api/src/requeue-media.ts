import { PrismaClient } from '@prisma/client';

/** Operator recovery: media that could not be stored (failed `media.prepare` obligations whose message still has no
 * durable copy) gets a new attempt budget, the same way the effect runner's `requeue` does. Without --apply it counts. */
const [workspaceId, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
const hours = Number(flags.find(f => f.startsWith('--hours='))?.slice(8) ?? 48);
if (!workspaceId || !Number.isFinite(hours) || hours <= 0) throw new Error('Usage: requeue-media <workspace-id> [--hours=48] [--apply]');
const db = new PrismaClient();
try {
  const since = new Date(Date.now() - hours * 60 * 60_000);
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT e.id FROM ingress_effects e LEFT JOIN message_media m ON m.message_id = e.message_id
    WHERE e.workspace_id = ${workspaceId} AND e.kind = 'media.prepare' AND e.state = 'failed' AND e.created_at >= (${since}::timestamptz AT TIME ZONE 'UTC')
      AND (m.message_id IS NULL OR m.state <> 'stored')`;
  let requeued = 0;
  if (apply) {
    for (const { id } of rows) requeued += await db.$executeRaw`UPDATE ingress_effects SET state = 'pending', attempts = 0, next_attempt_at = now(),
      completed_at = NULL, last_error_code = NULL WHERE id = ${id}::uuid AND state = 'failed'`;
  }
  console.info(JSON.stringify({ workspaceId, hours, apply, candidates: rows.length, requeued }));
} finally { await db.$disconnect(); }
