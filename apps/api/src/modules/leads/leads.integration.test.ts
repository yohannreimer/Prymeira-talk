import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { CnpjRepository } from "./cnpj.repository.js";
import { LeadsDomainError } from "./leads.repository.js";
import { leadsRoutes, type LeadsRoutesConversionService, type LeadsRoutesService } from "./leads.routes.js";

const now = "2026-09-22T15:00:00.000Z";
const workspaceA = "clinic_a";
const workspaceB = "clinic_b";
const leadId = randomUUID();
const listId = randomUUID();
const jobId = randomUUID();
const contactId = randomUUID();
const provenanceId = randomUUID();
const campaignId = randomUUID();
const conversationId = randomUUID();
const cnpj = "12345678ABCD90";

const company = { cnpj, companyName: "Clínica Exemplo", tradeName: "Clínica Exemplo" };
const list = {
  id: listId, workspaceId: workspaceA, name: "Clínicas em Curitiba", source: "receita_federal" as const,
  criteria: { city: "Curitiba", activity: "Clínicas" }, totalCount: 1, processedCount: 1, failedCount: 0,
  startedAt: now, completedAt: now, createdAt: now, updatedAt: now
};
const job = {
  id: jobId, workspaceId: workspaceA, listId, operation: "receita_search", status: "completed" as const,
  attempts: 1, leaseUntil: null, startedAt: now, finishedAt: now, errorMessage: null,
  createdAt: now, updatedAt: now
};
const lead = {
  id: leadId, workspaceId: workspaceA, listId, source: "receita_federal" as const,
  companyName: "Clínica Exemplo", tradeName: "Clínica Exemplo", cnpj,
  cnaePrimary: "8630503", cnaeSecondary: [], category: null,
  address: "Rua Exemplo, 10", city: "Curitiba", state: "PR", postalCode: "80000000",
  phones: ["5541999999999"], normalizedPhone: "5541999999999", email: null,
  website: null, rating: null, reviewCount: null, latitude: null, longitude: null,
  sourceUrl: null, whatsappStatus: "unverified" as const, whatsappVerifications: [],
  createdAt: now, updatedAt: now
};

const auth = (workspaceId: string, role = "agent") => ({ "x-workspace": workspaceId, "x-role": role });

