import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { createContactsService } from "./contacts.service.js";

const searchQuerySchema = z.object({
  search: z.string().optional()
});

const contactParamsSchema = z.object({
  contactId: z.string().uuid()
});

const optionalEmailSchema = z
  .string()
  .trim()
  .refine((value) => value === "" || z.string().email().safeParse(value).success, {
    message: "Invalid email"
  });

const createContactBodySchema = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().trim().min(1).max(40),
  email: optionalEmailSchema.optional(),
  company: z.string().max(200).optional()
});

const updateContactBodySchema = z
  .object({
    name: z.string().max(200).optional(),
    phone: z.string().trim().min(1).max(40).optional(),
    email: optionalEmailSchema.optional(),
    company: z.string().max(200).optional()
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required"
  });

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function sendPhoneConflict(reply: FastifyReply) {
  return reply
    .code(409)
    .send({
      code: "CONTACT_PHONE_CONFLICT",
      error: "A contact with this phone already exists."
    });
}

export const contactsRoutes: FastifyPluginAsync = async (app) => {
  const service = createContactsService(app.prisma);

  app.get("/contacts", async (request, reply) => {
    const query = searchQuerySchema.safeParse(request.query);

    if (!query.success) {
      return reply.code(400).send({ error: "Invalid contacts request." });
    }

    return service.listContacts({
      workspaceId: request.talk.workspaceId,
      search: query.data.search
    });
  });

  app.post("/contacts", async (request, reply) => {
    const body = createContactBodySchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid contact request." });
    }

    const contact = await service.createContact({
      workspaceId: request.talk.workspaceId,
      ...body.data
    }).catch((error: unknown) => {
      if (isPrismaKnownRequestErrorCode(error, "P2002")) {
        return null;
      }

      throw error;
    });

    if (!contact) {
      return sendPhoneConflict(reply);
    }

    return reply.code(201).send(contact);
  });

  app.patch("/contacts/:contactId", async (request, reply) => {
    const params = contactParamsSchema.safeParse(request.params);
    const body = updateContactBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid contact request." });
    }

    const contact = await service.updateContact({
      workspaceId: request.talk.workspaceId,
      contactId: params.data.contactId,
      ...body.data
    }).catch((error: unknown) => {
      if (isPrismaKnownRequestErrorCode(error, "P2025")) {
        return { status: "not_found" as const };
      }

      if (isPrismaKnownRequestErrorCode(error, "P2002")) {
        return { status: "conflict" as const };
      }

      throw error;
    });

    if ("status" in contact && contact.status === "not_found") {
      return reply
        .code(404)
        .send({ code: "CONTACT_NOT_FOUND", error: "Contact not found." });
    }

    if ("status" in contact && contact.status === "conflict") {
      return sendPhoneConflict(reply);
    }

    return contact;
  });
};
