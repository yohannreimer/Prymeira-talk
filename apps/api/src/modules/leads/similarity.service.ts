import { createHash } from "node:crypto";
import type {
  LeadJobDto,
  LeadListDto,
  SimilarCompanyReasonKey,
  SimilarCompanyResult,
  SimilarCompanyScoreComponent,
  SimilarCompanyScoreExplanation,
  SimilarCompanyScoreReason,
  SimilarCompanySearchResult
} from "@prymeira-talk/shared";
import type { Lead } from "@prisma/client";
import { CnpjRepository, type CnpjCompanyRecord } from "./cnpj.repository.js";
import {
  LeadsDomainError,
  type ClaimedLeadJob,
  type LeadUpsertInput,
  type LeadsRepositoryLike
} from "./leads.repository.js";
import { normalizeCnpj } from "./leads.types.js";

export const SIMILARITY_SCORING_VERSION = "cnpj-similarity-v1" as const;
const MAX_CANDIDATES = 100;
const MAX_CANDIDATE_POOL = 1_000;
const LEASE_MS = 300_000;
const INVALID_SEED_MESSAGE = "Escolha um lead da Receita Federal com CNPJ ou informe um CNPJ válido.";

const COMPONENT_WEIGHTS = {
  activity: 35,
  location: 25,
  profile: 20,
  commercial_readiness: 20
} as const;

const REASON_LABELS: Record<SimilarCompanyReasonKey, string> = {
  activity_primary_cnae_exact: "Mesmo CNAE principal",
  activity_reciprocal_primary_secondary: "CNAE principal e secundário compatíveis",
  activity_cnae_group: "Mesmo grupo ou divisão CNAE",
  location_same_city: "Mesmo município",
  location_same_state: "Mesma UF",
  location_distance_25km: "Distância de até 25 km",
  location_distance_100km: "Distância de até 100 km",
  location_distance_250km: "Distância de até 250 km",
  profile_same_size: "Mesmo porte empresarial",
  profile_same_legal_nature: "Mesma natureza jurídica",
  profile_same_simples: "Mesmo enquadramento no Simples",
  profile_comparable_capital: "Faixa de capital comparável",
  profile_comparable_age: "Faixa de idade empresarial comparável",
  commercial_active: "Situação cadastral ativa",
  commercial_usable_address: "Endereço comercial utilizável",
  commercial_phone: "Telefone disponível",
  commercial_email: "E-mail disponível"
};

export interface SimilaritySeedInput {
  workspaceId: string;
  seedCnpj?: string;
  listId?: string;
  leadId?: string;
}

export interface FindSimilarCompaniesInput extends SimilaritySeedInput {
  limit?: number;
}

export interface CreateSimilarListJobInput extends SimilaritySeedInput {
  name: string;
  selectedCnpjs: readonly string[];
  idempotencyKey: string;
}

interface SimilarityServiceOptions {
  repository: LeadsRepositoryLike;
  cnpjRepository?: CnpjRepository;
  now?: () => Date;
  onListUpdated?: (list: LeadListDto) => void;
  onJobUpdated?: (job: LeadJobDto) => void;
}

function reason(key: SimilarCompanyReasonKey, points: number): SimilarCompanyScoreReason {
  return { key, label: REASON_LABELS[key], points };
}

function component(
  key: SimilarCompanyScoreComponent["key"],
  reasons: SimilarCompanyScoreReason[]
): SimilarCompanyScoreComponent {
  const weight = COMPONENT_WEIGHTS[key];
  const score = Math.min(weight, reasons.reduce((total, entry) => total + entry.points, 0));
  return { key, weight, score, reasons };
}

function normalizedText(value: string | null | undefined) {
  const normalized = value?.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
  return normalized || null;
}

function normalizedCode(value: string | null | undefined) {
  const normalized = value?.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return normalized || null;
}

function normalizedCodes(values: readonly string[]) {
  return values.map(normalizedCode).filter((value): value is string => Boolean(value));
}

