import type { FastifyPluginAsync } from "fastify";
import { createReportsService } from "./reports.service.js";
import type { PrismaLike } from "./reports.service.js";

export const reportsRoutes: FastifyPluginAsync = async (app) => {
  const service = createReportsService(app.prisma as unknown as PrismaLike);

  app.get("/reports/overview", async (request) =>
    service.getOverview({ workspaceId: request.talk.workspaceId })
  );
};
