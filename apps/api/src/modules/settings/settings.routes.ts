import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import { createSettingsService } from "./settings.service.js";
import type { PrismaLike } from "./settings.service.js";

const updateSettingsBodySchema = z.object({
  provider: z.string().trim().min(1).max(80),
  mode: z.enum(["simulated", "real"]),
  settings: z.record(z.string(), z.unknown()).optional()
});

function requireWorkspaceManage(
  role: Parameters<typeof canPerform>[0],
  reply: FastifyReply
) {
  if (canPerform(role, "workspace.manage")) {
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
    if (!requireWorkspaceManage(request.talk.role, reply)) {
      return reply;
    }

    const body = updateSettingsBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid settings request." });
    }

    return service.updateIntegrationMode({
      workspaceId: request.talk.workspaceId,
      ...body.data,
      settings: body.data.settings as Prisma.InputJsonValue | undefined
    });
  });

  app.get("/settings/audit-log", async (request, reply) => {
    if (!requireWorkspaceManage(request.talk.role, reply)) {
      return reply;
    }

    return service.listAuditLog({ workspaceId: request.talk.workspaceId });
  });
};
