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
          title: "Tabela de preços",
          content: "Plano profissional custa R$ 199 por mês. Inclui automações e atendimento.",
          metadata: { category: "precos", keywords: ["plano profissional", "mensalidade"] }
        },
        {
          id: "policies",
          title: "Políticas de cancelamento",
          content: "Cancelamentos podem ser feitos com aviso prévio de 30 dias.",
          metadata: { category: "politicas", keywords: ["cancelamento"] }
        }
      ]
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toEqual(
      expect.objectContaining({
        id: "prices",
        title: "Tabela de preços",
        content: "Plano profissional custa R$ 199 por mês. Inclui automações e atendimento.",
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
          title: "Tabela de preços",
          content: "Plano profissional custa R$ 199 por mês.",
          metadata: { category: "precos", keywords: ["mensalidade"] }
        },
        {
          id: "product",
          title: "Recursos do produto",
          content: "O produto organiza conversas de WhatsApp com automações.",
          metadata: { category: "produto", keywords: ["automacoes"] }
        }
      ]
    });

    expect(result.selected).toEqual([]);
    expect(result.total).toBe(2);
  });

  it("does not treat duration questions as pricing questions because they use quanto", () => {
    const result = selectRelevantKnowledge({
      latestMessage: "Quanto tempo leva a implantação?",
      conversationHistory:
        "[2026-06-23T18:00:00.000Z] cliente: Antes eu tinha perguntado sobre preço e mensalidade.",
      instruction: null,
      sources: [
        {
          id: "prices",
          title: "Tabela de preços",
          content: "Plano profissional custa R$ 199 por mês.",
          metadata: { category: "precos" }
        },
        {
          id: "onboarding",
          title: "Guia de onboarding",
          content: "A implantação leva 7 dias uteis com treinamento.",
          metadata: { category: "onboarding" }
        }
      ]
    });

    expect(result.selected.map((source) => source.id)).toEqual(["onboarding"]);
  });

  it("marks oversized documents as chunks", () => {
    const longContent = `${"Trecho geral sem valores. ".repeat(900)}Preço do plano profissional: R$ 199 por mês. Detalhes finais.`;

    const result = selectRelevantKnowledge({
      latestMessage: "Qual o preço do plano profissional?",
      conversationHistory: "",
      instruction: null,
      sources: [
        {
          id: "long_prices",
          title: "Preços",
          content: longContent,
          metadata: { category: "precos" }
        }
      ]
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.includedAs).toBe("chunk");
    expect(result.selected[0]?.content.length).toBeLessThanOrEqual(2_400);
    expect(result.selected[0]?.content).toContain("Preço do plano profissional");
  });

  it.each([
    ["início", "CÓDIGO-INÍCIO"],
    ["meio", "CÓDIGO-MEIO"],
    ["fim", "CÓDIGO-FIM"]
  ])("retrieves a fact from the %s of one long source", (_position, fact) => {
    const content = [
      "Catálogo CÓDIGO-INÍCIO chapas especiais.",
      "texto neutro ".repeat(1_100),
      "Catálogo CÓDIGO-MEIO tubos especiais.",
      "texto neutro ".repeat(1_100),
      "Catálogo CÓDIGO-FIM vigas especiais."
    ].join("\n\n");
    const result = selectRelevantKnowledge({
      latestMessage: `Quero informações sobre ${fact}`,
      conversationHistory: "",
      instruction: null,
      sources: [{ id: "long", title: "INSTRUÇÕES GERAIS", content }]
    });

    expect(result.selected.some((chunk) => chunk.content.includes(fact))).toBe(true);
    expect(result.selected.every((chunk) => chunk.start >= 0 && chunk.end > chunk.start)).toBe(true);
  });

  it("limits selected knowledge to six chunks and 12000 characters", () => {
    const result = selectRelevantKnowledge({
      latestMessage: "chapas tubos vigas perfis cantoneiras estoque preço",
      conversationHistory: "",
      instruction: null,
      sources: Array.from({ length: 4 }, (_, index) => ({
        id: `source-${index}`,
        title: `Catálogo ${index}`,
        content: "chapas tubos vigas perfis cantoneiras estoque preço ".repeat(800)
      }))
    });

    expect(result.selected.length).toBeLessThanOrEqual(6);
    expect(result.selected.reduce((sum, chunk) => sum + chunk.content.length, 0)).toBeLessThanOrEqual(12_000);
    expect(result.evaluatedChunks).toBeGreaterThan(result.selected.length);
  });
});
