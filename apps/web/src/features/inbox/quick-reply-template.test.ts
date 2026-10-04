import { describe, expect, it } from "vitest";
import { greeting, renderTemplate, templateFields, usesContactFields } from "./quick-reply-template";

describe("quick reply fields", () => {
  it("fills every field, old {{company}} templates included", () => {
    expect(renderTemplate("{saudacao}, {primeiro_nome}! Aqui é o {vendedor} da Villefer.", { saudacao: "Boa tarde", primeiro_nome: "Jackson", vendedor: "Junior" }).text)
      .toBe("Boa tarde, Jackson! Aqui é o Junior da Villefer.");
    expect(renderTemplate("Olá, tudo bem? Vi a {{company}} e queria falar.", { empresa: "Construtora Alfa" }).text).toBe("Olá, tudo bem? Vi a Construtora Alfa e queria falar.");
    expect(renderTemplate("{Primeiro Nome}", { primeiro_nome: "Ana" }).text).toBe("Ana");
  });
  it("drops a missing field and keeps the sentence clean", () => {
    expect(renderTemplate("Olá, {primeiro_nome}!", {})).toEqual({ text: "Olá!", missing: ["primeiro_nome"] });
    expect(renderTemplate("{primeiro_nome}, tudo bem?", {}).text).toBe("Tudo bem?");
    expect(renderTemplate("Oi {primeiro_nome}, como vai a {empresa}?", { primeiro_nome: "Ana" }).text).toBe("Oi Ana, como vai a?");
    expect(renderTemplate("Bom dia {primeiro_nome}.\nSegue a tabela.", {}).text).toBe("Bom dia.\nSegue a tabela.");
  });
  it("knows which fields need the contact, and leaves unknown braces alone", () => {
    expect(templateFields("{saudacao} {primeiro_nome} {{company}}")).toEqual(["saudacao", "primeiro_nome", "empresa"]);
    expect(usesContactFields("{saudacao}, tudo bem?")).toBe(false);
    expect(renderTemplate("Use {chave} aqui", {}).text).toBe("Use {chave} aqui");
  });
  it("greets by the hour", () => {
    expect(greeting(new Date(2026, 9, 4, 9))).toBe("Bom dia"); expect(greeting(new Date(2026, 9, 4, 14))).toBe("Boa tarde"); expect(greeting(new Date(2026, 9, 4, 20))).toBe("Boa noite");
  });
});
