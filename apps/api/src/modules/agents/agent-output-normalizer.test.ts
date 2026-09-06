import { describe, expect, it } from "vitest";
import { HANDOFF_ACKNOWLEDGEMENT } from "./agent-safety-policy.js";
import { normalizeAgentHandoffOutput } from "./agent-output-normalizer.js";

describe("normalizeAgentHandoffOutput", () => {
  it("turns the reserved acknowledgement into a complete handoff", () => {
    const result = normalizeAgentHandoffOutput({
      confidence: 0.82,
      reply: HANDOFF_ACKNOWLEDGEMENT,
      actions: [],
      handoff: { required: false, reason: null }
    });

    expect(result.handoff).toEqual({
      required: true,
      reason: "Agent requested consultation."
    });
    expect(result.actions).toEqual([
      { type: "request_handoff", reason: "Agent requested consultation." }
    ]);
  });

  it("uses an existing action reason and does not duplicate the action", () => {
    const result = normalizeAgentHandoffOutput({
      confidence: 0.8,
      reply: "Vou encaminhar ao vendedor.",
      actions: [
        { type: "add_tag", tag: "Lead quente" },
        { type: "request_handoff", reason: "Preço precisa de validação." }
      ],
      handoff: { required: false, reason: null }
    });

    expect(result.reply).toBe(HANDOFF_ACKNOWLEDGEMENT);
    expect(result.handoff).toEqual({
      required: true,
      reason: "Preço precisa de validação."
    });
    expect(result.actions.filter((action) => action.type === "request_handoff")).toHaveLength(1);
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "add_tag", tag: "Lead quente" })
    ]));
  });

  it("preserves a normal non-handoff reply", () => {
    const output = {
      confidence: 0.9,
      reply: "Qual medida você precisa?",
      actions: [],
      handoff: { required: false, reason: null }
    };

    expect(normalizeAgentHandoffOutput(output)).toEqual(output);
  });
});
