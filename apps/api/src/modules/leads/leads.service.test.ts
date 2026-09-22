import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LeadJob, LeadJobStatus } from "@prisma/client";
import { LeadSourceUnavailableError, type CnpjCompanyRecord } from "./cnpj.repository.js";
import { GoogleMapsScraperError } from "./google-maps-scraper.client.js";
import { LeadLeaseLostError, LeadsDomainError, type ClaimedLeadJob } from "./leads.repository.js";
import {
  MAX_CSV_BYTES,
  createErrorCsv,
  createLeadsService,
  parseGoogleMapsCsv
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
    mei: null,
    latitude: null,
    longitude: null
  };
}

function setup(
  csv = "cnpj\n12345678ABCD90\n",
  timing: { now?: () => Date; sleep?: (milliseconds: number) => Promise<void>; pollIntervalMs?: number } = {}
) {
  const stored = new Map<string, unknown>();
  const repository = {
    listLists: vi.fn(),
    getList: vi.fn(),
    updateList: vi.fn(),
    deleteList: vi.fn(),
    listLeads: vi.fn(),
    getJob: vi.fn(),
    retryGoogleJob: vi.fn(),
    getLeadForSimilarity: vi.fn(),
    findJobByIdempotency: vi.fn(async (): Promise<any> => null),
    createListAndJob: vi.fn(async (input: any) => {
      stored.set("create", input);
      return {
        list: listDto({ source: input.source, name: input.name, criteria: input.criteria }),
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
          : undefined,
        persistedInput: input.input,
        persistedOutput: input.output ?? {},
        replayed: false
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
    })),
    fencedUpsertLeads: vi.fn(),
    fencedUpdateListProgress: vi.fn(),
    fencedCheckpointJob: vi.fn(),
    fencedUpsertArtifact: vi.fn(),
    fencedFinishJob: vi.fn()
  };
  repository.fencedUpsertLeads.mockImplementation(async (_job: unknown, leads: any[]) => repository.upsertLeads(leads));
  repository.fencedUpdateListProgress.mockImplementation(async (_job: unknown, input: any) => repository.updateListProgress(input));
  repository.fencedCheckpointJob.mockImplementation(async (claimed: any, data: any) => {
    const updated = { ...claimed, ...data, output: data.output ?? claimed.output, input: data.input ?? claimed.input };
    stored.set("checkpoint", updated.output);
    return updated;
  });
  repository.fencedUpsertArtifact.mockImplementation(async (_job: unknown, input: any) => repository.upsertArtifact(input));
  repository.fencedFinishJob.mockImplementation(async (input: any) => ({
    job: await repository.finishJob({
      workspaceId: input.job.workspaceId,
      jobId: input.job.id,
      leaseToken: input.job.leaseToken,
      status: input.status,
      output: input.output,
      errorMessage: input.errorMessage,
      finishedAt: input.now
    }),
    list: await repository.updateListProgress(input.progress)
  }));
  const cnpjRepository = {
    searchEstablishments: vi.fn(),
    findByCnpj: vi.fn(),
    findByCnpjs: vi.fn(),
    countEstablishments: vi.fn(),
    scanEstablishments: vi.fn(),
    findSimilarCandidates: vi.fn()
  };
  cnpjRepository.countEstablishments.mockImplementation(async (filters: unknown) =>
    (await cnpjRepository.searchEstablishments(filters)).total
  );
  cnpjRepository.scanEstablishments.mockImplementation(async (input: any) => {
    const result = await cnpjRepository.searchEstablishments(input.filters);
    const last = result.items.at(-1);
    return {
      items: result.items,
      nextCursor: result.items.length >= 100 && last
        ? { cnpjBasico: last.cnpj.slice(0, 8), cnpjOrdem: last.cnpj.slice(8, 12), cnpjDv: last.cnpj.slice(12, 14) }
        : null
    };
  });
  const realtime = { publish: vi.fn() };
  const googleMapsClient = {
    health: vi.fn(async () => ({ ok: true as const })),
    findJobByName: vi.fn(async () => null),
    createJob: vi.fn(async () => ({ id: "remote-job-1" })),
    getJob: vi.fn(async () => ({ id: "remote-job-1", status: "succeeded" as const })),
    download: vi.fn(async () => "title,link,category,address,phone,website,review_rating,review_count,latitude,longitude,place_id,complete_address\nPadaria Sol,https://www.google.com/maps/place/sol,Padaria,Rua A 1,(19) 99999-0000,https://padariasol.example,4.7,120,-22.90,-47.06,place-sol,\"{\"\"city\"\":\"\"Campinas\"\",\"\"state\"\":\"\"SP\"\"}\"\n")
  };
  const cityGeocoder = {
    geocode: vi.fn(async () => ({ city: "Campinas", state: "SP", latitude: -22.9056, longitude: -47.0608 }))
  };
  const service = createLeadsService({
    repository: repository as never,
    cnpjRepository: cnpjRepository as never,
    realtime,
    now: timing.now ?? (() => now),
    googleMapsClient: googleMapsClient as never,
    cityGeocoder: cityGeocoder as never,
    googlePollIntervalMs: timing.pollIntervalMs ?? 1,
    sleep: timing.sleep ?? vi.fn(async () => undefined)
  });
  return { service, repository, cnpjRepository, googleMapsClient, cityGeocoder, realtime, stored };
}

