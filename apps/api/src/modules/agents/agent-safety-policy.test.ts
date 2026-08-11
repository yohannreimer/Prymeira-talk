import { describe, expect, it } from "vitest";
import { evaluateAgentSafety } from "./agent-safety-policy.js";

describe("evaluateAgentSafety", () => {
  it.each([
    ["Tem exatamente 30 chapas em estoque hoje?", "stock"],
    ["Vocês têm exatamente 30 unidades disponíveis hoje?", "stock"],
    ["Qual o preço exato e o desconto?", "price"],
    ["Entrega até sexta sem falta?", "deadline"],
    ["Qual viga aguenta 5 toneladas?", "technical_specification"]
  ])("requires evidence for %s", (message, protectedFact) => {
    expect(evaluateAgentSafety({ message, selectedKnowledge: [] })).toEqual(
      expect.objectContaining({ handoffRequired: true, protectedFact })
    );
  });

  it.each([
    ["Tem 30 chapas em estoque?", "Há 30 chapas disponíveis em estoque.", "stock"],
    ["Qual o preço?", "O preço confirmado é R$ 199 por unidade.", "price"],
    ["Qual o prazo de entrega?", "O prazo confirmado é de 5 dias úteis.", "deadline"],
    ["Essa viga suporta a carga?", "O dimensionamento depende do responsável técnico.", "technical_specification"]
  ])("permits %s only with class-specific evidence", (message, content, protectedFact) => {
    expect(evaluateAgentSafety({
      message,
      selectedKnowledge: [{ content }]
    })).toEqual({ handoffRequired: false, protectedFact, reason: null });
  });

  it("does not accept evidence from a different protected class", () => {
    expect(evaluateAgentSafety({
      message: "Tem a chapa em estoque?",
      selectedKnowledge: [{ content: "O preço deve ser consultado com o comercial." }]
    })).toEqual(expect.objectContaining({ handoffRequired: true, protectedFact: "stock" }));
  });

  it.each([
    "manda o vlr",
    "qual o vlr da chapa?",
    "qto custa a barra?"
  ])("recognizes informal WhatsApp price requests: %s", (message) => {
    expect(evaluateAgentSafety({ message, selectedKnowledge: [] })).toEqual(
      expect.objectContaining({ handoffRequired: true, protectedFact: "price" })
    );
  });

  it.each([
    ["Qual o preço?", "O preço deve ser consultado com o comercial.", "price"],
    ["Tem 30 chapas em estoque?", "A disponibilidade deve ser confirmada.", "stock"],
    ["Qual o prazo de entrega?", "O prazo deve ser confirmado.", "deadline"]
  ])("does not mistake confirmation guidance for factual evidence: %s", (message, content, protectedFact) => {
    expect(evaluateAgentSafety({ message, selectedKnowledge: [{ content }] })).toEqual(
      expect.objectContaining({ handoffRequired: true, protectedFact })
    );
  });

  it.each([
    "Quero falar agora com uma pessoa do comercial.",
    "Preciso de um atendente humano.",
    "Pode me passar para um especialista?"
  ])("hands off immediately when a person is requested: %s", (message) => {
    expect(evaluateAgentSafety({ message, selectedKnowledge: [] })).toEqual(
      expect.objectContaining({ handoffRequired: true, protectedFact: null })
    );
  });

  it("does not require handoff for an ordinary product question", () => {
    expect(evaluateAgentSafety({
      message: "Quais produtos vocês trabalham?",
      selectedKnowledge: []
    })).toEqual({ handoffRequired: false, protectedFact: null, reason: null });
  });

  it("lets the agent qualify a new quote request before handing off", () => {
    expect(evaluateAgentSafety({
      message: "Quero fazer um orçamento de chapa xadrez.",
      selectedKnowledge: []
    })).toEqual({ handoffRequired: false, protectedFact: null, reason: null });
  });

  it("still protects a previously quoted commercial condition", () => {
    expect(evaluateAgentSafety({
      message: "Pode fechar nesse orçamento que você me passou ontem?",
      selectedKnowledge: []
    })).toEqual(expect.objectContaining({ handoffRequired: true, protectedFact: "price" }));
  });
});
