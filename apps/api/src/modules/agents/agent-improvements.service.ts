import type { Prisma } from "@prisma/client";
import {
  aiAgentImprovementNormalizationSchema,
  type AiAgentImprovementDto
} from "@prymeira-talk/shared";
import type {
  AgentImprovementAssessment,
  AgentImprovementDetector,
  AgentImprovementKind,
  AgentImprovementNormalizer
} from "./jev-agent-improvement.js";

type DateLike = Date | string;
type ImprovementStatus = AiAgentImprovementDto["status"];
type ClarificationQuestion = AiAgentImprovementDto["clarification"]["questions"][number];
type ImprovementNormalization = NonNullable<AiAgentImprovementDto["clarification"]["normalization"]>;

type AgentRecord = {
  id: string;
  workspaceId: string;
};

type HandoffSessionRecord = {
  id: string;
  agentId: string;
  lastRunAt?: DateLike | null;
};

type ConversationRecord = { activeAgentSessionId: string | null };

type MessageRecord = {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  metadata?: Prisma.JsonValue;
  createdAt: DateLike;
};

type ImprovementRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  sourceMessageId: string;
  status: ImprovementStatus;
  kind: AgentImprovementKind;
  title: string;
  content: string;
  rationale: string | null;
  sourceCustomerMessage: string;
  sourceHumanReply: string;
  detector: Prisma.JsonValue;
  clarificationAnswers: Prisma.JsonValue;
  clarificationNormalization: Prisma.JsonValue;
  reviewedAt: DateLike | null;
  acceptedKnowledgeSourceId: string | null;
  createdAt: DateLike;
  updatedAt: DateLike;
};

type KnowledgeRecord = { id: string };

type TransactionPrismaLike = {
  aiKnowledgeSource: {
    create(args: unknown): Promise<KnowledgeRecord>;
  };
  aiAgentImprovement: {
    update(args: unknown): Promise<ImprovementRecord>;
  };
};

export interface AgentImprovementsPrismaLike {
  conversation: {
    findFirst(args: unknown): Promise<ConversationRecord | null>;
  };
  aiAgent: {
    findFirst(args: unknown): Promise<AgentRecord | null>;
  };
  aiAgentSession: {
    findFirst(args: unknown): Promise<HandoffSessionRecord | null>;
  };
  aiAgentRun: {
    findFirst(args: unknown): Promise<{ createdAt: DateLike } | null>;
  };
  message: {
    findFirst(args: unknown): Promise<MessageRecord | null>;
    findMany(args: unknown): Promise<MessageRecord[]>;
  };
  aiAgentImprovement: {
    findFirst(args: unknown): Promise<ImprovementRecord | null>;
    findMany(args: unknown): Promise<ImprovementRecord[]>;
    create(args: unknown): Promise<ImprovementRecord>;
    update(args: unknown): Promise<ImprovementRecord>;
  };
  $transaction<T>(callback: (tx: TransactionPrismaLike) => Promise<T>): Promise<T>;
}

export interface AgentImprovementObserver {
  observeHumanReply(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
  }): Promise<{ created: boolean; reason?: string }>;
  observeLatestHumanReplyAfterHandoff(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<{ created: boolean; reason?: string }>;
}

export class AgentImprovementsServiceError extends Error {
  constructor(
    public readonly code:
      | "AGENT_NOT_FOUND"
      | "IMPROVEMENT_NOT_FOUND"
      | "IMPROVEMENT_ALREADY_REVIEWED"
      | "IMPROVEMENT_CLARIFICATION_REQUIRED"
      | "IMPROVEMENT_NORMALIZATION_REQUIRED"
      | "IMPROVEMENT_NORMALIZER_UNAVAILABLE"
      | "IMPROVEMENT_NORMALIZATION_AMBIGUOUS",
    message: string
  ) {
    super(message);
    this.name = "AgentImprovementsServiceError";
  }
}

