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

describe("validateVariations preserva links, preços e números", () => {
  const offer = "Olá {{nome}}, o kit sai por R$ 10 e o frete R$ 1.234,56. Veja https://loja.com/kit?id=7. Dúvidas: (47) 99999-1234.";

  it("rejeita variação que muda o preço", () => {
    expect(validateVariations(offer, [
      "Oi {{nome}}! O kit custa R$ 12 e o frete R$ 1.234,56. Link: https://loja.com/kit?id=7 — dúvidas no (47) 99999-1234."
    ])).toEqual([]);
  });

  it("rejeita variação que perde ou altera o link", () => {
    expect(validateVariations(offer, [
      "Oi {{nome}}! Kit por R$ 10, frete R$ 1.234,56. Dúvidas: (47) 99999-1234.",
      "Oi {{nome}}! Kit por R$ 10, frete R$ 1.234,56. Veja https://loja.com/kit?id=8 ou (47) 99999-1234."
    ])).toEqual([]);
  });

  it("rejeita variação que altera o telefone ou um número grande", () => {
    expect(validateVariations(offer, [
      "Oi {{nome}}! Kit por R$ 10, frete R$ 1.234,56. Veja https://loja.com/kit?id=7. Fale no (47) 99999-1235.",
      "Oi {{nome}}! Kit por R$ 10, frete R$ 1.235,56. Veja https://loja.com/kit?id=7. Fale no (47) 99999-1234."
    ])).toEqual([]);
  });

  it("aceita variação que mantém link, preços e telefone", () => {
    const ok = "Oi {{nome}}! O kit está R$ 10 e o frete fica R$ 1.234,56. Confira em https://loja.com/kit?id=7, e qualquer dúvida chame no (47) 99999-1234!";
    expect(validateVariations(offer, [ok])).toEqual([ok]);
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

  it("pede mais tokens de saída para mensagens longas", async () => {
    const analyze = vi.fn(async () => ({ variations: five }));
    await createMessageVariationService({ analyze: analyze as never }).generate({ workspaceId: "w", message: original });
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ maxCompletionTokens: 8192 }));
  });

  it("se a segunda tentativa falhar, devolve as já aceitas", async () => {
    const analyze = vi.fn()
      .mockResolvedValueOnce({ variations: five.slice(0, 2) })
      .mockRejectedValueOnce(new Error("LUNA_ANALYSIS_RESPONSE_INVALID"));
    expect(await createMessageVariationService({ analyze: analyze as never }).generate({ workspaceId: "w", message: original }))
      .toEqual(five.slice(0, 2));
  });

  it("se a segunda tentativa falhar sem nenhuma aceita, propaga o erro", async () => {
    const analyze = vi.fn()
      .mockResolvedValueOnce({ variations: ["sem campo nenhum"] })
      .mockRejectedValueOnce(new Error("LUNA_ANALYSIS_RESPONSE_INVALID"));
    await expect(createMessageVariationService({ analyze: analyze as never }).generate({ workspaceId: "w", message: original }))
      .rejects.toThrow("LUNA_ANALYSIS_RESPONSE_INVALID");
  });
});