function validCoordinatePair(record: CnpjCompanyRecord) {
  return typeof record.latitude === "number" && Number.isFinite(record.latitude) &&
    record.latitude >= -90 && record.latitude <= 90 &&
    typeof record.longitude === "number" && Number.isFinite(record.longitude) &&
    record.longitude >= -180 && record.longitude <= 180;
}

function distanceKm(left: CnpjCompanyRecord, right: CnpjCompanyRecord) {
  if (!validCoordinatePair(left) || !validCoordinatePair(right)) return null;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(right.latitude! - left.latitude!);
  const longitudeDelta = radians(right.longitude! - left.longitude!);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left.latitude!)) * Math.cos(radians(right.latitude!)) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function capitalBand(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  if (value === 0) return 0;
  if (value <= 10_000) return 1;
  if (value <= 100_000) return 2;
  if (value <= 1_000_000) return 3;
  if (value <= 10_000_000) return 4;
  return 5;
}

function comparableCapital(left: number | null, right: number | null) {
  const leftBand = capitalBand(left);
  const rightBand = capitalBand(right);
  if (leftBand === null || rightBand === null) return false;
  if (leftBand === rightBand) return true;
  if (left === null || right === null || left <= 0 || right <= 0) return false;
  return Math.max(left, right) / Math.min(left, right) <= 2;
}

function companyAge(openedAt: string | null, now: Date) {
  if (!openedAt) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(openedAt);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const opened = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(opened.getTime()) || opened.getUTCFullYear() !== year ||
      opened.getUTCMonth() !== month - 1 || opened.getUTCDate() !== day || opened > now) return null;
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() < month - 1 || (now.getUTCMonth() === month - 1 && now.getUTCDate() < day)) age -= 1;
  return age;
}

function ageBand(openedAt: string | null, now: Date) {
  const age = companyAge(openedAt, now);
  if (age === null) return null;
  if (age < 2) return 0;
  if (age <= 5) return 1;
  if (age <= 10) return 2;
  if (age <= 20) return 3;
  return 4;
}

function hasUsableAddress(record: CnpjCompanyRecord) {
  return Boolean(record.address?.trim() && record.city?.trim() && record.state?.trim());
}

