import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  leadCampaignDraftRequestSchema,
  leadCampaignDraftResultSchema,
  leadComposerDraftSchema,
  leadContactImportRequestSchema,
  leadContactImportResultSchema,
  leadCsvImportResponseSchema,
  leadCsvUploadRequestSchema,
  leadGoogleRetryResponseSchema,
  leadGoogleSearchRequestSchema,
  leadGoogleSearchResponseSchema,
  leadJobSchema,
  leadListSchema,
  leadPaginatedResultSchema,
  leadReceitaLookupQuerySchema,
  leadReceitaLookupResponseSchema,
  leadReceitaSearchRequestSchema,
  leadSimilarQuerySchema,
  leadSimilarSaveRequestSchema,
  leadSourceSchema,
  leadWhatsappVerificationRequestSchema,
  leadWhatsappVerificationResponseSchema,
  leadWhatsappRetryResponseSchema,
  similarCompanySearchResultSchema,
  uuidSchema
} from "@prymeira-talk/shared";
import { canPerform } from "../access/roles.js";
import { LeadSourceUnavailableError } from "./cnpj.repository.js";
import { LeadConversionError, createLeadConversionService } from "./lead-conversion.service.js";
import { LeadsDomainError } from "./leads.repository.js";
import { MAX_CSV_BYTES, createLeadsService } from "./leads.service.js";

const listParamsSchema = z.object({ listId: uuidSchema });
const jobParamsSchema = z.object({ jobId: uuidSchema });
const conversationParamsSchema = z.object({ conversationId: uuidSchema });
const listQuerySchema = z.object({
  source: leadSourceSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
});
const resultsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});
const renameListSchema = z.object({ name: z.string().trim().min(1).max(160) });
const selectionParamsSchema = z.object({ listId: uuidSchema });

export type LeadsRoutesService = ReturnType<typeof createLeadsService>;
export type LeadsRoutesConversionService = ReturnType<typeof createLeadConversionService>;

interface LeadsRoutesOptions {
  service?: LeadsRoutesService;
  conversionService?: LeadsRoutesConversionService;
  publicTalkUrl?: string;
}

function domainStatus(code: string) {
  if (code === "LEAD_NOT_FOUND" || code === "LEAD_CITY_NOT_FOUND" ||
      code === "LEAD_CAMPAIGN_TEMPLATE_NOT_FOUND") return 404;
  if (code === "LEAD_SOURCE_UNAVAILABLE" || code === "LEAD_GEOCODER_UNAVAILABLE") return 503;
  if (code === "LEAD_LIMIT_EXCEEDED") return 413;
  if (code === "LEAD_INVALID_TRANSITION" || code === "LEAD_IDEMPOTENCY_CONFLICT" ||
      code === "LEAD_EVOLUTION_NOT_CONNECTED" || code === "LEAD_CAMPAIGN_COMMON_BODY_REQUIRED") return 409;
  return 400;
}

