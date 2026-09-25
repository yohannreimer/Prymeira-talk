import { z } from "zod";

export type AgentImprovementKind = "not_sold" | "made_to_order" | "policy" | "faq";
export type AgentImprovementScope =
  | "requested_item_only"
  | "requested_item_variations"
  | "material_or_finish_family"
  | "broader_catalog_scope";

export type AgentImprovementDetectorInput = {
  workspaceId: string;
  customerMessage: string;
  humanReply: string;
  conversationMessages: Array<{
    label: "cliente" | "atendente" | "nota interna" | "sistema";
    body: string | null;
    createdAt: string | null;
  }>;
};

export type AgentImprovementAssessment =
  | { outcome: "ignore"; reason: string; provider?: string }
  | { outcome: "suggest"; kind: AgentImprovementKind; confidence: number; provider?: string };

export type AgentImprovementDetector = {
  assess(input: AgentImprovementDetectorInput): Promise<AgentImprovementAssessment>;
};

export type AgentImprovementNormalizationInput = {
  kind: AgentImprovementKind;
  customerMessage: string;
  humanReply: string;
  proposedContent: string;
  clarificationAnswers: Record<string, string>;
  clarificationQuestions?: Record<string, string>;
};

export type AgentImprovementNormalization = {
  scope: AgentImprovementScope;
  confidence: number;
  requiresHandoffOutsideScope: boolean;
};

export type AgentImprovementNormalizationResult =
  | { outcome: "ready"; normalization: AgentImprovementNormalization }
  | { outcome: "needs_clarification"; reason: string };

export type AgentImprovementNormalizer = {
  normalize(input: AgentImprovementNormalizationInput): Promise<AgentImprovementNormalizationResult>;
};

export type JevAgentImprovementDetectorOptions = {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

const kindSchema = z.enum(["not_sold", "made_to_order", "policy", "faq", "none"]);
const normalizationScopeSchema = z.enum([
  "requested_item_only",
  "requested_item_variations",
  "material_or_finish_family",
  "broader_catalog_scope",
  "ambiguous"
]);

const responseSchema = z.object({
  answers: z.object({
    shouldSuggest: z.object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1)
    }),
    kind: z.object({
      type: z.literal("choice"),
      choice: kindSchema,
      confidence: z.number().min(0).max(1)
    })
  })
});

const normalizationResponseSchema = z.object({
  answers: z.object({
    scope: z.object({
      type: z.literal("choice"),
      choice: normalizationScopeSchema,
      confidence: z.number().min(0).max(1)
    }),
    answersAreClear: z.object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1)
    }),
    proposalMatchesAnswers: z.object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1)
    }),
    requiresHandoffOutsideScope: z.object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1)
    })
  })
});

const questions = {
  shouldSuggest: {
    type: "noul",
    instructions:
      "A última resposta do atendente humano, depois de um repasse do agente, confirma uma regra comercial ou de atendimento reutilizável para consultas futuras? Só considere verdadeiro quando a resposta for explícita e possa ser reutilizada sem inventar preço, estoque, prazo, frete, equivalência técnica ou uma decisão particular do cliente.",
    criteria: {
      true: "Há uma orientação explícita e durável, como item não comercializado, atendimento sob encomenda sob condições informadas, política fixa ou resposta recorrente de FAQ.",
      false: "É apenas conferência pontual de estoque, preço, prazo, negociação, resposta incompleta, decisão individual ou algo que ainda exige confirmação humana."
    }
  },
  kind: {
    type: "choice",
    instructions:
      "Qual categoria descreve a regra confirmada pelo humano? Escolha none se não houver base segura para sugerir aprendizado.",
    criteria: {
      not_sold: "O humano confirmou que o item ou variação solicitada não é comercializado.",
      made_to_order: "O humano confirmou de forma explícita um atendimento sob encomenda ou sob condição comercial reutilizável.",
      policy: "O humano confirmou uma política estável de atendimento ou comercial.",
      faq: "O humano deu uma resposta factual recorrente que pode entrar como FAQ.",
      none: "Não há regra reutilizável com segurança."
    }
  }
} as const;