export function scoreSimilarCompany(
  seed: CnpjCompanyRecord,
  candidate: CnpjCompanyRecord,
  now: Date
): SimilarCompanyScoreExplanation {
  const activityReasons: SimilarCompanyScoreReason[] = [];
  const seedPrimary = normalizedCode(seed.cnaePrimary);
  const candidatePrimary = normalizedCode(candidate.cnaePrimary);
  const seedSecondary = normalizedCodes(seed.cnaeSecondary);
  const candidateSecondary = normalizedCodes(candidate.cnaeSecondary);
  if (seedPrimary && candidatePrimary && seedPrimary === candidatePrimary) {
    activityReasons.push(reason("activity_primary_cnae_exact", 20));
  }
  if ((seedPrimary && candidateSecondary.includes(seedPrimary)) ||
      (candidatePrimary && seedSecondary.includes(candidatePrimary)) ||
      seedSecondary.some((code) => candidateSecondary.includes(code))) {
    activityReasons.push(reason("activity_reciprocal_primary_secondary", 10));
  }
  const seedCnaes = [seedPrimary, ...seedSecondary].filter((value): value is string => Boolean(value));
  const candidateCnaes = [candidatePrimary, ...candidateSecondary].filter((value): value is string => Boolean(value));
  if (seedCnaes.some((left) => candidateCnaes.some((right) =>
    left.length >= 3 && right.length >= 3 && left.slice(0, 3) === right.slice(0, 3)))) {
    activityReasons.push(reason("activity_cnae_group", 5));
  }

  const locationReasons: SimilarCompanyScoreReason[] = [];
  const seedState = normalizedText(seed.state);
  const candidateState = normalizedText(candidate.state);
  const seedCity = normalizedText(seed.city);
  const candidateCity = normalizedText(candidate.city);
  if (seedCity && candidateCity && seedState && candidateState &&
      seedCity === candidateCity && seedState === candidateState) {
    locationReasons.push(reason("location_same_city", 15));
  }
  if (seedState && candidateState && seedState === candidateState) {
    locationReasons.push(reason("location_same_state", 5));
  }
  const distance = distanceKm(seed, candidate);
  if (distance !== null && distance <= 25) locationReasons.push(reason("location_distance_25km", 5));
  else if (distance !== null && distance <= 100) locationReasons.push(reason("location_distance_100km", 3));
  else if (distance !== null && distance <= 250) locationReasons.push(reason("location_distance_250km", 1));

  const profileReasons: SimilarCompanyScoreReason[] = [];
  if (normalizedCode(seed.porte) && normalizedCode(seed.porte) === normalizedCode(candidate.porte)) {
    profileReasons.push(reason("profile_same_size", 5));
  }
  if (normalizedCode(seed.legalNature) && normalizedCode(seed.legalNature) === normalizedCode(candidate.legalNature)) {
    profileReasons.push(reason("profile_same_legal_nature", 4));
  }
  if (seed.simples !== null && candidate.simples !== null && seed.simples === candidate.simples) {
    profileReasons.push(reason("profile_same_simples", 3));
  }
  if (comparableCapital(seed.capitalSocial, candidate.capitalSocial)) {
    profileReasons.push(reason("profile_comparable_capital", 4));
  }
  const seedAgeBand = ageBand(seed.openedAt, now);
  if (seedAgeBand !== null && seedAgeBand === ageBand(candidate.openedAt, now)) {
    profileReasons.push(reason("profile_comparable_age", 4));
  }

  const commercialReasons: SimilarCompanyScoreReason[] = [];
  if (candidate.status?.trim() === "02") commercialReasons.push(reason("commercial_active", 5));
  if (hasUsableAddress(candidate)) commercialReasons.push(reason("commercial_usable_address", 5));
  if (candidate.phone1?.trim() || candidate.phone2?.trim()) commercialReasons.push(reason("commercial_phone", 5));
  if (candidate.email?.trim()) commercialReasons.push(reason("commercial_email", 5));

  const components = [
    component("activity", activityReasons),
    component("location", locationReasons),
    component("profile", profileReasons),
    component("commercial_readiness", commercialReasons)
  ];
  const reasons = components.flatMap((entry) => entry.reasons);
  const score = Math.min(100, Math.max(0, components.reduce((total, entry) => total + entry.score, 0)));
  return { score, components, reasons };
}

function displayName(record: Pick<CnpjCompanyRecord, "tradeName" | "companyName">) {
  return normalizedText(record.tradeName) ?? normalizedText(record.companyName) ?? "";
}

function compareResults(left: SimilarCompanyResult, right: SimilarCompanyResult) {
  if (left.score !== right.score) return right.score - left.score;
  const nameOrder = displayName(left).localeCompare(
    displayName(right),
    "pt-BR"
  );
  return nameOrder || left.cnpj.localeCompare(right.cnpj);
}

