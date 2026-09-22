import { describe, expect, it } from "vitest";
import type { MessageDto } from "@prymeira-talk/shared";
import { buildHandoffBrief } from "./handoff-brief";

function message(direction: MessageDto["direction"], body: string, sentByUserId: string | null = null) {
  return { direction, body, type: "text" as const, sentByUserId };
}

describe("buildHandoffBrief", () => {
  it("summarizes the customer's latest details and the last automated reply for a commercial handoff", () => {
    const brief = buildHandoffBrief("commercial_policy_risk", [
      message("inbound", "Poderia me ajudar com uma cotação?"),
      message("outbound", "Qual produto, medidas e quantidade?"),
      message("inbound", "Material para porcas Oxicortado, 4 peças, aço 1045."),
      message("outbound", "Vou consultar essas informações e já te dou um retorno."),
      message("outbound", "Mensagem posterior do vendedor.", "user-1")
    ]);

    expect(brief.customerContext).toContain("4 peças, aço 1045");
    expect(brief.lastReply).toBe("Vou consultar essas informações e já te dou um retorno.");
    expect(brief.reason).toContain("confirmada por uma pessoa");
    expect(brief.nextStep).toContain("responda ao cliente");
    expect(brief.nextStep).not.toContain("estoque confirmado");
  });

  it("keeps an explicit human reason and uses safe fallbacks when history is unavailable", () => {
    expect(buildHandoffBrief("Cliente pediu atendimento humano", [])).toEqual({
      customerContext: null,
      lastReply: null,
      reason: "Cliente pediu atendimento humano",
      nextStep: "Revise o pedido e responda ao cliente com as informações confirmadas."
    });
  });

  it("points to image attachments without pretending to know their content", () => {
    const brief = buildHandoffBrief("commercial_policy_risk", [
      { direction: "inbound", body: null, type: "image", sentByUserId: null }
    ]);
    expect(brief.customerContext).toContain("confira o anexo");
  });
});
