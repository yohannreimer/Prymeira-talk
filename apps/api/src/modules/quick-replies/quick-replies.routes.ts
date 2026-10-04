import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createQuickRepliesService, QuickReplyNotFoundError } from "./quick-replies.service.js";
import type { PrismaLike } from "./quick-replies.service.js";

const paramsSchema = z.object({ quickReplyId: z.string().uuid() });

const bodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  category: z.string().trim().max(80).nullable().optional(),
  shortcut: z.string().trim().max(60).nullable().optional()
});
const packSchema = z.object({
  version: z.literal(1).optional(),
  replies: z.array(bodySchema).min(1).max(200)
});

const updateBodySchema = bodySchema.partial().refine((body) => Object.keys(body).length > 0, {
  message: "At least one field is required."
});

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  if (error instanceof QuickReplyNotFoundError) return code === "P2025";
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
    service.list({ workspaceId: request.talk.workspaceId, ownerUserId: request.talk.clerkUserId })
  );

  app.post("/quick-replies", async (request, reply) => {
    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid quick reply request." });
    }

    const quickReply = await service.create({
      workspaceId: request.talk.workspaceId,
      ownerUserId: request.talk.clerkUserId,
      ...body.data
    });

    return reply.code(201).send(quickReply);
  });

  // A pack (JSON exported from Talk) becomes the importer's own quick replies.
  app.post("/quick-replies/import", async (request, reply) => {
    const body = packSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Pacote de mensagens inválido." });
    return service.importPack({ workspaceId: request.talk.workspaceId, ownerUserId: request.talk.clerkUserId, replies: body.data.replies });
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
        ownerUserId: request.talk.clerkUserId,
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
        ownerUserId: request.talk.clerkUserId,
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
