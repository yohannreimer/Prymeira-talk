import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createReportsService } from "./reports.service.js";
import type { PrismaLike } from "./reports.service.js";

const reportsOverviewQuerySchema = z.object({
  preset: z.enum(["today", "7d", "30d", "month", "custom"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(["open", "pending", "closed"]).optional(),
  channelId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional()
});

export const reportsRoutes: FastifyPluginAsync = async (app) => {
  const service = createReportsService(app.prisma as unknown as PrismaLike);

  app.get("/reports/overview", async (request, reply) => {
    const query = reportsOverviewQuerySchema.safeParse(request.query);

    if (!query.success) {
      return reply.code(400).send({ error: "Invalid reports query." });
    }

    return service.getOverview({
      workspaceId: request.talk.workspaceId,
      filters: query.data
    });
  });
};
