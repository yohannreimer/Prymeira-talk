import { describe, expect, it, vi } from "vitest";
import { createJevReplyPreflight } from "./jev-reply-preflight.js";

const baseInput = {
  currentMessage: {
    id: "message_current",
    body: "Obrigado!",
    type: "text"
  },
  conversationMessages: [
    {
      id: "message_previous",
      label: "atendente" as const,
      body: "Perfeito, fico à disposição.",
      type: "text",
      createdAt: "2026-09-21T12:00:00.000Z"
    },
    {
      id: "message_current",
      label: "cliente" as const,
      body: "Obrigado!",
      type: "text",
      createdAt: "2026-09-21T12:01:00.000Z"
    }
  ],
  selectedKnowledge: []
};

function choice(value: string) {
  return {
    type: "choice",
    choice: value,
    probabilities: { [value]: 1 },
    confidence: 1
  };
}

function auditResponse(input: {
  disposition: "send" | "suppress" | "handoff";
  followsPlan: number;
  assertsUnsupportedCommercialFact: number;
  advancesOpenQualification?: number;
}) {
  return new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      disposition: choice(input.disposition),
      followsPlan: { type: "noul", noul: input.followsPlan },
      assertsUnsupportedCommercialFact: {
        type: "noul",
        noul: input.assertsUnsupportedCommercialFact
      },
      advancesOpenQualification: {
        type: "noul",
        noul: input.advancesOpenQualification ?? 0
      }
    }
  }));
}

