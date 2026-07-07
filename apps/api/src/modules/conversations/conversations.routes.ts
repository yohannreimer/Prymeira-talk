import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createBoardRulesService } from "../boards/board-rules.service.js";
import type { BoardRulesPrismaLike } from "../boards/board-rules.service.js";
import { EvolutionClientError } from "../evolution/evolution.client.js";
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

interface ConversationsRoutesOptions {
  evolution?: EvolutionRuntime;
}

export const createMessageParamsSchema = z.object({
  conversationId: z.string().uuid()
});

const listConversationsQuerySchema = z.object({
  status: z.enum(["active", "closed", "all"]).optional()
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
  z.object({
    action: z.literal("close_conversation")
  })
]);

function readCurrentClerkUserId(authorizationHeader: string | undefined) {
  const token = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : null;
  const payload = token?.split(".")[1];

  if (!payload) return null;

  try {
    const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(Buffer.from(normalizedPayload, "base64").toString("utf8")) as {
      sub?: unknown;
    };

    return typeof decoded.sub === "string" ? decoded.sub : null;
  } catch {
    return null;
  }
}

async function resolveCurrentUserProfileId(input: {
  prisma: PrismaLike;
  workspaceId: string;
  authorizationHeader: string | undefined;
}) {
  const currentClerkUserId = readCurrentClerkUserId(input.authorizationHeader);

  if (!currentClerkUserId) return null;

  const user = await input.prisma.userProfile.findFirst({
    where: {
      workspaceId: input.workspaceId,
      clerkUserId: currentClerkUserId
    },
    select: { id: true }
  });

  return user?.id ?? null;
}

export const conversationsRoutes: FastifyPluginAsync<ConversationsRoutesOptions> = async (
  app,
  options
) => {
  const service = createConversationsService(app.prisma as unknown as PrismaLike, {
    evolution: options.evolution
  });

  app.get("/conversations", async (request, reply) => {
    const query = listConversationsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid conversations request." });
    }

    return service.listConversations({
      workspaceId: request.talk.workspaceId,
      status: query.data.status
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
      const result = { conversation, context };

      app.realtime.publish({
        type: "conversation.updated",
        workspaceId: request.talk.workspaceId,
        payload: result.conversation
      });

      return result;
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

  app.post("/conversations/:conversationId/messages", async (request, reply) => {
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
