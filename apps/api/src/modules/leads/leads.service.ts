import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import {
  leadSearchFiltersSchema,
  type LeadJobDto,
  type LeadListDto,
  type RealtimeEvent
} from "@prymeira-talk/shared";
import { Prisma, type LeadJob } from "@prisma/client";
import {
  CnpjRepository,
  LeadSourceUnavailableError,
  type CnpjCompanyRecord,
  type CnpjSearchFilters
} from "./cnpj.repository.js";
import {
  LeadsDomainError,
  LeadLeaseLostError,
  type ClaimedLeadJob,
  type LeadArtifactDownload,
  type LeadListProgressInput,
  type LeadUpsertInput,
  type LeadsRepositoryLike
} from "./leads.repository.js";
import { normalizeCnpj } from "./leads.types.js";
import { createSimilarityService } from "./similarity.service.js";

export const MAX_RECEITA_LEADS = 5_000;
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 5_000;
const RECEITA_PAGE_SIZE = 100;
const CSV_LOOKUP_BATCH_SIZE = 25;

export type CsvUpload = Buffer | Uint8Array | string | AsyncIterable<Uint8Array | Buffer | string>;

interface RealtimePublisher {
  publish(event: RealtimeEvent): void;
}

interface ParsedCsvRow {
  rowNumber: number;
  rawCnpj: string;
  normalizedCnpj?: string;
  metadata: Record<string, string>;
}

interface CsvRowError {
  rowNumber: number;
  cnpj: string;
  company: string;
  context: string;
  reason: string;
}

interface ParsedCsv {
  rows: ParsedCsvRow[];
  validRows: ParsedCsvRow[];
  errors: CsvRowError[];
  duplicateRows: number;
  invalidRows: number;
}

const searchJobInputSchema = z.object({
  filters: z.record(z.string(), z.unknown()),
  maxResults: z.number().int().positive().max(MAX_RECEITA_LEADS)
});

const csvJobInputSchema = z.object({
  artifactId: z.string().uuid()
});

function requiredText(value: string, field: string, max = 160) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new LeadsDomainError("LEAD_INVALID_INPUT", `${field} is invalid.`);
  }
  return normalized;
}

function boundedPage(value: number | undefined, fallback: number, max: number) {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", "Lead pagination limit exceeded.");
  }
  return parsed;
}

function sanitizeMetadata(value: string | undefined, max: number) {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function normalizeHeader(value: string) {
  return value.trim().toLocaleLowerCase("pt-BR");
}

function firstColumn(headers: string[], aliases: readonly string[]) {
  return headers.findIndex((header) => aliases.includes(normalizeHeader(header)));
}

function rowError(row: ParsedCsvRow, reason: string): CsvRowError {
  return {
    rowNumber: row.rowNumber,
    cnpj: row.rawCnpj,
    company: row.metadata.company ?? "",
    context: row.metadata.context ?? "",
    reason
  };
}

function parseCsvBytes(bytes: Buffer): ParsedCsv {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LeadsDomainError("LEAD_INVALID_ENCODING", "CSV must be valid UTF-8 text.");
  }
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      columns: false,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: false,
      max_record_size: 1_000_000
    }) as string[][];
  } catch {
    throw new LeadsDomainError("LEAD_INVALID_INPUT", "CSV is malformed.");
  }
  if (records.length === 0) throw new LeadsDomainError("LEAD_INVALID_INPUT", "CSV header is required.");
  const headers = records[0] ?? [];
  const cnpjIndex = firstColumn(headers, ["cnpj", "documento"]);
  if (cnpjIndex < 0) {
    throw new LeadsDomainError("LEAD_INVALID_INPUT", "CSV must include a CNPJ or documento column.");
  }
  const dataRows = records.slice(1);
  if (dataRows.length > MAX_CSV_ROWS) {
    throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", `CSV cannot contain more than ${MAX_CSV_ROWS} rows.`);
  }
  const companyIndex = firstColumn(headers, ["empresa", "company", "razao_social", "razão social", "nome_empresa"]);
  const contextIndex = firstColumn(headers, ["contexto", "context"]);
  const rows: ParsedCsvRow[] = [];
  const validRows: ParsedCsvRow[] = [];
  const errors: CsvRowError[] = [];
  const seen = new Set<string>();
  let duplicateRows = 0;
  let invalidRows = 0;

  for (const [index, record] of dataRows.entries()) {
    const row: ParsedCsvRow = {
      rowNumber: index + 2,
      rawCnpj: String(record[cnpjIndex] ?? "").trim(),
      metadata: {
        ...(companyIndex >= 0 ? { company: sanitizeMetadata(record[companyIndex], 240) } : {}),
        ...(contextIndex >= 0 ? { context: sanitizeMetadata(record[contextIndex], 500) } : {})
      }
    };
    rows.push(row);
    try {
      row.normalizedCnpj = normalizeCnpj(row.rawCnpj);
    } catch {
      invalidRows += 1;
      errors.push(rowError(row, "INVALID_CNPJ"));
      continue;
    }
    if (seen.has(row.normalizedCnpj)) {
      duplicateRows += 1;
      errors.push(rowError(row, "DUPLICATE_CNPJ"));
      continue;
    }
    seen.add(row.normalizedCnpj);
    validRows.push(row);
  }
  return { rows, validRows, errors, duplicateRows, invalidRows };
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

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertReplayFingerprint(persistedInput: unknown, requestFingerprint: string) {
  if (jsonRecord(persistedInput).requestFingerprint !== requestFingerprint) {
    throw new LeadsDomainError(
      "LEAD_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for a different lead request."
    );
  }
}

