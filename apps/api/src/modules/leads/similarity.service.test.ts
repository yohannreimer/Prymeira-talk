import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CnpjCompanyRecord } from "./cnpj.repository.js";
import { LeadsDomainError, type ClaimedLeadJob } from "./leads.repository.js";
import {
  SIMILARITY_SCORING_VERSION,
  createSimilarityService,
  scoreSimilarCompany
} from "./similarity.service.js";

const workspaceId = "workspace_a";
const foreignWorkspaceId = "workspace_b";
const listId = randomUUID();
const leadId = randomUUID();
const jobId = randomUUID();
const fixedNow = new Date("2026-09-22T12:00:00.000Z");

function company(cnpj: string, overrides: Partial<CnpjCompanyRecord> = {}): CnpjCompanyRecord {
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
    status: null,
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
    longitude: null,
    ...overrides
  };
}

const seed = company("12345678ABCD90", {
  companyName: "Semente",
  legalNature: "2062",
  porte: "03",
  capitalSocial: 100_000,
  status: "02",
  openedAt: "2020-09-22",
  cnaePrimary: "6201500",
  cnaeSecondary: ["6202300"],
  address: "Rua Um, 10",
  city: "São Paulo",
  state: "SP",
  phone1: "11999999999",
  email: "contato@example.com",
  simples: true,
  latitude: -23.5505,
  longitude: -46.6333
});

function setup() {
  const repository = {
    getLeadForSimilarity: vi.fn(),
    findJobByIdempotency: vi.fn(async (): Promise<any> => null),
    createListAndJob: vi.fn(async (input: any) => ({
      list: {
        id: listId, workspaceId: input.workspaceId, name: input.name, source: input.source,
        criteria: input.criteria, totalCount: 0, processedCount: 0, failedCount: 0,
        startedAt: null, completedAt: null, createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString()
      },
      job: {
        id: jobId, workspaceId: input.workspaceId, listId, operation: input.operation, status: "queued",
        attempts: 0, leaseUntil: null, startedAt: null, finishedAt: null, errorMessage: null,
        createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString()
      },
      persistedInput: input.input,
      persistedOutput: input.output ?? {},
      replayed: false
    })),
    fencedUpdateListProgress: vi.fn(async (_job: unknown, progress: any) => ({
      id: listId, workspaceId, name: "Parecidas", source: "receita_federal", criteria: {},
      totalCount: progress.totalCount, processedCount: progress.processedCount, failedCount: progress.failedCount,
      startedAt: fixedNow.toISOString(), completedAt: progress.completedAt?.toISOString() ?? null,
      createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString()
    })),
    fencedUpsertLeads: vi.fn(async (_job: unknown, leads: unknown[]) => leads),
    fencedFinishJob: vi.fn(async (input: any) => ({
      list: {
        id: listId, workspaceId, name: "Parecidas", source: "receita_federal", criteria: {},
        totalCount: input.progress.totalCount, processedCount: input.progress.processedCount,
        failedCount: input.progress.failedCount, startedAt: fixedNow.toISOString(),
        completedAt: fixedNow.toISOString(), createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString()
      },
      job: {
        id: jobId, workspaceId, listId, operation: "similar_company_save", status: input.status,
        attempts: 1, leaseUntil: null, startedAt: fixedNow.toISOString(), finishedAt: fixedNow.toISOString(),
        errorMessage: input.errorMessage, createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString()
      }
    }))
  };
  const cnpjRepository = {
    findByCnpj: vi.fn(async () => seed),
    findByCnpjs: vi.fn(),
    findSimilarCandidates: vi.fn(async () => [] as CnpjCompanyRecord[])
  };
  const events = { lists: [] as unknown[], jobs: [] as unknown[] };
  const service = createSimilarityService({
    repository: repository as never,
    cnpjRepository: cnpjRepository as never,
    now: () => fixedNow,
    onListUpdated: (list) => events.lists.push(list),
    onJobUpdated: (job) => events.jobs.push(job)
  });
  return { service, repository, cnpjRepository, events };
}

function claimedSimilarityJob(cnpjs: string[]): ClaimedLeadJob {
  return {
    id: jobId,
    workspaceId,
    listId,
    operation: "similar_company_save",
    status: "running",
    input: { seedCnpj: seed.cnpj, cnpjs, scoringVersion: SIMILARITY_SCORING_VERSION } as never,
    output: {},
    errorMessage: null,
    attempts: 1,
    leaseToken: randomUUID(),
    leaseUntil: new Date(fixedNow.getTime() + 300_000),
    startedAt: fixedNow,
    finishedAt: null,
    idempotencyKey: "idem",
    createdAt: fixedNow,
    updatedAt: fixedNow
  };
}

