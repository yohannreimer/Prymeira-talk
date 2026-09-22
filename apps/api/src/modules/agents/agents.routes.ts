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
  AgentImprovementsServiceError,
  createAgentImprovementsService,
  type AgentImprovementsService,
  type AgentImprovementsPrismaLike
} from "./agent-improvements.service.js";
import {
  ingestKnowledgeUpload,
  MAX_KNOWLEDGE_UPLOAD_BYTES
} from "./knowledge-ingestion.js";
import { createSimulatedAgentProvider } from "./provider-gateway.js";
import { INBOUND_MEDIA_MIME_TYPES, MAX_INBOUND_MEDIA_BYTES } from "./inbound-media.js";
import { storeWorkspaceAsset } from "../uploads/uploads.routes.js";

const uuidSchema = z.string().uuid();

const agentParamsSchema = z.object({
  agentId: uuidSchema
});

const knowledgeSourceParamsSchema = agentParamsSchema.extend({
  sourceId: uuidSchema
});

const improvementParamsSchema = agentParamsSchema.extend({
  improvementId: uuidSchema
});

const allowedActionSchema = z.enum([
  "send_message",
  "send_attachment",
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
  reasoningEffort: z.enum(["none", "low"]).optional(),
  onlyNewConversations: z.boolean().optional(),
  systemPrompt: z.string().trim().min(10).max(12000),
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

const updateKnowledgeSourceBodySchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    content: z.string().trim().max(20000).nullable().optional(),
    fileUrl: z.string().trim().max(1000).nullable().optional()
  })
  .refine((body) => Object.keys(body).length > 0, "At least one knowledge source field is required.");

const improvementsQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "rejected", "all"]).optional()
});

const updateImprovementBodySchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    content: z.string().trim().min(1).max(20000).optional(),
    reject: z.literal(true).optional(),
    clarificationAnswers: z
      .record(z.string().trim().min(1).max(80), z.string().trim().min(1).max(600))
      .optional()
  })
  .refine((body) => Object.keys(body).length > 0, "At least one improvement field is required.");

const approveImprovementBodySchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  content: z.string().trim().min(1).max(20000).optional()
});

const knowledgeCategorySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*$/);

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
        content: z.string().trim().max(24_000)
      })
    )
    .min(1)
    .max(40),
  attachment: z.object({
    fileName: z.string().trim().min(1).max(240),
    mimeType: z.enum(INBOUND_MEDIA_MIME_TYPES),
    base64Content: z.string().min(1).max(Math.ceil(MAX_INBOUND_MEDIA_BYTES / 3) * 4)
  }).strict().optional()
}).strict()
  .refine((body) => body.messages.reduce((sum, message) => sum + message.content.length, 0) <= 120_000)
  .refine((body) => !body.attachment || (body.messages.at(-1)?.content.length ?? 0) <= 3_000);
const testChatBodyLimit = Math.ceil(MAX_INBOUND_MEDIA_BYTES / 3) * 4 + 750_000;

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

