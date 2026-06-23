import { z } from "zod";

export const agentOutputSchema = z.object({
  confidence: z.number().min(0).max(1),
  reply: z.string().trim().min(1).nullable().optional(),
  actions: z.array(z.record(z.string(), z.unknown())).default([]),
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

export function parseAgentOutput(value: unknown): AgentOutput {
  const result = agentOutputSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Invalid agent output.");
  }

  return result.data;
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
