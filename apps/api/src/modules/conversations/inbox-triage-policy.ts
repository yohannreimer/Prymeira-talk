export type TriageDecision = "needs_reply" | "no_reply" | "uncertain";

export type TriageMessage = {
  id: string;
  direction: "inbound" | "outbound";
  author: "cliente" | "empresa_humano" | "empresa_ia";
  type: string;
  body: string | null;
  createdAt: string;
  caption?: string | null;
  transcript?: string | null;
  status?: string | null;
  metadata?: unknown;
};

export function hasPendingHandoff(c: {
  status: string;
  aiControlStatus: string;
  activeAgentSessionStatus?: string | null;
  handoffReason?: string | null;
  handoffActionCompletedAt?: string | null;
}) {
  return c.status !== "closed" && !c.handoffActionCompletedAt &&
    (c.activeAgentSessionStatus === "handoff_requested" ||
      (c.aiControlStatus === "human_controlled" && Boolean(c.handoffReason)));
}

export function shouldShowUnread(c: {
  unreadCount: number;
  aiControlStatus: string;
  pendingHandoff: boolean;
}) {
  return c.unreadCount > 0 && (c.aiControlStatus === "human_controlled" || c.pendingHandoff);
}

export function shouldShowMarked(c: { manualMarkedAt: Date | string | null }) {
  return c.manualMarkedAt !== null;
}

export function shouldShowReply(c: {
  aiControlStatus: string;
  pendingHandoff: boolean;
  decision: TriageDecision | null;
  dismissed: boolean;
}) {
  return c.pendingHandoff ||
    (c.aiControlStatus === "human_controlled" && !c.dismissed &&
      (c.decision === "needs_reply" || c.decision === "uncertain"));
}

function isUsefulMessage(message: TriageMessage) {
  if (message.type === "system" || message.type === "internal_note") return false;
  if (message.status !== "pending") return true;
  const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown> : null;
  return metadata?.source !== "followup_review";
}

export function formatTriageContext(messages: TriageMessage[]) {
  return messages.filter(isUsefulMessage).slice(-20).map((message) => {
    const author = message.author === "cliente" ? "Cliente" :
      message.author === "empresa_ia" ? "Empresa (IA)" : "Empresa (humano)";
    const content = [message.body, message.caption, message.transcript]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join("\n")
      .slice(0, 2_000) || "conteúdo indisponível";
    return `[id=${message.id}; ${message.createdAt}; ${author}; tipo=${message.type}]\n${content}`;
  }).join("\n\n");
}
