import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { OutboundDispatchJournal } from './outbound-dispatch-journal.js';

/** Sends whose outcome was uncertain. An operator looks at the customer's WhatsApp and says whether the message
 * arrived; nothing is ever resent automatically. */
const canReview = (role: string) => role === 'owner' || role === 'manager';

export const outboundReviewRoutes: FastifyPluginAsync<{ journal: OutboundDispatchJournal }> = async (app, options) => {
  app.get('/channels/outbound-review', async (request, reply) => {
    if (!canReview(request.talk.role)) return reply.code(403).send({ error: 'Forbidden.' });
    const items = await options.journal.listForReview({ workspaceId: request.talk.workspaceId, limit: 100 });
    return { items: items.map(item => ({ id: item.id, channelId: item.channelId, kind: item.kind, destination: item.destination, preview: item.preview,
      errorCode: item.errorCode, createdAt: item.createdAt.toISOString() })) };
  });
  app.post('/channels/outbound-review/:id/resolve', async (request, reply) => {
    if (!canReview(request.talk.role)) return reply.code(403).send({ error: 'Forbidden.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ delivered: z.boolean() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid request.' });
    const resolved = await options.journal.resolve({ workspaceId: request.talk.workspaceId, id: params.data.id, delivered: body.data.delivered, by: request.talk.clerkUserId ?? request.talk.role });
    return resolved ? { ok: true } : reply.code(404).send({ error: 'Envio não encontrado ou já resolvido.' });
  });
};
