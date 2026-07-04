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
    throw new Error("Invalid agent output.");
  }

  return result.data;
}

function normalizeAgentOutputShape(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const alternateReply = record.reply ?? record.answer ?? record.message ?? record.content;

  return {
    ...record,
    ...(record.reply === undefined && typeof alternateReply === "string"
      ? { reply: alternateReply }
      : {})
  };
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
