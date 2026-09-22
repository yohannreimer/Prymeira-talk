import { randomUUID } from "node:crypto";
import {
  Prisma,
  type Lead,
  type LeadArtifact,
  type LeadJob,
  type LeadJobStatus,
  type LeadList,
  type LeadSource,
  type LeadWhatsappVerification,
  type PrismaClient
} from "@prisma/client";
import type {
  LeadJobDto,
  LeadListDto,
  LeadPaginatedResultDto,
  LeadResultDto,
  LeadWhatsappVerificationResult
} from "@prymeira-talk/shared";
import { canTransitionLeadJob } from "./leads.types.js";
import { canonicalizePhone } from "../contacts/phone-normalization.js";

type DateLike = Date | string;

export type LeadsErrorCode =
  | "LEAD_NOT_FOUND"
  | "LEAD_SOURCE_UNAVAILABLE"
  | "LEAD_INVALID_TRANSITION"
  | "LEAD_LIMIT_EXCEEDED"
  | "LEAD_INVALID_INPUT"
  | "LEAD_INVALID_ENCODING"
  | "LEAD_CITY_NOT_FOUND"
  | "LEAD_CITY_AMBIGUOUS"
  | "LEAD_GEOCODER_UNAVAILABLE"
  | "LEAD_SIMILARITY_SEED_INVALID"
  | "LEAD_IDEMPOTENCY_CONFLICT"
  | "LEAD_EVOLUTION_NOT_CONNECTED"
  | "LEAD_LEASE_LOST";

export class LeadsDomainError extends Error {
  constructor(public readonly code: LeadsErrorCode, message: string) {
    super(message);
    this.name = "LeadsDomainError";
  }
}

export class LeadLeaseLostError extends LeadsDomainError {
  constructor() {
    super("LEAD_LEASE_LOST", "Lead job lease ownership was lost.");
    this.name = "LeadLeaseLostError";
  }
}

export interface LeadArtifactMetadata {
  id: string;
  workspaceId: string;
  listId: string;
  jobId: string;
  kind: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface LeadArtifactDownload extends LeadArtifactMetadata {
  content: Buffer;
}

export interface LeadUpsertInput {
  workspaceId: string;
  listId: string;
  source: LeadSource;
  sourceDedupeKey: string;
  sourceExternalId?: string | null;
  companyName?: string | null;
  tradeName?: string | null;
  cnpj?: string | null;
  cnaePrimary?: string | null;
  cnaeSecondary?: string[];
  category?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phones?: string[];
  normalizedPhone?: string | null;
  email?: string | null;
  website?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  sourceUrl?: string | null;
  sourceSnapshot?: Prisma.InputJsonValue;
}

export interface CreateLeadJobInput {
  workspaceId: string;
  name: string;
  source: LeadSource;
  criteria: Prisma.InputJsonValue;
  operation: string;
  input: Prisma.InputJsonValue;
  output?: Prisma.InputJsonValue;
  idempotencyKey: string;
  artifact?: {
    kind: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
  };
}

export interface ClaimedLeadJob extends LeadJob {
  leaseToken: string;
}

export type LeadJobFence = Pick<ClaimedLeadJob, "workspaceId" | "id" | "listId" | "leaseToken">;

export interface LeadListProgressInput {
  workspaceId: string;
  listId: string;
  totalCount: number;
  processedCount: number;
  failedCount: number;
  startedAt?: Date;
  completedAt?: Date | null;
}

export interface LeadJobCreationResult {
  list: LeadListDto;
  job: LeadJobDto;
  artifact?: LeadArtifactMetadata;
  persistedInput: Prisma.JsonValue;
  persistedOutput: Prisma.JsonValue;
  replayed: boolean;
}

function toIso(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIso(value: DateLike | null) {
  return value === null ? null : toIso(value);
}

function strings(value: Prisma.JsonValue) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function jobIsRetryable(record: Pick<LeadJob, "status" | "output">) {
  if (record.status !== "failed" && record.status !== "partial") return false;
  return requestJsonRecord(record.output).retryable === true;
}

function requestJsonRecord(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return value && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

export function toLeadListDto(record: LeadList): LeadListDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    source: record.source,
    criteria: record.criteria,
    totalCount: record.totalCount,
    processedCount: record.processedCount,
    failedCount: record.failedCount,
    startedAt: toNullableIso(record.startedAt),
    completedAt: toNullableIso(record.completedAt),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt)
  };
}

export function toLeadJobDto(record: LeadJob): LeadJobDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    listId: record.listId,
    operation: record.operation,
    status: record.status,
    attempts: record.attempts,
    leaseUntil: toNullableIso(record.leaseUntil),
    startedAt: toNullableIso(record.startedAt),
    finishedAt: toNullableIso(record.finishedAt),
    errorMessage: record.errorMessage,
    retryable: jobIsRetryable(record),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt)
  };
}

export function toLeadResultDto(
  record: Lead,
  whatsappVerifications: LeadResultDto["whatsappVerifications"] = []
): LeadResultDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    listId: record.listId,
    source: record.source,
    companyName: record.companyName,
    tradeName: record.tradeName,
    cnpj: record.cnpj,
    cnaePrimary: record.cnaePrimary,
    cnaeSecondary: strings(record.cnaeSecondary),
    category: record.category,
    address: record.address,
    city: record.city,
    state: record.state,
    postalCode: record.postalCode,
    phones: strings(record.phones),
    normalizedPhone: record.normalizedPhone,
    email: record.email,
    website: record.website,
    rating: record.rating,
    reviewCount: record.reviewCount,
    latitude: record.latitude,
    longitude: record.longitude,
    sourceUrl: record.sourceUrl,
    whatsappStatus: whatsappVerifications[0]?.status ?? "unverified",
    whatsappVerifications,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt)
  };
}

