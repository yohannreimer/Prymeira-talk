import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import { createTagsService, TagsServiceError } from "./tags.service.js";
import type { TagsPrismaLike } from "./tags.service.js";

const paramsSchema = z.object({
  tagId: z.string().uuid()
});

const bodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: z.string().trim().max(40),
  useGuide: z.string().trim().min(1).max(1000)
});

const updateBodySchema = bodySchema
  .partial()
  .extend({
    isActive: z.boolean().optional()
  })
  .refine((body) => Object.keys(body).length > 0, "At least one tag field is required.");

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function handleTagsError(reply: FastifyReply, error: unknown) {
  if (error instanceof TagsServiceError) {
    return reply.code(400).send({
      code: error.code,
      error: error.message
    });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2025")) {
    return reply.code(404).send({
      code: "TAG_NOT_FOUND",
      error: "Tag not found."
    });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2002")) {
    return reply.code(409).send({
      code: "TAG_CONFLICT",
      error: "Tag already exists."
    });
  }

  throw error;
}

function requireTagManage(role: Parameters<typeof canPerform>[0], reply: FastifyReply) {
  if (canPerform(role, "automation.manage")) {
    return true;
  }

  reply.code(403).send({
    code: "TAG_MANAGE_FORBIDDEN",
    error: "Tag management permission required."
  });
  return false;
}

export const tagsRoutes: FastifyPluginAsync = async (app) => {
  const service = createTagsService(app.prisma as unknown as TagsPrismaLike);

  app.get("/tags", async (request) =>
    service.listTags({ workspaceId: request.talk.workspaceId })
  );

  app.post("/tags", async (request, reply) => {
    if (!requireTagManage(request.talk.role, reply)) {
      return reply;
    }

    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid tag request." });
    }

    try {
      const tag = await service.createTag({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      return reply.code(201).send(tag);
    } catch (error) {
      return handleTagsError(reply, error);
    }
  });

  app.patch("/tags/:tagId", async (request, reply) => {
    if (!requireTagManage(request.talk.role, reply)) {
      return reply;
    }

    const params = paramsSchema.safeParse(request.params);
    const body = updateBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid tag update request." });
    }

    try {
      return await service.updateTag({
        workspaceId: request.talk.workspaceId,
        tagId: params.data.tagId,
        data: body.data
      });
    } catch (error) {
      return handleTagsError(reply, error);
    }
  });
};
