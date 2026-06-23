import { describe, expect, it } from "vitest";
import { createSimulatedAgentProvider, parseAgentOutput } from "./provider-gateway.js";

describe("parseAgentOutput", () => {
  it("parses valid structured agent output", () => {
    const output = parseAgentOutput({
      confidence: 0.82,
      reply: "Posso ajudar com isso.",
      actions: [{ type: "add_tag", tagName: "onboarding" }],
      handoff: { required: false, reason: null }
    });

    expect(output).toEqual({
      confidence: 0.82,
      reply: "Posso ajudar com isso.",
      actions: [{ type: "add_tag", tagName: "onboarding" }],
      handoff: { required: false, reason: null }
    });
  });

  it("allows nullable or omitted replies and defaults actions", () => {
    expect(
      parseAgentOutput({
        confidence: 0.7,
        reply: null,
        handoff: { required: false, reason: null }
      })
    ).toEqual({
      confidence: 0.7,
      reply: null,
      actions: [],
      handoff: { required: false, reason: null }
    });

    expect(
      parseAgentOutput({
        confidence: 0.7,
        handoff: { required: false, reason: null }
      })
    ).toEqual({
      confidence: 0.7,
      actions: [],
      handoff: { required: false, reason: null }
    });
  });

  it("throws a stable error for malformed output", () => {
    expect(() =>
      parseAgentOutput({
        reply: "",
        confidence: 2,
        handoff: { required: "no", reason: null },
        actions: ["change_priority"]
      })
    ).toThrow("Invalid agent output.");
  });
});

describe("createSimulatedAgentProvider", () => {
  it.each(["nao sei", "não sei", "irritado"])(
    "returns low confidence and handoff for %s input",
    async (text) => {
      const provider = createSimulatedAgentProvider();

      const output = await provider.generate({
        model: "simulated",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: text,
        context: {}
      });

      expect(output.confidence).toBeLessThan(0.55);
      expect(output.handoff.required).toBe(true);
      expect(output.actions).toContainEqual(
        expect.objectContaining({ type: "request_handoff" })
      );
    }
  );

  it("checks relevant message body context when simulating low confidence", async () => {
    const provider = createSimulatedAgentProvider();

    const output = await provider.generate({
      model: "simulated",
      systemPrompt: "Atenda clientes da Prymeira Talk.",
      userPrompt: "Pode analisar a conversa?",
      context: { messageBody: "O cliente esta irritado com o atraso." }
    });

    expect(output.handoff.required).toBe(true);
  });

  it("returns a normal reply and add_tag action for answerable text", async () => {
    const provider = createSimulatedAgentProvider();

    const output = await provider.generate({
      model: "simulated",
      systemPrompt: "Atenda clientes da Prymeira Talk.",
      userPrompt: "Qual o horario de atendimento?",
      context: {}
    });

    expect(output).toEqual(
      expect.objectContaining({
        confidence: 0.84,
        handoff: { required: false, reason: null }
      })
    );
    expect(output.reply).toContain("Prymeira Talk");
    expect(output.actions).toEqual([{ type: "add_tag", tagName: "Atendido pela IA" }]);
  });
});
