import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { createBoardRulesService } from "../boards/board-rules.service.js";
import type { BoardRulesPrismaLike } from "../boards/board-rules.service.js";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import { AgentMediaError } from "../agents/agent-media-resolver.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { MetaClientError } from "../meta/meta.client.js";
import { resolveMetaRuntime } from "../meta/meta-runtime.js";
import {
  ConversationActionError,
  ConversationNotFoundError,
  OutboundMessageValidationError,
  createConversationsService
} from "./conversations.service.js";
import type { PrismaLike } from "./conversations.service.js";
import { createInboxMediaService } from './inbox-media.js';
import type { ConversationFollowupsObserver } from "../followups/conversation-followups.service.js";
import type { AgentImprovementObserver } from "../agents/agent-improvements.service.js";
import { readCurrentClerkUserId, resolveCurrentUserProfileId } from "./current-user.js";
import { pauseAgentOnHumanOutbound } from "./pause-agent-on-human-outbound.js";

interface ConversationsRoutesOptions {
  assistantScheduler?: import('../assistant/assistant-scheduler.js').AssistantScheduler;
  handoffBriefService?: ReturnType<typeof import('../assistant/handoff-brief-service.js').createHandoffBriefService>;
  evolution?: EvolutionRuntime;
  followupService?: ConversationFollowupsObserver;
  agentImprovements?: AgentImprovementObserver;
}

export const createMessageParamsSchema = z.object({
  conversationId: z.string().uuid()
});

const listConversationsQuerySchema = z.object({
  status: z.enum(["active", "closed", "all"]).optional(),
  assignee: z.enum(["me"]).optional()
});

const createMessageBodySchema = z
  .object({
    body: z.string().trim().min(1).max(4000).optional(),
    attachment: z
      .object({
        fileName: z.string().trim().min(1).max(240),
        mimetype: z.string().trim().min(1).max(160),
        mediaUrl: z.string().min(1)
      })
      .optional()
  })
  .refine((body) => body.body || body.attachment, {
    message: "Message body or attachment is required."
  });

const conversationPrioritySchema = z.enum(["low", "normal", "high"]);

const conversationActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add_note"),
    body: z.string().trim().min(1).max(1200)
  }),
  z.object({
    action: z.literal("assign_current_user")
  }),
  z.object({
    action: z.literal("change_department"),
    departmentId: z.string().uuid().nullable()
  }),
  z.object({
    action: z.literal("change_priority"),
    priority: conversationPrioritySchema
  }),
  z.object({
    action: z.literal("change_primary_board_stage"),
    stageId: z.string().uuid()
  }),
  z.object({
    action: z.literal("add_tag"),
    name: z.string().trim().min(1).max(80)
  }),
  z.object({
    action: z.literal("remove_tag"),
    tagId: z.string().uuid()
  }),
  z.object({
    action: z.literal("request_ai_suggestion")
  }),
  z.object({
    action: z.literal("create_crm_note")
  }),
  z.object({
    action: z.literal("assume_ai_control")
  }),
  z.object({
    action: z.literal("release_ai_control")
  }),
  z.object({ action: z.literal("complete_handoff_action") }),
  z.object({ action: z.literal("reopen_handoff_action") }),
  z.object({ action: z.literal("reanalyze_handoff_reply") }),
  z.object({
    action: z.literal("close_conversation")
  })
]);

function requireConversationResetOwner(
  role: "owner" | "manager" | "agent",
  reply: FastifyReply
) {
  if (role === "owner") return true;

  reply.code(403).send({
    code: "CONVERSATION_RESET_FORBIDDEN",
    error: "Only the workspace owner can reset a conversation."
  });
  return false;
}

