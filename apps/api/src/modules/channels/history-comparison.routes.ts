import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { compareProviderHistories, type ProviderHistoryDeps } from './provider-history.js';
import { rolloutDiagnostics } from './rollout-diagnostics.js';

/** Read-only comparison of what Evolution and WAHA return for the same recent chats, matched by exact message id.
 * Used during homologation to decide whether one engine should lead history. Owners and managers only. */
export const historyComparisonRoutes: FastifyPluginAsync<{ db: PrismaClient; deps: ProviderHistoryDeps }> = async (app, options) => {
  /** Read-only health summary of the integration for this workspace (counts, states, timings; no message text). */
  app.get('/channels/rollout-diagnostics', async (request, reply) => {
    if (request.talk.role !== 'owner' && request.talk.role !== 'manager') return reply.code(403).send({ error: 'Forbidden.' });
    const query = z.object({ hours: z.coerce.number().int().min(1).max(336).default(24) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid request.' });
    return rolloutDiagnostics(options.db, { workspaceId: request.talk.workspaceId, hours: query.data.hours });
  });
  app.get('/channels/:channelId/history-comparison', async (request, reply) => {
    if (request.talk.role !== 'owner' && request.talk.role !== 'manager') return reply.code(403).send({ error: 'Forbidden.' });
    const params = z.object({ channelId: z.string().uuid() }).safeParse(request.params);
    const query = z.object({ chats: z.coerce.number().int().min(1).max(50).default(20) }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'Invalid request.' });
    if (!options.deps.evolution || !options.deps.waha) return reply.code(409).send({ error: 'Evolution e WAHA precisam estar configuradas para comparar.' });
    const connections = await options.db.channelConnection.findMany({ where: { workspaceId: request.talk.workspaceId, channelId: params.data.channelId, status: 'connected' } });
    const evolution = connections.find(c => c.provider === 'evolution'), waha = connections.find(c => c.provider === 'waha');
    if (!evolution || !waha) return reply.code(409).send({ error: 'As duas conexões precisam estar conectadas para comparar.' });
    try {
      return await compareProviderHistories(options.deps as Required<ProviderHistoryDeps>, { evolutionSession: evolution.sessionName, wahaSession: waha.sessionName, chatLimit: query.data.chats });
    } catch {
      return reply.code(502).send({ error: 'Um dos provedores não respondeu à comparação. Tente novamente.' });
    }
  });
};
