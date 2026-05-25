import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import {
  createAutomationRunner,
  type AutomationRunnerEvolution,
  type AutomationRunnerPrisma
} from "./automation-runner.js";
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

const actionsSchema = z.union([
  z.array(actionSchema),
  z.record(z.string(), z.unknown())
]);

const createAutomationBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  status: z.enum(["enabled", "disabled"]).optional(),
  trigger: z.string().trim().min(1).max(120),
  conditions: z.record(z.string(), z.unknown()).optional(),
  actions: actionsSchema.optional()
});

const updateAutomationBodySchema = createAutomationBodySchema.partial().refine(
  (body) => Object.keys(body).length > 0,
  "At least one automation field is required."
);

const testAutomationBodySchema = z
  .object({
    contactId: uuidParamSchema.optional(),
    channelId: uuidParamSchema.optional(),
    eventKey: z.string().trim().min(1).max(240).optional(),
    input: z.unknown().optional(),
    messageBody: z.string().trim().min(1).max(1000).optional()
  })
  .optional();

interface AutomationsRoutesOptions {
  evolution?: AutomationRunnerEvolution;
}

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
    if (error.code === "AUTOMATION_INVALID_FLOW") {
      return reply.code(400).send({ code: error.code, error: error.message });
    }

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

function requireAutomationManage(
  role: Parameters<typeof canPerform>[0],
  reply: FastifyReply
) {
  if (canPerform(role, "automation.manage")) {
    return true;
  }

  reply.code(403).send({
    code: "AUTOMATION_MANAGE_FORBIDDEN",
    error: "Automation management permission required."
  });
  return false;
}

export const automationsRoutes: FastifyPluginAsync<AutomationsRoutesOptions> = async (
  app,
  options
) => {
  const service = createAutomationsService(app.prisma as unknown as PrismaLike);

  async function simulateAutomationWithContact(input: {
    workspaceId: string;
    automationId: string;
    channelId?: string;
    contactId: string;
    eventKey?: string;
    messageBody?: string;
  }) {
    const contact = await app.prisma.contact.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.contactId
      }
    });

    if (!contact) {
      throw new AutomationsServiceError("AUTOMATION_NOT_FOUND", "Contact not found.");
    }

    const channelWhere = {
      workspaceId: input.workspaceId,
      provider: "evolution" as const,
      ...(input.channelId ? { id: input.channelId } : {})
    };
    const channel =
      (await app.prisma.channel.findFirst({
        where: {
          ...channelWhere,
          status: "connected"
        },
        orderBy: [{ createdAt: "asc" }]
      })) ??
      (await app.prisma.channel.findFirst({
        where: channelWhere,
        orderBy: [{ createdAt: "asc" }]
      }));

    if (!channel) {
      throw new AutomationsServiceError("AUTOMATION_NOT_FOUND", "Channel not found.");
    }

    const now = new Date();
    const body = input.messageBody ?? "Mensagem de simulacao da automacao.";
    const eventKey = `message.received:automation-simulation:${input.automationId}:${randomUUID()}`;
    const conversation = await app.prisma.conversation.upsert({
      where: {
        workspaceId_channelId_contactId: {
          workspaceId: input.workspaceId,
          channelId: channel.id,
          contactId: contact.id
        }
      },
      create: {
        workspaceId: input.workspaceId,
        channelId: channel.id,
        contactId: contact.id,
        status: "open",
        lastMessageAt: now,
        lastMessagePreview: body,
        unreadCount: 1
      },
      update: {
        status: "open",
        lastMessageAt: now,
        lastMessagePreview: body,
        unreadCount: { increment: 1 }
      }
    });
    const message = await app.prisma.message.create({
      data: {
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        providerEventId: eventKey,
        providerMessageId: `automation-simulation:${randomUUID()}`,
        direction: "inbound",
        type: "text",
        body,
        status: "delivered",
        metadata: {
          source: "automation_simulation",
          automationId: input.automationId,
          requestedEventKey: input.eventKey ?? null,
          contactId: contact.id,
          channelId: channel.id
        }
      }
    });
    const contactRunner = createAutomationRunner({
      prisma: app.prisma as unknown as AutomationRunnerPrisma,
      evolution: options.evolution,
      realtime: app.realtime
    });
    const runs = await contactRunner.runForInboundMessage({
      workspaceId: input.workspaceId,
      messageId: message.id,
      eventKey,
      automationId: input.automationId,
      includeDisabled: true
    });
    const run = runs.find((candidate) => candidate.ruleId === input.automationId) ?? runs[0];

    if (!run) {
      throw new AutomationsServiceError(
        "AUTOMATION_INVALID_FLOW",
        "Automation could not be simulated with a contact."
      );
    }

    return run;
  }

  app.get("/automations", async (request) =>
    service.listAutomations({ workspaceId: request.talk.workspaceId })
  );

  app.post("/automations", async (request, reply) => {
    if (!requireAutomationManage(request.talk.role, reply)) {
      return reply;
    }

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
    if (!requireAutomationManage(request.talk.role, reply)) {
      return reply;
    }

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

  app.delete("/automations/:automationId", async (request, reply) => {
    if (!requireAutomationManage(request.talk.role, reply)) {
      return reply;
    }

    const params = automationParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid automation request." });
    }

    try {
      return await service.deleteAutomation({
        workspaceId: request.talk.workspaceId,
        automationId: params.data.automationId
      });
    } catch (error) {
      return handleAutomationsError(reply, error);
    }
  });

  app.post("/automations/:automationId/test", async (request, reply) => {
    if (!requireAutomationManage(request.talk.role, reply)) {
      return reply;
    }

    const params = automationParamsSchema.safeParse(request.params);
    const body = testAutomationBodySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid automation test request." });
    }

    try {
      if (body.data?.contactId) {
        return await simulateAutomationWithContact({
          workspaceId: request.talk.workspaceId,
          automationId: params.data.automationId,
          channelId: body.data.channelId,
          contactId: body.data.contactId,
          eventKey: body.data.eventKey,
          messageBody: body.data.messageBody
        });
      }

      const run = await service.testAutomation({
        workspaceId: request.talk.workspaceId,
        automationId: params.data.automationId,
        eventKey: body.data?.eventKey,
        input: body.data?.input
      });
      app.realtime.publish({
        type: "automation_run.created",
        workspaceId: request.talk.workspaceId,
        payload: run
      });

      return run;
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
