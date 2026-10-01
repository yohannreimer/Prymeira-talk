import { describe, expect, it, vi } from "vitest";
import { createMessageVariationService, extractPlaceholders, validateVariations } from "./message-variations.js";

const original = "Olá {{nome}}, temos aço carbono em estoque. Posso te enviar a tabela?";

describe("extractPlaceholders", () => {
  it("normaliza espaços e ordena", () => {
    expect(extractPlaceholders("{{ b }} e {{a}} e {{b}}")).toEqual(["a", "b", "b"]);
  });
});

describe("validateVariations", () => {
  it("mantém só variações com os mesmos campos, diferentes entre si e da original", () => {
    const result = validateVariations(original, [
      "Oi {{nome}}! Temos aço carbono disponível. Quer a tabela?",
      "Oi {{nome}}! Temos aço carbono disponível. Quer a tabela?",
      "Olá {{nome}}, temos aço carbono em estoque. Posso te enviar a tabela?",
      "Oi, temos aço carbono. Quer a tabela?",
      "Bom dia {{nome}}, tenho aço carbono pronto. Mando a tabela?",
      "x".repeat(2001)
    ]);
    expect(result).toEqual([
      "Oi {{nome}}! Temos aço carbono disponível. Quer a tabela?",
      "Bom dia {{nome}}, tenho aço carbono pronto. Mando a tabela?"
    ]);
  });
});

describe("message variation service", () => {
  const five = [1, 2, 3, 4, 5].map((n) => `Variação ${n} para {{nome}}: aço carbono, posso enviar a tabela?`);

  it("devolve 5 variações válidas", async () => {
    const analyze = vi.fn(async () => ({ variations: [...five, "Variação 6 para {{nome}}: aço carbono?"] }));
    const service = createMessageVariationService({ analyze: analyze as never });
    expect(await service.generate({ workspaceId: "w", message: original })).toEqual(five);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("pede o que faltou numa segunda tentativa", async () => {
    const analyze = vi.fn()
      .mockResolvedValueOnce({ variations: five.slice(0, 3) })
      .mockResolvedValueOnce({ variations: five.slice(3) });
    const service = createMessageVariationService({ analyze: analyze as never });
    expect(await service.generate({ workspaceId: "w", message: original })).toEqual(five);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("devolve as válidas se mesmo assim faltarem, e erro se nenhuma servir", async () => {
    const some = vi.fn().mockResolvedValue({ variations: ["só uma {{nome}} variação diferente"] });
    expect(await createMessageVariationService({ analyze: some as never }).generate({ workspaceId: "w", message: original }))
      .toHaveLength(1);
    const none = vi.fn().mockResolvedValue({ variations: ["sem campo nenhum"] });
    await expect(createMessageVariationService({ analyze: none as never }).generate({ workspaceId: "w", message: original }))
      .rejects.toThrow("VARIATIONS_INVALID");
  });
});
