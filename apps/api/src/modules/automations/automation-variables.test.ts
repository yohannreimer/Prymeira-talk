import { describe, expect, it } from "vitest";
import {
  flattenAutomationVariables,
  formatAutomationVariablesForTeam,
  interpolateAutomationText
} from "./automation-variables.js";

const prymeiraSitePayload = {
  nome: "Joana Silva",
  whatsapp: "(47) 99999-1234",
  empresa: "Metalúrgica Joana",
  faturamento: "R$ 1 a 5 milhões",
  dor: "Caixa apertado",
  equipe: ["Financeiro", "Comercial"],
  utm: { source: "instagram", campaign: "outubro" },
  pagina: "/diagnostico",
  enviado_em: "2026-10-11T12:00:00.000Z"
};

describe("automation variables", () => {
  it("flattens form payloads into readable string variables", () => {
    expect(flattenAutomationVariables(prymeiraSitePayload)).toEqual({
      nome: "Joana Silva",
      whatsapp: "(47) 99999-1234",
      empresa: "Metalúrgica Joana",
      faturamento: "R$ 1 a 5 milhões",
      dor: "Caixa apertado",
      equipe: "Financeiro, Comercial",
      "utm.source": "instagram",
      "utm.campaign": "outubro",
      pagina: "/diagnostico",
      enviado_em: "2026-10-11T12:00:00.000Z"
    });
  });

  it("ignores unsafe keys, empty values and deep structures", () => {
    const variables = flattenAutomationVariables({
      "bad key": "x",
      vazio: "  ",
      aceite: true,
      idade: 42,
      profundo: { nivel: { mais: "x" } },
      lista: [{ a: 1 }, "ok"],
      ["__proto__"]: "valor"
    });

    expect(variables).toEqual({ aceite: "sim", idade: "42", lista: "ok", ["__proto__"]: "valor" });
    expect(Object.getPrototypeOf(variables)).toBe(Object.prototype);
  });

  it("interpolates {{campo}} placeholders, case-insensitively, with missing fields left empty", () => {
    const variables = flattenAutomationVariables(prymeiraSitePayload);

    expect(
      interpolateAutomationText(
        "Oi {{nome}}, vi aqui teu formulário sobre {{ DOR }} ({{utm.source}}).{{inexistente}}",
        variables
      )
    ).toBe("Oi Joana Silva, vi aqui teu formulário sobre Caixa apertado (instagram).");
    expect(interpolateAutomationText("{{constructor}}{{toString}}", variables)).toBe("");
  });

  it("keeps interpolated form values on one line and capped", () => {
    const text = interpolateAutomationText("Olá {{nome}}!", { nome: `Ana\n\nMaria ${"x".repeat(400)}` });

    expect(text.startsWith("Olá Ana Maria x")).toBe(true);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual("Olá !".length + 300);
  });

  it("formats variables as readable lines for the team", () => {
    expect(
      formatAutomationVariablesForTeam("Formulário recebido", {
        nome: "Joana",
        "utm.source": "instagram",
        dor: "linha 1\nlinha 2"
      })
    ).toBe("Formulário recebido\nNome: Joana\nUtm source: instagram\nDor: linha 1 / linha 2");
  });
});