function toResult(record: CnpjCompanyRecord, explanation: SimilarCompanyScoreExplanation): SimilarCompanyResult {
  return {
    cnpj: record.cnpj,
    companyName: record.companyName,
    tradeName: record.tradeName,
    cnaePrimary: record.cnaePrimary,
    cnaeSecondary: record.cnaeSecondary,
    address: record.address,
    city: record.city,
    state: record.state,
    postalCode: record.postalCode,
    phone: record.phone1?.trim() || record.phone2?.trim() || null,
    email: record.email?.trim() || null,
    ...explanation
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function leadToCompany(lead: Lead): CnpjCompanyRecord {
  const snapshot = jsonRecord(lead.sourceSnapshot);
  const phones = jsonStrings(lead.phones);
  const cnpj = normalizeCnpj(lead.cnpj!);
  return {
    cnpj,
    cnpjBasico: cnpj.slice(0, 8),
    companyName: lead.companyName,
    tradeName: lead.tradeName,
    legalNature: nullableText(snapshot.legalNature),
    legalNatureDescription: nullableText(snapshot.legalNatureDescription),
    porte: nullableText(snapshot.porte),
    capitalSocial: nullableNumber(snapshot.capitalSocial),
    establishmentType: nullableNumber(snapshot.establishmentType),
    status: nullableText(snapshot.status),
    openedAt: nullableText(snapshot.openedAt),
    cnaePrimary: lead.cnaePrimary,
    cnaePrimaryDescription: lead.category,
    cnaeSecondary: jsonStrings(lead.cnaeSecondary),
    address: lead.address,
    neighborhood: nullableText(snapshot.neighborhood),
    postalCode: lead.postalCode,
    city: lead.city,
    state: lead.state,
    phone1: phones[0] ?? null,
    phone2: phones[1] ?? null,
    email: lead.email,
    simples: nullableBoolean(snapshot.simples),
    mei: nullableBoolean(snapshot.mei),
    latitude: lead.latitude,
    longitude: lead.longitude
  };
}

function toLeadInput(record: CnpjCompanyRecord, workspaceId: string, listId: string): LeadUpsertInput {
  const phones = [record.phone1, record.phone2].filter((phone): phone is string => Boolean(phone?.trim()));
  return {
    workspaceId,
    listId,
    source: "receita_federal",
    sourceDedupeKey: record.cnpj,
    sourceExternalId: record.cnpj,
    companyName: record.companyName,
    tradeName: record.tradeName,
    cnpj: record.cnpj,
    cnaePrimary: record.cnaePrimary,
    cnaeSecondary: record.cnaeSecondary,
    category: record.cnaePrimaryDescription,
    address: record.address,
    city: record.city,
    state: record.state,
    postalCode: record.postalCode,
    phones,
    normalizedPhone: phones[0]?.replace(/\D/g, "") || null,
    email: record.email?.trim() || null,
    latitude: record.latitude,
    longitude: record.longitude,
    sourceSnapshot: {
      legalNature: record.legalNature,
      legalNatureDescription: record.legalNatureDescription,
      porte: record.porte,
      capitalSocial: record.capitalSocial,
      establishmentType: record.establishmentType,
      status: record.status,
      openedAt: record.openedAt,
      neighborhood: record.neighborhood,
      simples: record.simples,
      mei: record.mei,
      similarity: { scoringVersion: SIMILARITY_SCORING_VERSION }
    }
  };
}

function requiredText(value: string, field: string, max = 200) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new LeadsDomainError("LEAD_INVALID_INPUT", `${field} is invalid.`);
  }
  return normalized;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function persistedFingerprint(value: unknown) {
  const stored = jsonRecord(value).requestFingerprint;
  return typeof stored === "string" ? stored : null;
}

function normalizeSelection(values: readonly string[]) {
  if (values.length < 1 || values.length > MAX_CANDIDATES) {
    throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", `Selecione entre 1 e ${MAX_CANDIDATES} empresas parecidas.`);
  }
  let normalized: string[];
  try {
    normalized = values.map(normalizeCnpj);
  } catch {
    throw new LeadsDomainError("LEAD_INVALID_INPUT", "A seleção contém um CNPJ inválido.");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new LeadsDomainError("LEAD_INVALID_INPUT", "A seleção não pode conter CNPJs repetidos.");
  }
  return normalized.sort();
}

function boundedLimit(value: number | undefined) {
  const limit = value ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANDIDATES) {
    throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", `A busca de semelhantes é limitada a ${MAX_CANDIDATES} resultados.`);
  }
  return limit;
}

