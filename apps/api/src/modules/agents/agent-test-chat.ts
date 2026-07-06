import {
  resolveOpenAiCompatibleSettings,
  type AiProviderSettingsPrismaLike,
  type OpenAiCompatibleSettings
} from "./ai-provider-settings.js";
import {
  isDocumentDependentQuestion,
  selectRelevantKnowledge,
  type KnowledgeRetrievalSource
} from "./knowledge-retrieval.js";
import {
  createOpenAiCompatibleAgentProvider,
  type AgentOutput,
  type AgentProvider
} from "./provider-gateway.js";

type JsonValue = unknown;

type AgentRecord = {
  id: string;
  workspaceId: string;
  model: string;
  systemPrompt: string;
  handoffConfig?: JsonValue;
  allowedTags?: Array<{
    tag?: {
      id: string;
      name: string;
      color: string | null;
      useGuide: string | null;
      isActive: boolean;
    } | null;
  }>;
};

type AllowedAgentTag = {
  id: string;
  name: string;
  color: string | null;
  useGuide: string | null;
};

type KnowledgeSourceRecord = {
  id: string;
  title: string;
  content: string | null;
  metadata?: JsonValue;
};

export type AgentTestChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentTestChatResult = {
  message: AgentTestChatMessage;
  output: AgentOutput;
  knowledgeMatches: Array<Record<string, unknown>>;
  debug: AgentTestChatDebug;
};

export type AgentTestChatDebug = {
  providerMode: "real" | "simulated";
  model: string;
  totalKnowledgeSources: number;
  selectedKnowledgeSources: number;
  selectedKnowledgeCharacters: number;
  conversationMessages: number;
  conversationCharacters: number;
  allowedTags: string[];
  knowledgeMatches: Array<Record<string, unknown>>;
  output?: {
    confidence: number;
    handoffRequired: boolean;
    handoffReason: string | null;
    replyCharacters: number;
  };
  providerError?: string;
};

export interface AgentTestChatPrismaLike {
  aiAgent: {
    findFirst(args: unknown): Promise<AgentRecord | null>;
  };
  aiKnowledgeSource: {
    findMany(args: unknown): Promise<KnowledgeSourceRecord[]>;
  };
  integrationConfig: AiProviderSettingsPrismaLike["integrationConfig"];
}

export class AgentTestChatError extends Error {
  constructor(
    public readonly code:
      | "AGENT_NOT_FOUND"
      | "TEST_CHAT_INVALID_MESSAGES"
      | "AGENT_PROVIDER_FAILED",
    message: string,
    public readonly debug?: AgentTestChatDebug
  ) {
    super(message);
    this.name = "AgentTestChatError";
  }
}

const agentInclude = {
  allowedTags: {
    include: { tag: true },
    orderBy: { tag: { name: "asc" } }
  }
} as const;

