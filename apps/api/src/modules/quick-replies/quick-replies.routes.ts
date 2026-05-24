import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createQuickRepliesService } from "./quick-replies.service.js";
import type { PrismaLike } from "./quick-replies.service.js";

const paramsSchema = z.object({ quickReplyId: z.string().uuid() });

const bodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  category: z.string().trim().max(80).nullable().optional()
});

const updateBodySchema = bodySchema.partial().refine((body) => Object.keys(body).length > 0, {
  message: "At least one field is required."
});

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export const quickRepliesRoutes: FastifyPluginAsync = async (app) => {
  const service = createQuickRepliesService(app.prisma as unknown as PrismaLike);

  app.get("/quick-replies", async (request) =>
    service.list({ workspaceId: request.talk.workspaceId })
  );

  app.post("/quick-replies", async (request, reply) => {
    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid quick reply request." });
    }

    const quickReply = await service.create({
      workspaceId: request.talk.workspaceId,
      ...body.data
    });

    return reply.code(201).send(quickReply);
  });

  app.patch("/quick-replies/:quickReplyId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = updateBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid quick reply request." });
    }

    try {
      return await service.update({
        workspaceId: request.talk.workspaceId,
        id: params.data.quickReplyId,
        data: body.data
      });
    } catch (error) {
      if (isPrismaKnownRequestErrorCode(error, "P2025")) {
        return reply.code(404).send({
          code: "QUICK_REPLY_NOT_FOUND",
          error: "Quick reply not found."
        });
      }

      throw error;
    }
  });

  app.delete("/quick-replies/:quickReplyId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid quick reply request." });
    }

    try {
      await service.delete({
        workspaceId: request.talk.workspaceId,
        id: params.data.quickReplyId
      });
    } catch (error) {
      if (isPrismaKnownRequestErrorCode(error, "P2025")) {
        return reply.code(404).send({
          code: "QUICK_REPLY_NOT_FOUND",
          error: "Quick reply not found."
        });
      }

      throw error;
    }

    return reply.code(204).send();
  });
};