function persistedCount(value: unknown, key: string) {
  const count = jsonRecord(value)[key];
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
}

async function readUpload(upload: CsvUpload): Promise<Buffer> {
  if (typeof upload === "string") {
    const bytes = Buffer.from(upload, "utf8");
    if (bytes.byteLength > MAX_CSV_BYTES) throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", "CSV exceeds 5 MiB.");
    return bytes;
  }
  if (Buffer.isBuffer(upload) || upload instanceof Uint8Array) {
    const bytes = Buffer.from(upload);
    if (bytes.byteLength > MAX_CSV_BYTES) throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", "CSV exceeds 5 MiB.");
    return bytes;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of upload) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_CSV_BYTES) throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", "CSV exceeds 5 MiB.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function csvCell(value: string | number) {
  let text = String(value).replace(/\r\n?/g, "\n");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function createErrorCsv(errors: CsvRowError[]) {
  const lines = [
    ["row", "cnpj", "company", "context", "reason"].map(csvCell).join(","),
    ...[...errors]
      .sort((a, b) => a.rowNumber - b.rowNumber)
      .map((error) => [error.rowNumber, error.cnpj, error.company, error.context, error.reason].map(csvCell).join(","))
  ];
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

function toCnpjFilters(filters: z.infer<typeof leadSearchFiltersSchema>): CnpjSearchFilters {
  return {
    cnpj: filters.cnpj,
    companyName: filters.query,
    city: filters.city,
    state: filters.state,
    cnaePrimary: filters.cnae ?? filters.activity,
    porte: filters.companySize,
    openedFrom: filters.openedFrom,
    openedTo: filters.openedTo,
    capitalMin: filters.capitalMin,
    capitalMax: filters.capitalMax,
    hasPhone: filters.hasPhone,
    hasEmail: filters.hasEmail,
    activeOnly: filters.active
  };
}

function cnpjToLead(record: CnpjCompanyRecord, workspaceId: string, listId: string, metadata?: Record<string, string>): LeadUpsertInput {
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
      ...(metadata && Object.keys(metadata).length > 0 ? { csvInput: metadata } : {})
    }
  };
}

function isSourceUnavailable(error: unknown) {
  return error instanceof LeadSourceUnavailableError ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "LEAD_SOURCE_UNAVAILABLE");
}