const normalizationQuestions = {
  scope: {
    type: "choice",
    instructions:
      "Interprete as respostas junto das perguntas correspondentes, do pedido e da decisão humana. Ignore o texto proposto nesta pergunta: ele pode ser um rascunho antigo e contradizer as respostas. Uma confirmação de todas as variações do item solicitado não autoriza ampliar a recusa para toda a construção civil. Qual é o alcance confirmado pelo time? Escolha ambiguous somente se as respostas não permitirem definir esse alcance.",
    criteria: {
      requested_item_only: "A decisão é limitada exatamente ao item solicitado, sem incluir suas medidas, acabamentos ou variações.",
      requested_item_variations: "A decisão vale para as variações do mesmo item solicitado, como medidas, espessuras, acabamentos ou furações explicitamente abrangidos.",
      material_or_finish_family: "A decisão se estende a uma família pelo material ou acabamento, como 'nada galvanizado', mas não deve ser aplicada a outros materiais sem confirmação.",
      broader_catalog_scope: "O time confirmou uma regra de catálogo mais ampla e inequívoca, além do item, variações e família de material/acabamento.",
      ambiguous: "Há conflito, falta de detalhe ou texto que não permite definir um escopo seguro."
    }
  },
  answersAreClear: {
    type: "noul",
    instructions:
      "As respostas internas do time, lidas com as perguntas correspondentes, são suficientes e coerentes com o pedido e a decisão original para delimitar uma regra? Ignore o texto proposto nesta pergunta: ele pode ser um rascunho antigo. Uma confirmação curta como 'exato' responde afirmativamente à pergunta anterior. Não presuma informação ausente.",
    criteria: {
      true: "As respostas delimitam o escopo e as exceções de modo claro.",
      false: "As respostas se contradizem, usam linguagem vaga ou não esclarecem o escopo ou as exceções."
    }
  },
  proposalMatchesAnswers: {
    type: "noul",
    instructions:
      "O texto proposto respeita o escopo e as exceções confirmados nas respostas, sem acrescentar recusa, disponibilidade ou exceção não confirmada? Uma regra que exige repasse para variações que o time explicitamente incluiu no escopo é inconsistente. Não presuma informação ausente.",
    criteria: {
      true: "O texto proposto aplica a decisão somente ao escopo confirmado e encaminha apenas consultas fora dele.",
      false: "O texto proposto contradiz as respostas, restringe indevidamente o escopo confirmado ou amplia a recusa além do confirmado."
    }
  },
  requiresHandoffOutsideScope: {
    type: "noul",
    instructions:
      "Uma nova consulta que fique fora do escopo definido deve ser encaminhada ao comercial para não generalizar a regra?",
    criteria: {
      true: "Qualquer diferença fora do escopo precisa de confirmação humana.",
      false: "A regra aprovada descreve explicitamente um catálogo amplo o bastante para responder sem encaminhamento."
    }
  }
} as const;

function contextualizeClarificationAnswers(state: AgentImprovementNormalizationInput) {
  const answers = { ...state.clarificationAnswers };
  if (
    state.kind === "not_sold" &&
    /^(?:sim|isso mesmo|exato|exatamente|correto)[\s.!?]*$/i.test(answers.scope?.trim() ?? "")
  ) {
    answers.scope =
      "Sim, a decisão vale para todas as medidas, espessuras, acabamentos e furações do item solicitado.";
  }

  return Object.fromEntries(
    Object.entries(answers).map(([questionId, answer]) => [
      questionId.slice(0, 80),
      answer.slice(0, 800)
    ])
  );
}

export function createJevAgentImprovementDetector(
  input: JevAgentImprovementDetectorOptions
): AgentImprovementDetector {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  return {
    async assess(state) {
      const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        signal: AbortSignal.timeout(12_000),
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: input.model ?? "jev-latest",
          state: {
            customerMessage: state.customerMessage.slice(0, 2_500),
            humanReply: state.humanReply.slice(0, 2_500),
            conversationMessages: state.conversationMessages.slice(-12).map((message) => ({
              label: message.label,
              body: message.body?.slice(0, 1_500) ?? null,
              createdAt: message.createdAt
            }))
          },
          questions
        })
      });

      if (!response.ok) {
        throw new Error(`JEV_AGENT_IMPROVEMENT_HTTP_${response.status}`);
      }

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("JEV_AGENT_IMPROVEMENT_RESPONSE_INVALID");
      }

      const { shouldSuggest, kind } = parsed.data.answers;
      const confidence = Math.min(shouldSuggest.noul, kind.confidence);

      if (confidence < 0.8 || kind.choice === "none") {
        return { outcome: "ignore", reason: "not_a_durable_human_resolution" };
      }

      return {
        outcome: "suggest",
        kind: kind.choice,
        confidence
      };
    }
  };
}

export function createJevAgentImprovementNormalizer(
  input: JevAgentImprovementDetectorOptions
): AgentImprovementNormalizer {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  return {
    async normalize(state) {
      const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        signal: AbortSignal.timeout(12_000),
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: input.model ?? "jev-latest",
          state: {
            kind: state.kind,
            customerMessage: state.customerMessage.slice(0, 2_500),
            humanReply: state.humanReply.slice(0, 2_500),
            proposedContent: state.proposedContent.slice(0, 4_000),
            clarificationAnswers: contextualizeClarificationAnswers(state),
            clarificationQuestions: Object.fromEntries(
              Object.entries(state.clarificationQuestions ?? {}).map(([questionId, question]) => [
                questionId.slice(0, 80),
                question.slice(0, 800)
              ])
            )
          },
          questions: normalizationQuestions
        })
      });

      if (!response.ok) {
        throw new Error(`JEV_AGENT_IMPROVEMENT_NORMALIZATION_HTTP_${response.status}`);
      }

      const parsed = normalizationResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("JEV_AGENT_IMPROVEMENT_NORMALIZATION_RESPONSE_INVALID");
      }

      const { scope, answersAreClear, proposalMatchesAnswers, requiresHandoffOutsideScope } = parsed.data.answers;
      const confidence = Math.min(scope.confidence, answersAreClear.noul, proposalMatchesAnswers.noul);
      if (scope.choice === "ambiguous" || Math.min(scope.confidence, answersAreClear.noul) < 0.8) {
        return { outcome: "needs_clarification", reason: "normalization_ambiguous" };
      }
      if (proposalMatchesAnswers.noul < 0.8) {
        return { outcome: "needs_clarification", reason: "draft_inconsistent" };
      }

      return {
        outcome: "ready",
        normalization: {
          scope: scope.choice,
          confidence,
          requiresHandoffOutsideScope: requiresHandoffOutsideScope.noul >= 0.5
        }
      };
    }
  };
}
