import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createDemoScenarioService } from "./demo-scenario.js";
import type { DemoScenarioService } from "./demo-scenario.js";

export interface DemoRoutesOptions {
  enabled: boolean;
  demoWorkspaceId: string;
  service?: Pick<DemoScenarioService, "reset" | "simulateLead">;
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
    return service.reset(request.talk.workspaceId);
  });

  app.post("/demo/simulate-lead", async (request, reply) => {
    if (!requireDemoAccess(request, reply)) return reply;
    return service.simulateLead(request.talk.workspaceId);
  });
};
