import type { ConversationDto } from "@prymeira-talk/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ConversationNotFoundError, createConversationsService, type PrismaLike } from "./conversations.service.js";
import { hasPendingHandoff } from "./inbox-triage-policy.js";
import {
  InboxTriageConflictError, InboxTriageNotFoundError,
  type createInboxTriageService
} from "./inbox-triage.service.js";
import { resolveCurrentUserProfileId } from "./current-user.js";

type InboxTriageService = ReturnType<typeof createInboxTriageService>;
type RouteOptions = {
  triage: InboxTriageService;
  getConversation?: (input: { workspaceId: string; conversationId: string }) => Promise<ConversationDto>;
};

const paramsSchema = z.object({ conversationId: z.string().uuid() });
const anchorBodySchema = z.object({ anchorMessageId: z.string().uuid() });

export const inboxTriageRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const getConversation = options.getConversation ?? createConversationsService(app.prisma as unknown as PrismaLike).getConversationDto;

  function sendError(error: unknown, reply: import("fastify").FastifyReply) {
    if (error instanceof ConversationNotFoundError) {
      return reply.code(404).send({ code: error.code, error: error.message });
    }
    if (error instanceof InboxTriageNotFoundError || error instanceof InboxTriageConflictError) {
      return reply.code(error.statusCode).send({ code: error.code, error: error.message });
    }
    throw error;
  }

  async function publishCurrent(workspaceId: string, conversationId: string) {
    const conversation = await getConversation({ workspaceId, conversationId });
    app.realtime.publish({ type: "conversation.updated", workspaceId, payload: conversation });
    return conversation;
  }

  app.post("/conversations/:conversationId/manual-mark", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = z.object({ marked: z.boolean() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid manual mark request." });
    const actorId = await resolveCurrentUserProfileId({
      prisma: app.prisma, workspaceId: request.talk.workspaceId,
      clerkUserId: request.talk.clerkUserId,
      authorizationHeader: request.headers.authorization
    });
    if (!actorId) return reply.code(403).send({ error: "Current user profile required." });
    try {
      await options.triage.setManualMark({
        workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId,
        actorId, marked: body.data.marked
      });
      return await publishCurrent(request.talk.workspaceId, params.data.conversationId);
    } catch (error) { return sendError(error, reply); }
  });

  app.post("/conversations/:conversationId/reply-dismiss", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = anchorBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid reply dismissal request." });
    try {
      const current = await getConversation({ workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId });
      if (hasPendingHandoff({ ...current, aiControlStatus: current.aiControlStatus ?? "agent_allowed" })) {
        throw new InboxTriageConflictError();
      }
      await options.triage.dismiss({
        workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId,
        expectedAnchorMessageId: body.data.anchorMessageId
      });
      return await publishCurrent(request.talk.workspaceId, params.data.conversationId);
    } catch (error) { return sendError(error, reply); }
  });

  app.post("/conversations/:conversationId/reply-undo", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = anchorBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid reply undo request." });
    try {
      await options.triage.undoDismiss({
        workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId,
        expectedAnchorMessageId: body.data.anchorMessageId
      });
      return await publishCurrent(request.talk.workspaceId, params.data.conversationId);
    } catch (error) { return sendError(error, reply); }
  });
};