export function createSimilarityService(options: SimilarityServiceOptions) {
  const repository = options.repository;
  const cnpjRepository = options.cnpjRepository ?? new CnpjRepository();
  const now = options.now ?? (() => new Date());

  async function resolveSeed(input: SimilaritySeedInput) {
    const usesLead = Boolean(input.listId || input.leadId);
    if (usesLead) {
      if (!input.listId || !input.leadId || input.seedCnpj) {
        throw new LeadsDomainError("LEAD_INVALID_INPUT", "Informe um lead ou um CNPJ como semente, não ambos.");
      }
      const lead = await repository.getLeadForSimilarity(input.workspaceId, input.listId, input.leadId);
      if (lead.source !== "receita_federal" || !lead.cnpj) {
        throw new LeadsDomainError("LEAD_SIMILARITY_SEED_INVALID", INVALID_SEED_MESSAGE);
      }
      try {
        return leadToCompany(lead);
      } catch {
        throw new LeadsDomainError("LEAD_SIMILARITY_SEED_INVALID", INVALID_SEED_MESSAGE);
      }
    }
    if (!input.seedCnpj) {
      throw new LeadsDomainError("LEAD_SIMILARITY_SEED_INVALID", INVALID_SEED_MESSAGE);
    }
    let cnpj: string;
    try {
      cnpj = normalizeCnpj(input.seedCnpj);
    } catch {
      throw new LeadsDomainError("LEAD_SIMILARITY_SEED_INVALID", INVALID_SEED_MESSAGE);
    }
    const seed = await cnpjRepository.findByCnpj(cnpj);
    if (!seed) throw new LeadsDomainError("LEAD_NOT_FOUND", "CNPJ semente não encontrado na Receita Federal.");
    return seed;
  }

  async function findSimilarCompanies(input: FindSimilarCompaniesInput): Promise<SimilarCompanySearchResult> {
    requiredText(input.workspaceId, "workspaceId");
    const limit = boundedLimit(input.limit);
    const seed = await resolveSeed(input);
    const candidates = await cnpjRepository.findSimilarCandidates({
      seedCnpj: seed.cnpj,
      cnaePrimary: seed.cnaePrimary ?? undefined,
      cnaeSecondary: seed.cnaeSecondary,
      city: seed.city ?? undefined,
      state: seed.state ?? undefined,
      porte: seed.porte ?? undefined,
      legalNature: seed.legalNature ?? undefined,
      limit: MAX_CANDIDATE_POOL
    });
    const scoringNow = now();
    const items = candidates
      .filter((candidate) => candidate.cnpj !== seed.cnpj && candidate.cnpjBasico !== seed.cnpjBasico)
      .map((candidate) => toResult(candidate, scoreSimilarCompany(seed, candidate, scoringNow)))
      .sort(compareResults)
      .slice(0, limit);
    return {
      scoringVersion: SIMILARITY_SCORING_VERSION,
      seed: { cnpj: seed.cnpj, companyName: seed.companyName, tradeName: seed.tradeName },
      items
    };
  }

  async function createSimilarListJob(input: CreateSimilarListJobInput) {
    const workspaceId = requiredText(input.workspaceId, "workspaceId");
    const name = requiredText(input.name, "name", 160);
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const selected = normalizeSelection(input.selectedCnpjs);
    let normalizedSeedCnpj: string | null = null;
    if (input.seedCnpj) {
      try {
        normalizedSeedCnpj = normalizeCnpj(input.seedCnpj);
      } catch {
        throw new LeadsDomainError("LEAD_SIMILARITY_SEED_INVALID", INVALID_SEED_MESSAGE);
      }
    }
    const requestFingerprint = fingerprint({
      name,
      seedCnpj: normalizedSeedCnpj,
      listId: input.listId ?? null,
      leadId: input.leadId ?? null,
      selected
    });
    const replay = await repository.findJobByIdempotency(workspaceId, "similar_company_save", idempotencyKey);
    if (replay) {
      if (persistedFingerprint(replay.persistedInput) !== requestFingerprint) {
        throw new LeadsDomainError(
          "LEAD_IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used for a different lead request."
        );
      }
      return replay;
    }

    const ranked = await findSimilarCompanies({ ...input, workspaceId, limit: MAX_CANDIDATES });
    const selectedSet = new Set(selected);
    const rankedSelection = ranked.items.filter((candidate) => selectedSet.has(candidate.cnpj));
    if (rankedSelection.length !== selected.length) {
      throw new LeadsDomainError(
        "LEAD_INVALID_INPUT",
        "Selecione apenas empresas presentes no resultado atual de semelhantes."
      );
    }
    const cnpjs = rankedSelection.map((candidate) => candidate.cnpj);
    const created = await repository.createListAndJob({
      workspaceId,
      name,
      source: "receita_federal",
      criteria: {
        type: "similar_companies",
        seedCnpj: ranked.seed.cnpj,
        scoringVersion: SIMILARITY_SCORING_VERSION
      },
      operation: "similar_company_save",
      input: {
        requestFingerprint,
        seedCnpj: ranked.seed.cnpj,
        cnpjs,
        scoringVersion: SIMILARITY_SCORING_VERSION
      },
      idempotencyKey
    });
    if (!created.replayed) {
      options.onListUpdated?.(created.list);
      options.onJobUpdated?.(created.job);
    }
    return created;
  }

  async function processSimilarListJob(job: ClaimedLeadJob) {
    const input = jsonRecord(job.input);
    const rawCnpjs = input.cnpjs;
    if (input.scoringVersion !== SIMILARITY_SCORING_VERSION || !Array.isArray(rawCnpjs) ||
        rawCnpjs.some((value) => typeof value !== "string")) {
      return finish(job, [], 1, "LEAD_INVALID_INPUT");
    }
    let cnpjs: string[];
    try {
      cnpjs = normalizeSelection(rawCnpjs as string[]);
    } catch (error) {
      if (!(error instanceof LeadsDomainError)) throw error;
      return finish(job, [], 1, error.code);
    }

    const started = await repository.fencedUpdateListProgress(job, {
      workspaceId: job.workspaceId,
      listId: job.listId,
      totalCount: cnpjs.length,
      processedCount: 0,
      failedCount: 0,
      startedAt: now(),
      completedAt: null
    }, now(), LEASE_MS);
    options.onListUpdated?.(started);

    const records = await cnpjRepository.findByCnpjs(cnpjs);
    const byCnpj = new Map(records.filter((record) => record.status?.trim() === "02").map((record) => [record.cnpj, record]));
    const selected = cnpjs.map((cnpj) => byCnpj.get(cnpj)).filter((record): record is CnpjCompanyRecord => Boolean(record));
    if (selected.length > 0) {
      await repository.fencedUpsertLeads(
        job,
        selected.map((record) => toLeadInput(record, job.workspaceId, job.listId)),
        now(),
        LEASE_MS
      );
    }
    return finish(
      job,
      selected,
      cnpjs.length - selected.length,
      selected.length === cnpjs.length ? null : "LEAD_SIMILARITY_CANDIDATE_NOT_FOUND"
    );
  }

  async function finish(
    job: ClaimedLeadJob,
    records: CnpjCompanyRecord[],
    failedCount: number,
    errorMessage: string | null
  ) {
    const processedCount = records.length;
    const totalCount = Math.max(processedCount + failedCount, 1);
    const status = processedCount === 0 ? "failed" : failedCount > 0 ? "partial" : "completed";
    const updated = await repository.fencedFinishJob({
      job,
      now: now(),
      status,
      output: { totalCount, processedCount, failedCount },
      errorMessage,
      progress: {
        workspaceId: job.workspaceId,
        listId: job.listId,
        totalCount,
        processedCount,
        failedCount,
        completedAt: now()
      }
    });
    options.onListUpdated?.(updated.list);
    options.onJobUpdated?.(updated.job);
    return updated.job;
  }

  return { findSimilarCompanies, createSimilarListJob, processSimilarListJob };
}

export type SimilarityService = ReturnType<typeof createSimilarityService>;
