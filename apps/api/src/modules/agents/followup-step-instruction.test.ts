import { describe, expect, it } from "vitest";
import { resolveFollowupStepInstruction } from "./followup-step-instruction.js";

describe("resolveFollowupStepInstruction", () => {
  it("uses the safe qualification instruction even when the configured step is commercial", () => {
    const instruction = resolveFollowupStepInstruction({
      kind: "qualification",
      configuredInstruction: "Confirme o recebimento da proposta."
    });

    expect(instruction).toContain("qualificação técnica ou cadastral");
    expect(instruction).toContain("não é acompanhamento de proposta");
    expect(instruction).not.toContain("Confirme o recebimento");
    expect(instruction).toContain("catálogo");
  });

  it("preserves the configured instruction for human commercial review", () => {
    expect(resolveFollowupStepInstruction({
      kind: "human_commercial",
      configuredInstruction: "Confirme o recebimento da proposta."
    })).toBe("Confirme o recebimento da proposta.");
  });
});
