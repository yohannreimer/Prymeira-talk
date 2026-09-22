import { z } from "zod";

export type AgentReplyPreflightInput = {
  currentMessage: {
    id: string;
    body: string;
    type: string | null;
  };
  conversationMessages: Array<{
    id: string;
    label: "cliente" | "atendente" | "nota interna" | "sistema";
    body: string | null;
    type: string | null;
    createdAt: string | null;
  }>;
  selectedKnowledge: Array<{
    title: string;
    content: string;
  }>;
};

export type AgentReplyPreflightPlan = {
  conversationStage:
    | "new_quote"
    | "qualification"
    | "seller_owned"
    | "post_proposal"
    | "closure"
    | "general_support"
    | "unclear";
  commercialPath:
    | "stock"
    | "made_to_order"
    | "not_sold"
    | "ambiguous"
    | "not_applicable";
  nextAction:
    | "answer_current_request"
    | "ask_missing_technical"
    | "offer_catalog_or_seller"
    | "state_made_to_order_conditions"
    | "handoff"
    | "wait_for_customer"
    | "silence";
};

export type AgentReplyPreflightResult =
  | { outcome: "silence"; reason: "social_closure" }
  | { outcome: "continue"; plan: AgentReplyPreflightPlan };

export type AgentReplyQualityAuditInput = AgentReplyPreflightInput & {
  candidateReply: string;
  plan: AgentReplyPreflightPlan;
};

export type AgentReplyQualityAuditResult =
  | { outcome: "send" }
  | { outcome: "suppress"; reason: "redundant_or_unhelpful" }
  | { outcome: "handoff"; reason: "commercial_policy_risk" };

export type AgentReplyPreflight = {
  evaluate(input: AgentReplyPreflightInput): Promise<AgentReplyPreflightResult>;
  audit?(input: AgentReplyQualityAuditInput): Promise<AgentReplyQualityAuditResult>;
};

export type JevReplyPreflightOptions = {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

const conversationStageSchema = z.enum([
  "new_quote",
  "qualification",
  "seller_owned",
  "post_proposal",
  "closure",
  "general_support",
  "unclear"
]);
const commercialPathSchema = z.enum([
  "stock",
  "made_to_order",
  "not_sold",
  "ambiguous",
  "not_applicable"
]);
const nextActionSchema = z.enum([
  "answer_current_request",
  "ask_missing_technical",
  "offer_catalog_or_seller",
  "state_made_to_order_conditions",
  "handoff",
  "wait_for_customer",
  "silence"
]);

function choiceAnswerSchema<T extends z.ZodType>(choice: T) {
  return z.object({
    type: z.literal("choice"),
    choice,
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number().min(0).max(1).optional()
  });
}

const responseSchema = z.object({
  answers: z.object({
    shouldReply: z.object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1)
    }),
    conversationStage: choiceAnswerSchema(conversationStageSchema),
    commercialPath: choiceAnswerSchema(commercialPathSchema),
    nextAction: choiceAnswerSchema(nextActionSchema)
  })
});

const auditResponseSchema = z.object({
  answers: z.object({
    disposition: choiceAnswerSchema(z.enum(["send", "suppress", "handoff"])),
    followsPlan: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
    assertsUnsupportedCommercialFact: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) })
  })
});

const replyPreflightQuestions = {
  shouldReply: {
    type: "noul",
    instructions:
      "A última mensagem do cliente exige uma resposta útil agora? Responda não quando for apenas agradecimento, despedida, reação, emoji ou confirmação social sem nova pergunta, nova informação relevante ou pendência aberta.",
    criteria: {
      true: "Há demanda, pergunta, informação nova que avança uma pendência, ou uma resposta necessária.",
      false: "Há somente encerramento social e nenhuma pendência do cliente precisa de resposta."
    }
  },
  conversationStage: {
    type: "choice",
    instructions: "Qual é a etapa dominante da conversa?",
    criteria: {
      new_quote: "Novo pedido de cotação ainda não tratado.",
      qualification: "Coleta ou confirmação de dados para uma cotação em andamento.",
      seller_owned: "Um vendedor humano já está tratando cotação, negociação, entrega ou exceção.",
      post_proposal: "Proposta enviada, ajuste de proposta ou acompanhamento posterior.",
      closure: "Assunto concluído, despedida, agradecimento ou recusa sem demanda aberta.",
      general_support: "Atendimento que não é cotação comercial.",
      unclear: "Não há dados suficientes para definir a etapa com segurança."
    }
  },
  commercialPath: {
    type: "choice",
    instructions:
      "Usando somente o histórico e o conhecimento aprovado fornecido, qual caminho comercial se aplica ao pedido atual? Não trate uma inferência como fato confirmado.",
    criteria: {
      stock: "O conhecimento aprovado identifica o item como linha de estoque.",
      made_to_order: "O conhecimento aprovado identifica o item como sob encomenda.",
      not_sold: "O conhecimento aprovado identifica o item ou serviço como não vendido.",
      ambiguous: "Há pedido comercial, mas item ou disponibilidade não pode ser classificado com segurança.",
      not_applicable: "Não há decisão comercial aplicável nesta mensagem."
    }
  },
  nextAction: {
    type: "choice",
    instructions:
      "Qual único próximo movimento evita repetir a conversa e respeita o histórico? Não invente fatos comerciais nem reinicie uma negociação humana.",
    criteria: {
      answer_current_request: "Responder diretamente uma pergunta atual com informação aprovada.",
      ask_missing_technical: "Pedir somente os dados técnicos realmente ausentes de uma cotação em andamento.",
      offer_catalog_or_seller: "Para novo item sob encomenda, oferecer catálogo aprovado ou vendedor antes de checklist técnico adicional.",
      state_made_to_order_conditions: "Informar condições de encomenda ainda não apresentadas e perguntar se atendem.",
      handoff: "Encaminhar para humano por decisão, exceção, risco ou incerteza relevante.",
      wait_for_customer: "O cliente precisa responder uma pendência já apresentada; não criar nova pergunta.",
      silence: "Não enviar resposta para encerramento social sem pendência."
    }
  }
} as const;