function toWhatsappVerificationResult(record: LeadWhatsappVerification): LeadWhatsappVerificationResult {
  return {
    leadId: record.leadId,
    normalizedPhone: record.normalizedPhone,
    status: record.status,
    checkedAt: toNullableIso(record.checkedAt),
    errorMessage: record.errorMessage
  };
}

function inputRecord(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

function verificationIds(value: Prisma.JsonValue) {
  const entries = inputRecord(value).entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const id = inputRecord(entry).verificationId;
    return typeof id === "string" ? [id] : [];
  });
}

function allVerificationIds(value: Prisma.JsonValue) {
  const current = verificationIds(value);
  const history = inputRecord(value).verificationHistoryIds;
  return Array.isArray(history)
    ? [...new Set([...history.filter((id): id is string => typeof id === "string"), ...current])]
    : current;
}

function latestWhatsappVerificationRows(rows: LeadWhatsappVerification[]) {
  const latest = new Map<string, LeadWhatsappVerification>();
  for (const row of rows) latest.set(`${row.leadId}:${row.normalizedPhone}`, row);
  return [...latest.values()];
}

function isWhatsappAvailabilityOperation(operation: string) {
  return operation === "whatsapp_availability" || operation === "whatsapp_availability_batch";
}

function toArtifactMetadata(record: LeadArtifact): LeadArtifactMetadata {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    listId: record.listId,
    jobId: record.jobId,
    kind: record.kind,
    fileName: record.fileName,
    mimeType: record.mimeType,
    size: record.sizeBytes,
    createdAt: toIso(record.createdAt)
  };
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function requestFingerprint(value: Prisma.JsonValue) {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const fingerprint = (value as Record<string, Prisma.JsonValue>).requestFingerprint;
  return typeof fingerprint === "string" ? fingerprint : null;
}

function assertSameFingerprint(existing: LeadJob, requestedInput: Prisma.InputJsonValue) {
  const existingFingerprint = requestFingerprint(existing.input);
  const requestedFingerprint = requestFingerprint(requestedInput as Prisma.JsonValue);
  if (!existingFingerprint || !requestedFingerprint || existingFingerprint !== requestedFingerprint) {
    throw new LeadsDomainError(
      "LEAD_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for a different lead request."
    );
  }
}

function listProgressData(input: LeadListProgressInput): Prisma.LeadListUpdateManyMutationInput {
  return {
    totalCount: input.totalCount,
    processedCount: input.processedCount,
    failedCount: input.failedCount,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {})
  };
}

function prismaBytes(content: Buffer) {
  return Uint8Array.from(content);
}

function leadData(input: LeadUpsertInput): Prisma.LeadUncheckedCreateInput {
  return {
    workspaceId: input.workspaceId,
    listId: input.listId,
    source: input.source,
    sourceDedupeKey: input.sourceDedupeKey,
    sourceExternalId: input.sourceExternalId ?? null,
    companyName: input.companyName ?? null,
    tradeName: input.tradeName ?? null,
    cnpj: input.cnpj ?? null,
    cnaePrimary: input.cnaePrimary ?? null,
    cnaeSecondary: input.cnaeSecondary ?? [],
    category: input.category ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    postalCode: input.postalCode ?? null,
    phones: input.phones ?? [],
    normalizedPhone: input.normalizedPhone ?? null,
    email: input.email ?? null,
    website: input.website ?? null,
    rating: input.rating ?? null,
    reviewCount: input.reviewCount ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    sourceUrl: input.sourceUrl ?? null,
    sourceSnapshot: input.sourceSnapshot ?? {}
  };
}

