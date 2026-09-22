import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LeadsRepository } from "./leads.repository.js";

const url = process.env.LEADS_TEST_DATABASE_URL;

if (
  url &&
  !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/leads_task2_test(?:\?|$)/.test(url)
) {
  throw new Error("Refusing a non-disposable Leads test database.");
}

describe.skipIf(!url)("Leads PostgreSQL constraints", () => {
  const db = new PrismaClient({
    datasources: { db: { url: url ?? "postgresql://invalid/unused" } }
  });
  const workspaceId = `leads-test-${randomUUID()}`;
  const foreignWorkspaceId = `leads-foreign-${randomUUID()}`;
  let contactId: string;
  let receitaListId: string;
  let googleListId: string;
  let receitaLeadId: string;

  beforeAll(async () => {
    contactId = (
      await db.contact.create({
        data: { workspaceId, phone: `55${Date.now()}${Math.floor(Math.random() * 1000)}` }
      })
    ).id;
    receitaListId = (
      await db.leadList.create({
        data: { workspaceId, name: "Receita", source: "receita_federal" }
      })
    ).id;
    googleListId = (
      await db.leadList.create({
        data: { workspaceId, name: "Google", source: "google_maps" }
      })
    ).id;
    receitaLeadId = (
      await db.lead.create({
        data: {
          workspaceId,
          listId: receitaListId,
          source: "receita_federal",
          sourceDedupeKey: `receita-${randomUUID()}`
        }
      })
    ).id;
    await db.leadContactProvenance.create({
      data: {
        workspaceId,
        contactId,
        leadId: receitaLeadId,
        listId: receitaListId,
        source: "receita_federal"
      }
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("rejects cross-workspace and contradictory source/list lineage", async () => {
    await expect(
      db.lead.create({
        data: {
          workspaceId: foreignWorkspaceId,
          listId: receitaListId,
          source: "receita_federal",
          sourceDedupeKey: `foreign-${randomUUID()}`
        }
      })
    ).rejects.toThrow();

    await expect(
      db.lead.create({
        data: {
          workspaceId,
          listId: receitaListId,
          source: "google_maps",
          sourceDedupeKey: `mismatch-${randomUUID()}`
        }
      })
    ).rejects.toThrow();

    await expect(
      db.leadContactProvenance.create({
        data: {
          workspaceId,
          contactId,
          leadId: receitaLeadId,
          listId: googleListId,
          source: "google_maps"
        }
      })
    ).rejects.toThrow();
  });

  it("retains provenance by rejecting parent deletion", async () => {
    await expect(db.contact.delete({ where: { id: contactId } })).rejects.toThrow();
    await expect(db.lead.delete({ where: { id: receitaLeadId } })).rejects.toThrow();
    await expect(db.leadList.delete({ where: { id: receitaListId } })).rejects.toThrow();
  });

  it("allows alphanumeric CNPJ identifiers and rejects invalid stored formats", async () => {
    const valid = await db.lead.create({
      data: {
        workspaceId,
        listId: receitaListId,
        source: "receita_federal",
        sourceDedupeKey: `cnpj-valid-${randomUUID()}`,
        cnpj: "12345678ABCD90"
      }
    });

    expect(valid.cnpj).toBe("12345678ABCD90");

    await expect(
      db.lead.create({
        data: {
          workspaceId,
          listId: receitaListId,
          source: "receita_federal",
          sourceDedupeKey: `cnpj-invalid-${randomUUID()}`,
          cnpj: "12345678ABCD9X"
        }
      })
    ).rejects.toThrow();
  });

  it("enforces exact artifact job/list lineage with a composite foreign key", async () => {
    const firstList = await db.leadList.create({
      data: { workspaceId, name: "Artifact source", source: "receita_federal" }
    });
    const otherList = await db.leadList.create({
      data: { workspaceId, name: "Artifact mismatch", source: "receita_federal" }
    });
    const job = await db.leadJob.create({
      data: {
        workspaceId,
        listId: firstList.id,
        operation: "cnpj_csv_import",
        idempotencyKey: `artifact-${randomUUID()}`
      }
    });

    await expect(db.leadArtifact.create({
      data: {
        workspaceId,
        listId: otherList.id,
        jobId: job.id,
        kind: "csv_error",
        fileName: "errors.csv",
        mimeType: "text/csv",
        content: Uint8Array.from(Buffer.from("error")),
        sizeBytes: 5
      }
    })).rejects.toThrow();
    await expect(db.leadArtifact.create({
      data: {
        workspaceId,
        listId: firstList.id,
        jobId: job.id,
        kind: "csv_error",
        fileName: "errors.csv",
        mimeType: "text/csv",
        content: Uint8Array.from(Buffer.from("error")),
        sizeBytes: 5
      }
    })).resolves.toMatchObject({ listId: firstList.id, jobId: job.id });
  });

  it("rolls back a terminal job update when the list update fails in the same transaction", async () => {
    const list = await db.leadList.create({
      data: { workspaceId, name: "Atomic terminal", source: "receita_federal" }
    });
    const leaseToken = randomUUID();
    const job = await db.leadJob.create({
      data: {
        workspaceId,
        listId: list.id,
        operation: "receita_search",
        idempotencyKey: `atomic-${randomUUID()}`,
        status: "running",
        attempts: 1,
        leaseToken,
        leaseUntil: new Date(Date.now() + 60_000)
      }
    });
    const faultingPrisma = {
      $transaction: (callback: (tx: unknown) => Promise<unknown>) => db.$transaction((tx) => callback({
        leadJob: tx.leadJob,
        leadList: {
          updateMany: async () => { throw new Error("forced list write failure"); },
          findFirst: tx.leadList.findFirst.bind(tx.leadList)
        }
      }))
    };
    const repository = new LeadsRepository(faultingPrisma as never);

    await expect(repository.fencedFinishJob({
      job: { workspaceId, id: job.id, listId: list.id, leaseToken },
      now: new Date(),
      status: "completed",
      output: { processedCount: 1 },
      errorMessage: null,
      progress: { workspaceId, listId: list.id, totalCount: 1, processedCount: 1, failedCount: 0, completedAt: new Date() }
    })).rejects.toThrow("forced list write failure");

    const storedJob = await db.leadJob.findUniqueOrThrow({ where: { id: job.id } });
    const storedList = await db.leadList.findUniqueOrThrow({ where: { id: list.id } });
    expect(storedJob).toMatchObject({ status: "running", leaseToken, finishedAt: null });
    expect(storedList).toMatchObject({ totalCount: 0, processedCount: 0, failedCount: 0, completedAt: null });
  });

  it("prevents a reclaimed worker from writing leads, progress, artifacts, or terminal state", async () => {
    const list = await db.leadList.create({
      data: { workspaceId, name: "Fenced stale worker", source: "receita_federal" }
    });
    const staleToken = randomUUID();
    const expiredAt = new Date(Date.now() - 1_000);
    const job = await db.leadJob.create({
      data: {
        workspaceId,
        listId: list.id,
        operation: "receita_search",
        idempotencyKey: `fenced-${randomUUID()}`,
        status: "running",
        attempts: 1,
        leaseToken: staleToken,
        leaseUntil: expiredAt
      }
    });
    const repository = new LeadsRepository(db);
    let releaseReclaim!: () => void;
    const release = new Promise<void>((resolve) => { releaseReclaim = resolve; });
    let reclaimLocked!: () => void;
    const locked = new Promise<void>((resolve) => { reclaimLocked = resolve; });
    const reclaim = db.$transaction(async (tx) => {
      await tx.leadJob.updateMany({
        where: { workspaceId, id: job.id, status: "running", leaseToken: staleToken, leaseUntil: expiredAt },
        data: { status: "queued", leaseToken: null, leaseUntil: null }
      });
      reclaimLocked();
      await release;
    });
    await locked;
    const fence = { workspaceId, id: job.id, listId: list.id, leaseToken: staleToken };
    const attempted = [
      repository.fencedUpsertLeads(fence, [{
        workspaceId, listId: list.id, source: "receita_federal", sourceDedupeKey: "stale-lead"
      }], new Date(expiredAt.getTime() - 1), 60_000),
      repository.fencedUpdateListProgress(fence, {
        workspaceId, listId: list.id, totalCount: 9, processedCount: 8, failedCount: 1
      }, new Date(expiredAt.getTime() - 1), 60_000),
      repository.fencedUpsertArtifact(fence, {
        workspaceId, listId: list.id, jobId: job.id, kind: "csv_error", fileName: "stale.csv",
        mimeType: "text/csv", content: Buffer.from("stale")
      }, new Date(expiredAt.getTime() - 1), 60_000),
      repository.fencedFinishJob({
        job: fence,
        now: new Date(expiredAt.getTime() - 1),
        status: "completed",
        output: { stale: true },
        errorMessage: null,
        progress: { workspaceId, listId: list.id, totalCount: 1, processedCount: 1, failedCount: 0, completedAt: new Date() }
      })
    ];
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReclaim();
    await reclaim;
    const results = await Promise.allSettled(attempted);

    expect(results.every((result) => result.status === "rejected" &&
      typeof result.reason === "object" && result.reason?.code === "LEAD_LEASE_LOST")).toBe(true);
    await expect(db.lead.count({ where: { workspaceId, listId: list.id } })).resolves.toBe(0);
    await expect(db.leadArtifact.count({ where: { workspaceId, jobId: job.id } })).resolves.toBe(0);
    await expect(db.leadList.findUniqueOrThrow({ where: { id: list.id } })).resolves.toMatchObject({
      totalCount: 0, processedCount: 0, failedCount: 0, completedAt: null
    });
    await expect(db.leadJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({
      status: "queued", leaseToken: null, leaseUntil: null, finishedAt: null
    });
  });

  it("atomically fails an exhausted expired job and finalizes its list counters", async () => {
    const list = await db.leadList.create({
      data: {
        workspaceId,
        name: "Exhausted",
        source: "receita_federal",
        totalCount: 10,
        processedCount: 3,
        failedCount: 0
      }
    });
    const leaseToken = randomUUID();
    const job = await db.leadJob.create({
      data: {
        workspaceId,
        listId: list.id,
        operation: "receita_search",
        idempotencyKey: `exhausted-${randomUUID()}`,
        status: "running",
        attempts: 3,
        leaseToken,
        leaseUntil: new Date(Date.now() - 1_000)
      }
    });
    const repository = new LeadsRepository(db);
    const recovered = await repository.recoverExpiredJobs(new Date(), 3);
    const transition = recovered.find((entry) => entry.job.id === job.id);

    expect(transition?.job).toMatchObject({ status: "failed", errorMessage: "LEAD_JOB_ATTEMPTS_EXHAUSTED" });
    expect(transition?.list).toMatchObject({ totalCount: 10, processedCount: 3, failedCount: 7 });
    expect(transition?.list?.completedAt).not.toBeNull();
    await expect(db.leadJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({
      output: { totalCount: 10, processedCount: 3, failedCount: 7 }
    });
  });
});
