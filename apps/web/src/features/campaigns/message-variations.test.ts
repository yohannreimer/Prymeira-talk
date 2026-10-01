import { describe, expect, it } from "vitest";
import { buildTemplates, missingPlaceholders, placeholdersOf } from "./message-variations";

describe("variation helpers", () => {
  it("lista os campos usados", () => {
    expect(placeholdersOf("Oi {{ nome }} e {{empresa}}")).toEqual(["empresa", "nome"]);
  });
  it("aponta campos da original ausentes na variação", () => {
    expect(missingPlaceholders("Oi {{nome}} {{empresa}}", "Oi {{nome}}")).toEqual(["empresa"]);
    expect(missingPlaceholders("Oi {{nome}}", "Oi {{nome}}")).toEqual([]);
  });
  it("monta os templates: original primeiro, vazios fora, no máximo 6", () => {
    const variations = ["a", " ", "b", "c", "d", "e", "f", "g"];
    expect(buildTemplates("  original ", variations)).toEqual(["original", "a", "b", "c", "d", "e"]);
  });
});