export const conversationsRoutes: FastifyPluginAsync<ConversationsRoutesOptions> = async (
  app,
  options
) => {
  const mediaService = createInboxMediaService({ prisma: app.prisma, client: options.evolution?.client });
  app.get('/conversations/:conversationId/messages/:messageId/preview', async (request, reply) => {
    const params = z.object({ conversationId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(request.params);
    const query = z.object({ page: z.coerce.number().int().min(1).max(2000).default(1) }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'Invalid PDF preview request.' });
    try {
      const media = await mediaService.preview(request.talk.workspaceId, params.data.conversationId, params.data.messageId, query.data.page);
      return reply.header('Cache-Control', 'private, no-store').send({ imageUrl: `data:image/png;base64,${media.bytes.toString('base64')}`, pages: media.pageCount });
    } catch (error) {
      return reply.code(error instanceof Error && error.message === 'NOT_FOUND' ? 404 : 422).send({ error: 'Não foi possível abrir a prévia deste PDF.' });
    }
  });
  app.get('/conversations/:conversationId/messages/:messageId/media', async (request, reply) => {
    const params = z.object({ conversationId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid media request.' });
    try {
      const media = await mediaService.media(request.talk.workspaceId, params.data.conversationId, params.data.messageId);
      return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
        .type(media.mimeType).send(media.bytes);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return reply.code(code === 'NOT_FOUND' ? 404 : code === 'MEDIA_BUSY' ? 429 : 422)
        .send({ error: 'Não foi possível carregar o anexo. Tente novamente.' });
    }
  });
  app.get('/conversations/:conversationId/contact-photo', async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid photo request.' });
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    try {
      const photo = await mediaService.photo(request.talk.workspaceId, params.data.conversationId);
      return photo ? reply.type(photo.mimeType).send(photo.bytes) : reply.code(204).send();
    } catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND') return reply.code(404).send();
      request.log.warn({
        event: 'contact_photo_fetch_failed',
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId,
        reason: error instanceof AgentMediaError ? error.code
          : error instanceof EvolutionClientError ? `EVOLUTION_HTTP_${error.statusCode}`
          : error instanceof Error ? error.name : 'unknown'
      }, 'Failed to fetch contact photo');
      return reply.code(503).send({ error: 'Não foi possível carregar a foto do contato.' });
    }
  });
  const service = createConversationsService(app.prisma as unknown as PrismaLike, {
    evolution: options.evolution
  });

  app.get("/conversations", async (request, reply) => {
    const query = listConversationsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid conversations request." });
    }

    const assignedUserId = query.data.assignee === "me"
      ? await resolveCurrentUserProfileId({
          prisma: app.prisma as unknown as PrismaLike,
          workspaceId: request.talk.workspaceId,
          clerkUserId: request.talk.clerkUserId,
          authorizationHeader: request.headers.authorization
      })
      : null;

    if (query.data.assignee === "me" && !assignedUserId) {
      return [];
    }

    return service.listConversations({
      workspaceId: request.talk.workspaceId,
      status: query.data.status,
      assignedUserId: query.data.assignee === "me" ? assignedUserId : null
    });
  });

  app.get("/conversations/:conversationId/messages", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid conversation message request." });
    }

    const messages = await service.listMessages({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      throw error;
    });

    if (!messages) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    return messages;
  });

  app.get("/conversations/:conversationId/context", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid conversation context request." });
    }

    const context = await service.getContactContext({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      throw error;
    });

    if (!context) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    return context;
  });

  app.post("/conversations/:conversationId/read", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid conversation read request." });
    }

    const conversation = await service.markConversationRead({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      throw error;
    });

    if (!conversation) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    app.realtime.publish({
      type: "conversation.updated",
      workspaceId: request.talk.workspaceId,
      payload: conversation
    });

    return conversation;
  });

  app.post("/conversations/:conversationId/reset", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid conversation reset request." });
    }

    if (!requireConversationResetOwner(request.talk.role, reply)) {
      return reply;
    }

    const actorUserId = await resolveCurrentUserProfileId({
      prisma: app.prisma as unknown as PrismaLike,
      workspaceId: request.talk.workspaceId,
      clerkUserId: request.talk.clerkUserId,
      authorizationHeader: request.headers.authorization
    });
    const result = await service.resetConversation({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId,
      actorUserId
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) return null;
      throw error;
    });

    if (!result) {
      return reply.code(404).send({
        code: "CONVERSATION_NOT_FOUND",
        error: "Conversation not found."
      });
    }

    app.realtime.publish({
      type: "conversation.updated",
      workspaceId: request.talk.workspaceId,
      payload: result.conversation
    });

    return result;
  });

  app.post("/conversations/:conversationId/actions", async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);
    const body = conversationActionBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid conversation action request." });
    }

    if (body.data.action === "assume_ai_control" || body.data.action === "release_ai_control") {
      const actorUserId = await resolveCurrentUserProfileId({
        prisma: app.prisma as unknown as PrismaLike,
        workspaceId: request.talk.workspaceId,
        clerkUserId: request.talk.clerkUserId,
        authorizationHeader: request.headers.authorization
      });
      const conversation = await service.updateAiControl({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId,
        status: body.data.action === "assume_ai_control" ? "human_controlled" : "agent_allowed",
        actorUserId
      }).catch((error: unknown) => {
        if (error instanceof ConversationNotFoundError) {
          return null;
        }

        throw error;
      });

      if (!conversation) {
        return reply
          .code(404)
          .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
      }

      const context = await service.getContactContext({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId
      });

      await options.assistantScheduler?.control(request.talk.workspaceId, params.data.conversationId, body.data.action === 'assume_ai_control');
      const result = { conversation, context };

      app.realtime.publish({
        type: "conversation.updated",
        workspaceId: request.talk.workspaceId,
        payload: result.conversation
      });

      return result;
    }

    if (body.data.action === "complete_handoff_action" || body.data.action === "reopen_handoff_action" || body.data.action === "reanalyze_handoff_reply") {
      const action = body.data.action;
      const actorUserId = action === "complete_handoff_action" ? await resolveCurrentUserProfileId({
        prisma: app.prisma as unknown as PrismaLike,
        workspaceId: request.talk.workspaceId,
        clerkUserId: request.talk.clerkUserId,
        authorizationHeader: request.headers.authorization
      }) : null;
      const conversation = await service.updateHandoffAction({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId,
        completed: action === "reanalyze_handoff_reply" ? undefined : action === "complete_handoff_action",
        actorUserId
      }).catch((error: unknown) => {
        if (error instanceof ConversationNotFoundError) return null;
        if (error instanceof ConversationActionError) return error;
        throw error;
      });
      if (!conversation) return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
      if (conversation instanceof ConversationActionError) {
        return reply.code(conversation.statusCode).send({ code: conversation.code, error: conversation.message });
      }
      if (action === "complete_handoff_action") {
        await options.assistantScheduler?.handoffCompleted(request.talk.workspaceId, params.data.conversationId);
      } else if (action === "reopen_handoff_action") {
        await options.assistantScheduler?.control(request.talk.workspaceId, params.data.conversationId, true);
      }
      const context = await service.getContactContext({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId
      });
      let improvementAnalysis: { created: boolean; reason?: string } | null = null;
      if (action !== "reopen_handoff_action") {
        try {
          improvementAnalysis = await options.agentImprovements?.observeLatestHumanReplyAfterHandoff({
            workspaceId: request.talk.workspaceId,
            conversationId: params.data.conversationId
          }) ?? { created: false, reason: "analysis_unavailable" };
          request.log.info({
            event: "agent_improvement_observation",
            source: action,
            workspaceId: request.talk.workspaceId,
            conversationId: params.data.conversationId,
            outcome: improvementAnalysis.created ? "created" : "skipped",
            reason: improvementAnalysis.reason ?? null
          }, "Agent improvement observation completed.");
        } catch (error) {
          request.log.error({ error, event: "agent_improvement_observation_failed", source: action, workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId }, "Failed to analyze human handoff reply");
          improvementAnalysis = { created: false, reason: "analysis_failed" };
        }
      }
      app.realtime.publish({
        type: "conversation.updated",
        workspaceId: request.talk.workspaceId,
        payload: conversation
      });
      return { conversation, context, improvementAnalysis };
    }

    const result = await service.runConversationAction({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId,
      currentClerkUserId: readCurrentClerkUserId(request.headers.authorization),
      ...body.data
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      if (error instanceof ConversationActionError) {
        return error;
      }

      throw error;
    });

    if (!result) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    if (result instanceof ConversationActionError) {
      return reply.code(result.statusCode).send({ code: result.code, error: result.message });
    }

    if (result.appliedTag) {
      const ruleService = createBoardRulesService(app.prisma as unknown as BoardRulesPrismaLike);
      await ruleService.applyBoardRulesForConversationTags({
        workspaceId: request.talk.workspaceId,
        conversationId: result.appliedTag.conversationId,
        publish: (event) => app.realtime.publish(event)
      });
    }

    app.realtime.publish({
      type: "conversation.updated",
      workspaceId: request.talk.workspaceId,
      payload: result.conversation
    });

    if (result.boardMembership) {
      app.realtime.publish({
        type: "board_membership.updated",
        workspaceId: request.talk.workspaceId,
        payload: result.boardMembership
      });
    }

    return result;
  });

  app.post("/conversations/:conversationId/messages", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const params = createMessageParamsSchema.safeParse(request.params);
    const body = createMessageBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid conversation message request." });
    }

    const meta = await resolveMetaRuntime(app.prisma, { workspaceId: request.talk.workspaceId });
    const writeService = createConversationsService(app.prisma as unknown as PrismaLike, {
      evolution: options.evolution,
      meta: {
        client: meta.client,
        phoneNumberId: meta.phoneNumberId
      },
      metaEvolution: {
        client: meta.evolutionClient?.sendText ? {
          sendText: meta.evolutionClient.sendText.bind(meta.evolutionClient)
        } : null
      }
    });

    // Take control before the provider send: an agent run may be in progress.
    const humanTookControl = await app.prisma.$transaction((tx) =>
      pauseAgentOnHumanOutbound(tx, {
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId
      })
    );
    if (humanTookControl) {
      request.log.info({ event: "human_outbound_paused_agent", workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId }, "Talk outbound message paused the agent.");
      await options.assistantScheduler?.control(request.talk.workspaceId, params.data.conversationId, true).catch((error: unknown) => {
        request.log.error({ error, workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId }, "Failed to pause assistant suggestions after Talk outbound message.");
      });
    }

    const result = await writeService.createPendingOutboundMessage({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId,
      body: body.data.body,
      attachment: body.data.attachment,
      sentByUserId: null
    }).catch((error: unknown) => {
      if (error instanceof ConversationNotFoundError) {
        return null;
      }

      if (
        error instanceof OutboundMessageValidationError ||
        error instanceof EvolutionClientError ||
        error instanceof MetaClientError
      ) {
        return error;
      }

      throw error;
    });

    if (!result) {
      return reply
        .code(404)
        .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
    }

    if (result instanceof OutboundMessageValidationError) {
      return reply.code(result.statusCode).send({ code: result.code, error: result.message });
    }

    if (result instanceof EvolutionClientError) {
      return reply.code(502).send({
        code: "EVOLUTION_SEND_FAILED",
        error: "Evolution did not accept the outbound message."
      });
    }

    if (result instanceof MetaClientError) {
      return reply.code(502).send({
        code: "META_SEND_FAILED",
        error: "Meta did not accept the outbound message."
      });
    }

    await options.followupService?.observeConversationActivity({
      workspaceId: request.talk.workspaceId,
      conversationId: params.data.conversationId,
      messageId: result.message.id,
      direction: "outbound",
      source: "human"
    }).catch((error: unknown) => {
      request.log.error({ error }, "Failed to observe human outbound follow-up.");
    });
    if (options.agentImprovements) {
      void options.agentImprovements.observeHumanReply({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId,
        messageId: result.message.id
      }).then((analysis) => {
        request.log.info({
          event: "agent_improvement_observation",
          source: "talk_outbound",
          workspaceId: request.talk.workspaceId,
          conversationId: params.data.conversationId,
          messageId: result.message.id,
          outcome: analysis.created ? "created" : "skipped",
          reason: analysis.reason ?? null
        }, "Agent improvement observation completed.");
      }).catch((error: unknown) => {
        request.log.error({ error, event: "agent_improvement_observation_failed", source: "talk_outbound", workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId, messageId: result.message.id }, "Failed to prepare agent improvement suggestion.");
      });
    }
    if (!humanTookControl) {
      await options.assistantScheduler?.message({ workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId, messageId: result.message.id, direction: 'outbound' });
    }
    options.handoffBriefService?.schedule({ workspaceId: request.talk.workspaceId, conversationId: params.data.conversationId });
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
