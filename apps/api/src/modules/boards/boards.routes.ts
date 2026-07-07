import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { createBoardRulesService } from "./board-rules.service.js";
import type { BoardRulesPrismaLike } from "./board-rules.service.js";
import { BoardsServiceError, createBoardsService } from "./boards.service.js";
import type { PrismaLike } from "./boards.service.js";

const uuidParamSchema = z.string().uuid();

const boardParamsSchema = z.object({
  boardId: uuidParamSchema
});

const boardStageParamsSchema = z.object({
  boardId: uuidParamSchema,
  stageId: uuidParamSchema
});

const membershipParamsSchema = z.object({
  membershipId: uuidParamSchema
});

const boardRuleFieldsSchema = z.object({
  channelIds: uuidParamSchema.array().optional(),
  isPrimaryPipeline: z.boolean().optional()
});

const stageRuleFieldsSchema = z.object({
  tagIds: uuidParamSchema.array().optional()
});

const createBoardBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(500).optional()
}).merge(boardRuleFieldsSchema);

const updateBoardBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(500).optional()
  })
  .merge(boardRuleFieldsSchema)
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required"
  });

const createStageBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: z.string().trim().min(1).max(40),
  order: z.number().int().min(0)
}).merge(stageRuleFieldsSchema);

const updateStageBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    color: z.string().trim().min(1).max(40).optional()
  })
  .merge(stageRuleFieldsSchema)
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required"
  });

const reorderStagesBodySchema = z.object({
  stageIds: uuidParamSchema.array()
});

const syncBoardRulesBodySchema = z.object({
  scope: z.enum(["active", "closed", "all"])
});

const createMembershipBodySchema = z.object({
  contactId: uuidParamSchema,
  stageId: uuidParamSchema,
  isPrimary: z.boolean().optional()
});

const updateMembershipBodySchema = z
  .object({
    stageId: uuidParamSchema,
    isPrimary: z.boolean().optional()
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required"
  });

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function sendServiceError(reply: FastifyReply, error: BoardsServiceError) {
  if (
    error.code === "BOARD_NOT_FOUND" ||
    error.code === "STAGE_NOT_FOUND" ||
    error.code === "CONTACT_NOT_FOUND" ||
    error.code === "MEMBERSHIP_NOT_FOUND"
  ) {
    return reply.code(404).send({ code: error.code, error: error.message });
  }

  if (error.code === "STAGE_NOT_EMPTY" || error.code === "STAGE_ORDER_INVALID") {
    return reply.code(409).send({ code: error.code, error: error.message });
  }

  throw error;
}

function handleBoardsError(reply: FastifyReply, error: unknown) {
  if (error instanceof BoardsServiceError) {
    return sendServiceError(reply, error);
  }

  if (isPrismaKnownRequestErrorCode(error, "P2025")) {
    return reply.code(404).send({
      code: "BOARD_RECORD_NOT_FOUND",
      error: "Board record not found."
    });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2002")) {
    return reply.code(409).send({
      code: "BOARD_CONFLICT",
      error: "Board record already exists."
    });
  }

  throw error;
}

