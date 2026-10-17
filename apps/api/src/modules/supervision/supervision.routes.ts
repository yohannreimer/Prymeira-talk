import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { supervisionUnreadPeriodSchema } from "@prymeira-talk/shared";
import { createInboxMediaService } from "../conversations/inbox-media.js";
import { deploymentPhotoStore } from "../conversations/photo-store.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { SupervisionError } from "./supervision-access.js";
import { createSupervisionService } from "./supervision.service.js";
import { collectPlatformHealth } from "./platform-health.js";
import { loadWeeklyFollowupCatalog } from "./weekly-followup-catalog.js";
import { AgentEvaluationError, type AgentEvaluationsService } from "../agents/agent-evaluations.service.js";
import { AgentImprovementsServiceError, type AgentImprovementsService } from "../agents/agent-improvements.service.js";
import { agentImprovementErrorStatus, approveImprovementBodySchema, updateImprovementBodySchema } from "../agents/agents.routes.js";

const querySchema = z.object({
  status: z.enum(["active", "closed", "all"]).default("active"),
  sellerCustomerId: z.string().uuid().optional(),
  nextAction: z.enum(["true", "false"]).transform(value => value === "true").optional(),
  unread: z.enum(["true", "false"]).transform(value => value === "true").optional(),
  unreadPeriod: supervisionUnreadPeriodSchema.optional(),
  waiting: z.enum(["true", "false"]).transform(value => value === "true").optional(),
  search: z.string().trim().max(80).optional(),
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

/** The writes besides answering: marking a customer as not needing an answer, and the owner deciding agent rules. */
const waitingMarkPath = /^\/supervision\/workspaces\/[^/]+\/conversations\/[^/]+\/waiting$/;
const ownerWritePath = /^\/supervision\/admin\/(agent-evaluations\/[^/]+\/(run|proposals|rules\/remove)|agent-improvements\/[^/]+\/[^/]+\/(update|normalize|approve))$/;
function isAllowedWrite(request: FastifyRequest) {
  const path = request.url.split("?")[0]!;
  return request.method === "POST" && (waitingMarkPath.test(path) || ownerWritePath.test(path));
}
function admin(request: FastifyRequest) {
  if (request.supervision?.kind !== "admin") throw new SupervisionError(403, "Acesso administrativo necessário.");
}
const clientParams = z.object({ clientKey: z.string().regex(/^[a-z0-9-]{1,80}$/) });
function evaluationError(error: unknown): never {
  if (error instanceof AgentEvaluationError) throw new SupervisionError(error.code === "NOT_FOUND" ? 404 : 409, error.message);
  if (error instanceof AgentImprovementsServiceError) throw new SupervisionError(agentImprovementErrorStatus(error), error.message);
  throw error;
}
const improvementParams = clientParams.extend({ improvementId: z.string().uuid() });

export const supervisionRoutes: FastifyPluginAsync<{ evolution?: EvolutionRuntime; agentEvaluations?: AgentEvaluationsService; agentImprovements?: AgentImprovementsService }> = async (app, options) => {
  const service = createSupervisionService(app.prisma);
  const mediaService = createInboxMediaService({ prisma: app.prisma, client: options.evolution?.client, photos: deploymentPhotoStore() });
  app.addHook("preHandler", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (request.method !== "GET" && !isAllowedWrite(request)) throw new SupervisionError(403, "A supervisão permite somente consulta.");
  });
  app.get("/supervision/admin/channels", async request => {
    if (request.supervision?.kind !== "admin") throw new SupervisionError(403, "Acesso administrativo necessário.");
    const query = parse(z.object({ workspaceId: z.string().uuid() }).strict(), request.query);
    return service.channels(query.workspaceId);
  });
  // The product owner's health board: every customer's numbers, Hub admins only (validated on /admin/session).
  app.get("/supervision/admin/health", async request => {
    if (request.supervision?.kind !== "admin") throw new SupervisionError(403, "Acesso administrativo necessário.");
    return collectPlatformHealth(app.prisma);
  });

  // The weekly evaluation of each company's new attendance agent: the product owner's, never a supervisor's.
  const evaluations = options.agentEvaluations;
  function evaluationsService() {
    if (!evaluations) throw new SupervisionError(503, "Avaliação dos agentes indisponível.");
    return evaluations;
  }
  app.get("/supervision/admin/agent-evaluations", async request => {
    admin(request);
    return { clients: await evaluationsService().clients() };
  });
  app.get("/supervision/admin/agent-evaluations/:clientKey", async request => {
    admin(request);
    const params = parse(clientParams, request.params);
    return { evaluations: await evaluationsService().list(params).catch(evaluationError) };
  });
  // An evaluation takes minutes: it starts here and the page reloads the list until it is ready.
  app.post("/supervision/admin/agent-evaluations/:clientKey/run", async (request, reply) => {
    admin(request);
    const params = parse(clientParams, request.params);
    const service = evaluationsService();
    void service.runWeek({ ...params, periodEnd: new Date(), force: true })
      .catch(error => request.log.error({ err: error }, "Agent evaluation failed."));
    return reply.code(202).send({ started: true });
  });
  app.post("/supervision/admin/agent-evaluations/:clientKey/proposals", async request => {
    admin(request);
    const params = parse(clientParams, request.params);
    const body = parse(z.object({ evaluationId: z.string().uuid(), proposalId: z.string().min(1).max(20), decision: z.enum(["approve", "reject"]) }).strict(), request.body);
    return evaluationsService().decideProposal({ ...params, ...body }).catch(evaluationError);
  });
  app.post("/supervision/admin/agent-evaluations/:clientKey/rules/remove", async request => {
    admin(request);
    const params = parse(clientParams, request.params);
    const body = parse(z.object({ rule: z.string().min(1).max(400) }).strict(), request.body);
    return evaluationsService().removeRule({ ...params, rule: body.rule }).catch(evaluationError);
  });

  // The suggestions learned from hand-overs, for every workspace of the customer. One approved goes to all of them.
  function improvementsService() {
    if (!options.agentImprovements) throw new SupervisionError(503, "Aprimoramentos indisponíveis.");
    return options.agentImprovements;
  }
  async function improvementOwner(clientKey: string, improvementId: string) {
    const agents = await evaluationsService().clientAgents(clientKey).catch(evaluationError);
    for (const agent of agents) {
      const found = await app.prisma.aiAgentImprovement.findFirst({ where: { ...agent, id: improvementId }, select: { id: true } });
      if (found) return { owner: agent, agents };
    }
    throw new SupervisionError(404, "Sugestão de aprimoramento não encontrada.");
  }
  app.get("/supervision/admin/agent-improvements/:clientKey", async request => {
    admin(request);
    const params = parse(clientParams, request.params);
    const agents = await evaluationsService().clientAgents(params.clientKey).catch(evaluationError);
    const lists = await Promise.all(agents.map(agent => improvementsService().listImprovements({ ...agent, status: "all" }).catch(evaluationError)));
    return { improvements: lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  });
  app.post("/supervision/admin/agent-improvements/:clientKey/:improvementId/update", async request => {
    admin(request);
    const params = parse(improvementParams, request.params);
    const body = parse(updateImprovementBodySchema, request.body);
    const { owner } = await improvementOwner(params.clientKey, params.improvementId);
    return improvementsService().updateImprovement({ ...owner, improvementId: params.improvementId, ...body, reject: body.reject === true }).catch(evaluationError);
  });
  app.post("/supervision/admin/agent-improvements/:clientKey/:improvementId/normalize", async request => {
    admin(request);
    const params = parse(improvementParams, request.params);
    const { owner } = await improvementOwner(params.clientKey, params.improvementId);
    return improvementsService().normalizeImprovement({ ...owner, improvementId: params.improvementId }).catch(evaluationError);
  });
  app.post("/supervision/admin/agent-improvements/:clientKey/:improvementId/approve", async request => {
    admin(request);
    const params = parse(improvementParams, request.params);
    const body = parse(approveImprovementBodySchema, request.body ?? {});
    const { owner, agents } = await improvementOwner(params.clientKey, params.improvementId);
    return improvementsService().approveImprovement({ ...owner, improvementId: params.improvementId, ...body, alsoTo: agents }).catch(evaluationError);
  });

  app.get("/supervision/summary", async request => {
    const query = parse(z.object({ unreadPeriod: supervisionUnreadPeriodSchema.default("all") }).strict(), request.query);
    return service.summary(grants(request), query.unreadPeriod);
  });
  app.get("/supervision/conversations", async request => service.list(grants(request), parse(querySchema, request.query)));

  app.get("/supervision/followup-weeks", async request => {
    const access = grants(request);
    const query = parse(z.object({ weekId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), sellerCustomerId: z.string().uuid().optional(), search: z.string().trim().max(80).optional() }).strict(), request.query);
    return service.followupWeeks(access, await loadWeeklyFollowupCatalog(), query.weekId, query.sellerCustomerId, query.search);
  });

  const base = "/supervision/workspaces/:workspaceId/conversations/:conversationId";
  app.get(`${base}/messages`, async request => {
    const params = parse(threadParams, request.params);
    return service.thread(grants(request), params.workspaceId, params.conversationId);
  });
  app.post(`${base}/waiting`, async request => {
    const params = parse(threadParams, request.params);
    const body = parse(z.object({ dismissed: z.boolean() }).strict(), request.body);
    return service.setWaitingDismissed(grants(request), params.workspaceId, params.conversationId, body.dismissed);
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
