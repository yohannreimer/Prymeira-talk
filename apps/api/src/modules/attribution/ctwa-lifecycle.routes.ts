import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { CtwaOperationError } from './ctwa-service.js';
import { manualSaleSchema, type createCtwaLifecycleService } from './ctwa-lifecycle.js';
const paramsSchema = z.object({ id: z.string().uuid() }).strict();
export const ctwaLifecycleRoutes: FastifyPluginAsync<{ service: ReturnType<typeof createCtwaLifecycleService> }> = async (app, { service }) => {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });
  app.get('/conversations/:id/ctwa-lifecycle', async (request, reply) => {
    if (request.talk.role !== 'owner') return reply.code(403).send({ error: 'Forbidden.' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success || Object.keys(request.query as object).length) return reply.code(400).send({ error: 'Invalid request.' });
    return service.status(request.talk.workspaceId, params.data.id);
  });
  app.post('/conversations/:id/ctwa-lifecycle/sales', async (request, reply) => {
    if (request.talk.role !== 'owner' || !request.talk.clerkUserId) return reply.code(403).send({ error: 'Forbidden.' });
    const params = paramsSchema.safeParse(request.params), body = manualSaleSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid request.' });
    try {
      return await service.confirmSale({ ...body.data, workspaceId: request.talk.workspaceId, conversationId: params.data.id, userId: request.talk.clerkUserId, role: request.talk.role });
    } catch (error) {
      if (error instanceof CtwaOperationError) return reply.code(error.status).send({ error: error.reason });
      throw error;
    }
  });
};