function csvBytes(value: string) {
  if (value.length > Math.ceil(MAX_CSV_BYTES / 3) * 4) {
    throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", "CSV exceeds 5 MiB.");
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new LeadsDomainError("LEAD_INVALID_ENCODING", "CSV must be valid base64.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new LeadsDomainError("LEAD_INVALID_ENCODING", "CSV must be valid base64.");
  }
  if (bytes.byteLength > MAX_CSV_BYTES) {
    throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", "CSV exceeds 5 MiB.");
  }
  return bytes;
}

export const leadsRoutes: FastifyPluginAsync<LeadsRoutesOptions> = async (app, options) => {
  const service = options.service;
  const conversion = options.conversionService ?? createLeadConversionService(app.prisma);
  if (!service) throw new Error("Leads routes require a Leads service.");

  app.addHook("preHandler", async (request, reply) => {
    if (!request.talk?.workspaceId) {
      return reply.code(401).send({ code: "UNAUTHORIZED", error: "Workspace authentication required." });
    }
    if (!canPerform(request.talk.role, "lead.manage")) {
      return reply.code(403).send({ code: "LEAD_MANAGE_FORBIDDEN", error: "Lead management permission required." });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ code: "LEAD_INVALID_INPUT", error: "Invalid Leads request." });
    }
    if (error instanceof LeadsDomainError || error instanceof LeadConversionError) {
      return reply.code(domainStatus(error.code)).send({ code: error.code, error: error.message });
    }
    if (error instanceof LeadSourceUnavailableError) {
      return reply.code(503).send({ code: "LEAD_SOURCE_UNAVAILABLE", error: error.message });
    }
    if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 413) {
      return reply.code(413).send({ code: "LEAD_LIMIT_EXCEEDED", error: "Upload exceeds the server limit." });
    }
    return reply.send(error);
  });

  async function assertSelection(workspaceId: string, listId: string, selectedLeadIds: string[]) {
    const count = await app.prisma.lead.count({
      where: { workspaceId, listId, id: { in: selectedLeadIds } }
    });
    if (count !== selectedLeadIds.length) {
      throw new LeadsDomainError("LEAD_NOT_FOUND", "Selected lead or list not found in this workspace.");
    }
  }

  app.get("/leads/lists", async (request) => {
    const query = listQuerySchema.parse(request.query);
    return z.array(leadListSchema).parse(await service.listLists(
      request.talk.workspaceId, query.source, query.page, query.pageSize
    ));
  });

  app.get("/leads/lists/:listId", async (request) => {
    const { listId } = listParamsSchema.parse(request.params);
    return leadListSchema.parse(await service.getList(request.talk.workspaceId, listId));
  });

  app.patch("/leads/lists/:listId", async (request) => {
    const { listId } = listParamsSchema.parse(request.params);
    const { name } = renameListSchema.parse(request.body);
    return leadListSchema.parse(await service.updateList({ workspaceId: request.talk.workspaceId, listId, name }));
  });

  app.delete("/leads/lists/:listId", async (request, reply) => {
    const { listId } = listParamsSchema.parse(request.params);
    await service.deleteList(request.talk.workspaceId, listId);
    return reply.code(204).send();
  });

  app.get("/leads/lists/:listId/results", async (request) => {
    const { listId } = listParamsSchema.parse(request.params);
    const query = resultsQuerySchema.parse(request.query);
    return leadPaginatedResultSchema.parse(await service.listLeads({
      workspaceId: request.talk.workspaceId, listId, ...query
    }));
  });

  app.get("/leads/jobs/:jobId", async (request) => {
    const { jobId } = jobParamsSchema.parse(request.params);
    return leadJobSchema.parse(await service.getJob(request.talk.workspaceId, jobId));
  });

  app.post("/leads/receita/search", async (request, reply) => {
    const body = leadReceitaSearchRequestSchema.parse(request.body);
    const result = await service.createReceitaSearchJob({ ...body, workspaceId: request.talk.workspaceId });
    return reply.code(202).send(leadGoogleSearchResponseSchema.parse(result));
  });

  app.get("/leads/receita/lookup", async (request) => {
    const query = leadReceitaLookupQuerySchema.parse(request.query);
    return leadReceitaLookupResponseSchema.parse(await service.lookupReceitaCompany(query));
  });

  app.post("/leads/receita/csv", { bodyLimit: 7_100_000 }, async (request, reply) => {
    const body = leadCsvUploadRequestSchema.parse(request.body);
    const result = await service.createCsvImportJob({
      workspaceId: request.talk.workspaceId,
      name: body.name,
      fileName: body.fileName,
      upload: csvBytes(body.csvBase64),
      idempotencyKey: body.idempotencyKey
    });
    return reply.code(202).send(leadCsvImportResponseSchema.parse({
      ...result,
      errorCsvUrl: new URL(`/leads/jobs/${result.jobId}/errors.csv`, options.publicTalkUrl ?? "http://localhost").toString()
    }));
  });

  app.get("/leads/jobs/:jobId/errors.csv", async (request, reply) => {
    const { jobId } = jobParamsSchema.parse(request.params);
    const artifact = await service.getCsvErrorArtifact({ workspaceId: request.talk.workspaceId, jobId });
    return reply.header("content-type", artifact.mimeType)
      .header("content-disposition", 'attachment; filename="lead-errors.csv"')
      .send(artifact.content);
  });

  app.get("/leads/similar", async (request) => {
    const query = leadSimilarQuerySchema.parse(request.query);
    return similarCompanySearchResultSchema.parse(await service.findSimilarCompanies({
      ...query, workspaceId: request.talk.workspaceId
    }));
  });

  app.post("/leads/similar/jobs", async (request, reply) => {
    const body = leadSimilarSaveRequestSchema.parse(request.body);
    const result = await service.createSimilarListJob({ ...body, workspaceId: request.talk.workspaceId });
    return reply.code(202).send(leadGoogleSearchResponseSchema.parse(result));
  });

  app.post("/leads/google/search", async (request, reply) => {
    const body = leadGoogleSearchRequestSchema.parse(request.body);
    const result = await service.createGoogleSearchJob({ ...body, workspaceId: request.talk.workspaceId });
    return reply.code(202).send(leadGoogleSearchResponseSchema.parse(result));
  });

  app.post("/leads/jobs/:jobId/retry", async (request, reply) => {
    const { jobId } = jobParamsSchema.parse(request.params);
    const job = await service.getJob(request.talk.workspaceId, jobId);
    if (job.operation === "google_maps_search") {
      const result = await service.retryGoogleJob({ workspaceId: request.talk.workspaceId, jobId });
      return reply.code(202).send(leadGoogleRetryResponseSchema.parse(result));
    }
    if (job.operation === "whatsapp_availability" || job.operation === "whatsapp_availability_batch") {
      const result = await service.retryWhatsappVerification({ workspaceId: request.talk.workspaceId, jobId });
      return reply.code(202).send(leadWhatsappRetryResponseSchema.parse(result));
    }
    throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "This job is not ready for retry.");
  });

  app.post("/leads/lists/:listId/whatsapp-verifications", async (request, reply) => {
    const { listId } = selectionParamsSchema.parse(request.params);
    const body = leadWhatsappVerificationRequestSchema.parse(request.body);
    if (body.listId !== listId) throw new LeadsDomainError("LEAD_INVALID_INPUT", "List ids do not match.");
    await assertSelection(request.talk.workspaceId, listId, body.leadIds);
    const result = await service.createWhatsappVerification({
      workspaceId: request.talk.workspaceId, listId, leadIds: body.leadIds,
      idempotencyKey: body.idempotencyKey
    });
    return reply.code(202).send(leadWhatsappVerificationResponseSchema.parse(result));
  });

  app.post("/leads/lists/:listId/contacts/import", async (request, reply) => {
    const { listId } = selectionParamsSchema.parse(request.params);
    const body = leadContactImportRequestSchema.parse(request.body);
    await assertSelection(request.talk.workspaceId, listId, body.selectedLeadIds);
    return reply.code(201).send(leadContactImportResultSchema.parse(await conversion.importSelectedLeads({
      workspaceId: request.talk.workspaceId,
      selectedLeadIds: body.selectedLeadIds,
      actor: { id: request.talk.clerkUserId ?? request.talk.workspaceId, role: request.talk.role }
    })));
  });

  app.post("/leads/lists/:listId/campaign-drafts", async (request, reply) => {
    const { listId } = selectionParamsSchema.parse(request.params);
    const body = leadCampaignDraftRequestSchema.parse(request.body);
    await assertSelection(request.talk.workspaceId, listId, body.selectedLeadIds);
    if (body.originalSelectedLeadIds) {
      await assertSelection(request.talk.workspaceId, listId, body.originalSelectedLeadIds);
    }
    return reply.code(201).send(leadCampaignDraftResultSchema.parse(await conversion.createCampaignDraftFromLeads({
      ...body, listId, workspaceId: request.talk.workspaceId
    })));
  });

  app.get("/leads/conversations/:conversationId/composer-draft", async (request) => {
    const { conversationId } = conversationParamsSchema.parse(request.params);
    return leadComposerDraftSchema.nullable().parse(await conversion.lookupComposerDraft({
      workspaceId: request.talk.workspaceId, conversationId
    }));
  });
};