const replyQualityAuditQuestions = {
  disposition: {
    type: "choice",
    instructions: "A resposta candidata deve ser enviada, suprimida ou encaminhada para humano?",
    criteria: {
      send: "A resposta avança a demanda, segue o plano interno e não afirma fato comercial sem fonte aprovada.",
      suppress: "A resposta é redundante, socialmente desnecessária ou não ajuda a conversa.",
      handoff: "A resposta afirma, promete ou decide preço, estoque, prazo, frete, pagamento, especificação ou exceção sem base aprovada, ou conflita com o plano."
    }
  },
  followsPlan: {
    type: "noul",
    instructions: "A resposta candidata segue o agentPreflight e responde somente à próxima ação definida?",
    criteria: { true: "Segue a etapa, caminho comercial e próxima ação.", false: "Ignora, contradiz ou reinicia indevidamente o plano." }
  },
  assertsUnsupportedCommercialFact: {
    type: "noul",
    instructions: "A resposta candidata afirma fato comercial protegido sem evidência explícita no conhecimento aprovado?",
    criteria: { true: "Afirma ou promete fato sem fonte aprovada.", false: "Não afirma fato protegido sem evidência." }
  }
} as const;

export function createJevReplyPreflight(input: JevReplyPreflightOptions): AgentReplyPreflight {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  return {
    async evaluate(state) {
      const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        signal: AbortSignal.timeout(12_000),
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          state: toJevState(state),
          model: input.model ?? "jev-latest",
          questions: replyPreflightQuestions
        })
      });

      if (!response.ok) {
        throw new Error(`JEV_REPLY_PREFLIGHT_HTTP_${response.status}`);
      }

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("JEV_REPLY_PREFLIGHT_RESPONSE_INVALID");
      }

      const { answers } = parsed.data;
      if (answers.shouldReply.noul < 0.2 || answers.nextAction.choice === "silence") {
        return { outcome: "silence", reason: "social_closure" };
      }

      return {
        outcome: "continue",
        plan: {
          conversationStage: answers.conversationStage.choice,
          commercialPath: answers.commercialPath.choice,
          nextAction: answers.nextAction.choice
        }
      };
    },
    async audit(auditInput) {
      const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        signal: AbortSignal.timeout(12_000),
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          state: {
            ...toJevState(auditInput),
            agentPreflight: auditInput.plan,
            candidateReply: auditInput.candidateReply.slice(0, 1_500)
          },
          model: input.model ?? "jev-latest",
          questions: replyQualityAuditQuestions
        })
      });

      if (!response.ok) {
        throw new Error(`JEV_REPLY_AUDIT_HTTP_${response.status}`);
      }

      const parsed = auditResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("JEV_REPLY_AUDIT_RESPONSE_INVALID");
      }

      const { answers } = parsed.data;
      if (answers.disposition.choice === "handoff" || answers.assertsUnsupportedCommercialFact.noul >= 0.6) {
        return { outcome: "handoff", reason: "commercial_policy_risk" };
      }
      if (answers.disposition.choice === "suppress" || answers.followsPlan.noul < 0.2) {
        return { outcome: "suppress", reason: "redundant_or_unhelpful" };
      }
      return { outcome: "send" };
    }
  };
}

function toJevState(input: AgentReplyPreflightInput) {
  return {
    currentMessage: input.currentMessage,
    conversationMessages: input.conversationMessages.slice(-10).map((message) => ({
      id: message.id,
      label: message.label,
      type: message.type,
      body: message.body?.slice(0, 2_000) ?? null,
      createdAt: message.createdAt
    })),
    approvedKnowledge: input.selectedKnowledge.slice(0, 8).map((source) => ({
      title: source.title.slice(0, 240),
      content: source.content.slice(0, 1_500)
    }))
  };
}
