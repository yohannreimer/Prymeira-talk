import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { priceHistoryImportSchema, supplierImportSchema, uuidSchema } from "@prymeira-talk/shared";
import { canPerform } from "../access/roles.js";
import { createPurchasingService, PurchasingError, type PurchasingService } from "./purchasing.service.js";

const requestParams = z.object({ requestId: uuidSchema });
const inviteParams = z.object({ requestId: uuidSchema, inviteId: uuidSchema });
const supplierParams = z.object({ supplierId: uuidSchema });
const searchQuery = z.object({ search: z.string().trim().max(120).optional() });
const supplierIdsBody = z.object({ supplierIds: z.array(uuidSchema).min(1).max(30) });
const declineBody = z.object({ reason: z.string().trim().max(500).optional().nullable() });

/** Orçamentos: a paid add-on. Every route answers 403 until the Hub releases limits.modules.orcamentos for the workspace. */
export const purchasingRoutes: FastifyPluginAsync<{ service?: PurchasingService }> = async (app, options) => {
  const service = options.service ?? createPurchasingService(app.prisma);

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/purchasing")) return;
    if (!request.talk?.workspaceId) return reply.code(401).send({ code: "UNAUTHORIZED", error: "Workspace authentication required." });
    if (!request.talk.addons?.orcamentos) {
      return reply.code(403).send({ code: "PURCHASING_ADDON_DISABLED", error: "O módulo Orçamentos não está liberado para esta empresa." });
    }
    if (!canPerform(request.talk.role, "purchase.manage")) return reply.code(403).send({ code: "PURCHASE_FORBIDDEN", error: "Sem permissão para Orçamentos." });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      return reply.code(400).send({ code: "PURCHASE_INVALID_INPUT", error: issue?.message ?? "Dados inválidos." });
    }
    if (error instanceof PurchasingError) return reply.code(error.statusCode).send({ code: error.code, error: error.message });
    return reply.send(error);
  });

  const actor = (request: { talk: { workspaceId: string; clerkUserId?: string | null } }) =>
    ({ workspaceId: request.talk.workspaceId, userId: request.talk.clerkUserId ?? null });

  app.get("/purchasing/suppliers", async (request) =>
    service.listSuppliers(request.talk.workspaceId, searchQuery.parse(request.query).search));
  app.post("/purchasing/suppliers", async (request, reply) =>
    reply.code(201).send(await service.createSupplier(request.talk.workspaceId, request.body)));
  app.post("/purchasing/suppliers/import", { bodyLimit: 5 * 1024 * 1024 }, async (request) =>
    service.importSuppliers(request.talk.workspaceId, supplierImportSchema.parse(request.body).rows));
  app.patch("/purchasing/suppliers/:supplierId", async (request) =>
    service.updateSupplier(request.talk.workspaceId, supplierParams.parse(request.params).supplierId, request.body));
  app.delete("/purchasing/suppliers/:supplierId", async (request) =>
    service.archiveSupplier(request.talk.workspaceId, supplierParams.parse(request.params).supplierId));

  app.get("/purchasing/prices", async (request) =>
    service.listPriceHistory(request.talk.workspaceId, searchQuery.parse(request.query).search));
  app.post("/purchasing/prices/import", { bodyLimit: 5 * 1024 * 1024 }, async (request) =>
    service.importPriceHistory(request.talk.workspaceId, priceHistoryImportSchema.parse(request.body).rows));

  app.get("/purchasing/requests", async (request) => service.listRequests(request.talk.workspaceId));
  app.post("/purchasing/requests", async (request, reply) => reply.code(201).send(await service.createRequest(actor(request), request.body)));
  app.get("/purchasing/requests/:requestId", async (request) =>
    service.getRequest(request.talk.workspaceId, requestParams.parse(request.params).requestId));
  app.post("/purchasing/requests/:requestId/suppliers", async (request) =>
    service.addSuppliers(actor(request), requestParams.parse(request.params).requestId, supplierIdsBody.parse(request.body).supplierIds));
  app.delete("/purchasing/requests/:requestId/invites/:inviteId", async (request) => {
    const params = inviteParams.parse(request.params);
    return service.removeInvite(actor(request), params.requestId, params.inviteId);
  });
  app.post("/purchasing/requests/:requestId/start", async (request) =>
    service.startQuoting(actor(request), requestParams.parse(request.params).requestId));
  app.post("/purchasing/requests/:requestId/invites/:inviteId/quotes", async (request, reply) => {
    const params = inviteParams.parse(request.params);
    return reply.code(201).send(await service.recordQuote(actor(request), params.requestId, params.inviteId, request.body));
  });
  app.post("/purchasing/requests/:requestId/invites/:inviteId/decline", async (request) => {
    const params = inviteParams.parse(request.params);
    return service.declineInvite(actor(request), params.requestId, params.inviteId, declineBody.parse(request.body ?? {}).reason ?? null);
  });
  app.post("/purchasing/requests/:requestId/invites/:inviteId/approve", async (request, reply) => {
    if (!canPerform(request.talk.role, "purchase.approve")) {
      return reply.code(403).send({ code: "PURCHASE_APPROVE_FORBIDDEN", error: "Só dono ou gestor aprova uma compra." });
    }
    const params = inviteParams.parse(request.params);
    return service.approve(actor(request), params.requestId, params.inviteId);
  });
  app.post("/purchasing/requests/:requestId/cancel", async (request) =>
    service.cancel(actor(request), requestParams.parse(request.params).requestId));
  app.post("/purchasing/requests/:requestId/complete", async (request) =>
    service.complete(actor(request), requestParams.parse(request.params).requestId));
};