describe("Leads integrated API flow", () => {
  it("keeps the public CNPJ adapter tenant-neutral while all operational flows remain scoped and unsent", async () => {
    const query = vi.fn(async (_sql: string, _values: readonly unknown[]) => ({
      rows: [{ cnpj, cnpj_basico: "12345678", company_name: company.companyName, trade_name: company.tradeName }],
      rowCount: 1
    }));
    const cnpjRepository = new CnpjRepository({ query } as never);
    expect((await cnpjRepository.findByCnpj("12.345.678/abcd-90"))?.cnpj).toBe(cnpj);
    expect(query.mock.calls[0]?.[1]).toEqual(["12345678", "ABCD", "90"]);
    expect(query.mock.calls[0]?.[0]).not.toMatch(/workspace(_id|Id)?/i);

    const app = Fastify({ logger: false });
    const messageSend = vi.fn();
    const importedContacts = new Map<string, string>();
    app.decorate("prisma", {
      lead: { count: vi.fn(async ({ where }: { where: { workspaceId: string; listId: string; id: { in: string[] } } }) =>
        where.workspaceId === workspaceA && where.listId === listId
          ? where.id.in.filter((id) => id === leadId).length : 0) },
      message: { create: messageSend }
    } as never);
    app.addHook("onRequest", async (request) => {
      const workspaceId = request.headers["x-workspace"];
      if (typeof workspaceId !== "string") return;
      const role = request.headers["x-role"];
      request.talk = {
        workspaceId, role: role === "owner" || role === "manager" ? role : "agent",
        clerkUserId: "user_integration"
      };
    });
    const own = (workspaceId: string) => {
      if (workspaceId !== workspaceA) throw new LeadsDomainError("LEAD_NOT_FOUND", "Not found.");
    };
    const service = {
      listLists: vi.fn(async (workspaceId: string) => workspaceId === workspaceA ? [list] : []),
      listLeads: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
        own(workspaceId);
        return { items: [lead], page: 1, pageSize: 25, total: 1 };
      }),
      getJob: vi.fn(async (workspaceId: string) => { own(workspaceId); return job; }),
      createReceitaSearchJob: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
        own(workspaceId);
        return { list, job, replayed: false };
      }),
      lookupReceitaCompany: vi.fn(async ({ cnpj: requested }: { cnpj?: string }) => ({
        items: requested === cnpj ? [company] : [], page: 1, pageSize: 25, total: requested === cnpj ? 1 : 0
      })),
      getCsvErrorArtifact: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
        own(workspaceId);
        return { content: Buffer.from("row,reason\n"), mimeType: "text/csv; charset=utf-8" };
      }),
      createWhatsappVerification: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
        own(workspaceId);
        return {
          requestId: randomUUID(), jobs: [job], requestedCount: 1,
          verifications: [{ leadId, normalizedPhone: lead.normalizedPhone, status: "available", checkedAt: now, errorMessage: null }]
        };
      })
    };
    const conversion = {
      importSelectedLeads: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
        own(workspaceId);
        importedContacts.set(workspaceId, contactId);
        return {
          requestedCount: 1, importedCount: 1, createdCount: 1, reconciledCount: 0, skippedCount: 0,
          contacts: [{
            leadId, contactId, provenanceId, phone: lead.normalizedPhone, status: "created", reason: null,
            sourceTag: { name: "Origem: Lead Receita", color: "#0f766e" },
            provenance: {
              id: provenanceId, source: "receita_federal", listId, importedAt: now,
              whatsappStatus: "available", suggestedMessage: "Olá, Clínica Exemplo!"
            }
          }]
        };
      }),
      lookupComposerDraft: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
        own(workspaceId);
        if (!importedContacts.has(workspaceId)) return null;
        return { body: "Olá, Clínica Exemplo!", provenanceId };
      }),
      createCampaignDraftFromLeads: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
        own(workspaceId);
        return { campaignId, status: "draft", contactCount: 1 };
      })
    };
    await app.register(leadsRoutes, {
      service: service as unknown as LeadsRoutesService,
      conversionService: conversion as unknown as LeadsRoutesConversionService
    });

    const search = await app.inject({ method: "POST", url: "/leads/receita/search", headers: auth(workspaceA), payload: {
      name: list.name, filters: { city: "Curitiba", activity: "Clínicas" }, idempotencyKey: "integration-search"
    } });
    expect(search.statusCode).toBe(202);
    expect(search.json().list.id).toBe(listId);
    const results = await app.inject({ method: "GET", url: `/leads/lists/${listId}/results`, headers: auth(workspaceA) });
    expect(results.json().items[0].whatsappStatus).toBe("unverified");
    const selected = [results.json().items[0].id];

    const verify = await app.inject({ method: "POST", url: `/leads/lists/${listId}/whatsapp-verifications`,
      headers: auth(workspaceA), payload: { listId, leadIds: selected, idempotencyKey: "integration-wa" } });
    expect(verify.statusCode).toBe(202);
    expect(verify.json().verifications[0].status).toBe("available");
    const imported = await app.inject({ method: "POST", url: `/leads/lists/${listId}/contacts/import`,
      headers: auth(workspaceA), payload: { selectedLeadIds: selected } });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().contacts[0].sourceTag.name).toBe("Origem: Lead Receita");
    expect(imported.json().contacts[0].provenance.suggestedMessage).toBe("Olá, Clínica Exemplo!");
    const composer = await app.inject({ method: "GET", url: `/leads/conversations/${conversationId}/composer-draft`,
      headers: auth(workspaceA) });
    expect(composer.json().body).toBe("Olá, Clínica Exemplo!");
    const draft = await app.inject({ method: "POST", url: `/leads/lists/${listId}/campaign-drafts`,
      headers: auth(workspaceA), payload: { selectedLeadIds: selected } });
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toEqual({ campaignId, status: "draft", contactCount: 1 });

    expect((await app.inject({ method: "GET", url: "/leads/lists", headers: auth(workspaceB) })).json()).toEqual([]);
    for (const request of [
      { method: "GET", url: `/leads/lists/${listId}/results` },
      { method: "GET", url: `/leads/jobs/${jobId}/errors.csv` },
      { method: "POST", url: `/leads/lists/${listId}/whatsapp-verifications`, payload: {
        listId, leadIds: selected, idempotencyKey: "foreign-wa"
      } },
      { method: "POST", url: `/leads/lists/${listId}/contacts/import`, payload: { selectedLeadIds: selected } },
      { method: "POST", url: `/leads/lists/${listId}/campaign-drafts`, payload: { selectedLeadIds: selected } },
      { method: "GET", url: `/leads/conversations/${conversationId}/composer-draft` }
    ] as const) {
      const foreign = await app.inject({ ...request, headers: auth(workspaceB) });
      expect(foreign.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
    expect(messageSend).not.toHaveBeenCalled();
    await app.close();
  });
});
