import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createDemoScenarioService } from "./demo-scenario.js";
import type { DemoScenarioService } from "./demo-scenario.js";
import type { VinculaDemoClient, VinculaDemoResetResult } from "./vincula-demo-client.js";

export interface DemoRoutesOptions {
  enabled: boolean;
  demoWorkspaceId: string;
  service?: Pick<DemoScenarioService, "reset" | "simulateLead">;
  vinculaClient?: VinculaDemoClient;
  requireVinculaReset?: boolean;
}

export const demoRoutes: FastifyPluginAsync<DemoRoutesOptions> = async (app, options) => {
  const service = options.service ?? createDemoScenarioService(app.prisma, app.realtime);

  function requireDemoAccess(request: FastifyRequest, reply: FastifyReply) {
    if (!options.enabled) {
      reply.code(403).send({
        code: "LOCAL_DEMO_DISABLED",
        error: "Local demo mode is disabled."
      });
      return false;
    }

    if (request.talk.workspaceId !== options.demoWorkspaceId) {
      reply.code(403).send({
        code: "LOCAL_DEMO_WORKSPACE_MISMATCH",
        error: "The active workspace is not the configured demo workspace."
      });
      return false;
    }

    if (request.talk.role !== "owner") {
      reply.code(403).send({
        code: "LOCAL_DEMO_OWNER_REQUIRED",
        error: "Owner access is required."
      });
      return false;
    }

    return true;
  }

  app.post("/demo/reset", async (request, reply) => {
    if (!requireDemoAccess(request, reply)) return reply;

    let vincula: VinculaDemoResetResult | undefined;
    if (options.vinculaClient || options.requireVinculaReset) {
      try {
        if (!options.vinculaClient) {
          throw new Error("Vincula demo reset client is unavailable.");
        }
        vincula = await options.vinculaClient.reset();
      } catch {
        return reply.code(503).send({
          code: "VINCULA_DEMO_RESET_FAILED",
          error: "Vincula could not be restored, so Talk was left unchanged.",
          talkReset: false,
          vinculaReset: false
        });
      }
    }

    try {
      const talk = await service.reset(request.talk.workspaceId);
      return vincula ? { ...talk, vincula } : talk;
    } catch {
      return reply.code(500).send({
        code: "TALK_DEMO_RESET_FAILED",
        error: vincula
          ? "Vincula was restored, but Talk could not be restored."
          : "Talk could not be restored.",
        talkReset: false,
        vinculaReset: Boolean(vincula)
      });
    }
  });

  app.post("/demo/simulate-lead", async (request, reply) => {
    if (!requireDemoAccess(request, reply)) return reply;
    return service.simulateLead(request.talk.workspaceId);
  });
};