export const boardsRoutes: FastifyPluginAsync = async (app) => {
  const service = createBoardsService(app.prisma as unknown as PrismaLike);
  const rulesService = createBoardRulesService(app.prisma as unknown as BoardRulesPrismaLike);

  app.get("/boards", async (request) =>
    service.listBoards({ workspaceId: request.talk.workspaceId })
  );

  app.post("/boards", async (request, reply) => {
    const body = createBoardBodySchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid board request." });
    }

    try {
      const board = await service.createBoard({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      return reply.code(201).send(board);
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.patch("/boards/:boardId", async (request, reply) => {
    const params = boardParamsSchema.safeParse(request.params);
    const body = updateBoardBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid board request." });
    }

    try {
      return await service.updateBoard({
        workspaceId: request.talk.workspaceId,
        boardId: params.data.boardId,
        ...body.data
      });
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.delete("/boards/:boardId", async (request, reply) => {
    const params = boardParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid board request." });
    }

    try {
      return await service.deleteBoard({
        workspaceId: request.talk.workspaceId,
        boardId: params.data.boardId
      });
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.get("/boards/:boardId/contacts", async (request, reply) => {
    const params = boardParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid board request." });
    }

    try {
      return await service.listBoardContacts({
        workspaceId: request.talk.workspaceId,
        boardId: params.data.boardId
      });
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.post("/boards/:boardId/sync-rules", async (request, reply) => {
    const params = boardParamsSchema.safeParse(request.params);
    const body = syncBoardRulesBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid board sync request." });
    }

    try {
      return await rulesService.syncBoardRules({
        workspaceId: request.talk.workspaceId,
        boardId: params.data.boardId,
        scope: body.data.scope,
        publish: (event) => app.realtime.publish(event)
      });
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.post("/boards/:boardId/stages", async (request, reply) => {
    const params = boardParamsSchema.safeParse(request.params);
    const body = createStageBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid board stage request." });
    }

    try {
      const stage = await service.createStage({
        workspaceId: request.talk.workspaceId,
        boardId: params.data.boardId,
        ...body.data
      });

      return reply.code(201).send(stage);
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.patch("/boards/:boardId/stages/reorder", async (request, reply) => {
    const params = boardParamsSchema.safeParse(request.params);
    const body = reorderStagesBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid board stage reorder request." });
    }

    try {
      return await service.reorderStages({
        workspaceId: request.talk.workspaceId,
        boardId: params.data.boardId,
        stageIds: body.data.stageIds
      });
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.patch("/boards/:boardId/stages/:stageId", async (request, reply) => {
    const params = boardStageParamsSchema.safeParse(request.params);
    const body = updateStageBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid board stage request." });
    }

    try {
      return await service.updateStage({
        workspaceId: request.talk.workspaceId,
        boardId: params.data.boardId,
        stageId: params.data.stageId,
        ...body.data
      });
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.delete("/boards/:boardId/stages/:stageId", async (request, reply) => {
    const params = boardStageParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid board stage request." });
    }

    try {
      return await service.deleteStage({
        workspaceId: request.talk.workspaceId,
        boardId: params.data.boardId,
        stageId: params.data.stageId
      });
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.post("/boards/:boardId/memberships", async (request, reply) => {
    const params = boardParamsSchema.safeParse(request.params);
    const body = createMembershipBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid board membership request." });
    }

    try {
      const membership = await service.addContactToBoard({
        workspaceId: request.talk.workspaceId,
        boardId: params.data.boardId,
        ...body.data
      });

      app.realtime.publish({
        type: "board_membership.updated",
        workspaceId: request.talk.workspaceId,
        payload: membership
      });

      return reply.code(201).send(membership);
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.patch("/board-memberships/:membershipId", async (request, reply) => {
    const params = membershipParamsSchema.safeParse(request.params);
    const body = updateMembershipBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid board membership request." });
    }

    try {
      const membership = await service.moveContactToStage({
        workspaceId: request.talk.workspaceId,
        membershipId: params.data.membershipId,
        ...body.data
      });

      app.realtime.publish({
        type: "board_membership.updated",
        workspaceId: request.talk.workspaceId,
        payload: membership
      });

      return membership;
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });

  app.delete("/board-memberships/:membershipId", async (request, reply) => {
    const params = membershipParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid board membership request." });
    }

    try {
      const result = await service.removeContactFromBoard({
        workspaceId: request.talk.workspaceId,
        membershipId: params.data.membershipId
      });

      app.realtime.publish({
        type: "board_membership.deleted",
        workspaceId: request.talk.workspaceId,
        payload: result
      });

      return result;
    } catch (error) {
      return handleBoardsError(reply, error);
    }
  });
};
