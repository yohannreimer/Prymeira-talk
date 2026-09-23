import { describe, expect, it, vi } from "vitest";
import {
  createJevAgentImprovementDetector,
  createJevAgentImprovementNormalizer
} from "./jev-agent-improvement.js";

function choice(value: string, confidence = 1) {
  return {
    type: "choice",
    choice: value,
    probabilities: { [value]: 1 },
    confidence
  };
}

const input = {
  customerMessage: "Vocês têm barra chata galvanizada com furos de 7 mm?",
  humanReply: "Não trabalhamos com esse produto.",
  conversationMessages: [
    {
      label: "cliente" as const,
      body: "Vocês têm barra chata galvanizada com furos de 7 mm?",
      createdAt: "2026-09-22T13:56:00.000Z"
    },
    {
      label: "atendente" as const,
      body: "Não trabalhamos com esse produto.",
      createdAt: "2026-09-22T14:00:00.000Z"
    }
  ]
};

describe("createJevAgentImprovementDetector", () => {
  it("suggests a reviewed not-sold rule only for a confident explicit human decision", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        answers: {
          shouldSuggest: { type: "noul", noul: 0.96 },
          kind: choice("not_sold", 0.94)
        }
      }))
    );
    const detector = createJevAgentImprovementDetector({ apiKey: "jev-test", model: "jev-1.13", fetchImpl });

    await expect(detector.assess(input)).resolves.toEqual({
      outcome: "suggest",
      kind: "not_sold",
      confidence: 0.94
    });

    const [, request] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe("jev-1.13");
    expect(body.questions.shouldSuggest.instructions).toContain("sem inventar preço, estoque, prazo");
    expect(body.questions.kind.criteria.not_sold).toContain("não é comercializado");
  });

  it("ignores uncertain or non-reusable human replies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        answers: {
          shouldSuggest: { type: "noul", noul: 0.96 },
          kind: choice("not_sold", 0.61)
        }
      }))
    );
    const detector = createJevAgentImprovementDetector({ apiKey: "jev-test", fetchImpl });

    await expect(detector.assess(input)).resolves.toEqual({
      outcome: "ignore",
      reason: "not_a_durable_human_resolution"
    });
  });

  it("rejects a detector response that omits the JEV confidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        answers: {
          shouldSuggest: { type: "noul", noul: 0.96 },
          kind: { type: "choice", choice: "not_sold" }
        }
      }))
    );
    const detector = createJevAgentImprovementDetector({ apiKey: "jev-test", fetchImpl });

    await expect(detector.assess(input)).rejects.toThrow("JEV_AGENT_IMPROVEMENT_RESPONSE_INVALID");
  });
});

describe("createJevAgentImprovementNormalizer", () => {
  it("expands João's short confirmation using the question before asking JEV", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        answers: {
          scope: choice("requested_item_variations", 0.96),
          understandsAnswers: { type: "noul", noul: 0.95 },
          requiresHandoffOutsideScope: { type: "noul", noul: 0.99 }
        }
      }))
    );
    const normalizer = createJevAgentImprovementNormalizer({ apiKey: "jev-test", fetchImpl });

    await expect(normalizer.normalize({
      kind: "not_sold",
      customerMessage: "Quanto tá uma barra de 10mm 12m? Barra pra viga baldrame. 10mm.",
      humanReply: "Construção civil não trabalhamos.",
      proposedContent: "Não comercializamos a barra para viga baldrame solicitada.",
      clarificationAnswers: { scope: "exato", exceptions: "nenhuma" },
      clarificationQuestions: {
        scope: "A decisão de não trabalhar vale para todas as medidas, espessuras, acabamentos e furações do item solicitado?",
        exceptions: "Quais medidas, acabamentos ou produtos parecidos vocês ainda comercializam?"
      }
    })).resolves.toEqual({
      outcome: "ready",
      normalization: {
        scope: "requested_item_variations",
        confidence: 0.95,
        requiresHandoffOutsideScope: true
      }
    });

    const [, request] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(request?.body));
    expect(body.state.clarificationAnswers.scope).toBe(
      "Sim, a decisão vale para todas as medidas, espessuras, acabamentos e furações do item solicitado."
    );
    expect(body.state.clarificationAnswers.exceptions).toBe("nenhuma");
    expect(body.state.clarificationQuestions.scope).toContain("todas as medidas");
  });

  it("normalizes natural-language team answers into a bounded rule scope", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        answers: {
          scope: choice("material_or_finish_family", 0.97),
          understandsAnswers: { type: "noul", noul: 0.94 },
          requiresHandoffOutsideScope: { type: "noul", noul: 0.98 }
        }
      }))
    );
    const normalizer = createJevAgentImprovementNormalizer({ apiKey: "jev-test", fetchImpl });

    await expect(normalizer.normalize({
      kind: "not_sold",
      customerMessage: input.customerMessage,
      humanReply: "Não trabalhamos com nada galvanizado.",
      proposedContent: "Não comercializamos este produto.",
      clarificationAnswers: {
        scope: "Não trabalhamos com nada galvanizado.",
        exceptions: "Somente aço carbono sem galvanização."
      }
    })).resolves.toEqual({
      outcome: "ready",
      normalization: {
        scope: "material_or_finish_family",
        confidence: 0.94,
        requiresHandoffOutsideScope: true
      }
    });

    const [, request] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(request?.body));
    expect(body.questions.scope.criteria.requested_item_variations).toContain("medidas");
    expect(body.questions.scope.criteria.material_or_finish_family).toContain("nada galvanizado");
    expect(body.state.clarificationAnswers.scope).toBe("Não trabalhamos com nada galvanizado.");
  });

  it("refuses to normalize an ambiguous answer or one below the confidence threshold", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        answers: {
          scope: choice("ambiguous", 0.98),
          understandsAnswers: { type: "noul", noul: 0.99 },
          requiresHandoffOutsideScope: { type: "noul", noul: 1 }
        }
      }))
    );
    const normalizer = createJevAgentImprovementNormalizer({ apiKey: "jev-test", fetchImpl });

    await expect(normalizer.normalize({
      kind: "not_sold",
      customerMessage: input.customerMessage,
      humanReply: input.humanReply,
      proposedContent: "Não comercializamos este produto.",
      clarificationAnswers: { scope: "Talvez", exceptions: "Verificar." }
    })).resolves.toEqual({ outcome: "needs_clarification", reason: "normalization_ambiguous" });
  });

  it("rejects a normalization response that does not carry a JEV confidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        answers: {
          scope: { type: "choice", choice: "requested_item_variations" },
          understandsAnswers: { type: "noul", noul: 0.99 },
          requiresHandoffOutsideScope: { type: "noul", noul: 1 }
        }
      }))
    );
    const normalizer = createJevAgentImprovementNormalizer({ apiKey: "jev-test", fetchImpl });

    await expect(normalizer.normalize({
      kind: "not_sold",
      customerMessage: input.customerMessage,
      humanReply: input.humanReply,
      proposedContent: "Não comercializamos este produto.",
      clarificationAnswers: { scope: "Todas as variações", exceptions: "Nenhuma." }
    })).rejects.toThrow("JEV_AGENT_IMPROVEMENT_NORMALIZATION_RESPONSE_INVALID");
  });
});
