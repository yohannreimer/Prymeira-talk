import { z } from "zod";

const agentActionSchema = z
  .object({
    type: z.string().trim().min(1)
  })
  .catchall(z.unknown());

export const agentOutputSchema = z.object({
  confidence: z.number().min(0).max(1),
  reply: z.string().trim().min(1).nullable().optional(),
  actions: z.array(agentActionSchema).default([]),
  handoff: z.object({
    required: z.boolean(),
    reason: z.string().nullable()
  })
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
  const result = agentOutputSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Invalid agent output.");
  }

  return result.data;
}

export function createOpenAiCompatibleAgentProvider(
  input: OpenAiCompatibleAgentProviderInput
): AgentProvider {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  return {
    async generate(agentInput) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
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

      if (!response.ok) {
        throw new Error(
          `OpenAI-compatible provider request failed with status ${response.status}.`
        );
      }

      const payload = await response.json();
      const providerResponse = openAiCompatibleResponseSchema.safeParse(payload);
      if (!providerResponse.success) {
        throw new Error("OpenAI-compatible provider returned an invalid response shape.");
      }

      const content = providerResponse.data.choices[0].message.content;
      if (content.trim().length === 0) {
        throw new Error("OpenAI-compatible provider returned empty content.");
      }

      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(content);
      } catch {
        throw new Error("OpenAI-compatible provider returned invalid JSON content.");
      }

      return parseAgentOutput(parsedContent);
    }
  };
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
            "Vou chamar uma pessoa do time para continuar este atendimento com mais seguranca.",
          confidence: 0.32,
          handoff: {
            required: true,
            reason: "Baixa confianca ou sinal de irritacao do cliente."
          },
          actions: [
            {
              type: "request_handoff",
              reason: "Baixa confianca ou sinal de irritacao do cliente."
            }
          ]
        });
      }

      return parseAgentOutput({
        reply:
          "Sou o assistente simulado da Prymeira Talk. Posso ajudar com informacoes objetivas e encaminhar o atendimento quando necessario.",
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
