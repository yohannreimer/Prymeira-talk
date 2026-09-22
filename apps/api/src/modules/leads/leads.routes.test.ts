import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { LeadsDomainError } from "./leads.repository.js";
import { leadsRoutes, type LeadsRoutesConversionService, type LeadsRoutesService } from "./leads.routes.js";

const workspaceA = "workspace_a";
const workspaceB = "workspace_b";
const listId = randomUUID();
const leadId = randomUUID();
const jobId = randomUUID();
const conversationId = randomUUID();
const now = "2026-09-22T15:00:00.000Z";

const list = {
  id: listId, workspaceId: workspaceA, name: "Clínicas", source: "receita_federal" as const,
  criteria: {}, totalCount: 1, processedCount: 1, failedCount: 0,
  startedAt: now, completedAt: now, createdAt: now, updatedAt: now
};
const job = {
  id: jobId, workspaceId: workspaceA, listId, operation: "google_maps_search",
  status: "failed" as const, attempts: 1, leaseUntil: null, startedAt: now,
  finishedAt: now, errorMessage: "failure", createdAt: now, updatedAt: now
};
const company = { cnpj: "12345678ABCD90", companyName: "Clínica A", tradeName: null };

function scoped(workspaceId: string) {
  if (workspaceId !== workspaceA) throw new LeadsDomainError("LEAD_NOT_FOUND", "Not found.");
}

async function setup() {
  const app = Fastify({ logger: false });
  const sendMessage = vi.fn();
  const leadCount = vi.fn(async ({ where }: { where: { workspaceId: string; listId: string; id: { in: string[] } } }) =>
    where.workspaceId === workspaceA && where.listId === listId
      ? where.id.in.filter((id) => id === leadId).length : 0);
  app.decorate("prisma", { lead: { count: leadCount }, message: { create: sendMessage } } as never);
  app.addHook("onRequest", async (request) => {
    const workspaceId = request.headers["x-workspace"];
    const role = request.headers["x-role"];
    if (typeof workspaceId === "string") {
      request.talk = {
        workspaceId,
        role: role === "owner" || role === "manager" ? role : "agent",
        clerkUserId: "user_1"
      };
    }
  });
  const service = {
    listLists: vi.fn(async (workspaceId: string) => workspaceId === workspaceA ? [list] : []),
    getList: vi.fn(async (workspaceId: string) => { scoped(workspaceId); return list; }),
    updateList: vi.fn(async ({ workspaceId }: { workspaceId: string }) => { scoped(workspaceId); return list; }),
    deleteList: vi.fn(async (workspaceId: string) => { scoped(workspaceId); }),
    listLeads: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      scoped(workspaceId); return { items: [], page: 1, pageSize: 25, total: 0 };
    }),
    getJob: vi.fn(async (workspaceId: string) => { scoped(workspaceId); return job; }),
    createReceitaSearchJob: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      list: { ...list, workspaceId }, job: { ...job, workspaceId }, replayed: false
    })),
    lookupReceitaCompany: vi.fn(async () => ({ items: [company], page: 1, pageSize: 25, total: 1 })),
    createCsvImportJob: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      if (!workspaceId) throw new Error("Missing workspace.");
      return { listId, jobId, acceptedRows: 1, duplicateRows: 0, invalidRows: 0, errorCsvUrl: null };
    }),
    getCsvErrorArtifact: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      scoped(workspaceId);
      return { content: Buffer.from("row,reason\n2,INVALID_CNPJ\n"), mimeType: "text/csv; charset=utf-8" };
    }),
    findSimilarCompanies: vi.fn(async ({ workspaceId, listId: seedListId }: { workspaceId: string; listId?: string }) => {
      if (seedListId) scoped(workspaceId);
      return { scoringVersion: "cnpj-similarity-v1", seed: company, items: [] };
    }),
    createSimilarListJob: vi.fn(async ({ workspaceId, listId: seedListId }: { workspaceId: string; listId?: string }) => {
      if (seedListId) scoped(workspaceId);
      return { list: { ...list, workspaceId }, job: { ...job, workspaceId }, replayed: false };
    }),
    createGoogleSearchJob: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      return { list: { ...list, workspaceId }, job: { ...job, workspaceId }, replayed: false };
    }),
    retryGoogleJob: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      scoped(workspaceId);
      return { list, job: { ...job, status: "queued" } };
    }),
    retryWhatsappVerification: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      scoped(workspaceId);
      return { job, verifications: [] };
    }),
    createWhatsappVerification: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      scoped(workspaceId);
      return { requestId: randomUUID(), jobs: [job], requestedCount: 1, verifications: [] };
    })
  };
  const conversion = {
    importSelectedLeads: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      scoped(workspaceId);
      return { requestedCount: 1, importedCount: 0, createdCount: 0, reconciledCount: 0, skippedCount: 0, contacts: [] };
    }),
    createCampaignDraftFromLeads: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      scoped(workspaceId);
      return { campaignId: randomUUID(), status: "draft", contactCount: 1 };
    }),
    lookupComposerDraft: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      scoped(workspaceId);
      return { body: "Mensagem editável", provenanceId: randomUUID() };
    })
  };
  await app.register(leadsRoutes, {
    service: service as unknown as LeadsRoutesService,
    conversionService: conversion as unknown as LeadsRoutesConversionService,
    publicTalkUrl: "https://talk.example.com"
  });
  return { app, service, conversion, leadCount, sendMessage };
}

