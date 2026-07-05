import { z } from "zod";

const agentActionSchema = z
  .object({
    type: z.string().trim().min(1)
  })
  .catchall(z.unknown());

const agentSourceSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    category: z.string().optional()
  })
  .catchall(z.unknown());

const agentHandoffSchema = z
  .object({
    required: z.boolean().default(false),
    reason: z.string().nullable().optional().transform((reason) => reason ?? null)
  })
  .default({ required: false, reason: null });

export const agentOutputSchema = z.object({
  confidence: z.number().min(0).max(1).default(0.72),
  reply: z.string().trim().min(1).nullable().optional(),
  actions: z.array(agentActionSchema).default([]),
  handoff: agentHandoffSchema,
  sources: z.array(agentSourceSchema).optional()
});

export type AgentOutput = z.infer<typeof agentOutputSchema>;

export interface AgentProviderInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  context: Record<string, unknown>;
}

export interface AgentProvider {
  generate(input: AgentProviderInput): Promise<AgentOutput>;
}

export interface OpenAiCompatibleAgentProviderInput {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  fetchImpl?: typeof fetch;
}

const openAiCompatibleResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string()
        })
      })
    )
    .min(1)
});

export function parseAgentOutput(value: unknown): AgentOutput {
  const result = agentOutputSchema.safeParse(normalizeAgentOutputShape(value));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
      .slice(0, 4)
      .join("; ");
    throw new Error(`Invalid agent output.${issues ? ` ${issues}` : ""}`);
  }

  return result.data;
}

function normalizeAgentOutputShape(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const nested = [
    record.response,
    record.output,
    record.result,
    record.data
  ].find(isRecord);
  const outputRecord = nested ? { ...record, ...nested } : record;
  const confidence = normalizeConfidence(outputRecord.confidence ?? outputRecord.score);
  const actions = normalizeActions(outputRecord.actions);
  const alternateReply = readReply(outputRecord) ?? readReplyFromActions(actions);
  const handoff = normalizeHandoff(
    outputRecord.handoff ?? outputRecord.shouldHandoff ?? outputRecord.handoffRequired
  );
  const sources = normalizeSources(outputRecord.sources ?? outputRecord.citations);

  return {
    ...outputRecord,
    ...(outputRecord.reply === undefined && typeof alternateReply === "string"
      ? { reply: alternateReply }
      : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(actions !== undefined ? { actions } : {}),
    ...(handoff !== undefined ? { handoff } : {}),
    ...(sources !== undefined ? { sources } : {})
  };
}

function readReply(record: Record<string, unknown>) {
  const directReply = record.reply ?? record.answer ?? record.message ?? record.content ?? record.text;
  if (typeof directReply === "string") {
    return directReply;
  }

  if (isRecord(directReply)) {
    const nestedReply =
      directReply.reply ??
      directReply.answer ??
      directReply.message ??
      directReply.content ??
      directReply.text;
    return typeof nestedReply === "string" ? nestedReply : undefined;
  }

  return undefined;
}

function normalizeConfidence(value: unknown) {
  const confidence = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;

  if (!Number.isFinite(confidence)) {
    return undefined;
  }

  if (confidence > 1 && confidence <= 100) {
    return confidence / 100;
  }

  return confidence;
}

function normalizeActions(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((action) => {
    if (typeof action === "string") {
      return { type: normalizeActionType(action) };
    }

    if (!isRecord(action)) {
      return action;
    }

    const actionType =
      typeof action.type === "string"
        ? action.type
        : typeof action.action === "string"
          ? action.action
          : undefined;

    if (actionType) {
      return {
        ...action,
        type: normalizeActionType(actionType)
      };
    }

    return action;
  });
}

function normalizeActionType(type: string) {
  return ["reply", "send_reply", "respond"].includes(type.trim().toLocaleLowerCase("en-US"))
    ? "send_message"
    : type;
}

function readReplyFromActions(actions: unknown[] | undefined) {
  if (!actions) {
    return undefined;
  }

  for (const action of actions) {
    if (!isRecord(action) || action.type !== "send_message") {
      continue;
    }

    const reply =
      action.reply ??
      action.message ??
      action.body ??
      action.text ??
      action.content ??
      action.answer;

    if (typeof reply === "string" && reply.trim()) {
      return reply;
    }
  }

  return undefined;
}

function normalizeHandoff(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  const booleanValue = normalizeBoolean(value);
  if (booleanValue !== null) {
    return {
      required: booleanValue,
      reason: null
    };
  }

  if (!isRecord(value)) {
    return value;
  }

  const required =
    normalizeBoolean(value.required) ??
    normalizeBoolean(value.isRequired) ??
    normalizeBoolean(value.needed) ??
    false;
  const reason = typeof value.reason === "string" && value.reason.trim().length > 0
    ? value.reason
    : typeof value.message === "string" && value.message.trim().length > 0
      ? value.message
      : null;

  return {
    ...value,
    required,
    reason
  };
}

function normalizeSources(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((source) => {
    if (typeof source === "string") {
      return { title: source };
    }

    return source;
  });
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "sim", "yes", "1"].includes(normalized)) {
      return true;
    }

    if (["false", "nao", "não", "no", "0"].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createOpenAiCompatibleAgentProvider(
  input: OpenAiCompatibleAgentProviderInput
): AgentProvider {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  return {
    async generate(agentInput) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: input.chatModel,
            temperature: 0.2,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: buildOpenAiCompatibleSystemPrompt(agentInput.systemPrompt)
              },
              {
                role: "user",
                content: JSON.stringify({
                  userPrompt: agentInput.userPrompt,
                  context: agentInput.context
                })
              }
            ]
          })
        });
      } catch {
        throw new Error("OpenAI-compatible provider request failed.");
      }

      if (!response.ok) {
        throw new Error(
          `OpenAI-compatible provider request failed with status ${response.status}.`
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("OpenAI-compatible provider returned invalid JSON response.");
      }

      const providerResponse = openAiCompatibleResponseSchema.safeParse(payload);
      if (!providerResponse.success) {
        throw new Error("OpenAI-compatible provider returned invalid JSON response.");
      }

      const content = providerResponse.data.choices[0].message.content;
      if (content.trim().length === 0) {
        throw new Error("OpenAI-compatible provider returned empty content.");
      }

      return parseAgentOutputContent(content);
    }
  };
}

