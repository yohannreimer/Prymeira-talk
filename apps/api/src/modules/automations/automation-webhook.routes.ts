import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { AUTOMATION_WEBHOOK_PATH_PREFIX } from "@prymeira-talk/shared";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import { createBoardRulesService, type BoardRulesPrismaLike } from "../boards/board-rules.service.js";
import {
  createAutomationRunner,
  type AutomationRunnerAgentReplyScheduler,
  type AutomationRunnerAgentRuntime,
  type AutomationRunnerEvolution,
  type AutomationRunnerPrisma
} from "./automation-runner.js";
import {
  AutomationWebhookServiceError,
  createAutomationWebhookService,
  parseWebhookSubmission,
  type AutomationWebhookPrismaLike,
  type AutomationWebhookService
} from "./automation-webhook.service.js";

export const AUTOMATION_WEBHOOK_BODY_LIMIT_BYTES = 16 * 1024;
export const AUTOMATION_WEBHOOK_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;

const automationParamsSchema = z.object({ automationId: z.string().uuid() });
const tokenParamsSchema = z.object({ token: z.string().min(1).max(256) });

export function isAutomationWebhookPath(pathname: string) {
  return pathname.startsWith(AUTOMATION_WEBHOOK_PATH_PREFIX);
}

interface AutomationWebhookRoutesOptions {
  agentRuntime?: AutomationRunnerAgentRuntime;
  agentReplyScheduler?: AutomationRunnerAgentReplyScheduler;
  evolution?: AutomationRunnerEvolution;
  service?: AutomationWebhookService;
  /** Runs work after the 202 answer; tests replace it to await the processing. */
  schedule?: (task: () => Promise<unknown>) => void;
}

function handleServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof AutomationWebhookServiceError) {
    return reply
      .code(error.code === "AUTOMATION_NOT_FOUND" ? 404 : 409)
      .send({ code: error.code, error: error.message });
  }

  throw error;
}

export const automationWebhookRoutes: FastifyPluginAsync<AutomationWebhookRoutesOptions> = async (
  app,
  options
) => {
  const service =
    options.service ??
    createAutomationWebhookService({
      prisma: app.prisma as unknown as AutomationWebhookPrismaLike,
      realtime: app.realtime,
      runner: createAutomationRunner({
        prisma: app.prisma as unknown as AutomationRunnerPrisma,
        agentRuntime: options.agentRuntime,
        agentReplyScheduler: options.agentReplyScheduler,
        evolution: options.evolution,
        realtime: app.realtime,
        boardRules: createBoardRulesService(app.prisma as unknown as BoardRulesPrismaLike)
      })
    });
  const pending = new Set<Promise<unknown>>();
  const schedule =
    options.schedule ??
    ((task: () => Promise<unknown>) => {
      const promise = Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          app.log.error({ err: error }, "Automation webhook processing failed.");
        })
        .finally(() => {
          pending.delete(promise);
        });
      pending.add(promise);
    });

  app.addHook("onClose", async () => {
    await Promise.allSettled([...pending]);
  });

  // Public: the token in the URL is the credential. CORS for this path is
  // opened in app.ts because customers post from their own sites.
  app.post(
    `${AUTOMATION_WEBHOOK_PATH_PREFIX}:token`,
    {
      bodyLimit: AUTOMATION_WEBHOOK_BODY_LIMIT_BYTES,
      config: {
        rateLimit: {
          ...AUTOMATION_WEBHOOK_RATE_LIMIT,
          keyGenerator: (request) =>
            `automation-webhook:${(request.params as { token?: string } | undefined)?.token ?? ""}`
        }
      }
    },
    async (request, reply) => {
      const params = tokenParamsSchema.safeParse(request.params);
      const rule = params.success ? await service.resolveToken(params.data.token) : null;

      if (!rule) {
        return reply.code(404).send({ ok: false, error: "not_found" });
      }

      const submission = parseWebhookSubmission(request.body);
      if (!submission.ok) {
        return submission.code === "invalid_phone"
          ? reply.code(422).send({
              ok: false,
              error: "invalid_phone",
              message: "Informe um WhatsApp válido com DDD em whatsapp, telefone ou phone."
            })
          : reply.code(400).send({ ok: false, error: "invalid_body", message: "Envie um objeto JSON." });
      }

      const claim = await service.claimSubmission({ rule, submission });
      if (claim.claimed) {
        schedule(() => service.processSubmission({ rule, eventKey: claim.eventKey, submission }));
      }

      return reply.code(202).send({ ok: true });
    }
  );

  app.post("/automations/:automationId/webhook", async (request, reply) => {
    if (!canPerform(request.talk.role, "automation.manage")) {
      return reply.code(403).send({
        code: "AUTOMATION_MANAGE_FORBIDDEN",
        error: "Automation management permission required."
      });
    }

    const params = automationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid automation request." });
    }

    try {
      return await service.getOrCreateWebhook({
        workspaceId: request.talk.workspaceId,
        automationId: params.data.automationId
      });
    } catch (error) {
      return handleServiceError(reply, error);
    }
  });

  app.post("/automations/:automationId/webhook/regenerate", async (request, reply) => {
    if (!canPerform(request.talk.role, "automation.manage")) {
      return reply.code(403).send({
        code: "AUTOMATION_MANAGE_FORBIDDEN",
        error: "Automation management permission required."
      });
    }

    const params = automationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid automation request." });
    }

    try {
      return await service.regenerateWebhook({
        workspaceId: request.talk.workspaceId,
        automationId: params.data.automationId
      });
    } catch (error) {
      return handleServiceError(reply, error);
    }
  });
};
