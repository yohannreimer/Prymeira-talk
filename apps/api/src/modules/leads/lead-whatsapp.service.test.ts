import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import { LeadsDomainError, type ClaimedLeadJob } from "./leads.repository.js";
import { createLeadWhatsappService } from "./lead-whatsapp.service.js";

const workspaceId = "workspace_a";
const listId = randomUUID();
const channelId = randomUUID();
const now = new Date("2026-09-22T15:00:00.000Z");

function lead(index: number, phone = `55119999${index.toString().padStart(4, "0")}`) {
  return { id: randomUUID(), workspaceId, listId, normalizedPhone: phone, phones: [phone] };
}

function claimed(input: unknown): ClaimedLeadJob {
  return {
    id: randomUUID(), workspaceId, listId, operation: "whatsapp_availability", status: "running",
    input: input as never, output: {}, errorMessage: null, attempts: 1, leaseToken: randomUUID(),
    leaseUntil: new Date(now.getTime() + 300_000), startedAt: now, finishedAt: null,
    idempotencyKey: "request-1", createdAt: now, updatedAt: now
  };
}

function setup(selected = [lead(1)]) {
  const repository = {
    getWhatsappVerificationContext: vi.fn(async () => ({
      list: { id: listId, workspaceId },
      leads: selected,
      channel: { id: channelId, workspaceId, providerKey: "workspace-instance" }
    })),
    createWhatsappVerificationJobs: vi.fn(async (input: any) => ({
      requestId: input.requestId, jobs: [], requestedCount: selected.length, verifications: [], replayed: false
    })),
    fencedFinishWhatsappVerificationJob: vi.fn(async () => ({ status: "completed" }))
  };
  const evolution = { checkWhatsappNumbersAvailability: vi.fn() };
  const sleep = vi.fn(async (_milliseconds: number) => undefined);
  return {
    repository,
    evolution,
    sleep,
    service: createLeadWhatsappService({ repository: repository as never, evolution: evolution as never, now: () => now, sleep })
  };
}

describe("lead WhatsApp verification", () => {
  it("queries the original full Brazilian mobile number for deduplicated leads", async () => {
    const full = lead(1, "+55 (47) 99139-6920");
    full.normalizedPhone = "554791396920";
    const reduced = lead(2, "554791396920");
    const context = setup([reduced, full]);

    await context.service.createVerification({
      workspaceId,
      listId,
      leadIds: [reduced.id, full.id],
      idempotencyKey: "full-mobile-request"
    });

    const persisted = context.repository.createWhatsappVerificationJobs.mock.calls[0]![0];
    expect(persisted.batches).toEqual([[{
      phone: "554791396920",
      primary: "5547991396920",
      alternate: "554791396920",
      leadIds: expect.arrayContaining([reduced.id, full.id])
    }]]);
  });

  it("deduplicates normalized variants, preserves lead mapping and splits more than 25 numbers", async () => {
    const selected = Array.from({ length: 27 }, (_, index) => lead(index));
    selected[1]!.phones = ["+55 (11) 9999-0000"];
    selected[1]!.normalizedPhone = "551199990000";
    selected.push({ ...lead(99, "+55 (11) 9999-0000"), id: randomUUID() });
    const context = setup(selected);

    await context.service.createVerification({
      workspaceId,
      listId,
      leadIds: selected.map((item) => item.id),
      idempotencyKey: "request-1"
    });

    const persisted = context.repository.createWhatsappVerificationJobs.mock.calls[0]![0];
    expect(persisted.batches).toHaveLength(2);
    expect(persisted.batches[0]).toHaveLength(25);
    expect(persisted.batches[1]).toHaveLength(1);
    expect(persisted.batches.flat().find((item: any) => item.phone === "551199990000").leadIds).toHaveLength(3);
  });

  it("does not turn a missing Evolution channel into another source failure", async () => {
    const context = setup();
    context.repository.getWhatsappVerificationContext.mockRejectedValue(
      new LeadsDomainError("LEAD_EVOLUTION_NOT_CONNECTED", "No connected channel")
    );
    await expect(context.service.createVerification({ workspaceId, listId, leadIds: [randomUUID()], idempotencyKey: "x" }))
      .rejects.toMatchObject({ code: "LEAD_EVOLUTION_NOT_CONNECTED" });
    expect(context.repository.createWhatsappVerificationJobs).not.toHaveBeenCalled();
  });

  it("retries transient failures twice with bounded backoff, then persists explicit results", async () => {
    const context = setup();
    context.evolution.checkWhatsappNumbersAvailability
      .mockRejectedValueOnce(new EvolutionClientError(429, {}))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({ numbers: [{ phone: "551199990001", available: true, jid: "551199990001@s.whatsapp.net" }], raw: {} });
    const verificationId = randomUUID();
    const job = claimed({
      requestId: randomUUID(), instanceName: "workspace-instance", numbers: ["551199990001"],
      entries: [{ verificationId, leadId: randomUUID(), phone: "551199990001" }]
    });

    await context.service.processClaimedJob(job);

    expect(context.evolution.checkWhatsappNumbersAvailability).toHaveBeenCalledTimes(3);
    expect(context.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 500]);
    expect(context.repository.fencedFinishWhatsappVerificationJob).toHaveBeenCalledWith(expect.objectContaining({
      job,
      results: [{ verificationId, status: "available", errorMessage: null }]
    }));
  });

  it("treats an upstream request timeout as transient", async () => {
    const context = setup();
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    context.evolution.checkWhatsappNumbersAvailability
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ numbers: [{ phone: "551199990001", available: true }], raw: {} });
    const verificationId = randomUUID();
    await context.service.processClaimedJob(claimed({
      requestId: randomUUID(), instanceName: "workspace-instance", numbers: ["551199990001"],
      entries: [{ verificationId, leadId: randomUUID(), phone: "551199990001" }]
    }));
    expect(context.evolution.checkWhatsappNumbersAvailability).toHaveBeenCalledTimes(2);
    expect(context.sleep).toHaveBeenCalledWith(250);
  });

  it("does not retry permanent 4xx and marks missing partial response entries failed", async () => {
    const context = setup();
    context.evolution.checkWhatsappNumbersAvailability.mockResolvedValue({
      numbers: [{ phone: "551199990001", available: false }], raw: {}
    });
    const first = randomUUID();
    const missing = randomUUID();
    const job = claimed({
      requestId: randomUUID(), instanceName: "workspace-instance", numbers: ["551199990001", "551199990002"],
      entries: [
        { verificationId: first, leadId: randomUUID(), phone: "551199990001" },
        { verificationId: missing, leadId: randomUUID(), phone: "551199990002" }
      ]
    });
    await context.service.processClaimedJob(job);
    expect(context.repository.fencedFinishWhatsappVerificationJob).toHaveBeenCalledWith(expect.objectContaining({
      results: [
        { verificationId: first, status: "unavailable", errorMessage: null },
        { verificationId: missing, status: "failed", errorMessage: "LEAD_WHATSAPP_RESULT_MISSING" }
      ]
    }));

    context.evolution.checkWhatsappNumbersAvailability.mockReset();
    context.evolution.checkWhatsappNumbersAvailability.mockRejectedValue(new EvolutionClientError(400, {}));
    await context.service.processClaimedJob(job);
    expect(context.evolution.checkWhatsappNumbersAvailability).toHaveBeenCalledTimes(1);
  });
});
