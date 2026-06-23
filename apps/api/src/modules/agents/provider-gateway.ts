import { z } from "zod";

const prioritySchema = z.enum(["low", "normal", "high"]);

const agentActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send_message"),
    body: z.string().trim().min(1)
  }),
  z.object({
    action: z.literal("add_tag"),
    name: z.string().trim().min(1)
  }),
  z.object({
    action: z.literal("remove_tag"),
    tagId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional()
  }),
  z.object({
    action: z.literal("change_priority"),
    priority: prioritySchema
  }),
  z.object({
    action: z.literal("create_internal_note"),
    body: z.string().trim().min(1)
  }),
  z.object({
    action: z.literal("assign_user"),
    userId: z.string().trim().min(1)
  }),
  z.object({
    action: z.literal("assign_department"),
    departmentId: z.string().trim().min(1)
  }),
  z.object({
    action: z.literal("request_handoff"),
    reason: z.string().trim().min(1).optional()
  })
]);

export const agentOutputSchema = z.object({
  reply: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
  shouldHandoff: z.boolean(),
  handoffReason: z.string().trim().min(1).optional(),
  actions: z.array(agentActionSchema).default([])
});

export type AgentOutput = z.infer<typeof agentOutputSchema>;

export interface AgentProviderInput {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  text: string;
  systemPrompt?: string;
  knowledgeSnippets?: string[];
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
      const normalizedText = input.text.toLocaleLowerCase("pt-BR");
      const shouldHandoff =
        normalizedText.includes("nao sei") ||
        normalizedText.includes("não sei") ||
        normalizedText.includes("irritado");

      if (shouldHandoff) {
        return parseAgentOutput({
          reply:
            "Vou chamar uma pessoa do time para continuar este atendimento com mais seguranca.",
          confidence: 0.32,
          shouldHandoff: true,
          handoffReason: "Baixa confianca ou sinal de irritacao do cliente.",
          actions: [
            {
              action: "request_handoff",
              reason: "Baixa confianca ou sinal de irritacao do cliente."
            }
          ]
        });
      }

      return parseAgentOutput({
        reply:
          "Sou o assistente simulado da Prymeira Talk. Posso ajudar com informacoes objetivas e encaminhar o atendimento quando necessario.",
        confidence: 0.84,
        shouldHandoff: false,
        actions: [{ action: "add_tag", name: "Atendido pela IA" }]
      });
    }
  };
}
