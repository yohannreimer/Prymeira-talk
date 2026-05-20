import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  ConversationNotFoundError,
  createConversationsService
} from "./conversations.service.js";

export const createMessageParamsSchema = z.object({
  conversationId: z.string().uuid()
});

const createMessageBodySchema = z.object({
  body: z.string().min(1).max(4000)
});

export const conversationsRoutes: FastifyPluginAsync = async (app) => {
  const service = createConversationsService(app.prisma);

  app.get("/conversations", async (request) =>
    service.listConversations({ workspaceId: request.talk.workspaceId })
  );

  app.post("/conversations/:conversationId/messages", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);
    const body = createMessageBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid conversation message request." });
    }

    const result = await service.createPendingOutboundMessage({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId,
      body: body.data.body,
      sentByUserId: null
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      throw error;
    });

    if (!result) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    app.realtime.publish({
      type: "message.created",
      workspaceId: request.talk.workspaceId,
      payload: result.message
    });
    app.realtime.publish({
      type: "conversation.updated",
      workspaceId: request.talk.workspaceId,
      payload: result.conversation
    });

    return reply.code(201).send(result.message);
  });
};
