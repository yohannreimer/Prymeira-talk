import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import { AgentsServiceError, createAgentsService } from "./agents.service.js";
import type { AgentsPrismaLike } from "./agents.service.js";

const uuidSchema = z.string().uuid();

const agentParamsSchema = z.object({
  agentId: uuidSchema
});

const allowedActionSchema = z.enum([
  "send_message",
  "add_tag",
  "remove_tag",
  "change_priority",
  "create_internal_note",
  "assign_user",
  "assign_department",
  "request_handoff"
]);

const createAgentBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  systemPrompt: z.string().trim().min(10).max(8000),
  allowedActions: z.array(allowedActionSchema).optional()
});

const updateAgentBodySchema = createAgentBodySchema
  .partial()
  .extend({
    status: z.enum(["active", "inactive"]).optional()
  })
  .refine((body) => Object.keys(body).length > 0, "At least one agent field is required.");

const createKnowledgeSourceBodySchema = z.object({
  type: z.enum(["faq", "text", "file"]),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().max(20000).nullable().optional(),
  fileUrl: z.string().trim().max(1000).nullable().optional(),
  fileName: z.string().trim().max(240).nullable().optional(),
  mimeType: z.string().trim().max(160).nullable().optional()
});

function handleAgentsError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentsServiceError) {
    return reply.code(error.code === "AGENT_INVALID_CONFIG" ? 400 : 404).send({
      code: error.code,
      error: error.message
    });
  }

  throw error;
}

function requireAgentManage(role: Parameters<typeof canPerform>[0], reply: FastifyReply) {
  if (canPerform(role, "automation.manage")) {
    return true;
  }

  reply.code(403).send({
    code: "AGENT_MANAGE_FORBIDDEN",
    error: "Agent management permission required."
  });
  return false;
}

export const agentsRoutes: FastifyPluginAsync = async (app) => {
  const service = createAgentsService(app.prisma as unknown as AgentsPrismaLike);

  app.get("/agents", async (request) =>
    service.listAgents({ workspaceId: request.talk.workspaceId })
  );

  app.post("/agents", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const body = createAgentBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid agent request." });
    }

    try {
      const agent = await service.createAgent({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      return reply.code(201).send(agent);
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });

  app.patch("/agents/:agentId", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = agentParamsSchema.safeParse(request.params);
    const body = updateAgentBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid agent update request." });
    }

    try {
      return await service.updateAgent({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        data: body.data
      });
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });

  app.get("/agents/:agentId/knowledge", async (request, reply) => {
    const params = agentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid knowledge source request." });
    }

    try {
      return await service.listKnowledgeSources({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId
      });
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });

  app.post("/agents/:agentId/knowledge", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = agentParamsSchema.safeParse(request.params);
    const body = createKnowledgeSourceBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid knowledge source request." });
    }

    try {
      const source = await service.createKnowledgeSource({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        ...body.data
      });

      return reply.code(201).send(source);
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });
};