function toIso(value: DateLike | null) {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

function toRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function toStringRecord(value: Prisma.JsonValue): Record<string, string> {
  return Object.fromEntries(
    Object.entries(toRecord(value)).flatMap(([key, answer]) =>
      typeof answer === "string" && answer.trim() ? [[key, answer.trim()]] : []
    )
  );
}

function toNormalization(value: Prisma.JsonValue): ImprovementNormalization | null {
  const parsed = aiAgentImprovementNormalizationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function clarificationQuestions(kind: AgentImprovementKind): ClarificationQuestion[] {
  if (kind === "not_sold") {
    return [
      {
        id: "scope",
        question: "A decisão de não trabalhar vale para todas as medidas, espessuras, acabamentos e furações do item solicitado?",
        help: "Delimite o escopo. Ex.: “Sim, para todas as variações” ou “apenas acima de 6 mm”."
      },
      {
        id: "exceptions",
        question: "Quais medidas, acabamentos ou produtos parecidos vocês ainda comercializam?",
        help: "Se não houver exceção, escreva “Nenhuma”. Isso evita que o agente generalize a recusa."
      }
    ];
  }

  if (kind === "made_to_order") {
    return [
      {
        id: "scope",
        question: "Quais medidas, materiais ou variações podem ser atendidos sob encomenda?",
        help: "Registre somente o que a equipe confirmou, sem estimar disponibilidade."
      },
      {
        id: "conditions",
        question: "Que condição o agente deve informar antes de encaminhar a cotação?",
        help: "Ex.: análise do comercial, pedido mínimo ou necessidade de desenho técnico."
      }
    ];
  }

  if (kind === "policy") {
    return [
      {
        id: "scope",
        question: "Em quais situações essa política se aplica?",
        help: "Defina o contexto para que a regra não seja usada em negociações diferentes."
      },
      {
        id: "exceptions",
        question: "Há exceções que sempre devem ser encaminhadas ao comercial?",
        help: "Se não houver, escreva “Nenhuma”."
      }
    ];
  }

  return [
    {
      id: "scope",
      question: "Para quais produtos, clientes ou situações esta resposta é válida?",
      help: "Delimite o contexto para a resposta não ser reutilizada indevidamente."
    },
    {
      id: "exceptions",
      question: "Há alguma exceção ou informação que o agente deve confirmar antes de responder?",
      help: "Se não houver, escreva “Nenhuma”."
    }
  ];
}

function mergeClarificationAnswers(input: {
  kind: AgentImprovementKind;
  current: Prisma.JsonValue;
  next: Record<string, string>;
}) {
  const current = toStringRecord(input.current);
  const knownQuestionIds = new Set(clarificationQuestions(input.kind).map((question) => question.id));

  return Object.fromEntries(
    Object.entries({ ...current, ...input.next }).flatMap(([questionId, answer]) =>
      knownQuestionIds.has(questionId) && answer.trim() ? [[questionId, answer.trim()]] : []
    )
  );
}

function addClarificationToContent(input: {
  kind: AgentImprovementKind;
  content: string;
  answers: Record<string, string>;
  normalization?: ImprovementNormalization | null;
}) {
  const marker = "Escopo confirmado pelo time:";
  const baseContent = input.content.split(marker, 1)[0]?.trimEnd() ?? input.content.trimEnd();
  const answeredQuestions = clarificationQuestions(input.kind).flatMap((question) => {
    const answer = input.answers[question.id]?.trim();
    return answer ? [`- ${question.question}\n  Resposta: ${answer}`] : [];
  });

  if (answeredQuestions.length === 0) {
    return baseContent;
  }

  const normalizationLines = input.normalization
    ? [
        "",
        "Modo de aplicação interpretado pelo JEV:",
        `- ${normalizationScopeLabel(input.normalization.scope)}`,
        `- ${
          input.normalization.requiresHandoffOutsideScope
            ? "Fora desse escopo, encaminhe para o comercial; não generalize a regra."
            : "A regra foi confirmada para o escopo amplo descrito acima."
        }`
      ]
    : [];

  return [baseContent, "", marker, ...answeredQuestions, ...normalizationLines].join("\n");
}

function hasCompletedClarification(kind: AgentImprovementKind, answers: Prisma.JsonValue) {
  const savedAnswers = toStringRecord(answers);
  return clarificationQuestions(kind).every((question) => Boolean(savedAnswers[question.id]?.trim()));
}

function normalizationScopeLabel(scope: ImprovementNormalization["scope"]) {
  if (scope === "requested_item_only") {
    return "Apenas o item exatamente solicitado pelo cliente.";
  }

  if (scope === "requested_item_variations") {
    return "As variações explicitamente confirmadas do item solicitado.";
  }

  if (scope === "material_or_finish_family") {
    return "A família de material ou acabamento explicitamente confirmada pelo time.";
  }

  return "O escopo mais amplo de catálogo confirmado explicitamente pelo time.";
}

function toDto(record: ImprovementRecord): AiAgentImprovementDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    agentId: record.agentId,
    conversationId: record.conversationId,
    sourceMessageId: record.sourceMessageId,
    status: record.status,
    kind: record.kind,
    title: record.title,
    content: record.content,
    rationale: record.rationale,
    sourceCustomerMessage: record.sourceCustomerMessage,
    sourceHumanReply: record.sourceHumanReply,
    detector: toRecord(record.detector),
    clarification: {
      questions: clarificationQuestions(record.kind),
      answers: toStringRecord(record.clarificationAnswers),
      normalization: toNormalization(record.clarificationNormalization)
    },
    reviewedAt: toIso(record.reviewedAt),
    acceptedKnowledgeSourceId: record.acceptedKnowledgeSourceId,
    createdAt: toIso(record.createdAt) ?? "",
    updatedAt: toIso(record.updatedAt) ?? ""
  };
}