export function createAgentTestChatService(input: {
  prisma: AgentTestChatPrismaLike;
  provider: AgentProvider;
  providerFactory?: (settings: Extract<OpenAiCompatibleSettings, { active: true }>) => AgentProvider;
}) {
  const { prisma, provider } = input;

  return {
    async sendMessage(runInput: {
      workspaceId: string;
      agentId: string;
      messages: AgentTestChatMessage[];
    }): Promise<AgentTestChatResult> {
      const latestUserMessage = [...runInput.messages].reverse().find((message) => message.role === "user");
      if (!latestUserMessage || latestUserMessage.content.trim().length === 0) {
        throw new AgentTestChatError(
          "TEST_CHAT_INVALID_MESSAGES",
          "Test chat requires at least one user message."
        );
      }

      const agent = await prisma.aiAgent.findFirst({
        where: {
          workspaceId: runInput.workspaceId,
          id: runInput.agentId
        },
        include: agentInclude
      });

      if (!agent) {
        throw new AgentTestChatError("AGENT_NOT_FOUND", "Agent not found.");
      }

      const knowledge = await prisma.aiKnowledgeSource.findMany({
        where: {
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          status: "ready"
        },
        orderBy: [{ createdAt: "desc" }],
        take: 50
      });
      const conversationHistory = formatTestConversationHistory(runInput.messages);
      const knowledgeSelection = selectRelevantKnowledge({
        latestMessage: latestUserMessage.content,
        conversationHistory,
        instruction: null,
        sources: knowledge.map(toRetrievalSource)
      });
      const knowledgeMatches = knowledgeSelection.selected.map((source) => ({
        id: source.id,
        title: source.title,
        category: source.category,
        score: source.score,
        reasons: source.reasons,
        includedAs: source.includedAs
      }));
      const allowedTags = toAllowedTags(agent);

      const providerSettings = await resolveOpenAiCompatibleSettings(prisma, {
        workspaceId: runInput.workspaceId
      });
      const runProvider = providerSettings.active
        ? (input.providerFactory ?? createOpenAiCompatibleAgentProvider)(providerSettings)
        : provider;
      const model = providerSettings.active ? providerSettings.chatModel : agent.model;
      const debugBase: AgentTestChatDebug = {
        providerMode: providerSettings.active ? "real" : "simulated",
        model,
        totalKnowledgeSources: knowledgeSelection.total,
        selectedKnowledgeSources: knowledgeSelection.selected.length,
        selectedKnowledgeCharacters: knowledgeSelection.selected.reduce(
          (total, source) => total + source.content.length,
          0
        ),
        conversationMessages: runInput.messages.length,
        conversationCharacters: conversationHistory.length,
        allowedTags: allowedTags.map((tag) => tag.name),
        knowledgeMatches
      };

      let output: AgentOutput;

      if (
        isDocumentDependentQuestion(`${latestUserMessage.content}\n${conversationHistory}`) &&
        knowledgeSelection.selected.length === 0
      ) {
        output = createDocumentRequiredHandoffOutput();
      } else {
        try {
          output = await runProvider.generate({
            model,
            systemPrompt: agent.systemPrompt,
            userPrompt: latestUserMessage.content,
            context: {
              messageBody: latestUserMessage.content,
              conversationHistory,
              conversationMessages: runInput.messages,
              allowedTags,
              testMode: true,
              knowledge: knowledgeSelection.selected.map((source) => ({
                title: source.title,
                content: source.content
              }))
            }
          });
        } catch (error) {
          const detail = error instanceof Error ? ` Detalhe: ${error.message}` : "";
          const providerError =
            error instanceof Error ? error.message : "Erro desconhecido do provedor.";
          throw new AgentTestChatError(
            "AGENT_PROVIDER_FAILED",
            `Não foi possível obter resposta do provedor de IA. Verifique a chave, modelo e URL em Ajustes.${detail}`,
            {
              ...debugBase,
              providerError
            }
          );
        }
      }

      const debug: AgentTestChatDebug = {
        ...debugBase,
        output: {
          confidence: output.confidence,
          handoffRequired: output.handoff.required,
          handoffReason: output.handoff.reason,
          replyCharacters: output.reply?.length ?? 0
        }
      };

      return {
        message: {
          role: "assistant",
          content: output.reply?.trim() || "Vou chamar uma pessoa do time para continuar este teste."
        },
        output,
        knowledgeMatches,
        debug
      };
    }
  };
}

function formatTestConversationHistory(messages: AgentTestChatMessage[]) {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => `${message.role === "user" ? "cliente" : "atendente"}: ${message.content.trim()}`)
    .join("\n");
}

function createDocumentRequiredHandoffOutput(): AgentOutput {
  const reason = "No relevant document found for a document-dependent question.";

  return {
    confidence: 0.2,
    reply: "Vou chamar uma pessoa do time para confirmar essa informação com segurança.",
    actions: [{ type: "request_handoff", reason }],
    handoff: {
      required: true,
      reason
    }
  };
}

function toRetrievalSource(source: KnowledgeSourceRecord): KnowledgeRetrievalSource {
  return {
    id: source.id,
    title: source.title,
    content: source.content,
    metadata: isRecord(source.metadata) ? source.metadata : null
  };
}

function toAllowedTags(agent: Pick<AgentRecord, "allowedTags">): AllowedAgentTag[] {
  return (
    agent.allowedTags
      ?.filter((item) => item.tag?.isActive)
      .map((item) => ({
        id: item.tag!.id,
        name: item.tag!.name,
        color: item.tag!.color,
        useGuide: item.tag!.useGuide
      })) ?? []
  );
}

function isRecord(value: JsonValue): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