export class LeadsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private async fence(
    tx: Prisma.TransactionClient,
    job: LeadJobFence,
    now: Date,
    leaseMs: number
  ) {
    const fenced = await tx.leadJob.updateMany({
      where: {
        workspaceId: job.workspaceId,
        id: job.id,
        listId: job.listId,
        status: "running",
        leaseToken: job.leaseToken,
        leaseUntil: { gt: now }
      },
      data: { leaseUntil: new Date(now.getTime() + leaseMs) }
    });
    if (fenced.count !== 1) throw new LeadLeaseLostError();
  }

  async listLists(workspaceId: string, source?: LeadSource, page = 1, pageSize = 50) {
    const rows = await this.prisma.leadList.findMany({
      where: { workspaceId, ...(source ? { source } : {}) },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize
    });
    return rows.map(toLeadListDto);
  }

  async getList(workspaceId: string, listId: string) {
    const row = await this.prisma.leadList.findFirst({ where: { workspaceId, id: listId } });
    if (!row) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead list not found.");
    return toLeadListDto(row);
  }

  async updateList(workspaceId: string, listId: string, data: { name?: string }) {
    const result = await this.prisma.leadList.updateMany({
      where: { workspaceId, id: listId },
      data: data.name === undefined ? {} : { name: data.name }
    });
    if (result.count !== 1) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead list not found.");
    return this.getList(workspaceId, listId);
  }

  async deleteList(workspaceId: string, listId: string) {
    const result = await this.prisma.leadList.deleteMany({ where: { workspaceId, id: listId } });
    if (result.count !== 1) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead list not found.");
  }

  async listLeads(input: { workspaceId: string; listId: string; page: number; pageSize: number }): Promise<LeadPaginatedResultDto> {
    await this.getList(input.workspaceId, input.listId);
    const where = { workspaceId: input.workspaceId, listId: input.listId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize
      }),
      this.prisma.lead.count({ where })
    ]);
    const currentPhones = new Map(rows.map((row) => [
      row.id,
      new Set([row.normalizedPhone, ...strings(row.phones)].flatMap((phone) => {
        if (!phone) return [];
        const normalized = canonicalizePhone(phone);
        return /^\d{8,15}$/.test(normalized) ? [normalized] : [];
      }))
    ]));
    const phones = [...new Set([...currentPhones.values()].flatMap((set) => [...set]))];
    const recent = phones.length === 0 ? [] : await this.prisma.leadWhatsappVerification.findMany({
      where: {
        workspaceId: input.workspaceId,
        leadId: { in: rows.map((row) => row.id) },
        normalizedPhone: { in: phones }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    const latest = new Map<string, LeadWhatsappVerification>();
    for (const verification of recent) {
      const key = `${verification.leadId}:${canonicalizePhone(verification.normalizedPhone)}`;
      if (!latest.has(key)) latest.set(key, verification);
    }
    return {
      items: rows.map((row) => toLeadResultDto(row, [...(currentPhones.get(row.id) ?? [])].flatMap((phone) => {
        const verification = latest.get(`${row.id}:${phone}`);
        return verification ? [{
          normalizedPhone: phone,
          status: verification.status,
          checkedAt: toNullableIso(verification.checkedAt),
          errorMessage: verification.errorMessage
        }] : [];
      }).sort((left, right) => {
        const leftRecord = latest.get(`${row.id}:${left.normalizedPhone}`)!;
        const rightRecord = latest.get(`${row.id}:${right.normalizedPhone}`)!;
        return rightRecord.createdAt.getTime() - leftRecord.createdAt.getTime() || rightRecord.id.localeCompare(leftRecord.id);
      }))),
      page: input.page,
      pageSize: input.pageSize,
      total
    };
  }

  async getWhatsappVerificationContext(workspaceId: string, listId: string, leadIds: string[]) {
    const [list, leads, channels] = await Promise.all([
      this.prisma.leadList.findFirst({ where: { workspaceId, id: listId } }),
      this.prisma.lead.findMany({ where: { workspaceId, listId, id: { in: leadIds } } }),
      this.prisma.channel.findMany({
        where: { workspaceId, provider: "evolution", status: "connected" },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }]
      })
    ]);
    if (!list || leads.length !== leadIds.length) {
      throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead list or selected lead not found.");
    }
    const channel = channels.find((candidate) => candidate.providerKey.trim().length > 0);
    if (!channel) {
      throw new LeadsDomainError(
        "LEAD_EVOLUTION_NOT_CONNECTED",
        "A connected Evolution channel is required to check WhatsApp availability."
      );
    }
    return { list: toLeadListDto(list), leads, channel };
  }

  async createWhatsappVerificationJobs(input: {
    workspaceId: string;
    listId: string;
    channelId: string;
    instanceName: string;
    idempotencyKey: string;
    requestId: string;
    requestFingerprint: string;
    batches: Array<Array<{ phone: string; primary: string; alternate: string | null; leadIds: string[] }>>;
  }) {
    const create = () => this.prisma.$transaction(async (tx) => {
      const existing = await tx.leadJob.findUnique({
        where: {
          workspaceId_operation_idempotencyKey: {
            workspaceId: input.workspaceId,
            operation: "whatsapp_availability",
            idempotencyKey: input.idempotencyKey
          }
        }
      });
      if (existing) {
        if (inputRecord(existing.input).requestFingerprint !== input.requestFingerprint) {
          throw new LeadsDomainError("LEAD_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different lead request.");
        }
        const requestId = String(inputRecord(existing.input).requestId ?? "");
        const jobs = await tx.leadJob.findMany({
          where: {
            workspaceId: input.workspaceId,
            operation: { in: ["whatsapp_availability", "whatsapp_availability_batch"] },
            input: { path: ["requestId"], equals: requestId }
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }]
        });
        const ids = jobs.flatMap((job) => allVerificationIds(job.input));
        const rows = ids.length === 0 ? [] : await tx.leadWhatsappVerification.findMany({
          where: { workspaceId: input.workspaceId, id: { in: ids } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }]
        });
        const latestRows = latestWhatsappVerificationRows(rows);
        return {
          requestId,
          jobs: jobs.map(toLeadJobDto),
          requestedCount: new Set(latestRows.map((row) => row.leadId)).size,
          verifications: latestRows.map(toWhatsappVerificationResult),
          replayed: true
        };
      }

      const jobs: LeadJob[] = [];
      const rows: LeadWhatsappVerification[] = [];
      for (const [batchIndex, batch] of input.batches.entries()) {
        const entries: Array<{ verificationId: string; leadId: string; phone: string }> = [];
        for (const item of batch) {
          for (const leadId of item.leadIds) {
            const row = await tx.leadWhatsappVerification.create({
              data: {
                workspaceId: input.workspaceId,
                leadId,
                normalizedPhone: item.phone,
                channelId: input.channelId,
                status: "checking"
              }
            });
            rows.push(row);
            entries.push({ verificationId: row.id, leadId, phone: item.phone });
          }
        }
        jobs.push(await tx.leadJob.create({
          data: {
            workspaceId: input.workspaceId,
            listId: input.listId,
            operation: batchIndex === 0 ? "whatsapp_availability" : "whatsapp_availability_batch",
            idempotencyKey: batchIndex === 0 ? input.idempotencyKey : `${input.requestId}:${batchIndex}`,
            input: {
              requestId: input.requestId,
              requestFingerprint: input.requestFingerprint,
              batchIndex,
              totalBatches: input.batches.length,
              channelId: input.channelId,
              instanceName: input.instanceName,
              numbers: batch.map((item) => item.primary),
              lookups: batch.map((item) => ({
                phone: item.phone,
                primary: item.primary,
                alternate: item.alternate
              })),
              entries
            },
            output: { totalCount: entries.length, processedCount: 0, failedCount: 0 }
          }
        }));
      }
      return {
        requestId: input.requestId,
        jobs: jobs.map(toLeadJobDto),
        requestedCount: new Set(rows.map((row) => row.leadId)).size,
        verifications: rows.map(toWhatsappVerificationResult),
        replayed: false
      };
    });
    try {
      return await create();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.leadJob.findUnique({
        where: {
          workspaceId_operation_idempotencyKey: {
            workspaceId: input.workspaceId,
            operation: "whatsapp_availability",
            idempotencyKey: input.idempotencyKey
          }
        }
      });
      if (!existing) throw error;
      if (inputRecord(existing.input).requestFingerprint !== input.requestFingerprint) {
        throw new LeadsDomainError("LEAD_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different lead request.");
      }
      const requestId = String(inputRecord(existing.input).requestId ?? "");
      const jobs = await this.prisma.leadJob.findMany({
        where: {
          workspaceId: input.workspaceId,
          operation: { in: ["whatsapp_availability", "whatsapp_availability_batch"] },
          input: { path: ["requestId"], equals: requestId }
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });
      const ids = jobs.flatMap((job) => allVerificationIds(job.input));
      const rows = ids.length === 0 ? [] : await this.prisma.leadWhatsappVerification.findMany({
        where: { workspaceId: input.workspaceId, id: { in: ids } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });
      const latestRows = latestWhatsappVerificationRows(rows);
      return {
        requestId,
        jobs: jobs.map(toLeadJobDto),
        requestedCount: new Set(latestRows.map((row) => row.leadId)).size,
        verifications: latestRows.map(toWhatsappVerificationResult),
        replayed: true
      };
    }
  }

  async fencedFinishWhatsappVerificationJob(input: {
    job: LeadJobFence;
    now: Date;
    results: Array<{ verificationId: string; status: "available" | "unavailable" | "failed"; errorMessage: string | null }>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.leadJob.findFirst({
        where: {
          workspaceId: input.job.workspaceId,
          id: input.job.id,
          listId: input.job.listId,
          status: "running",
          leaseToken: input.job.leaseToken,
          leaseUntil: { gt: input.now }
        }
      });
      if (!current) throw new LeadLeaseLostError();
      const allowed = new Set(verificationIds(current.input));
      if (input.results.some((result) => !allowed.has(result.verificationId))) {
        throw new LeadsDomainError("LEAD_INVALID_INPUT", "Verification result does not belong to the claimed job.");
      }
      for (const result of input.results) {
        const updated = await tx.leadWhatsappVerification.updateMany({
          where: { workspaceId: input.job.workspaceId, id: result.verificationId, status: "checking" },
          data: { status: result.status, errorMessage: result.errorMessage, checkedAt: input.now }
        });
        if (updated.count !== 1) throw new LeadLeaseLostError();
      }
      const failedCount = input.results.filter((result) => result.status === "failed").length;
      const status = failedCount === 0 ? "completed" : failedCount === input.results.length ? "failed" : "partial";
      const finished = await tx.leadJob.updateMany({
        where: { workspaceId: input.job.workspaceId, id: input.job.id, status: "running", leaseToken: input.job.leaseToken },
        data: {
          status,
          output: {
            totalCount: input.results.length,
            processedCount: input.results.length - failedCount,
            failedCount,
            retryable: failedCount > 0
          },
          errorMessage: failedCount > 0 ? "LEAD_WHATSAPP_PARTIAL_FAILURE" : null,
          leaseToken: null,
          leaseUntil: null,
          finishedAt: input.now
        }
      });
      if (finished.count !== 1) throw new LeadLeaseLostError();
      const job = await tx.leadJob.findFirst({ where: { workspaceId: input.job.workspaceId, id: input.job.id } });
      if (!job) throw new LeadLeaseLostError();
      return toLeadJobDto(job);
    });
  }

  async getLeadForSimilarity(workspaceId: string, listId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { workspaceId, listId, id: leadId }
    });
    if (!lead) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead not found.");
    return lead;
  }

  async retryWhatsappJob(workspaceId: string, jobId: string, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.leadJob.findFirst({ where: { workspaceId, id: jobId } });
      if (!current || !isWhatsappAvailabilityOperation(current.operation)) {
        throw new LeadsDomainError("LEAD_NOT_FOUND", "WhatsApp verification job not found.");
      }
      if (!jobIsRetryable(current) || current.leaseToken !== null) {
        throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "WhatsApp verification job is not ready for retry.");
      }
      const oldIds = verificationIds(current.input);
      const failed = await tx.leadWhatsappVerification.findMany({
        where: { workspaceId, id: { in: oldIds }, status: "failed" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });
      if (failed.length === 0) {
        throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "WhatsApp verification job has no failed numbers to retry.");
      }
      const channels = await tx.channel.findMany({
        where: { workspaceId, provider: "evolution", status: "connected" },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }]
      });
      const channel = channels.find((candidate) => candidate.providerKey.trim().length > 0);
      if (!channel) {
        throw new LeadsDomainError("LEAD_EVOLUTION_NOT_CONNECTED", "A connected Evolution channel is required to retry verification.");
      }
      const entries = [];
      const rows: LeadWhatsappVerification[] = [];
      for (const old of failed) {
        const row = await tx.leadWhatsappVerification.create({
          data: {
            workspaceId,
            leadId: old.leadId,
            normalizedPhone: old.normalizedPhone,
            channelId: channel.id,
            status: "checking"
          }
        });
        rows.push(row);
        entries.push({ verificationId: row.id, leadId: row.leadId, phone: row.normalizedPhone });
      }
      const previous = inputRecord(current.input);
      const updated = await tx.leadJob.updateMany({
        where: {
          workspaceId,
          id: jobId,
          status: current.status,
          leaseToken: null,
          updatedAt: current.updatedAt
        },
        data: {
          status: "queued",
          attempts: 0,
          leaseToken: null,
          leaseUntil: null,
          startedAt: null,
          finishedAt: null,
          errorMessage: null,
          input: {
            ...previous,
            verificationHistoryIds: [
              ...new Set([...allVerificationIds(current.input), ...rows.map((row) => row.id)])
            ],
            channelId: channel.id,
            instanceName: channel.providerKey.trim(),
            numbers: [...new Set(rows.map((row) => row.normalizedPhone))],
            entries
          },
          output: { totalCount: rows.length, processedCount: 0, failedCount: 0, retryable: false }
        }
      });
      if (updated.count !== 1) throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "WhatsApp retry raced with another transition.");
      const job = await tx.leadJob.findFirst({ where: { workspaceId, id: jobId } });
      if (!job) throw new LeadsDomainError("LEAD_NOT_FOUND", "WhatsApp verification job not found.");
      return { job: toLeadJobDto(job), verifications: rows.map(toWhatsappVerificationResult) };
    });
  }

  async getJob(workspaceId: string, jobId: string) {
    const row = await this.prisma.leadJob.findFirst({ where: { workspaceId, id: jobId } });
    if (!row) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead job not found.");
    return toLeadJobDto(row);
  }

  async retryGoogleJob(workspaceId: string, jobId: string, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.leadJob.findFirst({
        where: { workspaceId, id: jobId, operation: "google_maps_search" }
      });
      if (!current) throw new LeadsDomainError("LEAD_NOT_FOUND", "Google lead job not found.");
      if (!jobIsRetryable(current) || current.leaseToken !== null) {
        throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "Google lead job is not ready for retry.");
      }
      const output = { ...requestJsonRecord(current.output) };
      const previousGeneration = typeof output.remoteGeneration === "number" &&
        Number.isInteger(output.remoteGeneration) && output.remoteGeneration >= 0
        ? output.remoteGeneration
        : 0;
      for (const key of ["retryable", "totalCount", "processedCount", "failedCount", "downloadedRows"]) {
        delete output[key];
      }
      if ([
        "LEAD_GOOGLE_REMOTE_FAILED",
        "LEAD_GOOGLE_NO_RESULTS",
        "LEAD_GOOGLE_TIMEOUT",
        "LEAD_GOOGLE_PARTIAL_ROWS"
      ].includes(current.errorMessage ?? "")) {
        for (const key of ["remoteJobId", "remoteStatus", "remoteSubmittedAt", "remotePolledAt"]) delete output[key];
        output.remoteGeneration = previousGeneration + 1;
      }
      output.retryRequestedAt = now.toISOString();
      const updated = await tx.leadJob.updateMany({
        where: {
          workspaceId,
          id: jobId,
          operation: "google_maps_search",
          status: current.status,
          leaseToken: null,
          updatedAt: current.updatedAt
        },
        data: {
          status: "queued",
          output,
          errorMessage: null,
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          leaseUntil: null
        }
      });
      if (updated.count !== 1) throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "Google lead job retry raced with another transition.");
      await tx.leadList.updateMany({
        where: { workspaceId, id: current.listId },
        data: { completedAt: null }
      });
      const [job, list] = await Promise.all([
        tx.leadJob.findFirst({ where: { workspaceId, id: jobId } }),
        tx.leadList.findFirst({ where: { workspaceId, id: current.listId } })
      ]);
      if (!job || !list) throw new LeadsDomainError("LEAD_NOT_FOUND", "Google lead retry state not found.");
      return { job: toLeadJobDto(job), list: toLeadListDto(list) };
    });
  }

  async findJobByIdempotency(workspaceId: string, operation: string, idempotencyKey: string): Promise<LeadJobCreationResult | null> {
    const existing = await this.prisma.leadJob.findUnique({
      where: { workspaceId_operation_idempotencyKey: { workspaceId, operation, idempotencyKey } },
      include: { list: true, artifacts: true }
    });
    if (!existing) return null;
    return {
      list: toLeadListDto(existing.list),
      job: toLeadJobDto(existing),
      artifact: existing.artifacts.find((artifact) => artifact.kind === "csv_input")
        ? toArtifactMetadata(existing.artifacts.find((artifact) => artifact.kind === "csv_input")!)
        : undefined,
      persistedInput: existing.input,
      persistedOutput: existing.output,
      replayed: true
    };
  }

  async createListAndJob(input: CreateLeadJobInput): Promise<LeadJobCreationResult> {
    const create = () => this.prisma.$transaction(async (tx) => {
      const existing = await tx.leadJob.findUnique({
        where: {
          workspaceId_operation_idempotencyKey: {
            workspaceId: input.workspaceId,
            operation: input.operation,
            idempotencyKey: input.idempotencyKey
          }
        },
        include: { list: true, artifacts: true }
      });
      if (existing) {
        assertSameFingerprint(existing, input.input);
        const matchingArtifact = input.artifact
          ? existing.artifacts.find((artifact) => artifact.kind === input.artifact?.kind)
          : undefined;
        return {
          list: toLeadListDto(existing.list),
          job: toLeadJobDto(existing),
          artifact: matchingArtifact ? toArtifactMetadata(matchingArtifact) : undefined,
          persistedInput: existing.input,
          persistedOutput: existing.output,
          replayed: true
        };
      }
      const list = await tx.leadList.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name,
          source: input.source,
          criteria: input.criteria
        }
      });
      const job = await tx.leadJob.create({
        data: {
          workspaceId: input.workspaceId,
          listId: list.id,
          operation: input.operation,
          input: input.input,
          output: input.output ?? {},
          idempotencyKey: input.idempotencyKey
        }
      });
      const artifact = input.artifact
        ? await tx.leadArtifact.create({
            data: {
              workspaceId: input.workspaceId,
              listId: list.id,
              jobId: job.id,
              kind: input.artifact.kind,
              fileName: input.artifact.fileName,
              mimeType: input.artifact.mimeType,
              content: prismaBytes(input.artifact.content),
              sizeBytes: input.artifact.content.byteLength
            }
          })
        : undefined;
      return {
        list: toLeadListDto(list),
        job: toLeadJobDto(job),
        artifact: artifact ? toArtifactMetadata(artifact) : undefined,
        persistedInput: job.input,
        persistedOutput: job.output,
        replayed: false
      };
    });

    try {
      return await create();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.leadJob.findUnique({
        where: {
          workspaceId_operation_idempotencyKey: {
            workspaceId: input.workspaceId,
            operation: input.operation,
            idempotencyKey: input.idempotencyKey
          }
        },
        include: { list: true, artifacts: true }
      });
      if (!existing) throw error;
      assertSameFingerprint(existing, input.input);
      const matchingArtifact = input.artifact
        ? existing.artifacts.find((artifact) => artifact.kind === input.artifact?.kind)
        : undefined;
      return {
        list: toLeadListDto(existing.list),
        job: toLeadJobDto(existing),
        artifact: matchingArtifact ? toArtifactMetadata(matchingArtifact) : undefined,
        persistedInput: existing.input,
        persistedOutput: existing.output,
        replayed: true
      };
    }
  }

  async findQueuedJobs(limit: number, maxAttempts: number) {
    const take = Math.min(Math.max(limit, 1), 50);
    const baseWhere = { status: "queued" as const, leaseToken: null, attempts: { lt: maxAttempts } };
    const [nonGoogle, google] = await Promise.all([
      this.prisma.leadJob.findMany({
        where: { ...baseWhere, operation: { not: "google_maps_search" } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: Math.max(take - 1, 1)
      }),
      this.prisma.leadJob.findMany({
        where: { ...baseWhere, operation: "google_maps_search" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1
      })
    ]);
    return [...nonGoogle, ...google].slice(0, take);
  }

  async claimJob(workspaceId: string, jobId: string, now: Date, leaseMs: number, maxAttempts: number): Promise<ClaimedLeadJob | null> {
    const leaseToken = randomUUID();
    let result;
    try {
      result = await this.prisma.leadJob.updateMany({
        where: { workspaceId, id: jobId, status: "queued", leaseToken: null, attempts: { lt: maxAttempts } },
        data: {
          status: "running",
          leaseToken,
          leaseUntil: new Date(now.getTime() + leaseMs),
          startedAt: now,
          finishedAt: null,
          errorMessage: null,
          attempts: { increment: 1 }
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    if (result.count !== 1) return null;
    const claimed = await this.prisma.leadJob.findFirst({ where: { workspaceId, id: jobId, leaseToken } });
    return claimed ? { ...claimed, leaseToken } : null;
  }

  async extendLease(job: Pick<ClaimedLeadJob, "workspaceId" | "id" | "leaseToken">, now: Date, leaseMs: number) {
    const result = await this.prisma.leadJob.updateMany({
      where: { workspaceId: job.workspaceId, id: job.id, status: "running", leaseToken: job.leaseToken },
      data: { leaseUntil: new Date(now.getTime() + leaseMs) }
    });
    return result.count === 1;
  }

  async recoverExpiredJobs(now: Date, maxAttempts: number, limit = 50) {
    const expired = await this.prisma.leadJob.findMany({
      where: { status: "running", leaseUntil: { lt: now } },
      orderBy: [{ leaseUntil: "asc" }, { id: "asc" }],
      take: Math.min(Math.max(limit, 1), 50)
    });
    const recovered: Array<{ job: LeadJob; list?: LeadListDto }> = [];
    for (const job of expired) {
      const exhausted = job.attempts >= maxAttempts;
      const transition = await this.prisma.$transaction(async (tx) => {
        const result = await tx.leadJob.updateMany({
          where: {
            workspaceId: job.workspaceId,
            id: job.id,
            listId: job.listId,
            status: "running",
            leaseToken: job.leaseToken,
            leaseUntil: job.leaseUntil
          },
          data: exhausted
            ? {
                status: "failed",
                leaseToken: null,
                leaseUntil: null,
                finishedAt: now,
                errorMessage: "LEAD_JOB_ATTEMPTS_EXHAUSTED"
              }
            : { status: "queued", leaseToken: null, leaseUntil: null }
        });
        if (result.count !== 1) return null;
        let list: LeadList | null = null;
        if (exhausted) {
          if (isWhatsappAvailabilityOperation(job.operation)) {
            const ids = verificationIds(job.input);
            if (ids.length > 0) {
              await tx.leadWhatsappVerification.updateMany({
                where: { workspaceId: job.workspaceId, id: { in: ids }, status: "checking" },
                data: { status: "failed", errorMessage: "LEAD_JOB_ATTEMPTS_EXHAUSTED", checkedAt: now }
              });
            }
            await tx.leadJob.updateMany({
              where: { workspaceId: job.workspaceId, id: job.id, status: "failed", leaseToken: null },
              data: { output: { ...requestJsonRecord(job.output), retryable: true } }
            });
          } else {
            const currentList = await tx.leadList.findFirst({
              where: { workspaceId: job.workspaceId, id: job.listId }
            });
            if (!currentList) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead list not found.");
            const failedCount = Math.max(
              currentList.failedCount,
              currentList.totalCount - currentList.processedCount,
              1
            );
            const totalCount = Math.max(currentList.totalCount, currentList.processedCount + failedCount);
            await tx.leadList.updateMany({
              where: { workspaceId: job.workspaceId, id: job.listId },
              data: { totalCount, failedCount, completedAt: now }
            });
            await tx.leadJob.updateMany({
              where: { workspaceId: job.workspaceId, id: job.id, listId: job.listId, status: "failed" },
              data: { output: { totalCount, processedCount: currentList.processedCount, failedCount } }
            });
            list = await tx.leadList.findFirst({ where: { workspaceId: job.workspaceId, id: job.listId } });
          }
        }
        const updatedJob = await tx.leadJob.findFirst({ where: { workspaceId: job.workspaceId, id: job.id } });
        if (!updatedJob) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead job not found.");
        return { job: updatedJob, list: list ? toLeadListDto(list) : undefined };
      });
      if (transition) recovered.push(transition);
    }
    return recovered;
  }

  async fencedUpsertLeads(
    job: LeadJobFence,
    inputs: LeadUpsertInput[],
    now: Date,
    leaseMs: number
  ) {
    if (inputs.some((entry) => entry.workspaceId !== job.workspaceId || entry.listId !== job.listId)) {
      throw new LeadsDomainError("LEAD_INVALID_INPUT", "Lead batch must belong to the claimed job list.");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.fence(tx, job, now, leaseMs);
      const results = [];
      for (const input of inputs) {
        const data = leadData(input);
        results.push(await tx.lead.upsert({
          where: {
            workspaceId_listId_sourceDedupeKey: {
              workspaceId: input.workspaceId,
              listId: input.listId,
              sourceDedupeKey: input.sourceDedupeKey
            }
          },
          create: data,
          update: {
            sourceExternalId: data.sourceExternalId,
            companyName: data.companyName,
            tradeName: data.tradeName,
            cnpj: data.cnpj,
            cnaePrimary: data.cnaePrimary,
            cnaeSecondary: data.cnaeSecondary,
            category: data.category,
            address: data.address,
            city: data.city,
            state: data.state,
            postalCode: data.postalCode,
            phones: data.phones,
            normalizedPhone: data.normalizedPhone,
            email: data.email,
            website: data.website,
            rating: data.rating,
            reviewCount: data.reviewCount,
            latitude: data.latitude,
            longitude: data.longitude,
            sourceUrl: data.sourceUrl,
            sourceSnapshot: data.sourceSnapshot
          }
        }));
      }
      return results;
    });
  }

  async fencedUpdateListProgress(
    job: LeadJobFence,
    input: LeadListProgressInput,
    now: Date,
    leaseMs: number
  ) {
    if (input.workspaceId !== job.workspaceId || input.listId !== job.listId) {
      throw new LeadsDomainError("LEAD_INVALID_INPUT", "Progress must belong to the claimed job list.");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.fence(tx, job, now, leaseMs);
      const updated = await tx.leadList.updateMany({
        where: { workspaceId: job.workspaceId, id: job.listId },
        data: listProgressData(input)
      });
      if (updated.count !== 1) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead list not found.");
      const list = await tx.leadList.findFirst({ where: { workspaceId: job.workspaceId, id: job.listId } });
      if (!list) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead list not found.");
      return toLeadListDto(list);
    });
  }

  async fencedCheckpointJob(
    job: LeadJobFence,
    data: { input?: Prisma.InputJsonValue; output?: Prisma.InputJsonValue },
    now: Date,
    leaseMs: number
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.fence(tx, job, now, leaseMs);
      const updated = await tx.leadJob.updateMany({
        where: {
          workspaceId: job.workspaceId,
          id: job.id,
          listId: job.listId,
          status: "running",
          leaseToken: job.leaseToken
        },
        data: {
          ...(data.input !== undefined ? { input: data.input } : {}),
          ...(data.output !== undefined ? { output: data.output } : {})
        }
      });
      if (updated.count !== 1) throw new LeadLeaseLostError();
      const record = await tx.leadJob.findFirst({
        where: { workspaceId: job.workspaceId, id: job.id, listId: job.listId, leaseToken: job.leaseToken }
      });
      if (!record) throw new LeadLeaseLostError();
      return { ...record, leaseToken: job.leaseToken } as ClaimedLeadJob;
    });
  }

  async fencedUpsertArtifact(
    job: LeadJobFence,
    input: {
      workspaceId: string;
      listId: string;
      jobId: string;
      kind: string;
      fileName: string;
      mimeType: string;
      content: Buffer;
    },
    now: Date,
    leaseMs: number
  ) {
    if (input.workspaceId !== job.workspaceId || input.listId !== job.listId || input.jobId !== job.id) {
      throw new LeadsDomainError("LEAD_INVALID_INPUT", "Artifact must belong to the claimed job.");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.fence(tx, job, now, leaseMs);
      const record = await tx.leadArtifact.upsert({
        where: { workspaceId_jobId_kind: { workspaceId: job.workspaceId, jobId: job.id, kind: input.kind } },
        create: { ...input, content: prismaBytes(input.content), sizeBytes: input.content.byteLength },
        update: {
          listId: input.listId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          content: prismaBytes(input.content),
          sizeBytes: input.content.byteLength
        }
      });
      return toArtifactMetadata(record);
    });
  }

  async fencedFinishJob(input: {
    job: LeadJobFence;
    now: Date;
    status: Extract<LeadJobStatus, "completed" | "partial" | "failed">;
    output: Prisma.InputJsonValue;
    errorMessage: string | null;
    progress: LeadListProgressInput;
  }) {
    if (input.progress.workspaceId !== input.job.workspaceId || input.progress.listId !== input.job.listId) {
      throw new LeadsDomainError("LEAD_INVALID_INPUT", "Terminal progress must belong to the claimed job.");
    }
    return this.prisma.$transaction(async (tx) => {
      const finished = await tx.leadJob.updateMany({
        where: {
          workspaceId: input.job.workspaceId,
          id: input.job.id,
          listId: input.job.listId,
          status: "running",
          leaseToken: input.job.leaseToken,
          leaseUntil: { gt: input.now }
        },
        data: {
          status: input.status,
          output: input.output,
          errorMessage: input.errorMessage,
          leaseToken: null,
          leaseUntil: null,
          finishedAt: input.now
        }
      });
      if (finished.count !== 1) throw new LeadLeaseLostError();
      const listUpdated = await tx.leadList.updateMany({
        where: { workspaceId: input.job.workspaceId, id: input.job.listId },
        data: listProgressData(input.progress)
      });
      if (listUpdated.count !== 1) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead list not found.");
      const [job, list] = await Promise.all([
        tx.leadJob.findFirst({ where: { workspaceId: input.job.workspaceId, id: input.job.id } }),
        tx.leadList.findFirst({ where: { workspaceId: input.job.workspaceId, id: input.job.listId } })
      ]);
      if (!job || !list) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead terminal state not found.");
      return { job: toLeadJobDto(job), list: toLeadListDto(list) };
    });
  }

  async upsertLeads(inputs: LeadUpsertInput[]) {
    if (inputs.length === 0) return [];
    const workspaceId = inputs[0]!.workspaceId;
    const listId = inputs[0]!.listId;
    if (inputs.some((entry) => entry.workspaceId !== workspaceId || entry.listId !== listId)) {
      throw new LeadsDomainError("LEAD_INVALID_INPUT", "Lead batch must belong to one workspace and list.");
    }
    return this.prisma.$transaction(inputs.map((input) => {
      const data = leadData(input);
      return this.prisma.lead.upsert({
        where: {
          workspaceId_listId_sourceDedupeKey: {
            workspaceId: input.workspaceId,
            listId: input.listId,
            sourceDedupeKey: input.sourceDedupeKey
          }
        },
        create: data,
        update: {
          sourceExternalId: data.sourceExternalId,
          companyName: data.companyName,
          tradeName: data.tradeName,
          cnpj: data.cnpj,
          cnaePrimary: data.cnaePrimary,
          cnaeSecondary: data.cnaeSecondary,
          category: data.category,
          address: data.address,
          city: data.city,
          state: data.state,
          postalCode: data.postalCode,
          phones: data.phones,
          normalizedPhone: data.normalizedPhone,
          email: data.email,
          website: data.website,
          rating: data.rating,
          reviewCount: data.reviewCount,
          latitude: data.latitude,
          longitude: data.longitude,
          sourceUrl: data.sourceUrl,
          sourceSnapshot: data.sourceSnapshot
        }
      });
    }));
  }

  async updateListProgress(input: {
    workspaceId: string;
    listId: string;
    totalCount: number;
    processedCount: number;
    failedCount: number;
    startedAt?: Date;
    completedAt?: Date | null;
  }) {
    const result = await this.prisma.leadList.updateMany({
      where: { workspaceId: input.workspaceId, id: input.listId },
      data: {
        totalCount: input.totalCount,
        processedCount: input.processedCount,
        failedCount: input.failedCount,
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {})
      }
    });
    if (result.count !== 1) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead list not found.");
    return this.getList(input.workspaceId, input.listId);
  }

  async finishJob(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    status: Extract<LeadJobStatus, "completed" | "partial" | "failed">;
    output: Prisma.InputJsonValue;
    errorMessage: string | null;
    finishedAt: Date;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.leadJob.findFirst({ where: { workspaceId: input.workspaceId, id: input.jobId } });
      if (!current) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead job not found.");
      if (!canTransitionLeadJob(current.status, input.status) || current.leaseToken !== input.leaseToken) {
        throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "Lead job transition is no longer valid.");
      }
      const result = await tx.leadJob.updateMany({
        where: {
          workspaceId: input.workspaceId,
          id: input.jobId,
          status: "running",
          leaseToken: input.leaseToken
        },
        data: {
          status: input.status,
          output: input.output,
          errorMessage: input.errorMessage,
          leaseToken: null,
          leaseUntil: null,
          finishedAt: input.finishedAt
        }
      });
      if (result.count !== 1) {
        throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "Lead job transition is no longer valid.");
      }
      const updated = await tx.leadJob.findFirst({ where: { workspaceId: input.workspaceId, id: input.jobId } });
      if (!updated) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead job not found.");
      return toLeadJobDto(updated);
    });
  }

  async upsertArtifact(input: {
    workspaceId: string;
    listId: string;
    jobId: string;
    kind: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
  }) {
    const record = await this.prisma.leadArtifact.upsert({
      where: {
        workspaceId_jobId_kind: {
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          kind: input.kind
        }
      },
      create: { ...input, content: prismaBytes(input.content), sizeBytes: input.content.byteLength },
      update: {
        listId: input.listId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        content: prismaBytes(input.content),
        sizeBytes: input.content.byteLength
      }
    });
    return toArtifactMetadata(record);
  }

  async getArtifact(workspaceId: string, artifactId: string): Promise<LeadArtifactDownload> {
    const record = await this.prisma.leadArtifact.findFirst({ where: { workspaceId, id: artifactId } });
    if (!record) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead artifact not found.");
    return { ...toArtifactMetadata(record), content: Buffer.from(record.content) };
  }

  async getJobArtifact(workspaceId: string, jobId: string, kind: string): Promise<LeadArtifactDownload> {
    const record = await this.prisma.leadArtifact.findFirst({ where: { workspaceId, jobId, kind } });
    if (!record) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead artifact not found.");
    return { ...toArtifactMetadata(record), content: Buffer.from(record.content) };
  }
}

export type LeadsRepositoryLike = Pick<
  LeadsRepository,
  | "listLists"
  | "getList"
  | "updateList"
  | "deleteList"
  | "listLeads"
  | "getWhatsappVerificationContext"
  | "createWhatsappVerificationJobs"
  | "fencedFinishWhatsappVerificationJob"
  | "retryWhatsappJob"
  | "getLeadForSimilarity"
  | "getJob"
  | "retryGoogleJob"
  | "findJobByIdempotency"
  | "createListAndJob"
  | "findQueuedJobs"
  | "claimJob"
  | "recoverExpiredJobs"
  | "fencedUpsertLeads"
  | "fencedUpdateListProgress"
  | "fencedCheckpointJob"
  | "fencedUpsertArtifact"
  | "fencedFinishJob"
  | "getArtifact"
  | "getJobArtifact"
>;
