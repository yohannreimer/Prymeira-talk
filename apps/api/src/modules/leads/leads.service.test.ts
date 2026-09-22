import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LeadJob, LeadJobStatus } from "@prisma/client";
import { LeadSourceUnavailableError, type CnpjCompanyRecord } from "./cnpj.repository.js";
import { LeadsDomainError, type ClaimedLeadJob } from "./leads.repository.js";
import {
  MAX_CSV_BYTES,
  createErrorCsv,
  createLeadsService
} from "./leads.service.js";

const workspaceId = "workspace_a";
const foreignWorkspaceId = "workspace_b";
const listId = randomUUID();
const jobId = randomUUID();
const artifactId = randomUUID();
const now = new Date("2026-09-22T15:00:00.000Z");

function listDto(overrides: Record<string, unknown> = {}) {
  return {
    id: listId,
    workspaceId,
    name: "Receita",
    source: "receita_federal" as const,
    criteria: {},
    totalCount: 0,
    processedCount: 0,
    failedCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

function jobDto(status: LeadJobStatus = "queued", overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    workspaceId,
    listId,
    operation: "receita_search",
    status,
    attempts: status === "queued" ? 0 : 1,
    leaseUntil: status === "running" ? new Date(now.getTime() + 300_000).toISOString() : null,
    startedAt: status === "queued" ? null : now.toISOString(),
    finishedAt: null,
    errorMessage: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

function rawJob(operation: string, input: unknown): ClaimedLeadJob {
  return {
    id: jobId,
    workspaceId,
    listId,
    operation,
    status: "running",
    input: input as never,
    output: {},
    errorMessage: null,
    attempts: 1,
    leaseToken: randomUUID(),
    leaseUntil: new Date(now.getTime() + 300_000),
    startedAt: now,
    finishedAt: null,
    idempotencyKey: "idem",
    createdAt: now,
    updatedAt: now
  };
}

function company(cnpj: string): CnpjCompanyRecord {
  return {
    cnpj,
    cnpjBasico: cnpj.slice(0, 8),
    companyName: `Empresa ${cnpj}`,
    tradeName: null,
    legalNature: null,
    legalNatureDescription: null,
    porte: null,
    capitalSocial: null,
    establishmentType: null,
    status: "02",
    openedAt: null,
    cnaePrimary: null,
    cnaePrimaryDescription: null,
    cnaeSecondary: [],
    address: null,
    neighborhood: null,
    postalCode: null,
    city: null,
    state: null,
    phone1: null,
    phone2: null,
    email: null,
    simples: null,
    mei: null
  };
}

function setup(csv = "cnpj\n12345678ABCD90\n") {
  const stored = new Map<string, unknown>();
  const repository = {
    listLists: vi.fn(),
    getList: vi.fn(),
    updateList: vi.fn(),
    deleteList: vi.fn(),
    listLeads: vi.fn(),
    getJob: vi.fn(),
    createListAndJob: vi.fn(async (input: any) => {
      stored.set("create", input);
      return {
        list: listDto(),
        job: jobDto("queued", { operation: input.operation }),
        artifact: input.artifact
          ? {
              id: artifactId,
              workspaceId,
              listId,
              jobId,
              kind: input.artifact.kind,
              fileName: input.artifact.fileName,
              mimeType: input.artifact.mimeType,
              size: input.artifact.content.byteLength,
              createdAt: now.toISOString()
            }
          : undefined
      };
    }),
    findQueuedJobs: vi.fn(),
    claimJob: vi.fn(),
    recoverExpiredJobs: vi.fn(),
    extendLease: vi.fn(async () => true),
    upsertLeads: vi.fn(async (leads: any[]) => {
      const map = (stored.get("leads") as Map<string, unknown> | undefined) ?? new Map();
      for (const lead of leads) map.set(lead.sourceDedupeKey, lead);
      stored.set("leads", map);
      return leads;
    }),
    updateListProgress: vi.fn(async (input: any) => listDto(input)),
    finishJob: vi.fn(async (input: any) => jobDto(input.status, {
      operation: (stored.get("operation") as string | undefined) ?? "receita_search",
      errorMessage: input.errorMessage,
      finishedAt: input.finishedAt.toISOString()
    })),
    upsertArtifact: vi.fn(async (input: any) => {
      stored.set("errorArtifact", input);
      return {
        id: artifactId,
        workspaceId: input.workspaceId,
        listId: input.listId,
        jobId: input.jobId,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: input.content.byteLength,
        createdAt: now.toISOString()
      };
    }),
    getArtifact: vi.fn(async () => ({
      id: artifactId,
      workspaceId,
      listId,
      jobId,
      kind: "csv_input",
      fileName: "input.csv",
      mimeType: "text/csv",
      size: Buffer.byteLength(csv),
      createdAt: now.toISOString(),
      content: Buffer.from(csv)
    })),
    getJobArtifact: vi.fn(async () => ({
      id: artifactId,
      workspaceId,
      listId,
      jobId,
      kind: "csv_input",
      fileName: "input.csv",
      mimeType: "text/csv",
      size: Buffer.byteLength(csv),
      createdAt: now.toISOString(),
      content: Buffer.from(csv)
    }))
  };
  const cnpjRepository = {
    searchEstablishments: vi.fn(),
    findByCnpj: vi.fn()
  };
  const realtime = { publish: vi.fn() };
  const service = createLeadsService({
    repository: repository as never,
    cnpjRepository: cnpjRepository as never,
    realtime,
    now: () => now
  });
  return { service, repository, cnpjRepository, realtime, stored };
}

describe("Leads service", () => {
  it("returns the same persisted job for a repeated workspace operation idempotency key", async () => {
    const context = setup();
    context.repository.createListAndJob.mockResolvedValue({ list: listDto(), job: jobDto(), artifact: undefined });

    const first = await context.service.createReceitaSearchJob({
      workspaceId,
      name: "Busca",
      filters: { state: "SP" },
      idempotencyKey: "same"
    });
    const second = await context.service.createReceitaSearchJob({
      workspaceId,
      name: "Busca repetida",
      filters: { state: "SP" },
      idempotencyKey: "same"
    });

    expect(first.job.id).toBe(second.job.id);
    expect(context.repository.createListAndJob).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId,
      operation: "receita_search",
      idempotencyKey: "same"
    }));
  });

  it("enforces the hard Receita result ceiling", async () => {
    const { service } = setup();
    await expect(service.createReceitaSearchJob({
      workspaceId,
      name: "Busca",
      filters: {},
      idempotencyKey: "too-many",
      maxResults: 5_001
    })).rejects.toMatchObject({ code: "LEAD_LIMIT_EXCEEDED" });
  });

  it("completes a Receita search and publishes workspace-scoped list/job events", async () => {
    const context = setup();
    context.cnpjRepository.searchEstablishments.mockResolvedValue({
      items: [company("12345678ABCD90")], page: 1, pageSize: 100, total: 1
    });
    const job = rawJob("receita_search", { filters: { state: "SP" }, maxResults: 5_000 });

    await context.service.runClaimedJob(job);

    expect(context.repository.upsertLeads).toHaveBeenCalledWith([
      expect.objectContaining({ workspaceId, listId, sourceDedupeKey: "12345678ABCD90" })
    ]);
    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", errorMessage: null }));
    expect(context.realtime.publish.mock.calls.every(([event]) => event.workspaceId === workspaceId)).toBe(true);
    expect(context.realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "lead_list.updated", workspaceId }));
    expect(context.realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "lead_job.updated", workspaceId }));
  });

  it("marks a search partial after persisting a page and failing the next source page", async () => {
    const context = setup();
    const items = Array.from({ length: 100 }, (_, index) => company(`${String(index).padStart(8, "0")}ABCD90`));
    context.cnpjRepository.searchEstablishments
      .mockResolvedValueOnce({ items, page: 1, pageSize: 100, total: 101 })
      .mockRejectedValueOnce(new LeadSourceUnavailableError());

    await context.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 5_000 }));

    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({
      status: "partial",
      errorMessage: "LEAD_SOURCE_UNAVAILABLE"
    }));
    expect((context.stored.get("leads") as Map<string, unknown>).size).toBe(100);
  });

  it("fails only the job when the CNPJ source is unavailable before any result", async () => {
    const context = setup();
    context.cnpjRepository.searchEstablishments.mockRejectedValue(new LeadSourceUnavailableError());

    await context.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 5_000 }));

    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorMessage: "LEAD_SOURCE_UNAVAILABLE"
    }));
  });

  it("accepts streamed CSV and alphanumeric CNPJ but rejects malformed, missing-column, and oversized input", async () => {
    const context = setup();
    async function* stream() {
      yield "Documento,Empresa\n";
      yield "12.345.678/abcd-90,Prymeira\n";
    }
    const accepted = await context.service.createCsvImportJob({
      workspaceId,
      name: "Importação",
      fileName: "input.csv",
      upload: stream(),
      idempotencyKey: "csv-1"
    });
    expect(accepted).toMatchObject({ acceptedRows: 1, duplicateRows: 0, invalidRows: 0 });
    expect(context.repository.createListAndJob).toHaveBeenCalledWith(expect.objectContaining({
      artifact: expect.objectContaining({ content: Buffer.from("Documento,Empresa\n12.345.678/abcd-90,Prymeira\n") })
    }));

    await expect(context.service.createCsvImportJob({ workspaceId, name: "x", fileName: "x.csv", upload: "empresa\nA\n", idempotencyKey: "missing" }))
      .rejects.toMatchObject({ code: "LEAD_INVALID_INPUT" });
    await expect(context.service.createCsvImportJob({ workspaceId, name: "x", fileName: "x.csv", upload: 'cnpj\n"unterminated', idempotencyKey: "bad" }))
      .rejects.toMatchObject({ code: "LEAD_INVALID_INPUT" });
    await expect(context.service.createCsvImportJob({ workspaceId, name: "x", fileName: "x.csv", upload: Buffer.alloc(MAX_CSV_BYTES + 1), idempotencyKey: "large" }))
      .rejects.toMatchObject({ code: "LEAD_LIMIT_EXCEEDED" });
  });

  it("deduplicates input, reports not-found rows in original order, and escapes spreadsheet formulas", async () => {
    const csv = [
      "cnpj,empresa,contexto",
      "12345678ABCD90,Found,ok",
      '12345678ABCD90,"=HYPERLINK(""https://bad"")",@cmd',
      "11111111AAAA11,Missing,+context",
      "invalid,-company,context"
    ].join("\n");
    const context = setup(csv);
    context.cnpjRepository.findByCnpj.mockImplementation(async (cnpj: string) =>
      cnpj === "12345678ABCD90" ? company(cnpj) : null
    );
    const job = rawJob("cnpj_csv_import", {});
    context.stored.set("operation", "cnpj_csv_import");

    await context.service.runClaimedJob(job);

    expect(context.repository.upsertLeads).toHaveBeenCalledWith([
      expect.objectContaining({ sourceDedupeKey: "12345678ABCD90", sourceSnapshot: expect.objectContaining({ csvInput: { company: "Found", context: "ok" } }) })
    ]);
    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({ status: "partial" }));
    const errorArtifact = context.stored.get("errorArtifact") as { content: Buffer };
    const errorCsv = errorArtifact.content.toString("utf8");
    expect(errorCsv.indexOf("DUPLICATE_CNPJ")).toBeLessThan(errorCsv.indexOf("CNPJ_NOT_FOUND"));
    expect(errorCsv.indexOf("CNPJ_NOT_FOUND")).toBeLessThan(errorCsv.indexOf("INVALID_CNPJ"));
    expect(errorCsv).toContain("'=HYPERLINK");
    expect(errorCsv).toContain("'@cmd");
    expect(errorCsv).toContain("'+context");
    expect(errorCsv).toContain("'-company");
  });

  it("retries idempotently without duplicating natural-key leads", async () => {
    const context = setup();
    context.cnpjRepository.searchEstablishments.mockResolvedValue({
      items: [company("12345678ABCD90")], page: 1, pageSize: 100, total: 1
    });
    await context.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 5_000 }));
    await context.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 5_000 }));

    expect((context.stored.get("leads") as Map<string, unknown>).size).toBe(1);
  });

  it("fails an empty CSV job because no useful result completed", async () => {
    const context = setup("cnpj\n");
    context.stored.set("operation", "cnpj_csv_import");

    await context.service.runClaimedJob(rawJob("cnpj_csv_import", {}));

    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorMessage: "LEAD_CSV_NO_RESULTS"
    }));
  });

  it("escapes every formula-leading error CSV cell", () => {
    const csv = createErrorCsv([{ rowNumber: 2, cnpj: "=1+1", company: "+SUM(A1)", context: "-2", reason: "@bad" }]).toString("utf8");
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'+SUM(A1)");
    expect(csv).toContain("'-2");
    expect(csv).toContain("'@bad");
  });

  it("retrieves an error artifact only through the caller workspace scope", async () => {
    const context = setup();
    context.repository.getJobArtifact.mockImplementation(async (requestedWorkspace?: string) => {
      if (requestedWorkspace !== workspaceId) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead artifact not found.");
      return { id: artifactId, workspaceId, listId, jobId, kind: "csv_error", fileName: "errors.csv", mimeType: "text/csv", size: 5, createdAt: now.toISOString(), content: Buffer.from("error") };
    });

    await expect(context.service.getCsvErrorArtifact({ workspaceId: foreignWorkspaceId, jobId }))
      .rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    await expect(context.service.getCsvErrorArtifact({ workspaceId, jobId }))
      .resolves.toMatchObject({ id: artifactId, workspaceId, jobId, kind: "csv_error" });
    expect(context.repository.getJobArtifact).toHaveBeenLastCalledWith(workspaceId, jobId, "csv_error");
  });
});