function messageLabel(message: MessageRecord): "cliente" | "atendente" | "nota interna" | "sistema" {
  if (message.type === "internal_note") {
    return "nota interna";
  }

  return message.direction === "inbound" ? "cliente" : "atendente";
}

function isAiAgentMessage(message: MessageRecord) {
  return Boolean(
    message.metadata &&
      typeof message.metadata === "object" &&
      !Array.isArray(message.metadata) &&
      message.metadata.source === "ai_agent"
  );
}

function isExplicitCatalogRefusal(reply: string): boolean {
  return /\b(?:n[aã]o\s+(?:trabalhamos|vendemos|comercializamos|fornecemos)|(?:trabalhamos|vendemos|comercializamos|fornecemos)\s+n[aã]o)\b/i.test(reply);
}

function recentCustomerRequest(messages: MessageRecord[]): string | null {
  const inbound = messages.filter((message) => message.direction === "inbound" && message.body?.trim()).slice(-6);
  const latest = inbound.at(-1);
  if (!latest) return null;
  const latestAt = new Date(latest.createdAt).getTime();
  const relevant = inbound.filter((message) =>
    !Number.isFinite(latestAt) || latestAt - new Date(message.createdAt).getTime() <= 2 * 60 * 60 * 1000
  );
  return relevant.map((message) => message.body!.trim()).join("\n").slice(0, 2_500);
}

function buildProposal(input: {
  kind: AgentImprovementKind;
  customerMessage: string;
  humanReply: string;
  assessment: Extract<AgentImprovementAssessment, { outcome: "suggest" }>;
}) {
  const base = [
    `Pedido do cliente: ${input.customerMessage}`,
    "",
    `Decisão confirmada pelo time: ${input.humanReply}`,
    ""
  ];

  if (input.kind === "not_sold") {
    return {
      title: "Produto não comercializado — revisar",
      content: [
        ...base,
        "Quando uma consulta futura corresponder claramente ao mesmo item ou variação, informe de forma objetiva que não trabalhamos com esse produto. Não generalize para materiais parecidos; se houver diferença de medida, acabamento, furação ou equivalência, faça handoff para o comercial."
      ].join("\n"),
      rationale:
        "O humano confirmou que o item solicitado não é comercializado. A revisão define o limite exato dessa orientação antes de ela entrar na base."
    };
  }

  if (input.kind === "made_to_order") {
    return {
      title: "Orientação sob encomenda — revisar",
      content: [
        ...base,
        "Use essa orientação somente para consultas claramente equivalentes. Não invente preço, prazo, disponibilidade ou especificação que não estejam confirmados nesta regra."
      ].join("\n"),
      rationale:
        "O humano forneceu uma orientação comercial reutilizável, mas ela precisa de aprovação para delimitar o que vale para produtos equivalentes."
    };
  }

  return {
    title: input.kind === "faq" ? "Resposta recorrente — revisar" : "Política comercial — revisar",
    content: [
      ...base,
      "Aplique esta orientação apenas quando a nova consulta tiver o mesmo contexto. Em caso de exceção, negociação ou informação incompleta, faça handoff para o comercial."
    ].join("\n"),
    rationale:
      "A resposta humana parece trazer uma orientação reutilizável. Revise o texto e o escopo antes de torná-la conhecimento do agente."
  };
}