const headers = (workspaceId: string, role: string = "agent") => ({
  "x-workspace": workspaceId, "x-role": role
});

describe("Leads routes", () => {
  it("permits agent, manager and owner with workspace context and rejects anonymous access", async () => {
    const { app } = await setup();
    for (const role of ["agent", "manager", "owner"]) {
      const response = await app.inject({ method: "GET", url: "/leads/lists", headers: headers(workspaceA, role) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([list]);
    }
    expect((await app.inject({ method: "GET", url: "/leads/lists" })).statusCode).toBe(401);
    for (const role of ["agent", "manager", "owner"]) {
      expect((await app.inject({ method: "POST", url: `/leads/lists/${listId}/contacts/import`,
        headers: headers(workspaceA, role), payload: { selectedLeadIds: [leadId] }
      })).statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url: `/leads/lists/${listId}/campaign-drafts`,
        headers: headers(workspaceA, role), payload: { selectedLeadIds: [leadId] }
      })).statusCode).toBe(201);
    }
    expect((await app.inject({ method: "POST", url: `/leads/lists/${listId}/contacts/import`,
      payload: { selectedLeadIds: [leadId] }
    })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/leads/lists", headers: headers(workspaceB) })).json()).toEqual([]);
    await app.close();
  });

  it("scopes reads, mutations, CSV download and drafts to the authenticated workspace", async () => {
    const { app, service, conversion, sendMessage } = await setup();
    const selected = { selectedLeadIds: [leadId] };
    const cases = [
      { method: "GET", url: `/leads/lists/${listId}` },
      { method: "PATCH", url: `/leads/lists/${listId}`, payload: { name: "Novo nome" } },
      { method: "DELETE", url: `/leads/lists/${listId}` },
      { method: "GET", url: `/leads/lists/${listId}/results` },
      { method: "GET", url: `/leads/jobs/${jobId}` },
      { method: "GET", url: `/leads/jobs/${jobId}/errors.csv` },
      { method: "GET", url: `/leads/similar?listId=${listId}&leadId=${leadId}` },
      { method: "POST", url: "/leads/similar/jobs", payload: {
        listId, leadId, name: "Semelhantes", selectedCnpjs: ["12345678ABCD90"], idempotencyKey: "similar-1"
      } },
      { method: "POST", url: `/leads/jobs/${jobId}/retry` },
      { method: "POST", url: `/leads/lists/${listId}/whatsapp-verifications`, payload: {
        listId, leadIds: [leadId], idempotencyKey: "wa-1"
      } },
      { method: "POST", url: `/leads/lists/${listId}/contacts/import`, payload: selected },
      { method: "POST", url: `/leads/lists/${listId}/campaign-drafts`, payload: selected },
      { method: "GET", url: `/leads/conversations/${conversationId}/composer-draft` }
    ] as const;
    for (const testCase of cases) {
      const own = await app.inject({ ...testCase, headers: headers(workspaceA) });
      expect(own.statusCode, `${testCase.method} ${testCase.url}: ${own.body}`).toBeLessThan(300);
      const foreign = await app.inject({ ...testCase, headers: headers(workspaceB) });
      expect(foreign.statusCode, `${testCase.method} ${testCase.url}: ${foreign.body}`).toBe(404);
    }
    expect(service.createWhatsappVerification).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: workspaceA, listId }));
    expect(conversion.importSelectedLeads).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: workspaceA }));
    expect(conversion.createCampaignDraftFromLeads).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: workspaceA }));
    expect(sendMessage).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a conflict with the reason when a list cannot be deleted", async () => {
    const { app, service } = await setup();
    service.deleteList.mockRejectedValueOnce(new LeadsDomainError(
      "LEAD_INVALID_TRANSITION", "Esta lista já originou contatos e não pode ser excluída."
    ));

    const response = await app.inject({ method: "DELETE", url: `/leads/lists/${listId}`, headers: headers(workspaceA) });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "LEAD_INVALID_TRANSITION", error: expect.stringContaining("originou contatos") });
    await app.close();
  });

  it("queues independent Receita, CSV, Google and similar jobs in both workspaces", async () => {
    const { app, service } = await setup();
    const receita = await app.inject({ method: "POST", url: "/leads/receita/search", headers: headers(workspaceA), payload: {
      name: "Receita", filters: { city: "São Paulo" }, idempotencyKey: "receita-1"
    } });
    expect(receita.statusCode).toBe(202);
    expect(service.createReceitaSearchJob).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: workspaceA }));
    expect((await app.inject({ method: "POST", url: "/leads/receita/search", headers: headers(workspaceB), payload: {
      name: "Receita B", filters: { city: "Campinas" }, idempotencyKey: "receita-b"
    } })).statusCode).toBe(202);
    const csv = await app.inject({ method: "POST", url: "/leads/receita/csv", headers: headers(workspaceA), payload: {
      name: "CSV", fileName: "cnpjs.csv", csvBase64: Buffer.from("cnpj\n12345678ABCD90\n").toString("base64"),
      idempotencyKey: "csv-1"
    } });
    expect(csv.statusCode).toBe(202);
    expect(csv.json().errorCsvUrl).toBe(`https://talk.example.com/leads/jobs/${jobId}/errors.csv`);
    expect((await app.inject({ method: "POST", url: "/leads/receita/csv", headers: headers(workspaceB), payload: {
      name: "CSV B", fileName: "cnpjs.csv", csvBase64: Buffer.from("cnpj\n12345678ABCD90\n").toString("base64"),
      idempotencyKey: "csv-b"
    } })).statusCode).toBe(202);
    for (const workspaceId of [workspaceA, workspaceB]) {
      expect((await app.inject({ method: "POST", url: "/leads/google/search", headers: headers(workspaceId), payload: {
        name: "Google", niche: "clínica", city: "São Paulo", state: "SP", idempotencyKey: `google-${workspaceId}`
      } })).statusCode).toBe(202);
      expect((await app.inject({ method: "GET", url: "/leads/similar?seedCnpj=12345678ABCD90", headers: headers(workspaceId) })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/leads/similar/jobs", headers: headers(workspaceId), payload: {
        seedCnpj: "12345678ABCD90", name: "Semelhantes", selectedCnpjs: ["12345678ABCD90"],
        idempotencyKey: `similar-${workspaceId}`
      } })).statusCode).toBe(202);
    }
    const lookup = await app.inject({ method: "GET", url: "/leads/receita/lookup?cnpj=12345678ABCD90", headers: headers(workspaceB) });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().items).toEqual([company]);
    expect(service.lookupReceitaCompany).toHaveBeenCalledWith(expect.objectContaining({ cnpj: "12345678ABCD90" }));
    await app.close();
  });

  it("rejects malformed, oversized and cross-list selections before invoking conversion or verification", async () => {
    const { app, conversion, service } = await setup();
    const importUrl = `/leads/lists/${listId}/contacts/import`;
    expect((await app.inject({ method: "POST", url: importUrl, headers: headers(workspaceA), payload: {
      selectedLeadIds: [randomUUID()]
    } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: importUrl, headers: headers(workspaceA), payload: {
      selectedLeadIds: Array.from({ length: 5001 }, () => randomUUID())
    } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/leads/lists/${listId}/campaign-drafts`, headers: headers(workspaceA), payload: {
      selectedLeadIds: [randomUUID()]
    } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/leads/lists/${listId}/whatsapp-verifications`, headers: headers(workspaceA), payload: {
      listId, leadIds: [randomUUID()], idempotencyKey: "wa-x"
    } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/leads/lists/${listId}/results?pageSize=101`, headers: headers(workspaceA) })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/leads/receita/lookup", headers: headers(workspaceA) })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/leads/receita/csv", headers: headers(workspaceA), payload: {
      name: "CSV", fileName: "x.csv", csvBase64: "%%%", idempotencyKey: "bad"
    } })).json().code).toBe("LEAD_INVALID_ENCODING");
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 65).toString("base64");
    const oversizedResponse = await app.inject({ method: "POST", url: "/leads/receita/csv", headers: headers(workspaceA), payload: {
      name: "CSV", fileName: "x.csv", csvBase64: oversized, idempotencyKey: "large"
    } });
    expect(oversizedResponse.statusCode, oversizedResponse.body).toBe(413);
    expect(conversion.importSelectedLeads).not.toHaveBeenCalled();
    expect(conversion.createCampaignDraftFromLeads).not.toHaveBeenCalled();
    expect(service.createWhatsappVerification).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps unavailable integrations and jobs not ready for retry to stable codes", async () => {
    const { app, service } = await setup();
    service.lookupReceitaCompany.mockRejectedValueOnce(new LeadsDomainError("LEAD_SOURCE_UNAVAILABLE", "Unavailable."));
    const unavailable = await app.inject({ method: "GET", url: "/leads/receita/lookup?cnpj=12345678ABCD90", headers: headers(workspaceA) });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().code).toBe("LEAD_SOURCE_UNAVAILABLE");
    service.retryGoogleJob.mockRejectedValueOnce(new LeadsDomainError("LEAD_INVALID_TRANSITION", "Not ready."));
    const retry = await app.inject({ method: "POST", url: `/leads/jobs/${jobId}/retry`, headers: headers(workspaceA) });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().code).toBe("LEAD_INVALID_TRANSITION");
    await app.close();
  });
});