function handleAgentImprovementsError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentImprovementsServiceError) {
    const statusCode =
      error.code === "AGENT_NOT_FOUND" || error.code === "IMPROVEMENT_NOT_FOUND"
        ? 404
        : error.code === "IMPROVEMENT_NORMALIZER_UNAVAILABLE"
          ? 503
          : [
              "IMPROVEMENT_CLARIFICATION_REQUIRED",
              "IMPROVEMENT_NORMALIZATION_REQUIRED",
              "IMPROVEMENT_NORMALIZATION_AMBIGUOUS"
            ].includes(error.code)
          ? 400
          : 409;
    return reply.code(statusCode).send({
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
    "O texto extraído do arquivo de conhecimento é muito grande.",
    "A categoria de conhecimento é inválida."
  ].includes(error.message);
}

export interface AgentsRoutesOptions {
  publicTalkUrl?: string;
  uploadDir?: string;
  agentImprovements?: AgentImprovementsService;
}

export const agentsRoutes: FastifyPluginAsync<AgentsRoutesOptions> = async (app, options) => {
  const service = createAgentsService(app.prisma as unknown as AgentsPrismaLike);
  const improvementsService = options.agentImprovements ?? createAgentImprovementsService(
    app.prisma as unknown as AgentImprovementsPrismaLike
  );
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

  app.delete("/agents/:agentId", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = agentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid agent delete request." });
    }

    try {
      await service.deleteAgent({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId
      });

      return reply.code(204).send();
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });

  app.get("/agents/:agentId/improvements", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = agentParamsSchema.safeParse(request.params);
    const query = improvementsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Invalid agent improvement request." });
    }

    try {
      return await improvementsService.listImprovements({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        status: query.data.status
      });
    } catch (error) {
      return handleAgentImprovementsError(reply, error);
    }
  });

  app.patch("/agents/:agentId/improvements/:improvementId", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = improvementParamsSchema.safeParse(request.params);
    const body = updateImprovementBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid agent improvement update request." });
    }

    try {
      return await improvementsService.updateImprovement({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        improvementId: params.data.improvementId,
        title: body.data.title,
        content: body.data.content,
        reject: body.data.reject === true,
        clarificationAnswers: body.data.clarificationAnswers
      });
    } catch (error) {
      return handleAgentImprovementsError(reply, error);
    }
  });

  app.post("/agents/:agentId/improvements/:improvementId/normalize", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = improvementParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid agent improvement normalization request." });
    }

    try {
      return await improvementsService.normalizeImprovement({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        improvementId: params.data.improvementId
      });
    } catch (error) {
      return handleAgentImprovementsError(reply, error);
    }
  });

  app.post("/agents/:agentId/improvements/:improvementId/approve", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = improvementParamsSchema.safeParse(request.params);
    const body = approveImprovementBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid agent improvement approval request." });
    }

    try {
      const improvement = await improvementsService.approveImprovement({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        improvementId: params.data.improvementId,
        title: body.data.title,
        content: body.data.content
      });

      return reply.code(201).send(improvement);
    } catch (error) {
      return handleAgentImprovementsError(reply, error);
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

  app.patch("/agents/:agentId/knowledge/:sourceId", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = knowledgeSourceParamsSchema.safeParse(request.params);
    const body = updateKnowledgeSourceBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid knowledge source update request." });
    }

    try {
      return await service.updateKnowledgeSource({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        sourceId: params.data.sourceId,
        data: body.data
      });
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });

  app.delete("/agents/:agentId/knowledge/:sourceId", async (request, reply) => {
    if (!requireAgentManage(request.talk.role, reply)) {
      return reply;
    }

    const params = knowledgeSourceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid knowledge source delete request." });
    }

    try {
      await service.deleteKnowledgeSource({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        sourceId: params.data.sourceId
      });

      return reply.code(204).send();
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
        let fileUrl: string | null = null;

        if (options.publicTalkUrl && options.uploadDir) {
          const stored = await storeWorkspaceAsset({
            uploadDir: options.uploadDir,
            publicTalkUrl: options.publicTalkUrl,
            workspaceId: request.talk.workspaceId,
            fileName: body.data.fileName,
            base64: body.data.base64Content,
            maxBytes: MAX_KNOWLEDGE_UPLOAD_BYTES
          });
          fileUrl = stored.url;
        }

        const source = await service.createKnowledgeSource({
          workspaceId: request.talk.workspaceId,
          agentId: params.data.agentId,
          type: ingestion.metadata.sourceKind === "pdf" ? "file" : "text",
          title: body.data.title,
          content: ingestion.content,
          fileUrl,
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

  app.post("/agents/:agentId/test-chat", { bodyLimit: testChatBodyLimit }, async (request, reply) => {
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
        messages: body.data.messages,
        attachment: body.data.attachment
      });
    } catch (error) {
      return handleAgentTestChatError(reply, error);
    }
  });
};
