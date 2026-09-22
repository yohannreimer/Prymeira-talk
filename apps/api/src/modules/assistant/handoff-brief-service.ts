import type { Prisma, PrismaClient } from "@prisma/client";
import type { HandoffBriefDto } from "../../../../../packages/shared/src/assistant.js";
import { resolveOpenAiCompatibleSettings } from "../agents/ai-provider-settings.js";
import { createOpenAiCompatibleAgentProvider } from "../agents/provider-gateway.js";
import { lockAssistantConversation } from "./assistant-access.js";
import { loadHandoffBriefContext, type HandoffBriefContext } from "./handoff-brief-context.js";
import { generateHandoffBrief, type GeneratedHandoffBrief } from "./handoff-brief-generation.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Target = { workspaceId: string; conversationId: string };
type StoredBrief = HandoffBriefDto & {
  source: string;
  reasonCode: string | null;
  runId: string | null;
  evidenceMessageIds: string[];
  attempts: number;
  retryAfter: string | null;
  failureCode: string | null;
};
const SAFE_FAILURE = "Não foi possível atualizar o apoio agora. Confira a conversa e tente novamente.";
const RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 2;

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (["HANDOFF_BRIEF_INVALID_RESPONSE", "HANDOFF_BRIEF_INVALID_EVIDENCE", "HANDOFF_BRIEF_PROVIDER_UNAVAILABLE"].includes(message)) return message;
  const providerStatus = message.match(/^OpenAI-compatible provider request failed with status (\d{3})\b/);
  if (providerStatus) return `PROVIDER_HTTP_${providerStatus[1]}`;
  if (message.startsWith("OpenAI-compatible provider")) return "PROVIDER_RESPONSE_ERROR";
  return "UNKNOWN_GENERATION_ERROR";
}

