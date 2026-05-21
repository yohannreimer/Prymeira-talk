import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { createAssistantService } from "./assistant.service.js";
import type { PrismaLike } from "./assistant.service.js";

const uuidSchema = z.string().uuid();

const createAssistantActionBodySchema = z.object({
  actionType: z.enum(["summary", "suggested_reply"]),
  conversationId: uuidSchema.nullable().optional(),
  contactId: uuidSchema.nullable().optional(),
  input: z.record(z.string(), z.unknown()).optional()
});

export const assistantRoutes: FastifyPluginAsync = async (app) => {
  const service = createAssistantService(app.prisma as unknown as PrismaLike);

  app.get("/assistant/actions", async (request) =>
    service.listActions({ workspaceId: request.talk.workspaceId })
  );

  app.post("/assistant/actions", async (request, reply) => {
    const body = createAssistantActionBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid assistant action request." });
    }

    const action = await service.createAction({
      workspaceId: request.talk.workspaceId,
      ...body.data,
      input: body.data.input as Prisma.InputJsonValue | undefined
    });

    return reply.code(201).send(action);
  });
};
