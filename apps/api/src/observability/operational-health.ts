import type { PrismaClient } from '@prisma/client';
import { writerCandidates } from '../modules/channels/outbound-routing.js';

type Db = Pick<PrismaClient, 'ingressReceipt' | 'ingressDelivery' | 'ingressApplication' | 'ingressEffect' | 'ingressEventProgress' | 'outboundDispatch' | 'channel'>;
const age = (at: Date | null, now: Date) => at ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000)) : null;
const iso = (at: Date | null) => at?.toISOString() ?? null;
function queue(pending: number, oldest: Date | null, progress: Date | null, blocked: number, now: Date, delaySeconds: number) {
  const oldestPendingSeconds = age(oldest, now);
  return { status: oldestPendingSeconds !== null && oldestPendingSeconds >= delaySeconds ? 'delayed' : blocked ? 'attention' : pending ? 'pending' : 'idle',
    pending, oldestPendingSeconds, lastProgressAt: iso(progress) };
}

/** Workspace-scoped persisted evidence. No message bodies, destinations, provider
 * credentials or cross-tenant queue counts are returned. Queue ages expose a
 * stopped consumer even when API liveness and database readiness still succeed. */
export async function readOperationalHealth(db: Db, input: { workspaceId: string; now?: Date; delaySeconds?: number }) {
  const now = input.now ?? new Date(), delaySeconds = input.delaySeconds ?? 120;
  const where = { workspaceId: input.workspaceId };
  const [transport, confirmed, deadLetters, application, applied, held, effects, completed, failed, outbound, settled, uncertain, channels] = await Promise.all([
    db.ingressReceipt.aggregate({ where: { ...where, delivery: { state: { in: ['staged', 'routed'] } } }, _count: { _all: true }, _min: { createdAt: true } }),
    db.ingressDelivery.aggregate({ where, _max: { confirmedAt: true } }),
    db.ingressDelivery.count({ where: { ...where, state: 'dead_letter' } }),
    db.ingressApplication.aggregate({ where: { ...where, state: 'pending_application' }, _count: { _all: true }, _min: { createdAt: true } }),
    db.ingressApplication.aggregate({ where, _max: { appliedAt: true } }),
    db.ingressEventProgress.count({ where: { ...where, state: 'held' } }),
    db.ingressEffect.aggregate({ where: { ...where, state: { in: ['pending', 'running'] } }, _count: { _all: true }, _min: { createdAt: true } }),
    db.ingressEffect.aggregate({ where, _max: { completedAt: true } }),
    db.ingressEffect.count({ where: { ...where, state: 'failed' } }),
    db.outboundDispatch.aggregate({ where: { ...where, state: 'sending' }, _count: { _all: true }, _min: { createdAt: true } }),
    db.outboundDispatch.aggregate({ where: { ...where, state: { not: 'sending' } }, _max: { updatedAt: true } }),
    db.outboundDispatch.count({ where: { ...where, state: 'uncertain', resolvedAt: null } }),
    db.channel.findMany({ where: { ...where, provider: 'evolution', archivedAt: null }, select: { redundancyEnabled: true, activeConnectionId: true, verifiedMessagingPhoneNumber: true,
      connections: { select: { id: true, provider: true, status: true, health: true, eligible: true, verifiedPhoneNumber: true, lastHealthyAt: true, lifecycleGeneration: true } } } })
  ]);
  const writers = channels.map(channel => writerCandidates(channel));
  const usable = writers.filter(connections => connections.length > 0).length;
  const channelHealth = { status: !channels.length ? 'idle' : usable ? 'available' : 'unavailable', total: channels.length, usable,
    unavailable: channels.length - usable, withoutRedundancy: writers.filter(connections => connections.length === 1).length, evidence: 'persisted_connections' };
  const transportHealth = { ...queue(transport._count._all, transport._min.createdAt, confirmed._max.confirmedAt, deadLetters, now, delaySeconds), deadLetters };
  const applicationHealth = { ...queue(application._count._all, application._min.createdAt, applied._max.appliedAt, held, now, delaySeconds), held };
  const effectHealth = { ...queue(effects._count._all, effects._min.createdAt, completed._max.completedAt, failed, now, delaySeconds), failed };
  const outboundHealth = { ...queue(outbound._count._all, outbound._min.createdAt, settled._max.updatedAt, uncertain, now, delaySeconds), uncertain };
  const degraded = [transportHealth, applicationHealth, effectHealth, outboundHealth, channelHealth].some(component => ['delayed', 'attention', 'unavailable'].includes(component.status));
  return { status: degraded ? 'degraded' : 'ok', checkedAt: now.toISOString(), database: { status: 'available' },
    transport: transportHealth, application: applicationHealth, effects: effectHealth, outbound: outboundHealth, channels: channelHealth,
    // API does not own a RabbitMQ connection or worker heartbeat. A previous
    // confirmation is evidence of progress, never a claim of live broker health.
    broker: { status: 'unobserved', lastConfirmedAt: iso(confirmed._max.confirmedAt) },
    workers: { status: 'unobserved', applicationLastProgressAt: iso(applied._max.appliedAt), effectsLastProgressAt: iso(completed._max.completedAt) } };
}