function retryDue(brief: StoredBrief, now = Date.now()): boolean {
  return brief.status === "failed" && brief.attempts < MAX_ATTEMPTS &&
    (brief.retryAfter === null || Date.parse(brief.retryAfter) <= now);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function readStored(metadata: unknown): StoredBrief | null {
  const raw = record(record(metadata).handoffBrief);
  if (!["ready", "failed"].includes(String(raw.status)) || typeof raw.contextKey !== "string") return null;
  return {
    status: raw.status as "ready" | "failed",
    nextAction: typeof raw.nextAction === "string" ? raw.nextAction : null,
    summary: typeof raw.summary === "string" ? raw.summary : null,
    contextKey: raw.contextKey,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    error: typeof raw.error === "string" ? raw.error : null,
    source: typeof raw.source === "string" ? raw.source : "legacy",
    reasonCode: typeof raw.reasonCode === "string" ? raw.reasonCode : null,
    runId: typeof raw.runId === "string" ? raw.runId : null,
    evidenceMessageIds: Array.isArray(raw.evidenceMessageIds) ? raw.evidenceMessageIds.filter((id): id is string => typeof id === "string") : [],
    attempts: typeof raw.attempts === "number" && Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    retryAfter: typeof raw.retryAfter === "string" ? raw.retryAfter : null,
    failureCode: typeof raw.failureCode === "string" ? raw.failureCode : null
  };
}

function dto(status: HandoffBriefDto["status"], stored: StoredBrief | null, contextKey: string | null): HandoffBriefDto {
  const current = status === "ready" || status === "failed" || status === "stale";
  return {
    status,
    nextAction: current ? stored?.nextAction ?? null : null,
    summary: current ? stored?.summary ?? null : null,
    contextKey,
    updatedAt: current ? stored?.updatedAt ?? null : null,
    error: status === "failed" ? stored?.error ?? SAFE_FAILURE : null
  };
}

export function createHandoffBriefService(prisma: PrismaClient, dependencies: {
  loadContext?: (db: Db, workspaceId: string, conversationId: string) => Promise<HandoffBriefContext | null>;
  generate?: (context: HandoffBriefContext) => Promise<GeneratedHandoffBrief>;
  delayMs?: number;
} = {}) {
  const loadContext = dependencies.loadContext ?? loadHandoffBriefContext;
  const generate = dependencies.generate ?? (async (context: HandoffBriefContext) => {
    const settings = await resolveOpenAiCompatibleSettings(prisma, { workspaceId: context.conversation.workspaceId });
    if (!settings.active) throw new Error("HANDOFF_BRIEF_PROVIDER_UNAVAILABLE");
    return generateHandoffBrief({
      model: settings.chatModel,
      source: context.source,
      reasonCode: context.reasonCode,
      agentRules: context.agent.systemPrompt,
      messages: context.messages.map((message) => ({ id: message.id, direction: message.direction, type: message.type, body: message.body })),
      approvedKnowledge: context.selectedKnowledge.map(({ id, title, content }) => ({ id, title, content }))
    }, createOpenAiCompatibleAgentProvider(settings));
  });
  const delayMs = dependencies.delayMs ?? 600;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const rerun = new Set<string>();
  let stopped = false;
  const keyFor = ({ workspaceId, conversationId }: Target) => `${workspaceId}:${conversationId}`;

  async function persist(target: Target, expected: HandoffBriefContext, result: GeneratedHandoffBrief | null, failureCode: string | null): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      await lockAssistantConversation(tx, target.workspaceId, target.conversationId);
      const current = await loadContext(tx, target.workspaceId, target.conversationId);
      if (!current || current.session.id !== expected.session.id || current.contextKey !== expected.contextKey) return false;
      const previous = readStored(current.session.metadata);
      const attempts = previous?.contextKey === current.contextKey ? previous.attempts + 1 : 1;
      const updatedAt = new Date();
      const brief: StoredBrief = {
        status: result ? "ready" : "failed",
        nextAction: result?.nextAction ?? null,
        summary: result?.summary ?? null,
        contextKey: current.contextKey,
        updatedAt: updatedAt.toISOString(),
        error: result ? null : SAFE_FAILURE,
        source: current.source,
        reasonCode: current.reasonCode,
        runId: current.run?.id ?? null,
        evidenceMessageIds: result?.evidenceMessageIds ?? [],
        attempts,
        retryAfter: result ? null : new Date(updatedAt.getTime() + RETRY_DELAY_MS).toISOString(),
        failureCode: result ? null : failureCode
      };
      const updated = await tx.aiAgentSession.updateMany({
        where: { id: current.session.id, workspaceId: target.workspaceId, updatedAt: current.session.updatedAt },
        data: { metadata: { ...record(current.session.metadata), handoffBrief: brief } as Prisma.InputJsonValue }
      });
      return updated.count === 1;
    });
  }

  async function run(target: Target): Promise<void> {
    const key = keyFor(target);
    if (running.has(key)) { rerun.add(key); return; }
    running.add(key);
    try {
      const context = await loadContext(prisma, target.workspaceId, target.conversationId);
      if (!context) return;
      const cached = readStored(context.session.metadata);
      if (cached?.contextKey === context.contextKey && (cached.status === "ready" || !retryDue(cached))) return;
      let result: GeneratedHandoffBrief | null = null;
      let failureCode: string | null = null;
      try { result = await generate(context); } catch (error) { failureCode = safeFailureCode(error); }
      const published = await persist(target, context, result, failureCode);
      if (!published) rerun.add(key);
    } catch {
      // A database failure must not turn a private brief into a customer-facing action.
    } finally {
      running.delete(key);
      if (rerun.delete(key) && !stopped) schedule(target);
    }
  }

  function schedule(target: Target): void {
    if (stopped) return;
    const key = keyFor(target);
    const previous = timers.get(key);
    if (previous) clearTimeout(previous);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      void run(target);
    }, delayMs));
  }

  async function get(target: Target): Promise<HandoffBriefDto> {
    const context = await loadContext(prisma, target.workspaceId, target.conversationId);
    if (!context) return dto("failed", null, null);
    const cached = readStored(context.session.metadata);
    if (cached?.contextKey === context.contextKey) {
      if (retryDue(cached)) schedule(target);
      return dto(cached.status, cached, context.contextKey);
    }
    schedule(target);
    return dto(cached ? "stale" : "pending", cached, context.contextKey);
  }

  function stop(): void {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { get, schedule, stop };
}
