type ConversationMessageRecord = {
  id: string;
  direction?: string | null;
  type?: string | null;
  body?: string | null;
  createdAt?: Date | string | null;
};

export type NormalizedConversationMessage = {
  id: string;
  direction: string | null;
  type: string | null;
  label: "cliente" | "atendente" | "nota interna" | "sistema";
  body: string | null;
  createdAt: string | null;
};

export type ConversationContext = {
  messages: NormalizedConversationMessage[];
  formattedHistory: string;
};

export type ConversationContextBuilderPrismaLike = {
  message: {
    findMany(args: unknown): Promise<ConversationMessageRecord[]>;
  };
};

const DEFAULT_MESSAGE_LIMIT = 80;

export async function buildConversationContext(
  prisma: ConversationContextBuilderPrismaLike,
  input: {
    workspaceId: string;
    conversationId: string;
    limit?: number;
  }
): Promise<ConversationContext> {
  const messages = await prisma.message.findMany({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId
    },
    orderBy: [{ createdAt: "asc" }],
    take: input.limit ?? DEFAULT_MESSAGE_LIMIT
  });

  const normalizedMessages = messages.map(normalizeConversationMessage);

  return {
    messages: normalizedMessages,
    formattedHistory: normalizedMessages
      .filter((message) => typeof message.body === "string" && message.body.trim().length > 0)
      .map(
        (message) =>
          `[${message.createdAt ?? "sem data"}] ${message.label}: ${message.body?.trim()}`
      )
      .join("\n")
  };
}

function normalizeConversationMessage(
  message: ConversationMessageRecord
): NormalizedConversationMessage {
  return {
    id: message.id,
    direction: message.direction ?? null,
    type: message.type ?? null,
    label: resolveMessageLabel(message),
    body: message.body ?? null,
    createdAt: normalizeCreatedAt(message.createdAt)
  };
}

function resolveMessageLabel(
  message: Pick<ConversationMessageRecord, "direction" | "type">
): NormalizedConversationMessage["label"] {
  if (message.type === "internal_note") {
    return "nota interna";
  }

  if (message.direction === "inbound") {
    return "cliente";
  }

  if (message.direction === "outbound") {
    return "atendente";
  }

  return "sistema";
}

function normalizeCreatedAt(value: ConversationMessageRecord["createdAt"]) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value ?? null;
}
