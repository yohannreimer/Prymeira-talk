import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandoffBriefService } from "./handoff-brief-service.js";

const workspaceId = "workspace-a";
const conversationId = randomUUID();
const sessionId = randomUUID();
const messageId = randomUUID();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  let contextKey = "context-1";
  let active = true;
  const metadata: Record<string, unknown> = { existingFlag: "keep-me" };
  const loadContext = vi.fn(async () => active ? ({
    contextKey,
    source: "jev_audit",
    reasonCode: "commercial_policy_risk",
    run: { id: randomUUID() },
    conversation: { id: conversationId, workspaceId },
    session: { id: sessionId, workspaceId, conversationId, metadata, updatedAt: new Date("2026-09-22T19:00:00Z") },
    agent: { id: randomUUID(), systemPrompt: "Atenda." },
    messages: [{ id: messageId, direction: "inbound", type: "text", body: "Quatro peças de aço 1045." }],
    selectedKnowledge: []
  }) : null);
  const generate = vi.fn(async () => ({
    nextAction: "Verifique se trabalhamos com o material solicitado.",
    summary: "Cliente pediu quatro peças de aço 1045; viabilidade ainda não confirmada.",
    evidenceMessageIds: [messageId]
  }));
  const updateMany = vi.fn(async ({ data }: any) => {
    Object.assign(metadata, data.metadata);
    return { count: 1 };
  });
  const tx = { $queryRaw: vi.fn(async () => []), aiAgentSession: { updateMany } };
  const prisma = { $transaction: vi.fn(async (fn: (db: typeof tx) => Promise<unknown>) => fn(tx)) };
  const service = createHandoffBriefService(prisma as never, {
    loadContext: loadContext as never,
    generate: generate as never,
    delayMs: 600
  });
  return { service, loadContext, generate, metadata, prisma, tx, setKey: (value: string) => { contextKey = value; }, setActive: (value: boolean) => { active = value; } };
}

afterEach(() => { vi.useRealTimers(); });

describe("createHandoffBriefService", () => {
  it("generates a legacy handoff once, caches it, and preserves other metadata", async () => {
    vi.useFakeTimers();
    const { service, generate, metadata, tx } = setup();
    expect(await service.get({ workspaceId, conversationId })).toMatchObject({ status: "pending", nextAction: null });
    expect(await service.get({ workspaceId, conversationId })).toMatchObject({ status: "pending" });
    await vi.advanceTimersByTimeAsync(600);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await service.get({ workspaceId, conversationId })).toMatchObject({
      status: "ready", nextAction: "Verifique se trabalhamos com o material solicitado."
    });
    expect(metadata.existingFlag).toBe("keep-me");
    expect(tx.aiAgentSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId, id: sessionId })
    }));
    service.stop();
  });

  it("coalesces consecutive message notifications into one generation", async () => {
    vi.useFakeTimers();
    const { service, generate } = setup();
    service.schedule({ workspaceId, conversationId });
    await vi.advanceTimersByTimeAsync(300);
    service.schedule({ workspaceId, conversationId });
    await vi.advanceTimersByTimeAsync(300);
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(generate).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("does not publish a result computed before the latest customer message", async () => {
    vi.useFakeTimers();
    const { service, generate, metadata, setKey } = setup();
    const first = deferred<Awaited<ReturnType<typeof generate>>>();
    generate.mockImplementationOnce(() => first.promise);
    service.schedule({ workspaceId, conversationId });
    await vi.advanceTimersByTimeAsync(600);
    setKey("context-2");
    first.resolve({ nextAction: "Ação antiga.", summary: "Resumo antigo que não pode ser publicado.", evidenceMessageIds: [messageId] });
    await vi.advanceTimersByTimeAsync(0);
    expect((metadata.handoffBrief as { nextAction?: string } | undefined)?.nextAction).not.toBe("Ação antiga.");
    await vi.advanceTimersByTimeAsync(600);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await service.get({ workspaceId, conversationId })).toMatchObject({ status: "ready", contextKey: "context-2" });
    service.stop();
  });

  it("shows a safe failure and does not generate without an active handoff", async () => {
    vi.useFakeTimers();
    const { service, generate, setActive } = setup();
    generate.mockRejectedValueOnce(new Error("secret-provider-key"));
    await service.get({ workspaceId, conversationId });
    await vi.advanceTimersByTimeAsync(600);
    const failed = await service.get({ workspaceId, conversationId });
    expect(failed.status).toBe("failed");
    expect(failed.error).not.toContain("secret-provider-key");
    setActive(false);
    service.schedule({ workspaceId, conversationId });
    await vi.advanceTimersByTimeAsync(600);
    expect(generate).toHaveBeenCalledTimes(1);
    service.stop();
  });
});