describe("createJevReplyPreflight", () => {
  it("distinguishes unsupported variants, approved refusals and ongoing qualification in JEV criteria", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ answers: {
      shouldReply: { type: "noul", noul: 0.98 },
      conversationStage: choice("qualification"),
      commercialPath: choice("ambiguous"),
      nextAction: choice("handoff")
    } })));

    await createJevReplyPreflight({ apiKey: "jev-test", fetchImpl }).evaluate(baseInput);

    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(payload.questions.conversationStage.criteria.qualification).toContain("resposta do cliente à pergunta de qualificação");
    expect(payload.questions.conversationStage.criteria.new_quote).toContain("não é resposta à qualificação anterior");
    expect(payload.questions.commercialPath.criteria.stock).toContain("variante solicitada não contradiz medidas, material ou norma aprovados");
    expect(payload.questions.commercialPath.criteria.ambiguous).toContain("medida fora da faixa aprovada");
    expect(payload.questions.commercialPath.criteria.not_sold).toContain("negativa explícita aplicável");
    expect(payload.questions.nextAction.criteria.answer_current_request).toContain("recusa objetiva de item explicitamente não vendido");
    expect(payload.questions.nextAction.criteria.answer_current_request).toContain("não substitui handoff quando a variante está fora da faixa aprovada");
    expect(payload.questions.nextAction.criteria.handoff).toContain("variante fora da faixa ou especificação não confirmada");
    expect(payload.questions.nextAction.instructions).toContain("Se a variante está fora da faixa aprovada");
    expect(payload.questions.nextAction.criteria.handoff).toContain("não para repetir uma negativa aprovada");
  });

  it("sends the full prompt, latest 20 complete messages, and selected evidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ answers: {
      shouldReply: { type: "noul", noul: 0.98 },
      conversationStage: choice("new_quote"),
      commercialPath: choice("ambiguous"),
      nextAction: choice("handoff")
    } })));
    const agentRules = `${"A".repeat(4_100)}\nNão fornecemos oxicorte.`;
    const conversationMessages = Array.from({ length: 22 }, (_, index) => ({
      id: `message-${index + 1}`,
      label: "cliente" as const,
      body: index === 20 ? "B".repeat(2_100) : `Mensagem ${index + 1}`,
      type: "text",
      createdAt: new Date(Date.UTC(2026, 8, 22, 12, index)).toISOString()
    }));
    const selectedKnowledge = [{ id: "approved-rule", title: "Regra aprovada", content: "C".repeat(1_600) }];

    await createJevReplyPreflight({ apiKey: "jev-test", fetchImpl }).evaluate({
      currentMessage: { id: "message-22", body: "Mensagem 22", type: "text" },
      conversationMessages,
      selectedKnowledge,
      agentRules
    });

    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(payload.state.agentRules).toBe(agentRules);
    expect(payload.state.conversationMessages).toHaveLength(20);
    expect(payload.state.conversationMessages[0].id).toBe("message-3");
    expect(payload.state.conversationMessages.at(-1).id).toBe("message-22");
    expect(payload.state.conversationMessages.find((item: { id: string }) => item.id === "message-21").body).toHaveLength(2_100);
    expect(payload.state.approvedKnowledge).toEqual(selectedKnowledge);
  });

  it("tells the auditor that an approved not-sold refusal is supported", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(auditResponse({
      disposition: "send",
      followsPlan: 1,
      assertsUnsupportedCommercialFact: 0
    }));
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });

    await preflight.audit!({
      currentMessage: { id: "message-1", body: "Vocês vendem barra maciça quadrada?", type: "text" },
      conversationMessages: [],
      selectedKnowledge: [{ title: "Catálogo aprovado", content: "Não vendemos barra maciça quadrada." }],
      candidateReply: "Não trabalhamos com barra maciça quadrada.",
      plan: { conversationStage: "new_quote", commercialPath: "not_sold", nextAction: "answer_current_request" }
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.questions.disposition.instructions).toContain("not_sold");
    expect(body.questions.assertsUnsupportedCommercialFact.instructions).toContain("explicitamente não vendido");
  });

  it("distinguishes sending a safe handoff notice from blocking the candidate reply", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(auditResponse({
      disposition: "send",
      followsPlan: 1,
      assertsUnsupportedCommercialFact: 0
    }));
    await createJevReplyPreflight({ apiKey: "jev-test", fetchImpl }).audit!({
      ...baseInput,
      candidateReply: "Vou encaminhar ao vendedor para verificar a disponibilidade e a especificação dessa barra.",
      plan: { conversationStage: "new_quote", commercialPath: "ambiguous", nextAction: "handoff" }
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.questions.disposition.instructions).toContain("handoff nesta auditoria significa bloquear a candidateReply");
    expect(body.questions.disposition.criteria.send).toContain("nextAction=handoff");
    expect(body.questions.disposition.criteria.handoff).toContain("não escolha handoff apenas porque o texto comunica um encaminhamento");
  });

  it("passes agent product rules to preflight and audit as commercial evidence", async () => {
    const preflightResponse = new Response(JSON.stringify({ answers: {
      shouldReply: { type: "noul", noul: 0.98 },
      conversationStage: choice("new_quote"),
      commercialPath: choice("not_sold"),
      nextAction: choice("answer_current_request")
    } }));
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(preflightResponse)
      .mockResolvedValueOnce(auditResponse({ disposition: "send", followsPlan: 1, assertsUnsupportedCommercialFact: 0 }));
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });
    const agentRules = "Não fornecemos oxicorte nem material cortado.";
    const state = { ...baseInput, agentRules, currentMessage: { id: "item", body: "Vocês fazem oxicorte?", type: "text" } };

    await preflight.evaluate(state);
    await preflight.audit!({
      ...state,
      candidateReply: "Não fornecemos oxicorte.",
      plan: { conversationStage: "new_quote", commercialPath: "not_sold", nextAction: "answer_current_request" }
    });

    const preflightBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const auditBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(preflightBody.state.agentRules).toContain("Não fornecemos oxicorte");
    expect(auditBody.state.agentRules).toContain("Não fornecemos oxicorte");
    expect(preflightBody.questions.commercialPath.instructions).toContain("regras do agente");
  });

  it("sends the next valid qualification question even when JEV marks it as suppress", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(auditResponse({
      disposition: "suppress",
      followsPlan: 0.98,
      assertsUnsupportedCommercialFact: 0.02,
      advancesOpenQualification: 0.96
    }));
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });

    await expect(preflight.audit!({
      currentMessage: { id: "message-pickup", body: "Retirada", type: "text" },
      conversationMessages: [
        {
          id: "message-question",
          label: "atendente",
          body: "Certo, Joinville. Será entrega ou retirada?",
          type: "text",
          createdAt: "2026-09-22T17:16:00.000Z"
        },
        {
          id: "message-pickup",
          label: "cliente",
          body: "Retirada",
          type: "text",
          createdAt: "2026-09-22T17:16:30.000Z"
        }
      ],
      selectedKnowledge: [],
      candidateReply: "Certo, retirada em Joinville. Para seguir, informe a empresa e CNPJ ou, se for pessoa física, seu nome.",
      plan: {
        conversationStage: "qualification",
        commercialPath: "stock",
        nextAction: "ask_missing_technical"
      }
    })).resolves.toEqual({ outcome: "send" });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.questions.advancesOpenQualification.instructions).toContain("empresa e CNPJ");
  });

  it("keeps a genuine duplicate or social closure suppressed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(auditResponse({
      disposition: "suppress",
      followsPlan: 0.97,
      assertsUnsupportedCommercialFact: 0.01,
      advancesOpenQualification: 0.03
    }));
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });

    await expect(preflight.audit!({
      ...baseInput,
      candidateReply: "Fico à disposição!",
      plan: {
        conversationStage: "closure",
        commercialPath: "not_applicable",
        nextAction: "silence"
      }
    })).resolves.toEqual({ outcome: "suppress", reason: "redundant_or_unhelpful" });
  });

  it("routes a reply that clearly conflicts with its plan to a human instead of silently suppressing it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(auditResponse({
      disposition: "suppress",
      followsPlan: 0.03,
      assertsUnsupportedCommercialFact: 0.01,
      advancesOpenQualification: 0.04
    }));
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });

    await expect(preflight.audit!({
      ...baseInput,
      candidateReply: "Posso entregar amanhã.",
      plan: {
        conversationStage: "qualification",
        commercialPath: "stock",
        nextAction: "ask_missing_technical"
      }
    })).resolves.toEqual({ outcome: "handoff", reason: "plan_mismatch" });
  });

  it("suppresses a social closure before a generative reply is created", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          shouldReply: { type: "noul", noul: 0.01 },
          conversationStage: choice("closure"),
          commercialPath: choice("not_applicable"),
          nextAction: choice("silence")
        },
        usage: { input_tokens: 88, output_tokens: 4 }
      }))
    );
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });

    await expect(preflight.evaluate(baseInput)).resolves.toEqual({
      outcome: "silence",
      reason: "social_closure"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer jev-test",
          "Content-Type": "application/json"
        }
      })
    );
  });

  it("returns a compact policy plan for a reply that should continue", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          shouldReply: { type: "noul", noul: 0.98 },
          conversationStage: choice("new_quote"),
          commercialPath: choice("made_to_order"),
          nextAction: choice("offer_catalog_or_seller")
        },
        usage: { input_tokens: 99, output_tokens: 8 }
      }))
    );
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", model: "jev-1.13", fetchImpl });

    await expect(preflight.evaluate(baseInput)).resolves.toEqual({
      outcome: "continue",
      plan: {
        conversationStage: "new_quote",
        commercialPath: "made_to_order",
        nextAction: "offer_catalog_or_seller"
      }
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("jev-1.13");
    expect(body.state.conversationMessages).toHaveLength(2);
    expect(body.questions).toHaveProperty("shouldReply");
    expect(body.questions).toHaveProperty("conversationStage");
    expect(body.questions).toHaveProperty("commercialPath");
    expect(body.questions).toHaveProperty("nextAction");
  });

  it("turns a commercially unsupported candidate into a human handoff", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          disposition: choice("handoff"),
          followsPlan: { type: "noul", noul: 0.1 },
          assertsUnsupportedCommercialFact: { type: "noul", noul: 0.98 },
          advancesOpenQualification: { type: "noul", noul: 0.01 }
        },
        usage: { input_tokens: 120, output_tokens: 6 }
      }))
    );
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });

    await expect(preflight.audit!({
      ...baseInput,
      candidateReply: "Temos em estoque e entregamos amanhã.",
      plan: {
        conversationStage: "new_quote",
        commercialPath: "ambiguous",
        nextAction: "handoff"
      }
    })).resolves.toEqual({ outcome: "handoff", reason: "commercial_policy_risk" });
  });

  it("fails closed when the disposition selects handoff even with low confidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          disposition: {
            type: "choice",
            choice: "handoff",
            probabilities: { handoff: 0.53, send: 0.45, suppress: 0.02 },
            confidence: 0.3
          },
          followsPlan: { type: "noul", noul: 0.87 },
          assertsUnsupportedCommercialFact: { type: "noul", noul: 0.09 },
          advancesOpenQualification: { type: "noul", noul: 0.02 }
        },
        usage: { input_tokens: 120, output_tokens: 6 }
      }))
    );
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });

    await expect(preflight.audit!({
      ...baseInput,
      candidateReply: "Vou encaminhar ao vendedor para verificar a disponibilidade.",
      plan: {
        conversationStage: "new_quote",
        commercialPath: "ambiguous",
        nextAction: "handoff"
      }
    })).resolves.toEqual({ outcome: "handoff", reason: "commercial_policy_risk" });
  });

  it("fails closed when a handoff disposition has no confidence metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          disposition: { type: "choice", choice: "handoff" },
          followsPlan: { type: "noul", noul: 0.91 },
          assertsUnsupportedCommercialFact: { type: "noul", noul: 0.08 },
          advancesOpenQualification: { type: "noul", noul: 0.02 }
        }
      }))
    );
    const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });

    await expect(preflight.audit!({
      ...baseInput,
      candidateReply: "Vou encaminhar ao vendedor para verificar a disponibilidade.",
      plan: {
        conversationStage: "new_quote",
        commercialPath: "ambiguous",
        nextAction: "handoff"
      }
    })).resolves.toEqual({ outcome: "handoff", reason: "commercial_policy_risk" });
  });
});
