import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import {
  AgentPackageServiceError,
  createAgentPackageService,
  type AgentPackagePrismaLike
} from "./agent-package.service.js";

const uuidSchema = z.string().uuid();
const packageBodySchema = z.object({ package: z.unknown() });
const importPackageBodySchema = packageBodySchema.extend({
  variableValues: z.record(z.string(), z.string().max(1000)).default({})
});
const agentParamsSchema = z.object({ agentId: uuidSchema });

export type AgentPackageRoutesService = ReturnType<typeof createAgentPackageService>;

type AgentPackageRoutesOptions = {
  service?: AgentPackageRoutesService;
};

function requirePackageManage(
  role: Parameters<typeof canPerform>[0],
  reply: FastifyReply
) {
  if (canPerform(role, "automation.manage")) {
    return true;
  }

  reply.code(403).send({
    code: "AGENT_PACKAGE_MANAGE_FORBIDDEN",
    error: "Agent package management permission required."
  });
  return false;
}

function handlePackageError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentPackageServiceError) {
    return reply.code(error.code === "AGENT_NOT_FOUND" ? 404 : 400).send({
      code: error.code,
      error: error.message
    });
  }

  throw error;
}

export const agentPackageRoutes: FastifyPluginAsync<AgentPackageRoutesOptions> = async (
  app,
  options
) => {
  const service =
    options.service ??
    createAgentPackageService(app.prisma as unknown as AgentPackagePrismaLike);

  app.post("/agent-packages/validate", async (request, reply) => {
    if (!requirePackageManage(request.talk.role, reply)) {
      return reply;
    }

    const body = packageBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid package validation request." });
    }

    try {
      return {
        valid: true,
        package: service.validatePackage(body.data.package)
      };
    } catch (error) {
      return handlePackageError(reply, error);
    }
  });

  app.post("/agent-packages/import", async (request, reply) => {
    if (!requirePackageManage(request.talk.role, reply)) {
      return reply;
    }

    const body = importPackageBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid package import request." });
    }

    try {
      const result = await service.importPackage({
        workspaceId: request.talk.workspaceId,
        package: body.data.package,
        variableValues: body.data.variableValues
      });
      return reply.code(201).send(result);
    } catch (error) {
      return handlePackageError(reply, error);
    }
  });

  app.get("/agents/:agentId/package", async (request, reply) => {
    if (!requirePackageManage(request.talk.role, reply)) {
      return reply;
    }

    const params = agentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid agent package request." });
    }

    try {
      return await service.exportPackage({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId
      });
    } catch (error) {
      return handlePackageError(reply, error);
    }
  });
};