function parseAgentOutputContent(content: string): AgentOutput {
  const trimmedContent = content.trim();

  try {
    const parsedContent = JSON.parse(trimmedContent) as unknown;
    return parseAgentOutput(parsedContent);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    const jsonCandidate = extractFirstJsonObject(trimmedContent);
    if (jsonCandidate) {
      try {
        const parsedCandidate = JSON.parse(jsonCandidate) as unknown;
        return parseAgentOutput(parsedCandidate);
      } catch (candidateError) {
        if (!(candidateError instanceof SyntaxError)) {
          throw candidateError;
        }
      }
    }
  }

  return parseAgentOutput({
    confidence: 0.62,
    reply: trimmedContent,
    actions: [],
    handoff: {
      required: false,
      reason: null
    }
  });
}

function extractFirstJsonObject(value: string) {
  const start = value.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

function buildOpenAiCompatibleSystemPrompt(systemPrompt: string): string {
  return [
    systemPrompt,
    "",
    "Strict operational rules:",
    "- respond only valid JSON",
    "- use full conversation history before answering",
    "- use selected documents when relevant",
    "- do not invent prices, policies, deadlines, guarantees, legal terms",
    "- if insufficient basis, request human handoff",
    '- required JSON shape: {"confidence": number between 0 and 1, "reply": string or null, "actions": array of objects with "type", "handoff": {"required": boolean, "reason": string or null}, "sources": array of cited selected documents or empty array}'
  ].join("\n");
}

export function createSimulatedAgentProvider(): AgentProvider {
  return {
    async generate(input) {
      const messageBody =
        typeof input.context.messageBody === "string" ? input.context.messageBody : "";
      const normalizedText = `${input.userPrompt} ${messageBody}`.toLocaleLowerCase("pt-BR");
      const shouldHandoff =
        normalizedText.includes("nao sei") ||
        normalizedText.includes("não sei") ||
        normalizedText.includes("irritado");

      if (shouldHandoff) {
        return parseAgentOutput({
          reply:
            "Vou chamar uma pessoa do time para continuar este atendimento com mais segurança.",
          confidence: 0.32,
          handoff: {
            required: true,
            reason: "Baixa confiança ou sinal de irritação do cliente."
          },
          actions: [
            {
              type: "request_handoff",
              reason: "Baixa confiança ou sinal de irritação do cliente."
            }
          ]
        });
      }

      return parseAgentOutput({
        reply:
          "Sou o assistente simulado da Prymeira Talk. Posso ajudar com informações objetivas e encaminhar o atendimento quando necessário.",
        confidence: 0.84,
        actions: [{ type: "add_tag", tagName: "Atendido pela IA" }],
        handoff: {
          required: false,
          reason: null
        }
      });
    }
  };
}
