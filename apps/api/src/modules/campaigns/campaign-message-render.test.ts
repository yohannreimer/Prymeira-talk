import { describe, expect, it } from "vitest";
import { findUnresolvedVariables, renderCampaignMessage } from "./campaign-message-render.js";

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

describe("renderCampaignMessage sem nome: só mexe ao redor do campo", () => {
  const blank = (template: string) => renderCampaignMessage({ template, contact, firstName: null });
  it.each([
    ["Olá, {{nome}}, tudo bem?", "Olá, tudo bem?"],
    ["Fala, {{nome}}, beleza?", "Fala, beleza?"],
    ["Olá {{nome}} :) Veja", "Olá :) Veja"],
    ["Oi {{nome}}", "Oi"],
    ["{{nome}}", ""],
    ["{{nome}}, oi\nSegunda linha: ok", "Oi\nSegunda linha: ok"],
    ["Oi {{nome}}!", "Oi!"],
    ["Olá, {{nome}}!", "Olá!"],
    ["Olá {{nome}}, tudo bem?", "Olá, tudo bem?"],
    ["{{nome}}, tudo bem?", "Tudo bem?"],
    ["Bom dia {{nome}} e equipe", "Bom dia e equipe"],
    ["Oi {{nome}}\n\nTchau", "Oi\n\nTchau"]
  ])("%j -> %j", (template, expected) => {
    expect(blank(template)).toBe(expected);
  });

  it("devolve o texto idêntico quando não há nome em branco", () => {
    const text = ":) começo\nPreço : R$ 10 . 000  hoje\nhttps://x.com/a, b\n, linha\n  recuo  ";
    expect(renderCampaignMessage({ template: text, contact, firstName: null })).toBe(text);
    expect(renderCampaignMessage({ template: `Oi {{nome}}\n${text}`, contact, firstName: "Ana" }))
      .toBe(`Oi Ana\n${text}`);
  });

  it("com nome em branco, só altera o trecho do campo", () => {
    expect(blank("Olá {{nome}}!\n:) veja https://x.com/a, b 10 . 000"))
      .toBe("Olá!\n:) veja https://x.com/a, b 10 . 000");
    expect(blank(":) oi\n  {{nome}}, tudo bem?  \n, fim"))
      .toBe(":) oi\n  Tudo bem?  \n, fim");
  });
});

describe("findUnresolvedVariables", () => {
  it("ignora nome e name, e aponta campos vazios", () => {
    expect(findUnresolvedVariables("{{nome}} {{name}} {{empresa}} {{cidade}}", contact)).toEqual(["cidade"]);
  });
});
