import { describe, expect, it } from "vitest";
import { HANDOFF_ACKNOWLEDGEMENT } from "./agent-safety-policy.js";
import { normalizeAgentHandoffOutput, usesQualificationHandoff } from "./agent-output-normalizer.js";

describe("normalizeAgentHandoffOutput", () => {
  it("aligns the qualified N11 handoff with its reply and records only the supplied reason", () => {
    const reason = "Confirmar se há cantoneira de alumínio com acabamento branco.";
    const result = normalizeAgentHandoffOutput({
      confidence: 0.9,
      reply: "Bom dia, Claudio! A Villefer trabalha com cantoneiras de alumínio; o acabamento branco precisa de confirmação. Posso encaminhar essa verificação ao vendedor?",
      actions: [{ type: "request_handoff", reason }],
      handoff: { required: true, reason }
    }, { preserveReply: true });

    expect(result.reply).toBe("Bom dia, Claudio! A Villefer trabalha com cantoneiras de alumínio; o acabamento branco precisa de confirmação. Vou encaminhar essa verificação ao vendedor.");
    expect(result.actions).toEqual([
      { type: "create_internal_note", body: `Motivo do repasse: ${reason}` },
      { type: "request_handoff", reason }
    ]);
    expect(normalizeAgentHandoffOutput(result, { preserveReply: true })).toEqual(result);
  });

  it("retains an existing seller note when changing the final handoff permission question", () => {
    const note = { type: "create_internal_note", body: "Cliente solicitou 4 cantoneiras; acabamento branco pendente." };
    const result = normalizeAgentHandoffOutput({ confidence: 0.9,
      reply: "O acabamento está pendente. Podemos passar essa dúvida ao vendedor?",
      actions: [note], handoff: { required: true, reason: "Confirmar acabamento." }
    }, { preserveReply: true });
    expect(result.reply).toBe("O acabamento está pendente. Vamos passar essa dúvida ao vendedor.");
    expect(result.actions.filter((action) => action.type === "create_internal_note")).toEqual([note]);
  });

  it("leaves customer-detail questions and non-handoff output unchanged", () => {
    const output = { confidence: 0.9, reply: "Posso confirmar a quantidade de cantoneiras?",
      actions: [], handoff: { required: false, reason: null } };
    expect(normalizeAgentHandoffOutput(output, { preserveReply: true })).toEqual(output);
    for (const reply of [output.reply, "Posso passar as medidas novamente?"]) {
      expect(normalizeAgentHandoffOutput({ ...output, reply, handoff: { required: true, reason: "Validação técnica." } }, { preserveReply: true }).reply).toBe(reply);
    }
  });

  it("does not invent details when a qualified handoff has no specific reason", () => {
    const output = { confidence: 0.9, reply: "Posso encaminhar?", actions: [],
      handoff: { required: true, reason: null } };
    const result = normalizeAgentHandoffOutput(output, { preserveReply: true });
    expect(result.reply).toBe("Vou encaminhar.");
    expect(result.actions[0]).toEqual({ type: "create_internal_note", body: "Repasse solicitado pelo agente; motivo específico não informado." });
    expect(output.actions).toEqual([]);
  });

  it("keeps legacy handoff output free of the new automatic note", () => {
    const result = normalizeAgentHandoffOutput({ confidence: 0.9,
      reply: "O acabamento está pendente. Posso encaminhar ao vendedor?",
      actions: [], handoff: { required: true, reason: "Confirmar acabamento." }
    });
    expect(result.reply).toBe(HANDOFF_ACKNOWLEDGEMENT);
    expect(result.actions).toEqual([{ type: "request_handoff", reason: "Confirmar acabamento." }]);
  });

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
