import { describe, expect, it } from "vitest";
import { humanReason } from "./RequestDetail";

describe("humanReason", () => {
  it("says in words why the buyer agent handed the conversation over", () => {
    expect(humanReason("quer_falar_com_pessoa: quer negociar por telefone")).toBe("O fornecedor pediu para falar com uma pessoa: quer negociar por telefone");
    expect(humanReason("fora_da_alcada")).toBe("O fornecedor quer fechar ou mudar o pedido.");
    expect(humanReason("Mensagem bloqueada pelo revisor (juiz_inventa): x")).toContain("não conseguiu escrever uma resposta segura");
    expect(humanReason("outro motivo")).toBe("outro motivo");
  });
});