export { LeadLeaseLostError };

export interface LeadsServiceOptions {
  repository: LeadsRepositoryLike;
  cnpjRepository?: CnpjRepository;
  realtime?: RealtimePublisher;
  now?: () => Date;
}

export function createLeadsService(options: LeadsServiceOptions) {
  const repository = options.repository;
  const cnpjRepository = options.cnpjRepository ?? new CnpjRepository();
  const now = options.now ?? (() => new Date());

  function publishList(list: LeadListDto) {
    options.realtime?.publish({ type: "lead_list.updated", workspaceId: list.workspaceId, payload: list });
  }

  function publishJob(job: LeadJobDto) {
    options.realtime?.publish({ type: "lead_job.updated", workspaceId: job.workspaceId, payload: job });
  }

  const similarityService = createSimilarityService({
    repository,
    cnpjRepository,
    now,
    onListUpdated: publishList,
    onJobUpdated: publishJob
  });

  async function updateProgress(job: ClaimedLeadJob, input: LeadListProgressInput) {
    const list = await repository.fencedUpdateListProgress(job, input, now(), 300_000);
    publishList(list);
    return list;
  }

  async function finishJob(job: ClaimedLeadJob, input: {
    status: "completed" | "partial" | "failed";
    output: Prisma.InputJsonObject;
    errorMessage: string | null;
    progress: LeadListProgressInput;
  }) {
    const updated = await repository.fencedFinishJob({
      job,
      now: now(),
      status: input.status,
      output: input.output,
      errorMessage: input.errorMessage,
      progress: input.progress
    });
    publishList(updated.list);
    publishJob(updated.job);
    return updated.job;
  }

  async function processSearch(job: ClaimedLeadJob) {
    const input = searchJobInputSchema.safeParse(job.input);
    if (!input.success) {
      return finishJob(job, {
        status: "failed",
        output: { processedCount: 0, failedCount: 1 },
        errorMessage: "LEAD_INVALID_INPUT",
        progress: { workspaceId: job.workspaceId, listId: job.listId, totalCount: 1, processedCount: 0, failedCount: 1, completedAt: now() }
      });
    }
    const filters = leadSearchFiltersSchema.safeParse(input.data.filters);
    if (!filters.success || (filters.data.source && filters.data.source !== "receita_federal")) {
      return finishJob(job, {
        status: "failed",
        output: { processedCount: 0, failedCount: 1 },
        errorMessage: "LEAD_INVALID_INPUT",
        progress: { workspaceId: job.workspaceId, listId: job.listId, totalCount: 1, processedCount: 0, failedCount: 1, completedAt: now() }
      });
    }

    let processedCount = 0;
    let totalCount = 0;
    let failure: string | null = null;
    await updateProgress(job, { workspaceId: job.workspaceId, listId: job.listId, totalCount: 0, processedCount: 0, failedCount: 0, startedAt: now(), completedAt: null });
    const sourceFilters = toCnpjFilters(filters.data);
    try {
      totalCount = Math.min(await cnpjRepository.countEstablishments(sourceFilters), input.data.maxResults);
    } catch (error) {
      if (!isSourceUnavailable(error)) throw error;
      failure = "LEAD_SOURCE_UNAVAILABLE";
    }
    let cursor = null;
    while (!failure && processedCount < totalCount) {
      let result;
      try {
        result = await cnpjRepository.scanEstablishments({
          filters: sourceFilters,
          cursor,
          limit: Math.min(RECEITA_PAGE_SIZE, totalCount - processedCount)
        });
      } catch (error) {
        if (!isSourceUnavailable(error)) throw error;
        failure = "LEAD_SOURCE_UNAVAILABLE";
        break;
      }
      const pageItems = result.items.slice(0, totalCount - processedCount);
      if (pageItems.length === 0) break;
      await repository.fencedUpsertLeads(
        job,
        pageItems.map((record) => cnpjToLead(record, job.workspaceId, job.listId)),
        now(),
        300_000
      );
      processedCount += pageItems.length;
      cursor = result.nextCursor;
      await updateProgress(job, { workspaceId: job.workspaceId, listId: job.listId, totalCount, processedCount, failedCount: 0 });
      if (!cursor) break;
    }

    const failedCount = failure ? Math.max(totalCount - processedCount, 1) : 0;
    const finalTotal = Math.max(totalCount, processedCount + failedCount);
    const status = failure ? (processedCount > 0 ? "partial" : "failed") : "completed";
    return finishJob(job, {
      status,
      output: { totalCount: finalTotal, processedCount, failedCount, capped: totalCount >= input.data.maxResults },
      errorMessage: failure,
      progress: { workspaceId: job.workspaceId, listId: job.listId, totalCount: finalTotal, processedCount, failedCount, completedAt: now() }
    });
  }

  async function processCsv(job: ClaimedLeadJob) {
    const input = csvJobInputSchema.safeParse(job.input);
    if (!input.success) {
      return finishJob(job, {
        status: "failed", output: { processedCount: 0, failedCount: 1 }, errorMessage: "LEAD_INVALID_INPUT",
        progress: { workspaceId: job.workspaceId, listId: job.listId, totalCount: 1, processedCount: 0, failedCount: 1, completedAt: now() }
      });
    }
    const artifact: LeadArtifactDownload = await repository.getArtifact(job.workspaceId, input.data.artifactId);
    let parsed: ParsedCsv;
    try {
      parsed = parseCsvBytes(artifact.content);
    } catch (error) {
      if (!(error instanceof LeadsDomainError)) throw error;
      const code = error.code;
      return finishJob(job, {
        status: "failed", output: { processedCount: 0, failedCount: 1 }, errorMessage: code,
        progress: { workspaceId: job.workspaceId, listId: job.listId, totalCount: 1, processedCount: 0, failedCount: 1, completedAt: now() }
      });
    }

    const errors = [...parsed.errors];
    let processedCount = 0;
    await updateProgress(job, {
      workspaceId: job.workspaceId,
      listId: job.listId,
      totalCount: parsed.rows.length,
      processedCount: 0,
      failedCount: errors.length,
      startedAt: now(),
      completedAt: null
    });

    for (let offset = 0; offset < parsed.validRows.length; offset += CSV_LOOKUP_BATCH_SIZE) {
      const batch = parsed.validRows.slice(offset, offset + CSV_LOOKUP_BATCH_SIZE);
      let sourceUnavailable = false;
      let results: CnpjCompanyRecord[] = [];
      try {
        results = await cnpjRepository.findByCnpjs(batch.map((row) => row.normalizedCnpj!));
      } catch (error) {
        if (!isSourceUnavailable(error)) throw error;
        sourceUnavailable = true;
      }
      const found: LeadUpsertInput[] = [];
      const byCnpj = new Map(results.map((record) => [record.cnpj, record]));
      for (const row of batch) {
        const result = byCnpj.get(row.normalizedCnpj!);
        if (sourceUnavailable) {
          errors.push(rowError(row, "SOURCE_UNAVAILABLE"));
        } else if (!result) {
          errors.push(rowError(row, "CNPJ_NOT_FOUND"));
        } else {
          found.push(cnpjToLead(result, job.workspaceId, job.listId, row.metadata));
        }
      }
      if (found.length > 0) {
        await repository.fencedUpsertLeads(job, found, now(), 300_000);
      }
      processedCount += found.length;
      await updateProgress(job, {
        workspaceId: job.workspaceId,
        listId: job.listId,
        totalCount: parsed.rows.length,
        processedCount,
        failedCount: errors.length
      });
      if (sourceUnavailable) {
        for (const remaining of parsed.validRows.slice(offset + batch.length)) {
          errors.push(rowError(remaining, "SOURCE_UNAVAILABLE"));
        }
        break;
      }
    }

    let errorArtifactId: string | null = null;
    if (errors.length > 0) {
      const errorArtifact = await repository.fencedUpsertArtifact(job, {
        workspaceId: job.workspaceId, listId: job.listId, jobId: job.id, kind: "csv_error",
        fileName: "cnpj-import-errors.csv", mimeType: "text/csv; charset=utf-8", content: createErrorCsv(errors)
      }, now(), 300_000);
      errorArtifactId = errorArtifact.id;
    }
    const failedCount = errors.length;
    const status = processedCount > 0 ? (failedCount > 0 ? "partial" : "completed") : "failed";
    const errorMessage = errors.some((error) => error.reason === "SOURCE_UNAVAILABLE")
      ? "LEAD_SOURCE_UNAVAILABLE"
      : status === "failed" ? "LEAD_CSV_NO_RESULTS" : null;
    return finishJob(job, {
      status,
      output: {
        acceptedRows: parsed.validRows.length,
        duplicateRows: parsed.duplicateRows,
        invalidRows: parsed.invalidRows,
        processedCount,
        failedCount,
        errorArtifactId
      },
      errorMessage,
      progress: { workspaceId: job.workspaceId, listId: job.listId, totalCount: parsed.rows.length, processedCount, failedCount, completedAt: now() }
    });
  }

  return {
    listLists: repository.listLists.bind(repository),
    getList: repository.getList.bind(repository),
    async updateList(input: { workspaceId: string; listId: string; name: string }) {
      const list = await repository.updateList(input.workspaceId, input.listId, { name: requiredText(input.name, "name") });
      publishList(list);
      return list;
    },
    async deleteList(workspaceId: string, listId: string) {
      const list = await repository.getList(workspaceId, listId);
      await repository.deleteList(workspaceId, listId);
      publishList(list);
    },
    async listLeads(input: { workspaceId: string; listId: string; page?: number; pageSize?: number }) {
      return repository.listLeads({
        workspaceId: input.workspaceId,
        listId: input.listId,
        page: boundedPage(input.page, 1, 10_000),
        pageSize: boundedPage(input.pageSize, 25, 100)
      });
    },
    getJob: repository.getJob.bind(repository),
    getArtifact: repository.getArtifact.bind(repository),
    findSimilarCompanies: similarityService.findSimilarCompanies,
    createSimilarListJob: similarityService.createSimilarListJob,
    async getCsvErrorArtifact(input: { workspaceId: string; jobId: string }) {
      return repository.getJobArtifact(input.workspaceId, input.jobId, "csv_error");
    },

    async createReceitaSearchJob(input: {
      workspaceId: string;
      name: string;
      filters: unknown;
      idempotencyKey: string;
      maxResults?: number;
    }) {
      const filters = leadSearchFiltersSchema.safeParse(input.filters);
      if (!filters.success || (filters.data.source && filters.data.source !== "receita_federal")) {
        throw new LeadsDomainError("LEAD_INVALID_INPUT", "Receita search filters are invalid.");
      }
      const maxResults = input.maxResults ?? MAX_RECEITA_LEADS;
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RECEITA_LEADS) {
        throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", `Receita searches are limited to ${MAX_RECEITA_LEADS} leads.`);
      }
      const normalizedName = requiredText(input.name, "name");
      const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 200);
      const requestFingerprint = sha256(stableSerialize({ name: normalizedName, filters: filters.data, maxResults }));
      const replay = await repository.findJobByIdempotency(input.workspaceId, "receita_search", idempotencyKey);
      if (replay) {
        assertReplayFingerprint(replay.persistedInput, requestFingerprint);
        return replay;
      }
      const created = await repository.createListAndJob({
        workspaceId: requiredText(input.workspaceId, "workspaceId"),
        name: normalizedName,
        source: "receita_federal",
        criteria: filters.data,
        operation: "receita_search",
        input: { requestFingerprint, filters: filters.data, maxResults },
        idempotencyKey
      });
      if (!created.replayed) {
        publishList(created.list);
        publishJob(created.job);
      }
      return created;
    },

    async createCsvImportJob(input: {
      workspaceId: string;
      name: string;
      fileName: string;
      upload: CsvUpload;
      idempotencyKey: string;
    }) {
      const bytes = await readUpload(input.upload);
      const requestFingerprint = sha256(bytes);
      const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 200);
      const replay = await repository.findJobByIdempotency(input.workspaceId, "cnpj_csv_import", idempotencyKey);
      if (replay) {
        assertReplayFingerprint(replay.persistedInput, requestFingerprint);
        return {
          listId: replay.list.id,
          jobId: replay.job.id,
          acceptedRows: persistedCount(replay.persistedOutput, "acceptedRows"),
          duplicateRows: persistedCount(replay.persistedOutput, "duplicateRows"),
          invalidRows: persistedCount(replay.persistedOutput, "invalidRows"),
          errorCsvUrl: null,
          inputArtifactId: replay.artifact?.id ?? null
        };
      }
      const parsed = parseCsvBytes(bytes);
      const originalRows = parsed.rows.length;
      const created = await repository.createListAndJob({
        workspaceId: requiredText(input.workspaceId, "workspaceId"),
        name: requiredText(input.name, "name"),
        source: "receita_federal",
        criteria: { type: "csv_import", fileName: requiredText(input.fileName, "fileName", 180) },
        operation: "cnpj_csv_import",
        input: {
          requestFingerprint,
          originalRows,
          acceptedRows: parsed.validRows.length,
          duplicateRows: parsed.duplicateRows,
          invalidRows: parsed.invalidRows
        },
        output: {
          originalRows,
          acceptedRows: parsed.validRows.length,
          duplicateRows: parsed.duplicateRows,
          invalidRows: parsed.invalidRows
        },
        idempotencyKey,
        artifact: {
          kind: "csv_input",
          fileName: requiredText(input.fileName, "fileName", 180),
          mimeType: "text/csv; charset=utf-8",
          content: bytes
        }
      });
      if (!created.artifact) throw new LeadsDomainError("LEAD_INVALID_INPUT", "CSV artifact was not persisted.");
      if (!created.replayed) {
        publishList(created.list);
        publishJob(created.job);
      }
      return {
        listId: created.list.id,
        jobId: created.job.id,
        acceptedRows: persistedCount(created.persistedOutput, "acceptedRows"),
        duplicateRows: persistedCount(created.persistedOutput, "duplicateRows"),
        invalidRows: persistedCount(created.persistedOutput, "invalidRows"),
        errorCsvUrl: null,
        inputArtifactId: created.artifact.id
      };
    },

    async runClaimedJob(job: ClaimedLeadJob) {
      if (job.operation === "receita_search") return processSearch(job);
      if (job.operation === "similar_company_save") return similarityService.processSimilarListJob(job);
      if (job.operation === "cnpj_csv_import") {
        // createListAndJob persists the input artifact in the same transaction.
        const artifact = await repository.getJobArtifact(job.workspaceId, job.id, "csv_input");
        const hydrated = { ...job, input: { artifactId: artifact.id } } as ClaimedLeadJob;
        return processCsv(hydrated);
      }
      return finishJob(job, {
        status: "failed",
        output: { processedCount: 0, failedCount: 1 },
        errorMessage: "LEAD_INVALID_OPERATION",
        progress: { workspaceId: job.workspaceId, listId: job.listId, totalCount: 1, processedCount: 0, failedCount: 1, completedAt: now() }
      });
    },

    publishRecoveredJob(job: LeadJob) {
      publishJob({
        id: job.id,
        workspaceId: job.workspaceId,
        listId: job.listId,
        operation: job.operation,
        status: job.status,
        attempts: job.attempts,
        leaseUntil: job.leaseUntil?.toISOString() ?? null,
        startedAt: job.startedAt?.toISOString() ?? null,
        finishedAt: job.finishedAt?.toISOString() ?? null,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString()
      });
    },

    publishRecoveredList(list: LeadListDto) {
      publishList(list);
    }
  };
}

export type LeadsService = ReturnType<typeof createLeadsService>;
