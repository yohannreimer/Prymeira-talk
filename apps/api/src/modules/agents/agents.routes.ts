import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import {
  AgentTestChatError,
  createAgentTestChatService,
  type AgentTestChatPrismaLike
} from "./agent-test-chat.js";
import { AgentsServiceError, createAgentsService } from "./agents.service.js";
import type { AgentsPrismaLike } from "./agents.service.js";
import {
  ingestKnowledgeUpload,
  MAX_KNOWLEDGE_UPLOAD_BYTES
} from "./knowledge-ingestion.js";
import { createSimulatedAgentProvider } from "./provider-gateway.js";

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
  status: z.enum(["active", "inactive"]).optional(),
  systemPrompt: z.string().trim().min(10).max(8000),
  allowedActions: z.array(allowedActionSchema).optional(),
  allowedTagIds: z.array(uuidSchema).max(100).optional()
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

const knowledgeCategorySchema = z.enum([
  "precos",
  "produto",
  "faq",
  "politicas",
  "onboarding",
  "comercial",
  "suporte",
  "outro"
]);

const uploadKnowledgeBodySchema = z.object({
  title: z.string().trim().min(1).max(160),
  category: knowledgeCategorySchema,
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(160),
  base64Content: z.string().trim().min(1)
});

const uploadKnowledgeBodyLimit = Math.ceil(MAX_KNOWLEDGE_UPLOAD_BYTES * 1.38) + 2048;

const testChatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(4000)
      })
    )
    .min(1)
    .max(40)
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

function handleAgentTestChatError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentTestChatError) {
    const statusCode =
      error.code === "AGENT_NOT_FOUND" ? 404 : error.code === "AGENT_PROVIDER_FAILED" ? 502 : 400;

    return reply.code(statusCode).send({
      code: error.code,
      error: error.message,
      ...(error.debug ? { debug: error.debug } : {})
    });
  }

  return handleAgentsError(reply, error);
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

function isKnowledgeUploadError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  return [
    "O conteúdo do arquivo de conhecimento é inválido.",
    "Tipo de arquivo de conhecimento não suportado.",
    "Não foi possível ler o arquivo de conhecimento.",
    "O arquivo de conhecimento não contém texto legível.",
    "O arquivo de conhecimento é muito grande.",
    "O texto extraído do arquivo de conhecimento é muito grande."
  ].includes(error.message);
}

export const agentsRoutes: FastifyPluginAsync = async (app) => {
  const service = createAgentsService(app.prisma as unknown as AgentsPrismaLike);
  const testChatService = createAgentTestChatService({
    prisma: app.prisma as unknown as AgentTestChatPrismaLike,
    provider: createSimulatedAgentProvider()
  });

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

  app.post(
    "/agents/:agentId/knowledge/upload",
    { bodyLimit: uploadKnowledgeBodyLimit },
    async (request, reply) => {
      if (!requireAgentManage(request.talk.role, reply)) {
        return reply;
      }

      const params = agentParamsSchema.safeParse(request.params);
      const body = uploadKnowledgeBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "Invalid knowledge upload request." });
      }

      try {
        const ingestion = await ingestKnowledgeUpload(body.data);
        const source = await service.createKnowledgeSource({
          workspaceId: request.talk.workspaceId,
          agentId: params.data.agentId,
          type: ingestion.metadata.sourceKind === "pdf" ? "file" : "text",
          title: body.data.title,
          content: ingestion.content,
          fileName: body.data.fileName,
          mimeType: body.data.mimeType,
          metadata: ingestion.metadata
        });

        return reply.code(201).send(source);
      } catch (error) {
        if (isKnowledgeUploadError(error)) {
          return reply.code(400).send({ error: error.message });
        }

        return handleAgentsError(reply, error);
      }
    }
  );

  app.post("/agents/:agentId/test-chat", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = agentParamsSchema.safeParse(request.params);
    const body = testChatBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid agent test chat request." });
    }

    try {
      return await testChatService.sendMessage({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        messages: body.data.messages
      });
    } catch (error) {
      return handleAgentTestChatError(reply, error);
    }
  });
};