describe("similar-company deterministic scoring", () => {
  it("awards every rule, caps components at 35/25/20/20, and explains every point in Portuguese", () => {
    const candidate = company("87654321WXYZ10", {
      ...seed,
      cnpj: "87654321WXYZ10",
      cnpjBasico: "87654321",
      cnaeSecondary: [seed.cnaePrimary!, "6202300"],
      latitude: -23.551,
      longitude: -46.633
    });

    const score = scoreSimilarCompany(seed, candidate, fixedNow);

    expect(score.score).toBe(100);
    expect(score.components.map(({ key, score }) => [key, score])).toEqual([
      ["activity", 35], ["location", 25], ["profile", 20], ["commercial_readiness", 20]
    ]);
    expect(score.reasons).toHaveLength(15);
    expect(score.reasons.every((reason) => reason.label.length > 3 && reason.points > 0)).toBe(true);
    expect(score.reasons.map((reason) => reason.key)).toEqual(expect.arrayContaining([
      "activity_primary_cnae_exact",
      "activity_reciprocal_primary_secondary",
      "activity_cnae_group",
      "location_same_city",
      "location_same_state",
      "location_distance_25km",
      "profile_comparable_age",
      "commercial_email"
    ]));
  });

  it("scores missing evidence as zero without rescaling other evidence", () => {
    const score = scoreSimilarCompany(
      company("12345678ABCD90"),
      company("87654321WXYZ10", { status: "02" }),
      fixedNow
    );

    expect(score.score).toBe(5);
    expect(score.components.map((component) => component.score)).toEqual([0, 0, 0, 5]);
    expect(score.reasons.map((reason) => reason.key)).toEqual(["commercial_active"]);
  });

  it.each([
    [-23.7755, -46.6333, 25, "location_distance_100km", 3],
    [-25.0, -46.6333, 250, "location_distance_250km", 1],
    [-27.0, -46.6333, 0, undefined, 0]
  ])("uses actual coordinate evidence at the distance thresholds", (latitude, longitude, _boundary, key, points) => {
    const score = scoreSimilarCompany(
      seed,
      company("87654321WXYZ10", { latitude, longitude }),
      fixedNow
    );
    const distanceReason = score.components[1]?.reasons.find((reason) => reason.key.startsWith("location_distance"));
    expect(distanceReason?.key).toBe(key);
    expect(distanceReason?.points ?? 0).toBe(points);
  });

  it("uses the injected clock for repeatable company-age bands", () => {
    const candidate = company("87654321WXYZ10", { openedAt: "2020-09-23" });
    const beforeBirthday = scoreSimilarCompany(
      company(seed.cnpj, { openedAt: "2020-09-22" }),
      candidate,
      new Date("2026-09-22T00:00:00.000Z")
    );
    const afterBirthday = scoreSimilarCompany(
      company(seed.cnpj, { openedAt: "2020-09-22" }),
      candidate,
      new Date("2026-09-23T00:00:00.000Z")
    );

    expect(beforeBirthday.components[2]?.reasons.some((reason) => reason.key === "profile_comparable_age")).toBe(false);
    expect(afterBirthday.components[2]?.reasons.some((reason) => reason.key === "profile_comparable_age")).toBe(true);
  });
});

