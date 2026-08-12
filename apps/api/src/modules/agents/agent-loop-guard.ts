export interface AgentLoopMessage {
  direction: string;
  type: string;
  body: string | null;
  metadata?: unknown;
  createdAt: Date | string;
}

export type AgentLoopGuardResult =
  | { triggered: false }
  | {
      triggered: true;
      guard: "repeated_inbound" | "rapid_exchange";
      inboundCount: number;
      aiOutboundCount: number;
    };

const LOOP_WINDOW_MS = 2 * 60 * 1_000;
const MAX_HISTORY_RECORDS = 30;
const MAX_COMPARISON_CHARACTERS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeLoopComparisonText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("pt-BR")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .slice(0, MAX_COMPARISON_CHARACTERS);
}

function isAiOutbound(message: AgentLoopMessage) {
  return message.direction === "outbound" &&
    message.type === "text" &&
    isRecord(message.metadata) &&
    message.metadata.source === "ai_agent";
}

export function evaluateAgentLoopGuard(input: {
  messages: readonly AgentLoopMessage[];
  now: Date;
}): AgentLoopGuardResult {
  const cutoff = input.now.getTime() - LOOP_WINDOW_MS;
  const recent = input.messages
    .filter((message) => {
      const createdAt = message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : new Date(message.createdAt).getTime();
      return Number.isFinite(createdAt) && createdAt >= cutoff && createdAt <= input.now.getTime();
    })
    .sort((first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime())
    .slice(-MAX_HISTORY_RECORDS);
  const inbound = recent.filter((message) => message.direction === "inbound" && message.type === "text");
  const aiOutbound = recent.filter(isAiOutbound);
  const current = [...recent].reverse().find((message) => message.direction === "inbound" && message.type === "text");
  const normalizedCurrent = current?.body ? normalizeLoopComparisonText(current.body) : "";

  if (normalizedCurrent) {
    const matchingInbound = inbound.filter((message) =>
      message.body && normalizeLoopComparisonText(message.body) === normalizedCurrent
    );
    if (matchingInbound.length >= 3 && aiOutbound.length >= 2) {
      return {
        triggered: true,
        guard: "repeated_inbound",
        inboundCount: matchingInbound.length,
        aiOutboundCount: aiOutbound.length
      };
    }
  }

  const qualifying = recent.filter((message) =>
    (message.direction === "inbound" && message.type === "text") || isAiOutbound(message)
  );
  const alternates = qualifying.length >= 10 && qualifying.every((message, index) =>
    index === 0 || message.direction !== qualifying[index - 1]?.direction
  );

  if (alternates && inbound.length >= 5 && aiOutbound.length >= 5) {
    return {
      triggered: true,
      guard: "rapid_exchange",
      inboundCount: inbound.length,
      aiOutboundCount: aiOutbound.length
    };
  }

  return { triggered: false };
}
