import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import { CampaignsServiceError, createCampaignsService } from "./campaigns.service.js";
import type { PrismaLike } from "./campaigns.service.js";

const uuidParamSchema = z.string().uuid();

const campaignParamsSchema = z.object({
  campaignId: uuidParamSchema
});

const audienceSchema = z
  .object({
    type: z.literal("board"),
    boardId: uuidParamSchema,
    stageId: uuidParamSchema.optional()
  });

const createCampaignBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  audience: audienceSchema,
  messageBody: z.string().trim().min(1).max(2000),
  scheduledAt: z.string().datetime().nullable().optional()
});

const updateCampaignBodySchema = createCampaignBodySchema
  .extend({
    status: z.enum(["draft", "scheduled", "sending", "completed", "failed"]).optional()
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "At least one campaign field is required.");

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function handleCampaignsError(reply: FastifyReply, error: unknown) {
  if (error instanceof CampaignsServiceError) {
    const statusCode =
      error.code === "CAMPAIGN_AUDIENCE_INVALID"
        ? 400
        : error.code === "CAMPAIGN_BOARD_NOT_FOUND"
          ? 404
          : 404;

    return reply.code(statusCode).send({ code: error.code, error: error.message });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2025")) {
    return reply.code(404).send({
      code: "CAMPAIGN_NOT_FOUND",
      error: "Campaign not found."
    });
  }

  throw error;
}

function requireCampaignManage(
  role: Parameters<typeof canPerform>[0],
  reply: FastifyReply
) {
  if (canPerform(role, "campaign.manage")) {
    return true;
  }

  reply.code(403).send({
    code: "CAMPAIGN_MANAGE_FORBIDDEN",
    error: "Campaign management permission required."
  });
  return false;
}

export const campaignsRoutes: FastifyPluginAsync = async (app) => {
  const service = createCampaignsService(app.prisma as unknown as PrismaLike);

  app.get("/campaigns", async (request) =>
    service.listCampaigns({ workspaceId: request.talk.workspaceId })
  );

  app.post("/campaigns", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) {
      return reply;
    }

    const body = createCampaignBodySchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      const campaign = await service.createCampaign({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      app.realtime.publish({
        type: "campaign.updated",
        workspaceId: request.talk.workspaceId,
        payload: campaign
      });

      return reply.code(201).send(campaign);
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.patch("/campaigns/:campaignId", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) {
      return reply;
    }

    const params = campaignParamsSchema.safeParse(request.params);
    const body = updateCampaignBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      const campaign = await service.updateCampaign({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId,
        data: body.data
      });

      app.realtime.publish({
        type: "campaign.updated",
        workspaceId: request.talk.workspaceId,
        payload: campaign
      });

      return campaign;
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.post("/campaigns/:campaignId/resolve-audience", async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      return await service.resolveAudience({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.post("/campaigns/:campaignId/send-simulated", async (request, reply) => {
    if (!requireCampaignManage(request.talk.role, reply)) {
      return reply;
    }

    const params = campaignParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      const result = await service.sendSimulated({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });
      const campaign = await service.getCampaign({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });

      app.realtime.publish({
        type: "campaign.updated",
        workspaceId: request.talk.workspaceId,
        payload: campaign
      });

      return result;
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });

  app.get("/campaigns/:campaignId/recipients", async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid campaign request." });
    }

    try {
      return await service.listRecipients({
        workspaceId: request.talk.workspaceId,
        campaignId: params.data.campaignId
      });
    } catch (error) {
      return handleCampaignsError(reply, error);
    }
  });
};
