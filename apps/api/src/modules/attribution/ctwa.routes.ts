import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { CtwaOperationError, type createCtwaService } from './ctwa-service.js';
import { purchaseSchema } from './ctwa-payload.js';

const idParams = z.object({ id: z.string().uuid() }).strict();
const prepareSchema = z.discriminatedUnion('eventName', [
  z.object({ eventName: z.literal('QualifiedLead') }).strict(),
  purchaseSchema.extend({ eventName: z.literal('Purchase') }).strict()
]);
const listSchema = z.object({
  channelId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
}).strict();

export const ctwaRoutes: FastifyPluginAsync<{ service: ReturnType<typeof createCtwaService> }> = async (app, { service }) => {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
  });
  app.get('/attribution/ctwa', async (request, reply) => {
    if (!['owner', 'manager'].includes(request.talk.role)) return reply.code(403).send({ error: 'Forbidden.' });
    const query = listSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid request.' });
    return { items: await service.list(request.talk.workspaceId, query.data) };
  });
  app.post('/attribution/ctwa/:id/events', async (request, reply) => {
    if (request.talk.role !== 'owner') return reply.code(403).send({ error: 'Forbidden.' });
    const params = idParams.safeParse(request.params);
    const body = prepareSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid request.' });
    try {
      const data = body.data;
      const purchase = data.eventName === 'Purchase'
        ? { orderId: data.orderId, value: data.value, currency: data.currency } : undefined;
      return await service.prepare(request.talk.workspaceId, params.data.id, data.eventName, purchase);
    } catch (error) {
      if (error instanceof CtwaOperationError) return reply.code(error.status).send({ error: error.reason });
      throw error;
    }
  });
  app.post('/attribution/ctwa/events/:id/dispatch', async (request, reply) => {
    if (request.talk.role !== 'owner') return reply.code(403).send({ error: 'Forbidden.' });
    const params = idParams.safeParse(request.params);
    const body = z.object({ validated: z.literal(true) }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid request.' });
    try {
      return await service.dispatch(request.talk.workspaceId, params.data.id);
    } catch (error) {
      if (error instanceof CtwaOperationError) return reply.code(error.status).send({ error: error.reason });
      throw error;
    }
  });
};
