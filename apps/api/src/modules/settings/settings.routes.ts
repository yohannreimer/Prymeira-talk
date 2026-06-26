import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Prisma } from "@prisma/client";
import type { UserRole } from "@prymeira-talk/shared";
import { z } from "zod";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import { resolveMetaRuntime } from "../meta/meta-runtime.js";
import { createMetaTemplatesService } from "../meta/meta.templates.service.js";
import { createSettingsService, SettingsValidationError } from "./settings.service.js";
import type { PrismaLike } from "./settings.service.js";

const integrationModeSchema = z.enum(["simulated", "real"]);
const genericSettingsSchema = z.record(z.string(), z.unknown());
const metaConnectionModeSchema = z.enum(["direct", "evolution_official"]);
const metaSettingsSchema = z.object({
  enabled: z.boolean(),
  connectionMode: metaConnectionModeSchema.optional(),
  wabaId: z.string().trim().min(1).optional(),
  phoneNumberId: z.string().trim().min(1).optional(),
  accessToken: z.string().trim().min(1).optional(),
  webhookVerifyToken: z.string().trim().min(1).optional(),
  appSecret: z.string().trim().min(1).optional(),
  evolutionBaseUrl: z.string().trim().min(1).optional(),
  evolutionApiKey: z.string().trim().min(1).optional(),
  evolutionInstanceName: z.string().trim().min(1).optional()
});
const openAiCompatibleSettingsSchema = z.object({
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().trim().optional(),
  chatModel: z.string().trim().optional()
}).strict();

const updateSettingsBodySchema = z.union([
  z.object({
    provider: z.literal("meta_cloud"),
    mode: integrationModeSchema,
    settings: metaSettingsSchema
  }),
  z.object({
    provider: z.literal("openai_compatible"),
    mode: integrationModeSchema,
    settings: openAiCompatibleSettingsSchema.optional()
  }),
  z.object({
    provider: z.string().trim().min(1).max(80).refine(
      (provider) => provider !== "meta_cloud" && provider !== "openai_compatible"
    ),
    mode: integrationModeSchema,
    settings: genericSettingsSchema.optional()
  })
]);
const evolutionOfficialTemplateQuerySchema = z.object({
  channelId: z.string().uuid().optional()
});

function requireSettingsManage(
  role: UserRole,
  reply: FastifyReply
) {
  if (role === "owner" || role === "manager") {
    return true;
  }

  reply.code(403).send({
    code: "SETTINGS_MANAGE_FORBIDDEN",
    error: "Workspace management permission required."
  });
  return false;
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const service = createSettingsService(app.prisma as unknown as PrismaLike);

  app.get("/settings", async (request) =>
    service.getSettings({ workspaceId: request.talk.workspaceId })
  );

  app.patch("/settings", async (request, reply) => {
    if (!requireSettingsManage(request.talk.role, reply)) {
      return reply;
    }

    const body = updateSettingsBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid settings request." });
    }

    try {
      return await service.updateIntegrationMode({
        workspaceId: request.talk.workspaceId,
        ...body.data,
        settings: body.data.settings as Prisma.InputJsonValue | undefined
      });
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return reply.code(400).send({
          code: error.code,
          error: error.message
        });
      }

      throw error;
    }
  });

  app.get("/settings/audit-log", async (request, reply) => {
    if (!requireSettingsManage(request.talk.role, reply)) {
      return reply;
    }

    return service.listAuditLog({ workspaceId: request.talk.workspaceId });
  });

  app.post("/settings/meta-cloud/sync-templates", async (request, reply) => {
    if (!requireSettingsManage(request.talk.role, reply)) {
      return reply;
    }

    const runtime = await resolveMetaRuntime(app.prisma, {
      workspaceId: request.talk.workspaceId
    });

    if (!runtime.active || !runtime.client || !runtime.wabaId) {
      return reply.code(409).send({
        code: "META_CLOUD_NOT_CONFIGURED",
        error: "Meta Cloud integration is not active for this workspace."
      });
    }

    const templateService = createMetaTemplatesService(app.prisma);
    return templateService.syncTemplates({
      workspaceId: request.talk.workspaceId,
      wabaId: runtime.wabaId,
      client: runtime.client
    });
  });

  app.get("/settings/meta-cloud/evolution-templates", async (request, reply) => {
    if (!requireSettingsManage(request.talk.role, reply)) {
      return reply;
    }

    const query = evolutionOfficialTemplateQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid template list request." });
    }

    const runtime = await resolveMetaRuntime(app.prisma, {
      workspaceId: request.talk.workspaceId
    });

    if (
      !runtime.active ||
      runtime.connectionMode !== "evolution_official" ||
      !runtime.evolutionClient?.listTemplates
    ) {
      return reply.code(409).send({
        code: "META_CLOUD_NOT_CONFIGURED",
        error: "Meta Cloud via Evolution is not active for this workspace."
      });
    }

    let instanceName = runtime.evolutionInstanceName;
    if (query.data.channelId) {
      const channel = await app.prisma.channel.findFirst({
        where: {
          workspaceId: request.talk.workspaceId,
          id: query.data.channelId,
          provider: "meta_cloud",
          status: "connected"
        },
        select: { providerKey: true }
      });

      if (!channel?.providerKey) {
        return reply.code(404).send({
          code: "META_CHANNEL_NOT_FOUND",
          error: "Connected Meta Cloud channel not found."
        });
      }

      instanceName = channel.providerKey;
    }

    if (!instanceName) {
      return reply.code(400).send({
        code: "META_CHANNEL_REQUIRED",
        error: "Choose a Meta Cloud channel to list Evolution templates."
      });
    }

    try {
      return runtime.evolutionClient.listTemplates({
        instanceName
      });
    } catch (error) {
      if (error instanceof EvolutionClientError) {
        return reply.code(502).send({
          code: "EVOLUTION_TEMPLATE_LIST_FAILED",
          error: "Evolution did not return the official template list."
        });
      }

      throw error;
    }
  });
};
