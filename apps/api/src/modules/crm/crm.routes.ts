import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import { createCrmService, CrmServiceError } from "./crm.service.js";
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

function requireCrmManage(role: "owner" | "manager" | "agent", reply: FastifyReply) {
  if (canPerform(role, "crm.manage")) {
    return true;
  }

  reply.code(403).send({
    code: "CRM_MANAGE_FORBIDDEN",
    error: "CRM management permission required."
  });
  return false;
}

function handleCrmError(reply: FastifyReply, error: unknown) {
  if (error instanceof CrmServiceError) {
    return reply.code(404).send({ code: error.code, error: error.message });
  }

  throw error;
}

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
    if (!requireCrmManage(request.talk.role, reply)) {
      return reply;
    }

    const body = linkContactBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid CRM link request." });
    }

    try {
      const action = await service.linkContact({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      return reply.code(201).send(action);
    } catch (error) {
      return handleCrmError(reply, error);
    }
  });

  app.post("/crm/create-lead", async (request, reply) => {
    if (!requireCrmManage(request.talk.role, reply)) {
      return reply;
    }

    const body = createLeadBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid CRM lead request." });
    }

    try {
      const action = await service.createLead({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      return reply.code(201).send(action);
    } catch (error) {
      return handleCrmError(reply, error);
    }
  });

  app.post("/crm/create-note", async (request, reply) => {
    if (!requireCrmManage(request.talk.role, reply)) {
      return reply;
    }

    const body = createNoteBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid CRM note request." });
    }

    try {
      const action = await service.createNote({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      return reply.code(201).send(action);
    } catch (error) {
      return handleCrmError(reply, error);
    }
  });
};
