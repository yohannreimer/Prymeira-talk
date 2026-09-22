import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadHandoffBriefContext } from "./handoff-brief-context.js";

const workspaceId = "workspace-a";
const conversationId = randomUUID();
const agentId = randomUUID();
const sessionId = randomUUID();
const now = new Date("2026-09-22T19:00:00.000Z");

function fixture(input: {
  audit?: unknown;
  reason?: string | null;
  output?: unknown;
  run?: boolean;
  session?: boolean;
  workspace?: string;
} = {}) {
  const session = input.session === false ? null : {
    id: sessionId, workspaceId, agentId, conversationId, status: "paused_by_human",
    handoffReason: input.reason === undefined ? "commercial_policy_risk" : input.reason,
    metadata: {}, updatedAt: now
  };
  const conversation = {
    id: conversationId, workspaceId, aiControlStatus: "human_controlled",
    activeAgentSessionId: session?.id ?? null, activeAgentSession: session
  };
  const messages = [
    { id: randomUUID(), workspaceId, conversationId, direction: "outbound", type: "text", body: "Qual medida precisa?", createdAt: new Date(now.getTime() - 3_000), status: "delivered", metadata: {} },
    { id: randomUUID(), workspaceId, conversationId, direction: "inbound", type: "text", body: "Diâmetro externo 200 mm", createdAt: new Date(now.getTime() - 2_000), status: "delivered", metadata: {} },
    { id: randomUUID(), workspaceId, conversationId, direction: "inbound", type: "text", body: "Corrigindo: diâmetro externo 220 mm; 4 peças de aço 1045", createdAt: new Date(now.getTime() - 1_000), status: "delivered", metadata: {} }
  ];
  const run = input.run === false ? null : {
    id: randomUUID(), workspaceId, sessionId, conversationId, status: "handoff_requested",
    contextSummary: input.audit ? { replyQualityAudit: input.audit } : {},
    output: input.output ?? { handoff: { required: true, reason: "confirmar produto" } },
    confidence: 0.84, createdAt: now
  };
  const db = {
    conversation: { findFirst: vi.fn(async ({ where }: any) => where.workspaceId === workspaceId ? conversation : null) },
    aiAgent: { findFirst: vi.fn(async ({ where }: any) => where.workspaceId === workspaceId ? { id: agentId, workspaceId, systemPrompt: "Atenda usando apenas fatos aprovados.", behaviorConfig: {} } : null) },
    aiAgentRun: { findFirst: vi.fn(async () => run) },
    message: { findMany: vi.fn(async () => [...messages].reverse()) },
    aiKnowledgeSource: { findMany: vi.fn(async () => [
      { id: randomUUID(), workspaceId, agentId, title: "Aço 1045", content: "Material 1045 sob consulta.", status: "ready", metadata: {}, updatedAt: now },
      { id: randomUUID(), workspaceId, agentId, title: "Rascunho", content: "Não aprovado", status: "processing", metadata: {}, updatedAt: now }
    ]) }
  };
  return { db, messages, run, conversation, session };
}

describe("loadHandoffBriefContext", () => {
  it("keeps the JEV audit cause distinct from an inferred product doubt", async () => {
    const { db, messages } = fixture({ audit: { outcome: "handoff", reason: "commercial_policy_risk" } });
    const context = await loadHandoffBriefContext(db as never, workspaceId, conversationId);

    expect(context).toMatchObject({ source: "jev_audit", reasonCode: "commercial_policy_risk" });
    expect(context?.messages.map((message) => message.body)).toEqual(messages.map((message) => message.body));
    expect(context?.messages.at(-1)?.body).toContain("220 mm");
    expect(context?.selectedKnowledge.map((source) => source.title)).toContain("Aço 1045");
    expect(context?.selectedKnowledge.some((source) => source.title === "Rascunho")).toBe(false);
    expect(db.aiAgentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId, sessionId, status: "handoff_requested" }) }));
    expect(db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId, conversationId }) }));
    expect(db.aiKnowledgeSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId, agentId, status: "ready" }) }));
  });

  it.each([
    [{ reason: "Cliente pediu atendente humano." }, "human_request"],
    [{ reason: "Confirme a cotação", output: { handoff: { required: true, reason: "Confirme a cotação" } } }, "agent_request"],
    [{ reason: "Baixa confiança", output: { handoff: { required: false, reason: null } } }, "low_confidence"],
    [{ reason: "Motivo antigo", run: false }, "legacy"]
  ] as const)("classifies source %s as %s", async (input, source) => {
    const { db } = fixture(input);
    await expect(loadHandoffBriefContext(db as never, workspaceId, conversationId)).resolves.toMatchObject({ source });
  });

  it("returns no context for a foreign workspace or a conversation without active handoff", async () => {
    const foreign = fixture();
    await expect(loadHandoffBriefContext(foreign.db as never, "workspace-b", conversationId)).resolves.toBeNull();
    expect(foreign.db.message.findMany).not.toHaveBeenCalled();

    const noHandoff = fixture({ session: false });
    await expect(loadHandoffBriefContext(noHandoff.db as never, workspaceId, conversationId)).resolves.toBeNull();
    expect(noHandoff.db.aiAgent.findFirst).not.toHaveBeenCalled();
  });

  it("changes the context key when a newer correction changes the requested measure", async () => {
    const { db, messages } = fixture();
    const before = await loadHandoffBriefContext(db as never, workspaceId, conversationId);
    messages[2]!.body = "Corrigindo: diâmetro externo 225 mm; 4 peças de aço 1045";
    const after = await loadHandoffBriefContext(db as never, workspaceId, conversationId);
    expect(before?.contextKey).not.toBe(after?.contextKey);
  });
});
