import { describe, expect, it } from "vitest";
import { findUnresolvedVariables, renderCampaignMessage, tidyRenderedText } from "./campaign-message-render.js";

const contact = { phone: "554799999999", fields: { empresa: "Metalpress" } };

describe("renderCampaignMessage", () => {
  it("usa o primeiro nome quando informado", () => {
    expect(renderCampaignMessage({ template: "Olá {{nome}}, tudo bem?", contact, firstName: "Agnaldo" }))
      .toBe("Olá Agnaldo, tudo bem?");
  });
  it("sem nome, remove o espaço antes da pontuação", () => {
    expect(renderCampaignMessage({ template: "Olá {{nome}}, tudo bem?", contact, firstName: null }))
      .toBe("Olá, tudo bem?");
    expect(renderCampaignMessage({ template: "Oi {{ name }}!", contact, firstName: null })).toBe("Oi!");
  });
  it("sem nome no início da frase, remove a vírgula e põe maiúscula", () => {
    expect(renderCampaignMessage({ template: "{{nome}}, tudo bem?", contact, firstName: null }))
      .toBe("Tudo bem?");
  });
  it("sem nome, trata 'Olá, {{nome}}!'", () => {
    expect(renderCampaignMessage({ template: "Olá, {{nome}}!", contact, firstName: null })).toBe("Olá!");
  });
  it("não mexe no texto quando o nome está preenchido", () => {
    expect(renderCampaignMessage({ template: "Preço : R$ 10  hoje", contact, firstName: "Ana" }))
      .toBe("Preço : R$ 10  hoje");
  });
  it("usa fallback explícito, mas ignora o 'cliente' padrão", () => {
    expect(renderCampaignMessage({ template: "Olá {{nome}}!", contact, firstName: null, explicitFallbackName: "amigo" }))
      .toBe("Olá amigo!");
    expect(renderCampaignMessage({ template: "Olá {{nome}}!", contact, firstName: null, explicitFallbackName: "Cliente" }))
      .toBe("Olá!");
  });
  it("preenche outros campos e telefone", () => {
    expect(renderCampaignMessage({ template: "{{empresa}} {{telefone}}", contact, firstName: null }))
      .toBe("Metalpress 554799999999");
  });
});

describe("tidyRenderedText", () => {
  it("colapsa espaços e apara as linhas", () => {
    expect(tidyRenderedText("  Oi   você \n  tudo bem  ")).toBe("Oi você\ntudo bem");
  });
});

describe("findUnresolvedVariables", () => {
  it("ignora nome e name, e aponta campos vazios", () => {
    expect(findUnresolvedVariables("{{nome}} {{name}} {{empresa}} {{cidade}}", contact)).toEqual(["cidade"]);
  });
});