describe("Leads service", () => {
  it("returns the same persisted job for a repeated workspace operation idempotency key", async () => {
    const context = setup();
    const first = await context.service.createReceitaSearchJob({
      workspaceId,
      name: "Busca",
      filters: { state: "SP" },
      idempotencyKey: "same"
    });
    const created = context.stored.get("create") as any;
    context.repository.findJobByIdempotency.mockResolvedValue({
      list: listDto(),
      job: jobDto("queued"),
      artifact: undefined,
      persistedInput: created.input,
      persistedOutput: {},
      replayed: true
    });
    const second = await context.service.createReceitaSearchJob({
      workspaceId,
      name: "Busca",
      filters: { state: "SP" },
      idempotencyKey: "same"
    });

    expect(first.job.id).toBe(second.job.id);
    expect(context.repository.createListAndJob).toHaveBeenCalledTimes(1);
    expect(context.repository.createListAndJob).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId,
      operation: "receita_search",
      idempotencyKey: "same"
    }));
  });

  it("rejects a reused search idempotency key when the filters differ", async () => {
    const context = setup();
    await context.service.createReceitaSearchJob({
      workspaceId,
      name: "Busca",
      filters: { state: "SP" },
      idempotencyKey: "search-conflict"
    });
    const created = context.stored.get("create") as any;
    context.repository.findJobByIdempotency.mockResolvedValue({
      list: listDto(), job: jobDto(), artifact: undefined,
      persistedInput: created.input, persistedOutput: {}, replayed: true
    });

    await expect(context.service.createReceitaSearchJob({
      workspaceId,
      name: "Busca",
      filters: { state: "RJ" },
      idempotencyKey: "search-conflict"
    })).rejects.toMatchObject({ code: "LEAD_IDEMPOTENCY_CONFLICT" });
    expect(context.repository.createListAndJob).toHaveBeenCalledTimes(1);
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

  it("counts Receita results once and advances deterministic keyset cursors", async () => {
    const context = setup();
    const first = Array.from({ length: 100 }, (_, index) => company(`${String(index).padStart(8, "0")}ABCD90`));
    const second = Array.from({ length: 100 }, (_, index) => company(`${String(index + 100).padStart(8, "0")}ABCD90`));
    const cursor1 = { cnpjBasico: "00000099", cnpjOrdem: "ABCD", cnpjDv: "90" };
    const cursor2 = { cnpjBasico: "00000199", cnpjOrdem: "ABCD", cnpjDv: "90" };
    context.cnpjRepository.countEstablishments.mockResolvedValueOnce(201);
    context.cnpjRepository.scanEstablishments
      .mockResolvedValueOnce({ items: first, nextCursor: cursor1 })
      .mockResolvedValueOnce({ items: second, nextCursor: cursor2 })
      .mockResolvedValueOnce({ items: [company("00000200ABCD90")], nextCursor: null });

    await context.service.runClaimedJob(rawJob("receita_search", { filters: { state: "SP" }, maxResults: 5_000 }));

    expect(context.cnpjRepository.countEstablishments).toHaveBeenCalledTimes(1);
    expect(context.cnpjRepository.scanEstablishments).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: null, limit: 100 }));
    expect(context.cnpjRepository.scanEstablishments).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: cursor1, limit: 100 }));
    expect(context.cnpjRepository.scanEstablishments).toHaveBeenNthCalledWith(3, expect.objectContaining({ cursor: cursor2, limit: 1 }));
    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    expect((context.stored.get("leads") as Map<string, unknown>).size).toBe(201);
  });

  it("marks a search partial after persisting a page and failing the next source page", async () => {
    const context = setup();
    const items = Array.from({ length: 100 }, (_, index) => company(`${String(index).padStart(8, "0")}ABCD90`));
    context.cnpjRepository.countEstablishments.mockResolvedValueOnce(101);
    context.cnpjRepository.scanEstablishments
      .mockResolvedValueOnce({
        items,
        nextCursor: { cnpjBasico: "00000099", cnpjOrdem: "ABCD", cnpjDv: "90" }
      })
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

  it("rejects non-UTF-8 CSV with a stable encoding error", async () => {
    const context = setup();
    await expect(context.service.createCsvImportJob({
      workspaceId,
      name: "Encoding inválido",
      fileName: "invalid.csv",
      upload: Buffer.from([0x63, 0x6e, 0x70, 0x6a, 0x0a, 0xc3, 0x28]),
      idempotencyKey: "invalid-utf8"
    })).rejects.toMatchObject({ code: "LEAD_INVALID_ENCODING" });
    expect(context.repository.createListAndJob).not.toHaveBeenCalled();
  });

  it("replays queued and completed CSV jobs from persisted metadata and rejects changed bytes", async () => {
    const context = setup();
    const upload = "cnpj\n12345678ABCD90\n12345678ABCD90\ninvalid\n";
    const initial = await context.service.createCsvImportJob({
      workspaceId,
      name: "Importação",
      fileName: "input.csv",
      upload,
      idempotencyKey: "csv-replay"
    });
    const created = context.stored.get("create") as any;
    const persisted = {
      list: listDto(),
      job: jobDto("queued", { operation: "cnpj_csv_import" }),
      artifact: {
        id: artifactId, workspaceId, listId, jobId, kind: "csv_input", fileName: "input.csv",
        mimeType: "text/csv; charset=utf-8", size: Buffer.byteLength(upload), createdAt: now.toISOString()
      },
      persistedInput: created.input,
      persistedOutput: created.output,
      replayed: true
    };
    context.repository.findJobByIdempotency.mockResolvedValue(persisted);

    const queuedReplay = await context.service.createCsvImportJob({
      workspaceId, name: "Ignored replay name", fileName: "ignored.csv", upload, idempotencyKey: "csv-replay"
    });
    context.repository.findJobByIdempotency.mockResolvedValue({
      ...persisted,
      job: jobDto("completed", { operation: "cnpj_csv_import", finishedAt: now.toISOString() })
    });
    const completedReplay = await context.service.createCsvImportJob({
      workspaceId, name: "Ignored replay name", fileName: "ignored.csv", upload, idempotencyKey: "csv-replay"
    });

    expect(queuedReplay).toEqual(initial);
    expect(completedReplay).toEqual(initial);
    expect(context.repository.createListAndJob).toHaveBeenCalledTimes(1);
    expect(context.realtime.publish).toHaveBeenCalledTimes(2);

    await expect(context.service.createCsvImportJob({
      workspaceId,
      name: "Importação",
      fileName: "input.csv",
      upload: "cnpj\n99999999WXYZ10\n",
      idempotencyKey: "csv-replay"
    })).rejects.toMatchObject({ code: "LEAD_IDEMPOTENCY_CONFLICT" });
    expect(context.repository.createListAndJob).toHaveBeenCalledTimes(1);
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
    context.cnpjRepository.findByCnpjs.mockResolvedValue([company("12345678ABCD90")]);
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
    expect(context.cnpjRepository.findByCnpjs).toHaveBeenCalledTimes(1);
    expect(context.cnpjRepository.findByCnpjs).toHaveBeenCalledWith([
      "12345678ABCD90",
      "11111111AAAA11"
    ]);
    expect(context.cnpjRepository.findByCnpj).not.toHaveBeenCalled();
  });

  it("accepts exactly 5,000 CSV rows and rejects row 5,001 independently of byte size", async () => {
    const context = setup();
    const csv = (count: number) => [
      "cnpj",
      ...Array.from({ length: count }, (_, index) => `${String(index).padStart(8, "0")}ABCD90`)
    ].join("\n");

    await expect(context.service.createCsvImportJob({
      workspaceId,
      name: "Limite",
      fileName: "limit.csv",
      upload: csv(5_000),
      idempotencyKey: "rows-5000"
    })).resolves.toMatchObject({ acceptedRows: 5_000 });
    await expect(context.service.createCsvImportJob({
      workspaceId,
      name: "Excesso",
      fileName: "too-many.csv",
      upload: csv(5_001),
      idempotencyKey: "rows-5001"
    })).rejects.toMatchObject({ code: "LEAD_LIMIT_EXCEEDED" });
  });

  it("stops a search without further writes when its lease is reclaimed mid-processing", async () => {
    const context = setup();
    const firstPage = Array.from({ length: 100 }, (_, index) => company(`${String(index).padStart(8, "0")}ABCD90`));
    context.cnpjRepository.countEstablishments.mockResolvedValueOnce(101);
    context.cnpjRepository.scanEstablishments.mockResolvedValueOnce({
      items: firstPage,
      nextCursor: { cnpjBasico: "00000099", cnpjOrdem: "ABCD", cnpjDv: "90" }
    });
    context.repository.fencedUpdateListProgress
      .mockImplementationOnce(async (_job: unknown, input: any) => context.repository.updateListProgress(input))
      .mockRejectedValueOnce(new LeadLeaseLostError());

    await expect(context.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 5_000 })))
      .rejects.toMatchObject({ code: "LEAD_LEASE_LOST" });

    expect(context.repository.upsertLeads).toHaveBeenCalledTimes(1);
    expect(context.repository.updateListProgress).toHaveBeenCalledTimes(1);
    expect(context.cnpjRepository.scanEstablishments).toHaveBeenCalledTimes(1);
    expect(context.repository.finishJob).not.toHaveBeenCalled();
    expect(context.repository.upsertArtifact).not.toHaveBeenCalled();
  });

  it("propagates operational repository failures without terminalizing the job", async () => {
    const context = setup();
    context.cnpjRepository.searchEstablishments.mockResolvedValue({
      items: [company("12345678ABCD90")], page: 1, pageSize: 100, total: 1
    });
    context.repository.upsertLeads.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(context.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 5_000 })))
      .rejects.toThrow("database unavailable");
    expect(context.repository.finishJob).not.toHaveBeenCalled();
  });

  it("propagates unexpected CNPJ query failures instead of converting them to terminal status", async () => {
    const context = setup();
    context.cnpjRepository.searchEstablishments.mockRejectedValue(new Error("unexpected adapter bug"));

    await expect(context.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 5_000 })))
      .rejects.toThrow("unexpected adapter bug");
    expect(context.repository.finishJob).not.toHaveBeenCalled();
  });

  it("propagates progress and artifact storage failures for durable scheduler retry", async () => {
    const progress = setup();
    progress.repository.updateListProgress.mockRejectedValueOnce(new Error("progress database unavailable"));
    await expect(progress.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 5_000 })))
      .rejects.toThrow("progress database unavailable");
    expect(progress.repository.finishJob).not.toHaveBeenCalled();

    const artifact = setup("cnpj\ninvalid\n");
    artifact.repository.upsertArtifact.mockRejectedValueOnce(new Error("artifact database unavailable"));
    await expect(artifact.service.runClaimedJob(rawJob("cnpj_csv_import", {})))
      .rejects.toThrow("artifact database unavailable");
    expect(artifact.repository.finishJob).not.toHaveBeenCalled();
  });

  it("propagates lease storage failures without making processing writes", async () => {
    const context = setup();
    context.repository.fencedUpdateListProgress.mockRejectedValueOnce(new Error("lease database unavailable"));

    await expect(context.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 5_000 })))
      .rejects.toThrow("lease database unavailable");
    expect(context.repository.updateListProgress).not.toHaveBeenCalled();
    expect(context.repository.upsertLeads).not.toHaveBeenCalled();
    expect(context.repository.finishJob).not.toHaveBeenCalled();
  });

  it("stops CSV processing on lease loss before lead, progress, artifact, or terminal writes", async () => {
    const context = setup("cnpj\n12345678ABCD90\n");
    context.cnpjRepository.findByCnpjs.mockResolvedValue([company("12345678ABCD90")]);
    context.repository.fencedUpsertLeads.mockRejectedValueOnce(new LeadLeaseLostError());

    await expect(context.service.runClaimedJob(rawJob("cnpj_csv_import", {})))
      .rejects.toMatchObject({ code: "LEAD_LEASE_LOST" });

    expect(context.repository.upsertLeads).not.toHaveBeenCalled();
    expect(context.repository.updateListProgress).toHaveBeenCalledTimes(1);
    expect(context.repository.upsertArtifact).not.toHaveBeenCalled();
    expect(context.repository.finishJob).not.toHaveBeenCalled();
  });

  it("publishes list deletion only after the workspace-scoped delete succeeds", async () => {
    const success = setup();
    success.repository.getList.mockResolvedValue(listDto());
    success.repository.deleteList.mockResolvedValue(undefined);
    await success.service.deleteList(workspaceId, listId);
    expect(success.realtime.publish).toHaveBeenCalledWith({
      type: "lead_list.updated",
      workspaceId,
      payload: listDto()
    });

    const failure = setup();
    failure.repository.getList.mockRejectedValue(new LeadsDomainError("LEAD_NOT_FOUND", "Lead list not found."));
    await expect(failure.service.deleteList(foreignWorkspaceId, listId)).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    expect(failure.repository.deleteList).not.toHaveBeenCalled();
    expect(failure.realtime.publish).not.toHaveBeenCalled();

    const deleteFailure = setup();
    deleteFailure.repository.getList.mockResolvedValue(listDto());
    deleteFailure.repository.deleteList.mockRejectedValue(new Error("delete database unavailable"));
    await expect(deleteFailure.service.deleteList(workspaceId, listId)).rejects.toThrow("delete database unavailable");
    expect(deleteFailure.realtime.publish).not.toHaveBeenCalled();
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

  it("creates a workspace-scoped Google job from canonical geocoding without accepting scraper controls", async () => {
    const context = setup();
    const created = await context.service.createGoogleSearchJob({
      workspaceId,
      name: "Padarias Campinas",
      niche: "padarias",
      city: "campinas",
      state: "sp",
      idempotencyKey: "google-1",
      maxTimeSeconds: 600,
      depth: 99,
      concurrency: 99
    });

    expect(created.list.source).toBe("google_maps");
    expect(context.cityGeocoder.geocode).toHaveBeenCalledWith("campinas", "SP");
    expect(context.repository.createListAndJob).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      source: "google_maps",
      operation: "google_maps_search",
      criteria: { niche: "padarias", city: "Campinas", state: "SP" },
      input: expect.objectContaining({
        niche: "padarias",
        city: "Campinas",
        state: "SP",
        latitude: -22.9056,
        longitude: -47.0608,
        maxTimeSeconds: 600
      })
    }));
    const persisted = (context.repository.createListAndJob.mock.calls[0]?.[0] as any).input;
    expect(persisted).not.toHaveProperty("depth");
    expect(persisted).not.toHaveProperty("concurrency");
  });

  it("submits, checkpoints, polls, downloads, and normalizes Google rows", async () => {
    const context = setup();
    const job = rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64),
      niche: "padarias",
      city: "Campinas",
      state: "SP",
      latitude: -22.9056,
      longitude: -47.0608,
      maxTimeSeconds: 600
    });

    await context.service.runClaimedJob(job);

    expect(context.googleMapsClient.createJob).toHaveBeenCalledWith({
      name: `prymeira-${job.id}-g0`,
      keywords: ["padarias em Campinas, SP"],
      latitude: -22.9056,
      longitude: -47.0608,
      maxTimeSeconds: 600
    });
    expect(context.repository.fencedCheckpointJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id, workspaceId }),
      { output: expect.objectContaining({ remoteJobId: "remote-job-1" }) },
      now,
      300_000
    );
    expect(context.repository.upsertLeads).toHaveBeenCalledWith([
      expect.objectContaining({
        workspaceId,
        listId,
        source: "google_maps",
        companyName: "Padaria Sol",
        category: "Padaria",
        normalizedPhone: "19999990000",
        rating: 4.7,
        reviewCount: 120,
        sourceExternalId: "place-sol",
        sourceUrl: "https://www.google.com/maps/place/sol"
      })
    ]);
    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", errorMessage: null }));
  });

  it("resumes polling from a persisted remote id after restart without resubmitting", async () => {
    const context = setup();
    const job = rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64), niche: "padarias", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 600
    });
    job.output = {
      remoteJobId: "remote-existing",
      remoteStatus: "running",
      remoteSubmittedAt: now.toISOString()
    };
    context.googleMapsClient.getJob.mockResolvedValue({ id: "remote-existing", status: "succeeded" });

    await context.service.runClaimedJob(job);

    expect(context.googleMapsClient.findJobByName).not.toHaveBeenCalled();
    expect(context.googleMapsClient.createJob).not.toHaveBeenCalled();
    expect(context.googleMapsClient.getJob).toHaveBeenCalledWith("remote-existing");
    expect(context.googleMapsClient.download).toHaveBeenCalledWith("remote-existing");
  });

  it("uses a persisted retry generation to avoid rediscovering a terminal remote job", async () => {
    const context = setup();
    const job = rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64), niche: "padarias", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 600
    });
    job.output = { remoteGeneration: 2, retryRequestedAt: now.toISOString() };

    await context.service.runClaimedJob(job);

    expect(context.googleMapsClient.findJobByName).toHaveBeenCalledWith(`prymeira-${job.id}-g2`);
    expect(context.googleMapsClient.createJob).toHaveBeenCalledWith(expect.objectContaining({
      name: `prymeira-${job.id}-g2`
    }));
  });

  it("recovers a post-POST crash by finding the same persisted retry generation", async () => {
    const context = setup();
    const job = rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64), niche: "padarias", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 600
    });
    job.output = { remoteGeneration: 1, retryRequestedAt: now.toISOString() };
    context.googleMapsClient.findJobByName.mockResolvedValue({ id: "remote-g1", status: "succeeded" } as any);
    context.googleMapsClient.getJob.mockResolvedValue({ id: "remote-g1", status: "succeeded" } as any);

    await context.service.runClaimedJob(job);

    expect(context.googleMapsClient.findJobByName).toHaveBeenCalledWith(`prymeira-${job.id}-g1`);
    expect(context.googleMapsClient.createJob).not.toHaveBeenCalled();
    expect(context.repository.fencedCheckpointJob).toHaveBeenCalledWith(
      expect.anything(),
      { output: expect.objectContaining({ remoteGeneration: 1, remoteJobId: "remote-g1" }) },
      now,
      300_000
    );
  });

  it("marks malformed Google rows partial while preserving useful rows and safe counts", async () => {
    const context = setup();
    context.googleMapsClient.download.mockResolvedValue([
      "title,link,address,phone",
      "Good,https://maps.google.com/good,Rua 1,11999990000",
      ",,,"
    ].join("\n"));
    const job = rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64), niche: "x", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 600
    });

    await context.service.runClaimedJob(job);

    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({
      status: "partial",
      errorMessage: "LEAD_GOOGLE_PARTIAL_ROWS",
      output: expect.objectContaining({ totalCount: 2, processedCount: 1, failedCount: 1 })
    }));
  });

  it("deduplicates Maps rows by stable identity before canonical URL and fallback keys", () => {
    const csv = [
      "title,link,address,phone,place_id,data_id,cid",
      "A,https://www.google.com/maps/place/a?hl=pt,Rua 1,11999990000,Place-ABC,,",
      "A changed,https://google.com/maps/place/other?x=1,Rua 1,11999990000,Place-ABC,,",
      "B,https://MAPS.google.com/place/b?hl=pt#fragment,Rua 2,11888880000,,Data-B,",
      "B changed,https://maps.google.com/place/else,Rua 2,11888880000,,Data-B,",
      "C,https://maps.google.com/place/c?hl=pt,Rua 3,11777770000,,,",
      "C changed,https://maps.google.com/place/c?authuser=1#x,Rua 3,11777770000,,,"
    ].join("\n");

    const parsed = parseGoogleMapsCsv(csv, { workspaceId, listId, city: "Campinas", state: "SP" });

    expect(parsed.leads).toHaveLength(3);
    expect(parsed.leads.map((lead) => lead.sourceDedupeKey).sort()).toEqual([
      "maps:data_id:Data-B",
      "maps:place_id:Place-ABC",
      "maps:url:https://maps.google.com/place/c"
    ]);
  });

  it("persists a maximum-size Google result in bounded fenced chunks", async () => {
    const context = setup();
    const header = "title,link,address,phone,place_id";
    const rows = Array.from({ length: 5_000 }, (_, index) =>
      `Lead ${index},https://maps.google.com/place/${index},Rua ${index},1199999${String(index).padStart(4, "0")},place-${index}`
    );
    context.googleMapsClient.download.mockResolvedValue([header, ...rows].join("\n"));

    await context.service.runClaimedJob(rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64), niche: "x", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 600
    }));

    expect(context.repository.upsertLeads).toHaveBeenCalledTimes(50);
    expect(context.repository.upsertLeads.mock.calls.every(([batch]) => batch.length <= 100)).toBe(true);
    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      output: expect.objectContaining({ processedCount: 5_000, failedCount: 0 })
    }));
  });

  it("stops Google chunk writes immediately after lease loss", async () => {
    const context = setup();
    const rows = Array.from({ length: 201 }, (_, index) =>
      `Lead ${index},https://maps.google.com/place/${index},place-${index}`
    );
    context.googleMapsClient.download.mockResolvedValue([
      "title,link,place_id",
      ...rows
    ].join("\n"));
    context.repository.fencedUpsertLeads
      .mockImplementationOnce(async (_job: unknown, leads: any[]) => context.repository.upsertLeads(leads))
      .mockRejectedValueOnce(new LeadLeaseLostError());

    await expect(context.service.runClaimedJob(rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64), niche: "x", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 600
    }))).rejects.toMatchObject({ code: "LEAD_LEASE_LOST" });

    expect(context.repository.fencedUpsertLeads).toHaveBeenCalledTimes(2);
    expect(context.repository.upsertLeads).toHaveBeenCalledTimes(1);
    expect(context.repository.finishJob).not.toHaveBeenCalled();
  });

  it("turns Google rate limits into a retryable terminal failure and leaves Receita available", async () => {
    const context = setup();
    context.googleMapsClient.findJobByName.mockRejectedValue(
      new GoogleMapsScraperError("RATE_LIMITED", "limited", true)
    );
    await context.service.runClaimedJob(rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64), niche: "x", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 600
    }));

    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorMessage: "LEAD_GOOGLE_RATE_LIMITED",
      output: expect.objectContaining({ retryable: true })
    }));

    context.cnpjRepository.searchEstablishments.mockResolvedValue({ items: [], total: 0 });
    await expect(context.service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 10 }))).resolves.toBeDefined();
  });

  it("polls queued and running remote states until success within the overall deadline", async () => {
    let clock = now.getTime();
    const sleep = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
    const context = setup(undefined, { now: () => new Date(clock), sleep, pollIntervalMs: 5_000 });
    context.googleMapsClient.getJob
      .mockResolvedValueOnce({ id: "remote-job-1", status: "queued" } as any)
      .mockResolvedValueOnce({ id: "remote-job-1", status: "running" } as any)
      .mockResolvedValueOnce({ id: "remote-job-1", status: "succeeded" });

    await context.service.runClaimedJob(rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64), niche: "x", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 180
    }));

    expect(context.googleMapsClient.getJob).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 5_000);
    expect(context.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("terminalizes persisted Google jobs on deadline and explicit remote failure", async () => {
    const timedOut = setup();
    const timeoutJob = rawJob("google_maps_search", {
      requestFingerprint: "a".repeat(64), niche: "x", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 180
    });
    timeoutJob.output = {
      remoteJobId: "remote-old",
      remoteSubmittedAt: new Date(now.getTime() - 211_000).toISOString()
    };
    await timedOut.service.runClaimedJob(timeoutJob);
    expect(timedOut.googleMapsClient.getJob).not.toHaveBeenCalled();
    expect(timedOut.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", errorMessage: "LEAD_GOOGLE_TIMEOUT"
    }));

    const failed = setup();
    failed.googleMapsClient.getJob.mockResolvedValue({ id: "remote-job-1", status: "failed" } as any);
    await failed.service.runClaimedJob(rawJob("google_maps_search", {
      requestFingerprint: "b".repeat(64), niche: "x", city: "Campinas", state: "SP",
      latitude: -22.9, longitude: -47.06, maxTimeSeconds: 180
    }));
    expect(failed.repository.finishJob).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", errorMessage: "LEAD_GOOGLE_REMOTE_FAILED"
    }));
  });

  it("reports missing scraper configuration only for Google job creation", async () => {
    const context = setup();
    const service = createLeadsService({
      repository: context.repository as never,
      cnpjRepository: context.cnpjRepository as never,
      cityGeocoder: context.cityGeocoder as never,
      now: () => now
    });
    await expect(service.createGoogleSearchJob({
      workspaceId, name: "Google", niche: "padarias", city: "Campinas", state: "SP",
      idempotencyKey: "missing-google"
    })).rejects.toMatchObject({ code: "LEAD_SOURCE_UNAVAILABLE" });

    context.cnpjRepository.searchEstablishments.mockResolvedValue({ items: [], total: 0 });
    await expect(service.runClaimedJob(rawJob("receita_search", { filters: {}, maxResults: 10 }))).resolves.toBeDefined();
  });

  it("exposes a workspace-scoped manual Google retry and publishes the atomic transition", async () => {
    const context = setup();
    context.repository.retryGoogleJob.mockResolvedValue({
      list: listDto({ source: "google_maps", completedAt: null }),
      job: jobDto("queued", { operation: "google_maps_search", retryable: false })
    });

    await expect(context.service.retryGoogleJob({ workspaceId, jobId })).resolves.toMatchObject({
      job: { id: jobId, status: "queued" }
    });
    expect(context.repository.retryGoogleJob).toHaveBeenCalledWith(workspaceId, jobId, now);
    expect(context.realtime.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "lead_job.updated", workspaceId, payload: expect.objectContaining({ status: "queued" })
    }));
  });
});