export function createAgentImprovementsService(
  prisma: AgentImprovementsPrismaLike,
  options: { detector?: AgentImprovementDetector; normalizer?: AgentImprovementNormalizer } = {}
) {
  async function ensureAgent(input: { workspaceId: string; agentId: string }) {
    const agent = await prisma.aiAgent.findFirst({
      where: { workspaceId: input.workspaceId, id: input.agentId }
    });

    if (!agent) {
      throw new AgentImprovementsServiceError("AGENT_NOT_FOUND", "Agente não encontrado.");
    }

    return agent;
  }

  async function findImprovement(input: { workspaceId: string; agentId: string; improvementId: string }) {
    const improvement = await prisma.aiAgentImprovement.findFirst({
      where: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        id: input.improvementId
      }
    });

    if (!improvement) {
      throw new AgentImprovementsServiceError(
        "IMPROVEMENT_NOT_FOUND",
        "Sugestão de aprimoramento não encontrada."
      );
    }

    return improvement;
  }

  function ensurePending(improvement: ImprovementRecord) {
    if (improvement.status !== "pending") {
      throw new AgentImprovementsServiceError(
        "IMPROVEMENT_ALREADY_REVIEWED",
        "Esta sugestão já foi revisada."
      );
    }
  }

  return {
    async observeHumanReply(input: {
      workspaceId: string;
      conversationId: string;
      messageId: string;
    }): Promise<{ created: boolean; reason?: string }> {
      const [existing, humanReply, conversation] = await Promise.all([
        prisma.aiAgentImprovement.findFirst({
          where: { workspaceId: input.workspaceId, sourceMessageId: input.messageId }
        }),
        prisma.message.findFirst({
          where: {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            id: input.messageId
          }
        }),
        prisma.conversation.findFirst({
          where: { workspaceId: input.workspaceId, id: input.conversationId },
          select: { activeAgentSessionId: true }
        })
      ]);

      if (existing) {
        return { created: false, reason: "already_observed" };
      }

      if (
        !humanReply ||
        humanReply.direction !== "outbound" ||
        !humanReply.body?.trim() ||
        isAiAgentMessage(humanReply)
      ) {
        return { created: false, reason: "not_a_text_human_reply" };
      }

      const session = conversation?.activeAgentSessionId
        ? await prisma.aiAgentSession.findFirst({
            where: {
              workspaceId: input.workspaceId,
              id: conversation.activeAgentSessionId,
              conversationId: input.conversationId,
              status: { in: ["handoff_requested", "paused_by_human"] },
              handoffReason: { not: null }
            }
          })
        : null;
      if (!session) {
        return { created: false, reason: "no_agent_handoff" };
      }

      const messages = await prisma.message.findMany({
        where: {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId
        },
        orderBy: { createdAt: "desc" },
        take: 16
      });
      const chronological = [...messages].reverse();
      const humanReplyIndex = chronological.findIndex((message) => message.id === input.messageId);
      const previousMessages = humanReplyIndex === -1 ? chronological : chronological.slice(0, humanReplyIndex);
      const customerMessage = recentCustomerRequest(previousMessages);

      if (!customerMessage) {
        return { created: false, reason: "no_customer_request" };
      }

      const directRefusal = isExplicitCatalogRefusal(humanReply.body);
      if (!options.detector && !directRefusal) return { created: false, reason: "detector_unavailable" };
      let detected: AgentImprovementAssessment;
      try {
        detected = options.detector ? await options.detector.assess({
          customerMessage,
          humanReply: humanReply.body,
          conversationMessages: chronological.map((message) => ({
            label: messageLabel(message),
            body: message.body,
            createdAt: toIso(message.createdAt)
          }))
        }) : { outcome: "ignore", reason: "detector_unavailable" };
      } catch (error) {
        if (!directRefusal) throw error;
        detected = { outcome: "ignore", reason: "detector_failed" };
      }
      // A direct refusal is still only a proposal. Reviewers must define its
      // exact catalog scope before it can become agent knowledge.
      const assessment = detected.outcome === "ignore" && directRefusal
        ? { outcome: "suggest" as const, kind: "not_sold" as const, confidence: 0.8 }
        : detected;
      if (assessment.outcome === "ignore") return { created: false, reason: assessment.reason };

      const proposal = buildProposal({
        kind: assessment.kind,
        customerMessage,
        humanReply: humanReply.body,
        assessment
      });
      try {
        await prisma.aiAgentImprovement.create({
          data: {
            workspaceId: input.workspaceId,
            agentId: session.agentId,
            conversationId: input.conversationId,
            sourceMessageId: input.messageId,
            status: "pending",
            kind: assessment.kind,
            title: proposal.title,
            content: proposal.content,
            rationale: proposal.rationale,
            sourceCustomerMessage: customerMessage,
            sourceHumanReply: humanReply.body,
            detector: {
              provider: detected.outcome === "ignore" ? "explicit_human_refusal" : "jev",
              confidence: assessment.confidence,
              kind: assessment.kind
            },
            clarificationAnswers: {},
            clarificationNormalization: {}
          }
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
          return { created: false, reason: "already_observed" };
        }
        throw error;
      }

      return { created: true };
    },

    async observeLatestHumanReplyAfterHandoff(input: {
      workspaceId: string;
      conversationId: string;
    }): Promise<{ created: boolean; reason?: string }> {
      const conversation = await prisma.conversation.findFirst({
        where: { workspaceId: input.workspaceId, id: input.conversationId },
        select: { activeAgentSessionId: true }
      });
      if (!conversation?.activeAgentSessionId) return { created: false, reason: "no_agent_handoff" };
      const session = await prisma.aiAgentSession.findFirst({
        where: {
          workspaceId: input.workspaceId,
          id: conversation.activeAgentSessionId,
          conversationId: input.conversationId,
          status: { in: ["handoff_requested", "paused_by_human"] },
          handoffReason: { not: null }
        }
      });
      if (!session) return { created: false, reason: "no_agent_handoff" };
      const run = await prisma.aiAgentRun.findFirst({
        where: { workspaceId: input.workspaceId, sessionId: session.id, status: "handoff_requested" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { createdAt: true }
      });
      const since = run?.createdAt ?? session.lastRunAt;
      if (!since) return { created: false, reason: "no_handoff_run" };
      const replies = await prisma.message.findMany({
        where: {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          direction: "outbound",
          type: "text",
          createdAt: { gt: new Date(since) }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20
      });
      const latest = replies.find((message) => message.body?.trim() && !isAiAgentMessage(message));
      if (!latest) return { created: false, reason: "no_human_reply_since_handoff" };
      return this.observeHumanReply({ ...input, messageId: latest.id });
    },

    async listImprovements(input: {
      workspaceId: string;
      agentId: string;
      status?: ImprovementStatus | "all";
    }): Promise<AiAgentImprovementDto[]> {
      await ensureAgent(input);
      const improvements = await prisma.aiAgentImprovement.findMany({
        where: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          ...(input.status && input.status !== "all" ? { status: input.status } : {})
        },
        orderBy: [{ createdAt: "desc" }]
      });

      return improvements.map(toDto);
    },

    async updateImprovement(input: {
      workspaceId: string;
      agentId: string;
      improvementId: string;
      title?: string;
      content?: string;
      reject?: boolean;
      clarificationAnswers?: Record<string, string>;
    }): Promise<AiAgentImprovementDto> {
      await ensureAgent(input);
      const improvement = await findImprovement(input);
      ensurePending(improvement);

      const clarificationAnswers = input.clarificationAnswers
        ? mergeClarificationAnswers({
            kind: improvement.kind,
            current: improvement.clarificationAnswers,
            next: input.clarificationAnswers
          })
        : undefined;
      const content = input.content !== undefined
        ? input.content.trim()
        : improvement.content;
      const contentWithClarification = clarificationAnswers
        ? addClarificationToContent({
            kind: improvement.kind,
            content,
            answers: clarificationAnswers
          })
        : undefined;
      const updated = await prisma.aiAgentImprovement.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.improvementId
          }
        },
        data: {
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(contentWithClarification !== undefined
            ? { content: contentWithClarification }
            : input.content !== undefined
              ? { content: input.content.trim() }
              : {}),
          ...(clarificationAnswers ? { clarificationAnswers } : {}),
          ...(clarificationAnswers || input.content !== undefined ? { clarificationNormalization: {} } : {}),
          ...(input.reject ? { status: "rejected", reviewedAt: new Date() } : {})
        }
      });

      return toDto(updated);
    },

    async normalizeImprovement(input: {
      workspaceId: string;
      agentId: string;
      improvementId: string;
    }): Promise<AiAgentImprovementDto> {
      if (!options.normalizer) {
        throw new AgentImprovementsServiceError(
          "IMPROVEMENT_NORMALIZER_UNAVAILABLE",
          "O JEV não está configurado para interpretar este aprimoramento."
        );
      }

      await ensureAgent(input);
      const improvement = await findImprovement(input);
      ensurePending(improvement);
      if (!hasCompletedClarification(improvement.kind, improvement.clarificationAnswers)) {
        throw new AgentImprovementsServiceError(
          "IMPROVEMENT_CLARIFICATION_REQUIRED",
          "Responda as perguntas de escopo antes de gerar a regra inteligente."
        );
      }

      const answers = toStringRecord(improvement.clarificationAnswers);
      const result = await options.normalizer.normalize({
        kind: improvement.kind,
        customerMessage: improvement.sourceCustomerMessage,
        humanReply: improvement.sourceHumanReply,
        proposedContent: improvement.content,
        clarificationAnswers: answers
      });
      if (result.outcome === "needs_clarification") {
        throw new AgentImprovementsServiceError(
          "IMPROVEMENT_NORMALIZATION_AMBIGUOUS",
          "O JEV não conseguiu delimitar esta regra com segurança. Revise as respostas de escopo."
        );
      }

      const content = addClarificationToContent({
        kind: improvement.kind,
        content: improvement.content,
        answers,
        normalization: result.normalization
      });
      const updated = await prisma.aiAgentImprovement.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.improvementId
          }
        },
        data: {
          content,
          clarificationNormalization: result.normalization
        }
      });

      return toDto(updated);
    },

    async approveImprovement(input: {
      workspaceId: string;
      agentId: string;
      improvementId: string;
      title?: string;
      content?: string;
    }): Promise<AiAgentImprovementDto> {
      await ensureAgent(input);
      const improvement = await findImprovement(input);
      ensurePending(improvement);
      if (!hasCompletedClarification(improvement.kind, improvement.clarificationAnswers)) {
        throw new AgentImprovementsServiceError(
          "IMPROVEMENT_CLARIFICATION_REQUIRED",
          "Responda as perguntas de escopo antes de incluir este aprimoramento na base."
        );
      }
      const normalization = toNormalization(improvement.clarificationNormalization);
      if (!normalization || normalization.confidence < 0.8) {
        throw new AgentImprovementsServiceError(
          "IMPROVEMENT_NORMALIZATION_REQUIRED",
          "Gere a regra inteligente com o JEV antes de incluir este aprimoramento na base."
        );
      }
      const title = input.title?.trim() || improvement.title;
      const content = addClarificationToContent({
        kind: improvement.kind,
        content: input.content?.trim() || improvement.content,
        answers: toStringRecord(improvement.clarificationAnswers),
        normalization
      });

      return prisma.$transaction(async (tx) => {
        const source = await tx.aiKnowledgeSource.create({
          data: {
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            type: "text",
            title,
            content,
            status: "ready",
            metadata: {
              source: "approved_agent_improvement",
              improvementId: input.improvementId,
              kind: improvement.kind,
              normalizedBy: "jev",
              normalizationScope: normalization.scope
            }
          }
        });
        const updated = await tx.aiAgentImprovement.update({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.improvementId
            }
          },
          data: {
            status: "accepted",
            title,
            content,
            reviewedAt: new Date(),
            acceptedKnowledgeSourceId: source.id
          }
        });

        return toDto(updated);
      });
    }
  };
}

export type AgentImprovementsService = ReturnType<typeof createAgentImprovementsService>;
