import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { createContactsService } from "./contacts.service.js";

const searchQuerySchema = z.object({
  search: z.string().optional()
});

const contactParamsSchema = z.object({
  contactId: z.string().uuid()
});

const startConversationBodySchema = z.object({
  channelId: z.string().uuid()
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

    app.realtime.publish({
      type: "contact.updated",
      workspaceId: request.talk.workspaceId,
      payload: contact
    });

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

    app.realtime.publish({
      type: "contact.updated",
      workspaceId: request.talk.workspaceId,
      payload: contact
    });

    return contact;
  });

  app.post("/contacts/:contactId/conversations", async (request, reply) => {
    const params = contactParamsSchema.safeParse(request.params);
    const body = startConversationBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid contact conversation request." });
    }

    const conversation = await service.startConversation({
      workspaceId: request.talk.workspaceId,
      contactId: params.data.contactId,
      channelId: body.data.channelId
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "CONTACT_NOT_FOUND") {
        return { status: "contact_not_found" as const };
      }

      if (error instanceof Error && error.message === "CHANNEL_NOT_FOUND") {
        return { status: "channel_not_found" as const };
      }

      throw error;
    });

    if ("status" in conversation && conversation.status === "contact_not_found") {
      return reply.code(404).send({ code: "CONTACT_NOT_FOUND", error: "Contact not found." });
    }

    if ("status" in conversation && conversation.status === "channel_not_found") {
      return reply.code(404).send({ code: "CHANNEL_NOT_FOUND", error: "Channel not found." });
    }

    app.realtime.publish({
      type: "conversation.updated",
      workspaceId: request.talk.workspaceId,
      payload: conversation
    });

    return reply.code(201).send(conversation);
  });
};
