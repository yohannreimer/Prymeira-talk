import { describe, expect, it } from "vitest";
import { enforceWhatsAppReply } from "./agent-reply-policy.js";

describe("enforceWhatsAppReply", () => {
  it("keeps concise replies unchanged", () => {
    const reply = "Temos chapas, tubos e vigas. Qual item você procura?";
    expect(enforceWhatsAppReply(reply)).toEqual({
      reply,
      compacted: false,
      originalCharacters: reply.length
    });
  });

  it("normalizes whitespace before measuring", () => {
    expect(enforceWhatsAppReply("  Temos   chapas.\n\n\nQual medida?  ")).toEqual({
      reply: "Temos chapas.\n\nQual medida?",
      compacted: false,
      originalCharacters: 27
    });
  });

  it("compacts long lists without cutting a Unicode character", () => {
    const result = enforceWhatsAppReply(
      Array.from({ length: 30 }, (_, index) => `• Produto metálico ${index + 1} 🔩`).join("\n")
    );

    expect(result.reply.length).toBeLessThanOrEqual(500);
    expect(result.reply).toMatch(/[.!?…]$/u);
    expect(result.reply).not.toContain("�");
    expect(result.compacted).toBe(true);
  });

  it("preserves a final handoff sentence", () => {
    const result = enforceWhatsAppReply(
      `${"Detalhe comercial. ".repeat(80)}Vou encaminhar para o comercial confirmar.`
    );

    expect(result.reply.length).toBeLessThanOrEqual(500);
    expect(result.reply).toContain("encaminhar para o comercial");
  });
});
