import { describe, expect, it } from "vitest";
import { selectRelevantKnowledge } from "./knowledge-retrieval.js";

describe("selectRelevantKnowledge", () => {
  it("selects the pricing document for a pricing question", () => {
    const result = selectRelevantKnowledge({
      latestMessage: "Quanto custa o plano profissional?",
      conversationHistory: "[2026-06-23T18:00:00.000Z] cliente: Tenho interesse.",
      instruction: "Responda de forma objetiva.",
      sources: [
        {
          id: "prices",
          title: "Tabela de precos",
          content: "Plano profissional custa R$ 199 por mes. Inclui automacoes e atendimento.",
          metadata: { category: "precos", keywords: ["plano profissional", "mensalidade"] }
        },
        {
          id: "policies",
          title: "Politicas de cancelamento",
          content: "Cancelamentos podem ser feitos com aviso previo de 30 dias.",
          metadata: { category: "politicas", keywords: ["cancelamento"] }
        }
      ]
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toEqual(
      expect.objectContaining({
        id: "prices",
        title: "Tabela de precos",
        content: "Plano profissional custa R$ 199 por mes. Inclui automacoes e atendimento.",
        category: "precos",
        includedAs: "full_document"
      })
    );
    expect(result.selected[0]?.score).toBeGreaterThan(0);
    expect(result.selected[0]?.reasons).toEqual(
      expect.arrayContaining(["category_match", "keyword_match", "title_match"])
    );
  });

  it("does not select a document when there is no relevant match", () => {
    const result = selectRelevantKnowledge({
      latestMessage: "Oi, tudo bem?",
      conversationHistory: "[2026-06-23T18:00:00.000Z] cliente: Boa tarde.",
      instruction: null,
      sources: [
        {
          id: "prices",
          title: "Tabela de precos",
          content: "Plano profissional custa R$ 199 por mes.",
          metadata: { category: "precos", keywords: ["mensalidade"] }
        },
        {
          id: "product",
          title: "Recursos do produto",
          content: "O produto organiza conversas de WhatsApp com automacoes.",
          metadata: { category: "produto", keywords: ["automacoes"] }
        }
      ]
    });

    expect(result.selected).toEqual([]);
    expect(result.total).toBe(2);
  });

  it("does not treat duration questions as pricing questions because they use quanto", () => {
    const result = selectRelevantKnowledge({
      latestMessage: "Quanto tempo leva a implantacao?",
      conversationHistory:
        "[2026-06-23T18:00:00.000Z] cliente: Antes eu tinha perguntado sobre preco e mensalidade.",
      instruction: null,
      sources: [
        {
          id: "prices",
          title: "Tabela de precos",
          content: "Plano profissional custa R$ 199 por mes.",
          metadata: { category: "precos" }
        },
        {
          id: "onboarding",
          title: "Guia de onboarding",
          content: "A implantacao leva 7 dias uteis com treinamento.",
          metadata: { category: "onboarding" }
        }
      ]
    });

    expect(result.selected.map((source) => source.id)).toEqual(["onboarding"]);
  });

  it("marks oversized documents as snippets", () => {
    const longContent = `${"Trecho geral sem valores. ".repeat(900)}Preco do plano profissional: R$ 199 por mes. Detalhes finais.`;

    const result = selectRelevantKnowledge({
      latestMessage: "Qual o preco do plano profissional?",
      conversationHistory: "",
      instruction: null,
      sources: [
        {
          id: "long_prices",
          title: "Precos",
          content: longContent,
          metadata: { category: "precos" }
        }
      ]
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.includedAs).toBe("snippet");
    expect(result.selected[0]?.content.length).toBeLessThanOrEqual(18_000);
    expect(result.selected[0]?.content).toContain("Preco do plano profissional");
  });
});
