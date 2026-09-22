import { randomUUID } from "node:crypto";
import {
  Prisma,
  type Lead,
  type LeadArtifact,
  type LeadJob,
  type LeadJobStatus,
  type LeadList,
  type LeadSource,
  type PrismaClient
} from "@prisma/client";
import type {
  LeadJobDto,
  LeadListDto,
  LeadPaginatedResultDto,
  LeadResultDto
} from "@prymeira-talk/shared";
import { canTransitionLeadJob } from "./leads.types.js";

type DateLike = Date | string;

export type LeadsErrorCode =
  | "LEAD_NOT_FOUND"
  | "LEAD_SOURCE_UNAVAILABLE"
  | "LEAD_INVALID_TRANSITION"
  | "LEAD_LIMIT_EXCEEDED"
  | "LEAD_INVALID_INPUT";

export class LeadsDomainError extends Error {
  constructor(public readonly code: LeadsErrorCode, message: string) {
    super(message);
    this.name = "LeadsDomainError";
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

function toIso(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIso(value: DateLike | null) {
  return value === null ? null : toIso(value);
}

function strings(value: Prisma.JsonValue) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
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
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt)
  };
}

export function toLeadResultDto(record: Lead): LeadResultDto {
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
    whatsappStatus: "unverified",
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt)
  };
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

  async listLists(workspaceId: string, source?: LeadSource) {
    const rows = await this.prisma.leadList.findMany({
      where: { workspaceId, ...(source ? { source } : {}) },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }]
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
    return { items: rows.map(toLeadResultDto), page: input.page, pageSize: input.pageSize, total };
  }

  async getJob(workspaceId: string, jobId: string) {
    const row = await this.prisma.leadJob.findFirst({ where: { workspaceId, id: jobId } });
    if (!row) throw new LeadsDomainError("LEAD_NOT_FOUND", "Lead job not found.");
    return toLeadJobDto(row);
  }

  async createListAndJob(input: CreateLeadJobInput): Promise<{ list: LeadListDto; job: LeadJobDto; artifact?: LeadArtifactMetadata }> {
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
        const matchingArtifact = input.artifact
          ? existing.artifacts.find((artifact) => artifact.kind === input.artifact?.kind)
          : undefined;
        return {
          list: toLeadListDto(existing.list),
          job: toLeadJobDto(existing),
          artifact: matchingArtifact ? toArtifactMetadata(matchingArtifact) : undefined
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
        artifact: artifact ? toArtifactMetadata(artifact) : undefined
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
      const matchingArtifact = input.artifact
        ? existing.artifacts.find((artifact) => artifact.kind === input.artifact?.kind)
        : undefined;
      return {
        list: toLeadListDto(existing.list),
        job: toLeadJobDto(existing),
        artifact: matchingArtifact ? toArtifactMetadata(matchingArtifact) : undefined
      };
    }
  }

  async findQueuedJobs(limit: number, maxAttempts: number) {
    return this.prisma.leadJob.findMany({
      where: { status: "queued", leaseToken: null, attempts: { lt: maxAttempts } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit
    });
  }

  async claimJob(workspaceId: string, jobId: string, now: Date, leaseMs: number, maxAttempts: number): Promise<ClaimedLeadJob | null> {
    const leaseToken = randomUUID();
    const result = await this.prisma.leadJob.updateMany({
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

  async recoverExpiredJobs(now: Date, maxAttempts: number) {
    const expired = await this.prisma.leadJob.findMany({
      where: { status: "running", leaseUntil: { lt: now } },
      orderBy: [{ leaseUntil: "asc" }, { id: "asc" }]
    });
    const recovered: LeadJob[] = [];
    for (const job of expired) {
      const exhausted = job.attempts >= maxAttempts;
      const result = await this.prisma.leadJob.updateMany({
        where: {
          workspaceId: job.workspaceId,
          id: job.id,
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
      if (result.count === 1) {
        const updated = await this.prisma.leadJob.findFirst({ where: { workspaceId: job.workspaceId, id: job.id } });
        if (updated) recovered.push(updated);
      }
    }
    return recovered;
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
  | "getJob"
  | "createListAndJob"
  | "findQueuedJobs"
  | "claimJob"
  | "extendLease"
  | "recoverExpiredJobs"
  | "upsertLeads"
  | "updateListProgress"
  | "finishJob"
  | "upsertArtifact"
  | "getArtifact"
  | "getJobArtifact"
>;
