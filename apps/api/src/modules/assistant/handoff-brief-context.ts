import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { selectRelevantKnowledge } from "../agents/knowledge-retrieval.js";
import { readKnowledgeTaxonomy } from "../agents/knowledge-taxonomy.js";
import { visibleConversationMessageWhere, withoutInternalFollowupReservations } from "../conversations/internal-message.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type HandoffBriefSource = "jev_audit" | "human_request" | "agent_request" | "low_confidence" | "safety_policy" | "legacy";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sourceFor(input: { reason: string | null; run: { contextSummary: unknown; output: unknown; confidence: number | null } | null }): HandoffBriefSource {
  const reason = input.reason ?? "";
  if (/cliente.{0,45}(pediu|solicitou|quer).{0,45}(humano|atendente|pessoa|vendedor)/i.test(reason)) return "human_request";
  if (!input.run) return "legacy";
  const audit = record(record(input.run.contextSummary).replyQualityAudit);
  if (audit.outcome === "handoff") return "jev_audit";
  if (/baixa confiança|low confidence/i.test(reason)) return "low_confidence";
  const output = record(input.run.output);
  const handoff = record(output.handoff);
  if (handoff.required === true || (Array.isArray(output.actions) && output.actions.some((action) => record(action).type === "request_handoff"))) {
    return "agent_request";
  }
  if (record(input.run.contextSummary).protectedFact) return "safety_policy";
  return "low_confidence";
}

export async function loadHandoffBriefContext(db: Db, workspaceId: string, conversationId: string) {
  const conversation = await db.conversation.findFirst({
    where: { workspaceId, id: conversationId },
    include: { activeAgentSession: true }
  });
  const session = conversation?.activeAgentSession;
  if (!conversation || !session || !session.handoffReason ||
      !["handoff_requested", "paused_by_human"].includes(session.status) ||
      (session.status === "paused_by_human" && conversation.aiControlStatus !== "human_controlled")) {
    return null;
  }

  const [agent, run, fetched, sources] = await Promise.all([
    db.aiAgent.findFirst({ where: { workspaceId, id: session.agentId } }),
    db.aiAgentRun.findFirst({
      where: { workspaceId, sessionId: session.id, status: "handoff_requested" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    }),
    db.message.findMany({
      where: visibleConversationMessageWhere({ workspaceId, conversationId, type: { notIn: ["internal_note", "system"] as never } }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 81
    }),
    db.aiKnowledgeSource.findMany({
      where: { workspaceId, agentId: session.agentId, status: "ready" },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 50
    })
  ]);
  if (!agent) return null;

  const messages = withoutInternalFollowupReservations(fetched).slice(0, 80).reverse();
  const latestCustomer = [...messages].reverse().find((message) => message.direction === "inbound" && message.body?.trim())?.body ?? null;
  const history = messages.map((message) => `${message.direction === "inbound" ? "cliente" : "equipe"}: ${message.body ?? `[${message.type} sem texto confirmado]`}`).join("\n");
  const readySources = sources.filter((source) => source.status === "ready");
  const selected = selectRelevantKnowledge({
    latestMessage: latestCustomer,
    conversationHistory: history,
    instruction: session.handoffReason,
    taxonomy: readKnowledgeTaxonomy(agent.behaviorConfig),
    sources: readySources.map((source) => ({ ...source, metadata: record(source.metadata) }))
  }).selected;
  const selectedKnowledge = selected.map((source) => ({
    id: source.id,
    title: source.title,
    content: source.content,
    updatedAt: readySources.find((item) => item.id === source.id)?.updatedAt ?? null
  }));
  const source = sourceFor({ reason: session.handoffReason, run });
  const contextKey = createHash("sha256").update(JSON.stringify({
    sessionId: session.id,
    handoffReason: session.handoffReason,
    runId: run?.id ?? null,
    agent: [agent.id, agent.updatedAt, agent.systemPrompt],
    messages: messages.map((message) => [message.id, message.direction, message.type, message.body, message.createdAt]),
    knowledge: selectedKnowledge.map((knowledge) => [knowledge.id, knowledge.updatedAt])
  })).digest("hex");

  return {
    conversation,
    session,
    agent,
    run,
    messages,
    selectedKnowledge,
    source,
    reasonCode: session.handoffReason,
    contextKey
  };
}

export type HandoffBriefContext = NonNullable<Awaited<ReturnType<typeof loadHandoffBriefContext>>>;
