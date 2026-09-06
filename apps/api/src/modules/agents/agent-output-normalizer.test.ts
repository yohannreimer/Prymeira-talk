import { describe, expect, it } from "vitest";
import { HANDOFF_ACKNOWLEDGEMENT } from "./agent-safety-policy.js";
import { normalizeAgentHandoffOutput, usesQualificationHandoff } from "./agent-output-normalizer.js";

describe("normalizeAgentHandoffOutput", () => {
  it("enables contextual handoff only for qualification packages", () => {
    expect(usesQualificationHandoff({ qualification: { fields: [{ key: "product" }] } })).toBe(true);
    for (const value of [null, {}, { qualification: {} }, { qualification: { fields: [] } }]) {
      expect(usesQualificationHandoff(value)).toBe(false);
    }
  });
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

  it("preserves the useful short handoff explanation when explicitly enabled", () => {
    const output = normalizeAgentHandoffOutput({
      confidence: 0.9,
      reply: "O acabamento branco precisa ser confirmado pelo vendedor. Vou encaminhar seu pedido com essa observação.",
      actions: [{ type: "create_internal_note", body: "Cliente pediu acabamento branco; confirmar disponibilidade." }],
      handoff: { required: true, reason: "Acabamento não confirmado." }
    }, { preserveReply: true });
    expect(output.reply).toContain("acabamento branco");
    expect(output.actions.some((action) => action.type === "request_handoff")).toBe(true);
  });

  it("still supplies an acknowledgement for a missing reply in qualified mode", () => {
    expect(normalizeAgentHandoffOutput({ confidence: 0.9, reply: null, actions: [],
      handoff: { required: true, reason: "Pedido completo." }
    }, { preserveReply: true }).reply).toBe(HANDOFF_ACKNOWLEDGEMENT);
  });
});
