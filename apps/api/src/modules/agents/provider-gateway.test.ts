import { describe, expect, it } from "vitest";
import { createSimulatedAgentProvider, parseAgentOutput } from "./provider-gateway.js";

describe("parseAgentOutput", () => {
  it("parses valid structured agent output", () => {
    const output = parseAgentOutput({
      reply: "Posso ajudar com isso.",
      confidence: 0.82,
      shouldHandoff: false,
      actions: [{ action: "add_tag", name: "Atendido pela IA" }]
    });

    expect(output).toEqual({
      reply: "Posso ajudar com isso.",
      confidence: 0.82,
      shouldHandoff: false,
      actions: [{ action: "add_tag", name: "Atendido pela IA" }]
    });
  });

  it("throws a stable error for malformed output", () => {
    expect(() =>
      parseAgentOutput({
        reply: "",
        confidence: 2,
        shouldHandoff: "no",
        actions: [{ action: "change_priority", priority: "urgent" }]
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
        workspaceId: "workspace_a",
        agentId: "agent_1",
        conversationId: "conv_1",
        text
      });

      expect(output.confidence).toBeLessThan(0.55);
      expect(output.shouldHandoff).toBe(true);
      expect(output.actions).toContainEqual(
        expect.objectContaining({ action: "request_handoff" })
      );
    }
  );

  it("returns a normal reply and add_tag action for answerable text", async () => {
    const provider = createSimulatedAgentProvider();

    const output = await provider.generate({
      workspaceId: "workspace_a",
      agentId: "agent_1",
      conversationId: "conv_1",
      text: "Qual o horario de atendimento?"
    });

    expect(output).toEqual(
      expect.objectContaining({
        confidence: 0.84,
        shouldHandoff: false
      })
    );
    expect(output.reply).toContain("Prymeira Talk");
    expect(output.actions).toEqual([{ action: "add_tag", name: "Atendido pela IA" }]);
  });
});
