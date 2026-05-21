import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { AutomationsServiceError, createAutomationsService } from "./automations.service.js";
import type { PrismaLike } from "./automations.service.js";

const uuidParamSchema = z.string().uuid();

const automationParamsSchema = z.object({
  automationId: uuidParamSchema
});

const actionSchema = z
  .object({
    type: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(160).optional(),
    config: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough();

const createAutomationBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  status: z.enum(["enabled", "disabled"]).optional(),
  trigger: z.string().trim().min(1).max(120),
  conditions: z.record(z.string(), z.unknown()).optional(),
  actions: z.array(actionSchema).optional()
});

const updateAutomationBodySchema = createAutomationBodySchema.partial().refine(
  (body) => Object.keys(body).length > 0,
  "At least one automation field is required."
);

const testAutomationBodySchema = z
  .object({
    eventKey: z.string().trim().min(1).max(240).optional(),
    input: z.unknown().optional()
  })
  .optional();

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function handleAutomationsError(reply: FastifyReply, error: unknown) {
  if (error instanceof AutomationsServiceError) {
    return reply.code(404).send({ code: error.code, error: error.message });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2025")) {
    return reply.code(404).send({
      code: "AUTOMATION_NOT_FOUND",
      error: "Automation rule not found."
    });
  }

  if (isPrismaKnownRequestErrorCode(error, "P2002")) {
    return reply.code(409).send({
      code: "AUTOMATION_CONFLICT",
      error: "Automation rule already exists."
    });
  }

  throw error;
}

export const automationsRoutes: FastifyPluginAsync = async (app) => {
  const service = createAutomationsService(app.prisma as unknown as PrismaLike);

  app.get("/automations", async (request) =>
    service.listAutomations({ workspaceId: request.talk.workspaceId })
  );

  app.post("/automations", async (request, reply) => {
    const body = createAutomationBodySchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid automation request." });
    }

    try {
      const automation = await service.createAutomation({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });

      return reply.code(201).send(automation);
    } catch (error) {
      return handleAutomationsError(reply, error);
    }
  });

  app.patch("/automations/:automationId", async (request, reply) => {
    const params = automationParamsSchema.safeParse(request.params);
    const body = updateAutomationBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid automation request." });
    }

    try {
      return await service.updateAutomation({
        workspaceId: request.talk.workspaceId,
        automationId: params.data.automationId,
        data: body.data
      });
    } catch (error) {
      return handleAutomationsError(reply, error);
    }
  });

  app.post("/automations/:automationId/test", async (request, reply) => {
    const params = automationParamsSchema.safeParse(request.params);
    const body = testAutomationBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid automation test request." });
    }

    try {
      return await service.testAutomation({
        workspaceId: request.talk.workspaceId,
        automationId: params.data.automationId,
        eventKey: body.data?.eventKey,
        input: body.data?.input
      });
    } catch (error) {
      return handleAutomationsError(reply, error);
    }
  });

  app.get("/automations/:automationId/runs", async (request, reply) => {
    const params = automationParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid automation request." });
    }

    try {
      return await service.listRuns({
        workspaceId: request.talk.workspaceId,
        automationId: params.data.automationId
      });
    } catch (error) {
      return handleAutomationsError(reply, error);
    }
  });
};
