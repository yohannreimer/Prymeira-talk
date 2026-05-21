import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createCrmService } from "./crm.service.js";
import type { PrismaLike } from "./crm.service.js";

const uuidSchema = z.string().uuid();

const syncActionsQuerySchema = z.object({
  contactId: uuidSchema.optional()
});

const linkContactBodySchema = z.object({
  contactId: uuidSchema,
  atomicCrmContactId: z.string().trim().min(1).max(160).optional()
});

const createLeadBodySchema = z.object({
  contactId: uuidSchema,
  title: z.string().trim().min(1).max(200)
});

const createNoteBodySchema = z.object({
  contactId: uuidSchema,
  body: z.string().trim().min(1).max(2000)
});

export const crmRoutes: FastifyPluginAsync = async (app) => {
  const service = createCrmService(app.prisma as unknown as PrismaLike);

  app.get("/crm/sync-actions", async (request, reply) => {
    const query = syncActionsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid CRM sync action query." });
    }

    return service.listSyncActions({
      workspaceId: request.talk.workspaceId,
      contactId: query.data.contactId
    });
  });

  app.post("/crm/link-contact", async (request, reply) => {
    const body = linkContactBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid CRM link request." });
    }

    const action = await service.linkContact({
      workspaceId: request.talk.workspaceId,
      ...body.data
    });

    return reply.code(201).send(action);
  });

  app.post("/crm/create-lead", async (request, reply) => {
    const body = createLeadBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid CRM lead request." });
    }

    const action = await service.createLead({
      workspaceId: request.talk.workspaceId,
      ...body.data
    });

    return reply.code(201).send(action);
  });

  app.post("/crm/create-note", async (request, reply) => {
    const body = createNoteBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid CRM note request." });
    }

    const action = await service.createNote({
      workspaceId: request.talk.workspaceId,
      ...body.data
    });

    return reply.code(201).send(action);
  });
};
