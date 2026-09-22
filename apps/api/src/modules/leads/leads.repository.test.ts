import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LeadArtifact, LeadJob, LeadList } from "@prisma/client";
import { LeadsRepository } from "./leads.repository.js";

const workspaceId = "workspace_a";
const foreignWorkspaceId = "workspace_b";
const listId = randomUUID();
const leadId = randomUUID();
const jobId = randomUUID();
const artifactId = randomUUID();
const now = new Date("2026-09-22T15:00:00.000Z");

function list(): LeadList {
  return {
    id: listId,
    workspaceId,
    name: "Receita",
    source: "receita_federal",
    criteria: {},
    totalCount: 0,
    processedCount: 0,
    failedCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function job(): LeadJob {
  return {
    id: jobId,
    workspaceId,
    listId,
    operation: "receita_search",
    status: "queued",
    input: { requestFingerprint: "same-fingerprint" },
    output: {},
    errorMessage: null,
    attempts: 0,
    leaseToken: null,
    leaseUntil: null,
    startedAt: null,
    finishedAt: null,
    idempotencyKey: "same",
    createdAt: now,
    updatedAt: now
  };
}

function artifact(): LeadArtifact {
  return {
    id: artifactId,
    workspaceId,
    listId,
    jobId,
    kind: "csv_error",
    fileName: "errors.csv",
    mimeType: "text/csv",
    content: Uint8Array.from(Buffer.from("error")),
    sizeBytes: 5,
    createdAt: now,
    updatedAt: now
  };
}

describe("Leads repository workspace isolation", () => {
  it("makes a foreign list indistinguishable from a missing list", async () => {
    const findFirst = vi.fn(async () => null);
    const repository = new LeadsRepository({ leadList: { findFirst } } as never);

    await expect(repository.getList(foreignWorkspaceId, listId)).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    await expect(repository.getList(foreignWorkspaceId, randomUUID())).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    expect(findFirst).toHaveBeenNthCalledWith(1, { where: { workspaceId: foreignWorkspaceId, id: listId } });
  });

  it("scopes a similarity seed lead to its workspace and list", async () => {
    const findFirst = vi.fn(async () => null);
    const repository = new LeadsRepository({ lead: { findFirst } } as never);

    await expect(repository.getLeadForSimilarity(foreignWorkspaceId, listId, leadId))
      .rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { workspaceId: foreignWorkspaceId, listId, id: leadId }
    });
  });

  it("includes workspace and resource id in list update and delete mutations", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const repository = new LeadsRepository({ leadList: { updateMany, deleteMany } } as never);

    await expect(repository.updateList(foreignWorkspaceId, listId, { name: "x" })).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    await expect(repository.deleteList(foreignWorkspaceId, listId)).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: foreignWorkspaceId, id: listId } }));
    expect(deleteMany).toHaveBeenCalledWith({ where: { workspaceId: foreignWorkspaceId, id: listId } });
  });

  it("scopes job and authorized artifact retrieval to the caller workspace", async () => {
    const jobFindFirst = vi.fn(async () => null);
    const artifactFindFirst = vi.fn(async (args: any) => args.where.workspaceId === workspaceId ? artifact() : null);
    const repository = new LeadsRepository({
      leadJob: { findFirst: jobFindFirst },
      leadArtifact: { findFirst: artifactFindFirst }
    } as never);

    await expect(repository.getJob(foreignWorkspaceId, jobId)).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    await expect(repository.getArtifact(foreignWorkspaceId, artifactId)).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    const own = await repository.getArtifact(workspaceId, artifactId);
    expect(own.content.toString()).toBe("error");
    expect(jobFindFirst).toHaveBeenCalledWith({ where: { workspaceId: foreignWorkspaceId, id: jobId } });
    expect(artifactFindFirst).toHaveBeenCalledWith({ where: { workspaceId: workspaceId, id: artifactId } });
  });

  it("returns one existing list/job for duplicate workspace-operation idempotency", async () => {
    const existing = { ...job(), list: list(), artifacts: [] };
    const findUnique = vi.fn(async () => existing);
    const transaction = vi.fn(async (callback: any) => callback({
      leadJob: { findUnique },
      leadList: { create: vi.fn() },
      leadArtifact: { create: vi.fn() }
    }));
    const repository = new LeadsRepository({ $transaction: transaction } as never);
    const input = {
      workspaceId,
      name: "Busca",
      source: "receita_federal" as const,
      criteria: {},
      operation: "receita_search",
      input: { requestFingerprint: "same-fingerprint" },
      idempotencyKey: "same"
    };

    const first = await repository.createListAndJob(input);
    const second = await repository.createListAndJob(input);

    expect(first.job.id).toBe(second.job.id);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_operation_idempotencyKey: { workspaceId, operation: "receita_search", idempotencyKey: "same" } }
    }));
  });

  it("lets only one atomic lease update claim a queued job", async () => {
    const queued = job();
    const updateMany = vi.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const findFirst = vi.fn(async (args: any) => ({
      ...queued,
      status: "running",
      attempts: 1,
      leaseToken: args.where.leaseToken,
      leaseUntil: new Date(now.getTime() + 300_000)
    }));
    const repository = new LeadsRepository({ leadJob: { updateMany, findFirst } } as never);

    const first = await repository.claimJob(workspaceId, jobId, now, 300_000, 3);
    const second = await repository.claimJob(workspaceId, jobId, now, 300_000, 3);

    expect(first?.leaseToken).toEqual(expect.any(String));
    expect(second).toBeNull();
    expect(updateMany.mock.calls[0]?.[0].where).toEqual({
      workspaceId,
      id: jobId,
      status: "queued",
      leaseToken: null,
      attempts: { lt: 3 }
    });
  });

  it("recovers an expired lease with workspace+id and exhausts bounded attempts", async () => {
    const expired = {
      ...job(),
      status: "running" as const,
      attempts: 3,
      leaseToken: randomUUID(),
      leaseUntil: new Date(now.getTime() - 1)
    };
    const findMany = vi.fn(async () => [expired]);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findFirst = vi.fn(async () => ({ ...expired, status: "failed", finishedAt: now, leaseToken: null, leaseUntil: null }));
    const leadList = {
      findFirst: vi.fn(async () => list()),
      updateMany: vi.fn(async () => ({ count: 1 }))
    };
    const transaction = vi.fn(async (callback: any) => callback({ leadJob: { updateMany, findFirst }, leadList }));
    const repository = new LeadsRepository({
      leadJob: { findMany },
      $transaction: transaction
    } as never);

    const recovered = await repository.recoverExpiredJobs(now, 3);

    expect(recovered[0]?.job.status).toBe("failed");
    expect(recovered[0]?.list).toBeDefined();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId, id: jobId, status: "running", leaseToken: expired.leaseToken }),
      data: expect.objectContaining({ status: "failed", errorMessage: "LEAD_JOB_ATTEMPTS_EXHAUSTED" })
    }));
  });

  it("returns a stable invalid-transition error for a stale lease completion", async () => {
    const current = { ...job(), status: "completed" as const, finishedAt: now };
    const transaction = vi.fn(async (callback: any) => callback({
      leadJob: { findFirst: vi.fn(async () => current), updateMany: vi.fn() }
    }));
    const repository = new LeadsRepository({ $transaction: transaction } as never);

    await expect(repository.finishJob({
      workspaceId,
      jobId,
      leaseToken: randomUUID(),
      status: "completed",
      output: {},
      errorMessage: null,
      finishedAt: now
    })).rejects.toMatchObject({ code: "LEAD_INVALID_TRANSITION" });
  });

  it("checkpoints remote state only while the workspace-scoped lease fence is valid", async () => {
    const leaseToken = randomUUID();
    const running = {
      ...job(),
      status: "running" as const,
      leaseToken,
      leaseUntil: new Date(now.getTime() + 300_000),
      output: { remoteJobId: "remote-1" }
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findFirst = vi.fn(async () => running);
    const transaction = vi.fn(async (callback: any) => callback({ leadJob: { updateMany, findFirst } }));
    const repository = new LeadsRepository({ $transaction: transaction } as never);

    await expect(repository.fencedCheckpointJob(
      { workspaceId, id: jobId, listId, leaseToken },
      { output: { remoteJobId: "remote-1" } },
      now,
      300_000
    )).resolves.toMatchObject({ output: { remoteJobId: "remote-1" }, leaseToken });
    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ workspaceId, id: jobId, listId, leaseToken, status: "running" })
    }));
  });

  it("selects non-Google work and at most one Google candidate in each fair scheduler batch", async () => {
    const nonGoogle = { ...job(), id: randomUUID(), operation: "receita_search" };
    const google = { ...job(), id: randomUUID(), operation: "google_maps_search" };
    const findMany = vi.fn()
      .mockResolvedValueOnce([nonGoogle])
      .mockResolvedValueOnce([google]);
    const repository = new LeadsRepository({ leadJob: { findMany } } as never);

    await expect(repository.findQueuedJobs(2, 3)).resolves.toEqual([nonGoogle, google]);
    expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ operation: { not: "google_maps_search" } }),
      take: 1
    }));
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ operation: "google_maps_search" }),
      take: 1
    }));
  });

  it("atomically retries only a retryable workspace-owned Google terminal job", async () => {
    const retryable = {
      ...job(),
      operation: "google_maps_search",
      status: "failed" as const,
      attempts: 3,
      errorMessage: "LEAD_GOOGLE_REMOTE_FAILED",
      output: { retryable: true, remoteJobId: "remote-failed" },
      finishedAt: now,
      updatedAt: now
    };
    const queued = { ...retryable, status: "queued" as const, attempts: 0, errorMessage: null, output: {} };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const jobFindFirst = vi.fn()
      .mockResolvedValueOnce(retryable)
      .mockResolvedValueOnce(queued);
    const listFindFirst = vi.fn(async () => ({ ...list(), source: "google_maps", completedAt: null }));
    const transaction = vi.fn(async (callback: any) => callback({
      leadJob: { findFirst: jobFindFirst, updateMany },
      leadList: { findFirst: listFindFirst, updateMany: vi.fn(async () => ({ count: 1 })) }
    }));
    const repository = new LeadsRepository({ $transaction: transaction } as never);

    await expect(repository.retryGoogleJob(workspaceId, jobId, now)).resolves.toMatchObject({
      job: { status: "queued", retryable: false }
    });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId, id: jobId, status: "failed", leaseToken: null, updatedAt: now }),
      data: expect.objectContaining({ status: "queued", attempts: 0, errorMessage: null })
    }));
    const calls = updateMany.mock.calls as unknown as Array<[{ data: { output: Record<string, unknown> } }]>;
    const savedOutput = calls[0]![0].data.output;
    expect(savedOutput).not.toHaveProperty("remoteJobId");
    expect(savedOutput).toHaveProperty("retryRequestedAt", now.toISOString());
  });

  it.each(["LEAD_GOOGLE_TIMEOUT", "LEAD_GOOGLE_PARTIAL_ROWS"])(
    "clears an expired remote checkpoint when retrying %s",
    async (errorMessage) => {
      const terminal = {
        ...job(),
        operation: "google_maps_search",
        status: "failed" as const,
        errorMessage,
        output: {
          retryable: true,
          remoteJobId: "remote-old",
          remoteSubmittedAt: new Date(now.getTime() - 1_000_000).toISOString()
        },
        finishedAt: now,
        updatedAt: now
      };
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const transaction = vi.fn(async (callback: any) => callback({
        leadJob: {
          findFirst: vi.fn()
            .mockResolvedValueOnce(terminal)
            .mockResolvedValueOnce({ ...terminal, status: "queued", output: {}, errorMessage: null }),
          updateMany
        },
        leadList: {
          findFirst: vi.fn(async () => ({ ...list(), source: "google_maps" })),
          updateMany: vi.fn(async () => ({ count: 1 }))
        }
      }));
      const repository = new LeadsRepository({ $transaction: transaction } as never);

      await repository.retryGoogleJob(workspaceId, jobId, now);

      const calls = updateMany.mock.calls as unknown as Array<[{ data: { output: Record<string, unknown> } }]>;
      expect(calls[0]![0].data.output).not.toHaveProperty("remoteJobId");
      expect(calls[0]![0].data.output).not.toHaveProperty("remoteSubmittedAt");
    }
  );
});