describe("similar-company service", () => {
  it("resolves an exact normalized CNPJ, narrows candidates, and applies deterministic name/CNPJ tie-breaking", async () => {
    const context = setup();
    const candidates = [
      company("87654321WXYZ12", { companyName: "Zulu", cnaePrimary: seed.cnaePrimary, state: "SP" }),
      company("87654321WXYZ11", { companyName: "Ábaco", cnaePrimary: seed.cnaePrimary, state: "SP" }),
      company("87654321WXYZ10", { companyName: "Abaco", cnaePrimary: seed.cnaePrimary, state: "SP" })
    ];
    context.cnpjRepository.findSimilarCandidates.mockResolvedValue(candidates);

    const result = await context.service.findSimilarCompanies({
      workspaceId,
      seedCnpj: "12.345.678/abcd-90",
      limit: 3
    });

    expect(context.cnpjRepository.findByCnpj).toHaveBeenCalledWith("12345678ABCD90");
    expect(context.cnpjRepository.findSimilarCandidates).toHaveBeenCalledWith({
      seedCnpj: seed.cnpj,
      cnaePrimary: seed.cnaePrimary,
      state: seed.state,
      limit: 100
    });
    expect(result.items.map((item) => item.cnpj)).toEqual([
      "87654321WXYZ10", "87654321WXYZ11", "87654321WXYZ12"
    ]);
  });

  it("rejects Google-only and no-CNPJ lead seeds with one stable actionable error", async () => {
    const context = setup();
    context.repository.getLeadForSimilarity.mockResolvedValueOnce({
      id: leadId, workspaceId, listId, source: "google_maps", cnpj: null
    });

    await expect(context.service.findSimilarCompanies({ workspaceId, listId, leadId }))
      .rejects.toMatchObject({
        code: "LEAD_SIMILARITY_SEED_INVALID",
        message: "Escolha um lead da Receita Federal com CNPJ ou informe um CNPJ válido."
      });
    expect(context.cnpjRepository.findSimilarCandidates).not.toHaveBeenCalled();
  });

  it("uses an owned Receita lead snapshot as the seed without an external exact lookup", async () => {
    const context = setup();
    context.repository.getLeadForSimilarity.mockResolvedValue({
      id: leadId,
      workspaceId,
      listId,
      source: "receita_federal",
      sourceExternalId: seed.cnpj,
      sourceDedupeKey: seed.cnpj,
      companyName: seed.companyName,
      tradeName: seed.tradeName,
      cnpj: seed.cnpj,
      cnaePrimary: seed.cnaePrimary,
      cnaeSecondary: seed.cnaeSecondary,
      category: null,
      address: seed.address,
      city: seed.city,
      state: seed.state,
      postalCode: seed.postalCode,
      phones: [seed.phone1],
      normalizedPhone: seed.phone1,
      email: seed.email,
      website: null,
      rating: null,
      reviewCount: null,
      latitude: seed.latitude,
      longitude: seed.longitude,
      sourceUrl: null,
      sourceSnapshot: {
        legalNature: seed.legalNature,
        porte: seed.porte,
        capitalSocial: seed.capitalSocial,
        status: seed.status,
        openedAt: seed.openedAt,
        simples: seed.simples
      },
      createdAt: fixedNow,
      updatedAt: fixedNow
    });

    await context.service.findSimilarCompanies({ workspaceId, listId, leadId });

    expect(context.repository.getLeadForSimilarity).toHaveBeenCalledWith(workspaceId, listId, leadId);
    expect(context.cnpjRepository.findByCnpj).not.toHaveBeenCalled();
    expect(context.cnpjRepository.findSimilarCandidates).toHaveBeenCalledWith(expect.objectContaining({
      seedCnpj: seed.cnpj,
      cnaePrimary: seed.cnaePrimary,
      state: seed.state
    }));
  });

  it("keeps a foreign workspace lead indistinguishable from a missing seed", async () => {
    const context = setup();
    context.repository.getLeadForSimilarity.mockRejectedValue(
      new LeadsDomainError("LEAD_NOT_FOUND", "Lead not found.")
    );

    await expect(context.service.findSimilarCompanies({
      workspaceId: foreignWorkspaceId,
      listId,
      leadId
    })).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    expect(context.repository.getLeadForSimilarity).toHaveBeenCalledWith(foreignWorkspaceId, listId, leadId);
    expect(context.cnpjRepository.findByCnpj).not.toHaveBeenCalled();
  });

  it("saves only selected ranked candidates, revalidates them, and is idempotent per workspace", async () => {
    const context = setup();
    const selected = company("87654321WXYZ10", { cnaePrimary: seed.cnaePrimary, state: seed.state, status: "02" });
    const unselected = company("99999999AAAA10", { cnaePrimary: seed.cnaePrimary, state: seed.state });
    context.cnpjRepository.findSimilarCandidates.mockResolvedValue([selected, unselected]);

    const first = await context.service.createSimilarListJob({
      workspaceId,
      name: "Parecidas",
      seedCnpj: seed.cnpj,
      selectedCnpjs: [selected.cnpj],
      idempotencyKey: "save-1"
    });
    const created = context.repository.createListAndJob.mock.calls[0]?.[0] as any;
    context.repository.findJobByIdempotency.mockResolvedValue({
      ...first,
      persistedInput: created.input,
      persistedOutput: {},
      replayed: true
    });
    const replay = await context.service.createSimilarListJob({
      workspaceId,
      name: "Parecidas",
      seedCnpj: seed.cnpj,
      selectedCnpjs: [selected.cnpj],
      idempotencyKey: "save-1"
    });

    expect(created.criteria).toEqual({
      type: "similar_companies",
      seedCnpj: seed.cnpj,
      scoringVersion: SIMILARITY_SCORING_VERSION
    });
    expect(created.workspaceId).toBe(workspaceId);
    expect(created.input.cnpjs).toEqual([selected.cnpj]);
    expect(replay.job.id).toBe(first.job.id);
    expect(context.repository.createListAndJob).toHaveBeenCalledTimes(1);

    context.cnpjRepository.findByCnpjs.mockResolvedValue([selected]);
    await context.service.processSimilarListJob(claimedSimilarityJob([selected.cnpj]));
    expect(context.cnpjRepository.findByCnpjs).toHaveBeenCalledWith([selected.cnpj]);
    expect(context.repository.fencedUpsertLeads).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, listId }),
      [expect.objectContaining({ sourceDedupeKey: selected.cnpj })],
      fixedNow,
      300_000
    );
    expect(context.repository.fencedUpsertLeads.mock.calls[0]?.[1]).toHaveLength(1);
  });

  it("rejects a selection that is absent from the current ranked result", async () => {
    const context = setup();
    context.cnpjRepository.findSimilarCandidates.mockResolvedValue([
      company("87654321WXYZ10", { cnaePrimary: seed.cnaePrimary, state: seed.state })
    ]);

    await expect(context.service.createSimilarListJob({
      workspaceId,
      name: "Parecidas",
      seedCnpj: seed.cnpj,
      selectedCnpjs: ["99999999AAAA10"],
      idempotencyKey: "invalid-selection"
    })).rejects.toMatchObject({ code: "LEAD_INVALID_INPUT" });
    expect(context.repository.createListAndJob).not.toHaveBeenCalled();
  });
});
