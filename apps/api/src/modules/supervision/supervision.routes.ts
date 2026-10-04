import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { supervisionUnreadPeriodSchema } from "@prymeira-talk/shared";
import { createInboxMediaService } from "../conversations/inbox-media.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { SupervisionError } from "./supervision-access.js";
import { createSupervisionService } from "./supervision.service.js";

const querySchema = z.object({
  status: z.enum(["active", "closed", "all"]).default("active"),
  sellerCustomerId: z.string().uuid().optional(),
  nextAction: z.enum(["true", "false"]).transform(value => value === "true").optional(),
  unread: z.enum(["true", "false"]).transform(value => value === "true").optional(),
  unreadPeriod: supervisionUnreadPeriodSchema.optional(),
  waiting: z.enum(["true", "false"]).transform(value => value === "true").optional(),
  cursor: z.string().min(1).max(1024).optional()
}).strict();
const threadParams = z.object({ workspaceId: z.string().uuid(), conversationId: z.string().uuid() });
const mediaParams = threadParams.extend({ messageId: z.string().uuid() });

function grants(request: FastifyRequest) {
  if (request.supervision?.kind !== "viewer") throw new SupervisionError(403, "Acesso de supervisão necessário.");
  return request.supervision.grants;
}
function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new SupervisionError(400, "Consulta de supervisão inválida.");
  return result.data;
}

export const supervisionRoutes: FastifyPluginAsync<{ evolution?: EvolutionRuntime }> = async (app, options) => {
  const service = createSupervisionService(app.prisma);
  const mediaService = createInboxMediaService({ prisma: app.prisma, client: options.evolution?.client });
  app.addHook("preHandler", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (request.method !== "GET") throw new SupervisionError(403, "A supervisão permite somente consulta.");
  });
  app.get("/supervision/admin/channels", async request => {
    if (request.supervision?.kind !== "admin") throw new SupervisionError(403, "Acesso administrativo necessário.");
    const query = parse(z.object({ workspaceId: z.string().uuid() }).strict(), request.query);
    return service.channels(query.workspaceId);
  });
  app.get("/supervision/summary", async request => {
    const query = parse(z.object({ unreadPeriod: supervisionUnreadPeriodSchema.default("all") }).strict(), request.query);
    return service.summary(grants(request), query.unreadPeriod);
  });
  app.get("/supervision/conversations", async request => service.list(grants(request), parse(querySchema, request.query)));

  const base = "/supervision/workspaces/:workspaceId/conversations/:conversationId";
  app.get(`${base}/messages`, async request => {
    const params = parse(threadParams, request.params);
    return service.thread(grants(request), params.workspaceId, params.conversationId);
  });
  app.get(`${base}/messages/:messageId/media`, async (request, reply) => {
    const params = parse(mediaParams, request.params);
    await service.authorizedConversation(grants(request), params.workspaceId, params.conversationId);
    try {
      const media = await mediaService.media(params.workspaceId, params.conversationId, params.messageId);
      return reply.header("X-Content-Type-Options", "nosniff").type(media.mimeType).send(media.bytes);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      throw new SupervisionError(code === "NOT_FOUND" ? 404 : code === "MEDIA_BUSY" ? 429 : 422,
        "Não foi possível carregar o anexo.");
    }
  });
  app.get(`${base}/messages/:messageId/preview`, async request => {
    const params = parse(mediaParams, request.params);
    const query = parse(z.object({ page: z.coerce.number().int().min(1).max(2000).default(1) }).strict(), request.query);
    await service.authorizedConversation(grants(request), params.workspaceId, params.conversationId);
    try {
      const media = await mediaService.preview(params.workspaceId, params.conversationId, params.messageId, query.page);
      return { imageUrl: `data:image/png;base64,${media.bytes.toString("base64")}`, pages: media.pageCount };
    } catch (error) {
      throw new SupervisionError(error instanceof Error && error.message === "NOT_FOUND" ? 404 : 422,
        "Não foi possível abrir a prévia deste PDF.");
    }
  });
};
