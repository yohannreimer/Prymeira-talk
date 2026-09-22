import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Prisma, type LeadArtifact, type LeadJob, type LeadList } from "@prisma/client";
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

  it("requires every selected lead/list and connected Evolution channel in the caller workspace", async () => {
    const leadFindMany = vi.fn(async () => []);
    const channelFindMany = vi.fn(async () => []);
    const repository = new LeadsRepository({
      leadList: { findFirst: vi.fn(async () => list()) },
      lead: { findMany: leadFindMany },
      channel: { findMany: channelFindMany }
    } as never);

    await expect(repository.getWhatsappVerificationContext(foreignWorkspaceId, listId, [leadId]))
      .rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    expect(leadFindMany).toHaveBeenCalledWith({ where: { workspaceId: foreignWorkspaceId, listId, id: { in: [leadId] } } });
    expect(channelFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: foreignWorkspaceId, provider: "evolution", status: "connected" }
    }));
  });

  it("uses only the newest verification for the lead's normalized phone in list results", async () => {
    const lead = {
      id: leadId, workspaceId, listId, source: "receita_federal", sourceExternalId: null,
      sourceDedupeKey: "lead", companyName: null, tradeName: null, cnpj: null, cnaePrimary: null,
      cnaeSecondary: [], category: null, address: null, city: null, state: null, postalCode: null,
      phones: ["5511999990000", "5511888880000"], normalizedPhone: "5511999990000", email: null, website: null,
      rating: null, reviewCount: null, latitude: null, longitude: null, sourceUrl: null,
      sourceSnapshot: {}, createdAt: now, updatedAt: now
    };
    const repository = new LeadsRepository({
      leadList: { findFirst: vi.fn(async () => list()) },
      lead: { findMany: vi.fn(async () => [lead]), count: vi.fn(async () => 1) },
      leadWhatsappVerification: { findMany: vi.fn(async () => [
        { id: randomUUID(), workspaceId, leadId, normalizedPhone: lead.normalizedPhone, channelId: null, status: "available", errorMessage: null, checkedAt: now, createdAt: new Date(now.getTime() + 2), updatedAt: now },
        { id: randomUUID(), workspaceId, leadId, normalizedPhone: "5511888880000", channelId: null, status: "unavailable", errorMessage: null, checkedAt: now, createdAt: new Date(now.getTime() + 3), updatedAt: now },
        { id: randomUUID(), workspaceId, leadId, normalizedPhone: lead.normalizedPhone, channelId: null, status: "unavailable", errorMessage: null, checkedAt: now, createdAt: now, updatedAt: now }
      ]) },
      $transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations))
    } as never);

    const result = await repository.listLeads({ workspaceId, listId, page: 1, pageSize: 25 });
    expect(result.items[0]?.whatsappStatus).toBe("available");
    expect(result.items[0]?.whatsappVerifications).toEqual([
      expect.objectContaining({ normalizedPhone: "5511888880000", status: "unavailable" }),
      expect.objectContaining({ normalizedPhone: "551199990000", status: "available" })
    ]);
  });

  it("matches a local Google Maps phone to its country-coded verification", async () => {
    const row = {
      id: leadId, workspaceId, listId, source: "google_maps", sourceExternalId: null,
      sourceDedupeKey: "maps-local", companyName: "Padaria Sol", tradeName: null, cnpj: null,
      cnaePrimary: null, cnaeSecondary: [], category: null, address: null, city: "Campinas", state: "SP",
      postalCode: null, phones: ["(47) 99139-6920"], normalizedPhone: "47991396920",
      email: null, website: null, rating: null, reviewCount: null, latitude: null,
      longitude: null, sourceUrl: null, sourceSnapshot: {}, createdAt: now, updatedAt: now
    };
    const verification = {
      id: randomUUID(), workspaceId, leadId, normalizedPhone: "554791396920", channelId: null,
      status: "available", errorMessage: null, checkedAt: now, createdAt: now, updatedAt: now
    };
    const findVerifications = vi.fn(async () => [verification]);
    const repository = new LeadsRepository({
      leadList: { findFirst: vi.fn(async () => list()) },
      lead: { findMany: vi.fn(async () => [row]), count: vi.fn(async () => 1) },
      leadWhatsappVerification: { findMany: findVerifications },
      $transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations))
    } as never);

    const result = await repository.listLeads({ workspaceId, listId, page: 1, pageSize: 25 });

    expect(result.items[0]?.whatsappStatus).toBe("available");
    expect(findVerifications).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ normalizedPhone: { in: expect.arrayContaining(["554791396920", "47991396920"]) } })
    }));
  });

  it("persists checking rows and sequential batch jobs in one transaction", async () => {
    const createdRows: any[] = [];
    const createdJobs: any[] = [];
    const tx = {
      leadJob: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: any) => {
          const record = { ...job(), id: randomUUID(), operation: data.operation, input: data.input, output: data.output, idempotencyKey: data.idempotencyKey };
          createdJobs.push(record);
          return record;
        })
      },
      leadWhatsappVerification: {
        create: vi.fn(async ({ data }: any) => {
          const record = { id: randomUUID(), ...data, errorMessage: null, checkedAt: null, createdAt: now, updatedAt: now };
          createdRows.push(record);
          return record;
        })
      }
    };
    const transaction = vi.fn(async (callback: any) => callback(tx));
    const repository = new LeadsRepository({ $transaction: transaction } as never);
    const requestId = randomUUID();

    const result = await repository.createWhatsappVerificationJobs({
      workspaceId, listId, channelId: randomUUID(), instanceName: "instance-one",
      idempotencyKey: "request-1", requestId, requestFingerprint: "fingerprint",
      batches: [
        [{ phone: "5511999990000", primary: "5511999990000", alternate: null, leadIds: [leadId] }],
        [{ phone: "5511999990001", primary: "5511999990001", alternate: null, leadIds: [leadId] }]
      ]
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(createdRows.map((row) => row.status)).toEqual(["checking", "checking"]);
    expect(createdJobs).toHaveLength(2);
    expect(createdJobs.map((record) => record.input.batchIndex)).toEqual([0, 1]);
    expect(createdJobs.map((record) => record.operation)).toEqual(["whatsapp_availability", "whatsapp_availability_batch"]);
    expect(createdJobs.map((record) => record.idempotencyKey)).toEqual(["request-1", `${requestId}:1`]);
    expect(createdJobs[0].input.entries[0].verificationId).toBe(createdRows[0].id);
    expect(createdJobs[0].input.numbers).toEqual(["5511999990000"]);
    expect(createdJobs[0].input.lookups).toEqual([{
      phone: "5511999990000", primary: "5511999990000", alternate: null
    }]);
    expect(result).toMatchObject({ requestId, replayed: false });
  });

  it("includes workspace and resource id in list update and delete mutations", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const findFirst = vi.fn(async () => null);
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const tx = { leadList: { findFirst, deleteMany } };
    const repository = new LeadsRepository({
      leadList: { updateMany },
      $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
    } as never);

    await expect(repository.updateList(foreignWorkspaceId, listId, { name: "x" })).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    await expect(repository.deleteList(foreignWorkspaceId, listId)).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: foreignWorkspaceId, id: listId } }));
    expect(findFirst).toHaveBeenCalledWith({ where: { workspaceId: foreignWorkspaceId, id: listId } });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    [1, 0, "busca ou verificação"],
    [0, 1, "originou contatos"]
  ] as const)("rejects deletion with %s active jobs and %s imported sources", async (active, imported, message) => {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const countJobs = vi.fn(async () => active);
    const countProvenances = vi.fn(async () => imported);
    const tx = {
      leadList: { findFirst: vi.fn(async () => list()), deleteMany },
      leadJob: { count: countJobs },
      leadContactProvenance: { count: countProvenances }
    };
    const repository = new LeadsRepository({
      $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
    } as never);

    await expect(repository.deleteList(workspaceId, listId)).rejects.toMatchObject({
      code: "LEAD_INVALID_TRANSITION", message: expect.stringContaining(message)
    });
    expect(countJobs).toHaveBeenCalledWith({ where: {
      workspaceId, listId, status: { in: ["queued", "running"] }
    } });
    if (active === 0) expect(countProvenances).toHaveBeenCalledWith({ where: { workspaceId, listId } });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("deletes an eligible list inside a serializable transaction", async () => {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      leadList: { findFirst: vi.fn(async () => list()), deleteMany },
      leadJob: { count: vi.fn(async () => 0) },
      leadContactProvenance: { count: vi.fn(async () => 0) }
    };
    const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
    const repository = new LeadsRepository({ $transaction: transaction } as never);

    await repository.deleteList(workspaceId, listId);

    expect(deleteMany).toHaveBeenCalledWith({ where: { workspaceId, id: listId } });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
  });

  it.each([
    ["P2003", "contatos vinculados"],
    ["P2034", "mudou durante a exclusão"]
  ] as const)("turns database race %s into a safe conflict", async (code, message) => {
    const tx = {
      leadList: {
        findFirst: vi.fn(async () => list()),
        deleteMany: vi.fn(async () => { throw new Prisma.PrismaClientKnownRequestError("race", {
          code, clientVersion: "6.19.0"
        }); })
      },
      leadJob: { count: vi.fn(async () => 0) },
      leadContactProvenance: { count: vi.fn(async () => 0) }
    };
    const repository = new LeadsRepository({
      $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
    } as never);

    await expect(repository.deleteList(workspaceId, listId)).rejects.toMatchObject({
      code: "LEAD_INVALID_TRANSITION", message: expect.stringContaining(message)
    });
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

  it("treats the durable per-instance unique index as a lost claim", async () => {
    const updateMany = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("duplicate instance", {
      code: "P2002",
      clientVersion: "6.19.0"
    }));
    const repository = new LeadsRepository({ leadJob: { updateMany } } as never);
    await expect(repository.claimJob(workspaceId, jobId, now, 300_000, 3)).resolves.toBeNull();
  });

  it("atomically retries only failed WhatsApp rows in the caller workspace", async () => {
    const olderId = randomUUID();
    const failedId = randomUUID();
    const channelId = randomUUID();
    const current = {
      ...job(), operation: "whatsapp_availability", status: "partial" as const,
      output: { retryable: true }, input: {
        requestId: randomUUID(), instanceName: "old", numbers: ["5511999990000"],
        verificationHistoryIds: [olderId, failedId], entries: [{ verificationId: failedId }]
      }
    };
    const createdRows: any[] = [];
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findFirst = vi.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, status: "queued", attempts: 0, output: { retryable: false } });
    const tx = {
      leadJob: { findFirst, updateMany },
      leadWhatsappVerification: {
        findMany: vi.fn(async () => [{ id: failedId, workspaceId, leadId, normalizedPhone: "5511999990000", status: "failed", channelId: channelId, errorMessage: "x", checkedAt: now, createdAt: now, updatedAt: now }]),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: randomUUID(), ...data, errorMessage: null, checkedAt: null, createdAt: now, updatedAt: now };
          createdRows.push(row);
          return row;
        })
      },
      channel: { findMany: vi.fn(async () => [{ id: channelId, workspaceId, provider: "evolution", providerKey: "new-instance", status: "connected", updatedAt: now }]) }
    };
    const repository = new LeadsRepository({ $transaction: vi.fn(async (callback: any) => callback(tx)) } as never);

    const result = await repository.retryWhatsappJob(workspaceId, jobId, now);

    expect(result.job.status).toBe("queued");
    expect(createdRows).toHaveLength(1);
    expect(tx.leadWhatsappVerification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId, id: { in: [failedId] }, status: "failed" }
    }));
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId, id: jobId, status: "partial", leaseToken: null })
    }));
    const retryCalls = updateMany.mock.calls as unknown as Array<[{ data: { input: Record<string, unknown> } }]>;
    const retryInput = retryCalls[0]![0].data.input;
    expect(retryInput.verificationHistoryIds).toEqual([olderId, failedId, createdRows[0].id]);
  });

  it("retains only the failed lookup and its original variants when retrying a new WhatsApp job", async () => {
    const failedId = randomUUID();
    const channelId = randomUUID();
    const current = {
      ...job(), operation: "whatsapp_availability", status: "partial" as const,
      output: { retryable: true }, input: {
        requestId: randomUUID(), instanceName: "old",
        numbers: ["5511999990000", "5547991396920"],
        lookups: [
          { phone: "5511999990000", primary: "5511999990000", alternate: "55119999990000" },
          { phone: "554791396920", primary: "5547991396920", alternate: "554791396920" }
        ],
        entries: [{ verificationId: failedId, leadId, phone: "554791396920" }]
      }
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findFirst = vi.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, status: "queued", attempts: 0, output: { retryable: false } });
    const tx = {
      leadJob: { findFirst, updateMany },
      leadWhatsappVerification: {
        findMany: vi.fn(async () => [{ id: failedId, workspaceId, leadId, normalizedPhone: "554791396920", status: "failed", channelId, errorMessage: "x", checkedAt: now, createdAt: now, updatedAt: now }]),
        create: vi.fn(async ({ data }: any) => ({ id: randomUUID(), ...data, errorMessage: null, checkedAt: null, createdAt: now, updatedAt: now }))
      },
      channel: { findMany: vi.fn(async () => [{ id: channelId, workspaceId, provider: "evolution", providerKey: "new-instance", status: "connected", updatedAt: now }]) }
    };
    const repository = new LeadsRepository({ $transaction: vi.fn(async (callback: any) => callback(tx)) } as never);

    await repository.retryWhatsappJob(workspaceId, jobId, now);

    const retryInput = (updateMany.mock.calls as unknown as Array<[{ data: { input: Record<string, unknown> } }]>)[0]![0].data.input;
    expect(retryInput.numbers).toEqual(["5547991396920"]);
    expect(retryInput.lookups).toEqual([{
      phone: "554791396920", primary: "5547991396920", alternate: "554791396920"
    }]);
    expect(retryInput.entries).toEqual([expect.objectContaining({ leadId, phone: "554791396920" })]);
  });

  it("replays the winning WhatsApp request after a concurrent idempotency insert", async () => {
    const requestId = randomUUID();
    const oldVerificationId = randomUUID();
    const currentVerificationId = randomUUID();
    const existing = {
      ...job(),
      operation: "whatsapp_availability",
      idempotencyKey: "request-race",
      input: {
        requestId,
        requestFingerprint: "fingerprint",
        verificationHistoryIds: [oldVerificationId, currentVerificationId],
        entries: [{ verificationId: currentVerificationId }]
      }
    };
    const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate request", {
      code: "P2002",
      clientVersion: "6.19.0"
    });
    const repository = new LeadsRepository({
      $transaction: vi.fn(async () => { throw duplicate; }),
      leadJob: {
        findUnique: vi.fn(async () => existing),
        findMany: vi.fn(async () => [existing])
      },
      leadWhatsappVerification: {
        findMany: vi.fn(async () => [
          {
            id: oldVerificationId, workspaceId, leadId, normalizedPhone: "5511999990000",
            channelId: null, status: "available", errorMessage: null, checkedAt: now,
            createdAt: now, updatedAt: now
          },
          {
            id: currentVerificationId, workspaceId, leadId, normalizedPhone: "5511999990000",
            channelId: null, status: "unavailable", errorMessage: null, checkedAt: now,
            createdAt: new Date(now.getTime() + 1), updatedAt: new Date(now.getTime() + 1)
          }
        ])
      }
    } as never);

    const result = await repository.createWhatsappVerificationJobs({
      workspaceId,
      listId,
      channelId: randomUUID(),
      instanceName: "instance-one",
      idempotencyKey: "request-race",
      requestId: randomUUID(),
      requestFingerprint: "fingerprint",
      batches: [[{ phone: "5511999990000", primary: "5511999990000", alternate: null, leadIds: [leadId] }]]
    });

    expect(result).toMatchObject({
      requestId,
      replayed: true,
      requestedCount: 1,
      verifications: [{ leadId, normalizedPhone: "5511999990000", status: "unavailable" }]
    });
    expect(result.verifications).toHaveLength(1);
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

  it("fails only still-checking verification rows when a WhatsApp lease is exhausted", async () => {
    const verificationId = randomUUID();
    const expired = {
      ...job(), operation: "whatsapp_availability", status: "running" as const, attempts: 3,
      input: { entries: [{ verificationId }] }, leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() - 1)
    };
    const jobUpdateMany = vi.fn(async () => ({ count: 1 }));
    const verificationUpdateMany = vi.fn(async () => ({ count: 1 }));
    const listUpdateMany = vi.fn(async () => ({ count: 1 }));
    const repository = new LeadsRepository({
      leadJob: { findMany: vi.fn(async () => [expired]) },
      $transaction: vi.fn(async (callback: any) => callback({
        leadJob: { updateMany: jobUpdateMany, findFirst: vi.fn(async () => ({ ...expired, status: "failed", leaseToken: null })) },
        leadWhatsappVerification: { updateMany: verificationUpdateMany },
        leadList: { findFirst: vi.fn(), updateMany: listUpdateMany }
      }))
    } as never);

    const recovered = await repository.recoverExpiredJobs(now, 3);

    expect(recovered[0]?.list).toBeUndefined();
    expect(verificationUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId, id: { in: [verificationId] }, status: "checking" },
      data: { status: "failed", errorMessage: "LEAD_JOB_ATTEMPTS_EXHAUSTED", checkedAt: now }
    });
    expect(jobUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId, id: jobId, status: "failed", leaseToken: null },
      data: { output: { retryable: true } }
    });
    expect(listUpdateMany).not.toHaveBeenCalled();
  });

  it("does not update verification rows after the job lease was replaced", async () => {
    const verificationUpdateMany = vi.fn();
    const repository = new LeadsRepository({
      $transaction: vi.fn(async (callback: any) => callback({
        leadJob: { findFirst: vi.fn(async () => null) },
        leadWhatsappVerification: { updateMany: verificationUpdateMany }
      }))
    } as never);

    await expect(repository.fencedFinishWhatsappVerificationJob({
      job: { workspaceId, id: jobId, listId, leaseToken: randomUUID() },
      now,
      results: [{ verificationId: randomUUID(), status: "available", errorMessage: null }]
    })).rejects.toMatchObject({ code: "LEAD_LEASE_LOST" });
    expect(verificationUpdateMany).not.toHaveBeenCalled();
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
    expect(savedOutput).toHaveProperty("remoteGeneration", 1);
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
      expect(calls[0]![0].data.output).toHaveProperty("remoteGeneration", 1);
    }
  );
});
