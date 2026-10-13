import { describe, expect, it } from "vitest";
import { isExplicitProspectingRefusal } from "./prospecting-refusal.js";

describe("isExplicitProspectingRefusal", () => {
  it.each([
    "Não tenho interesse, obrigado",
    "não temos mais interesse",
    "Sem interesse",
    "não me interessa",
    "Por favor me tira da lista",
    "remova meu número",
    "não me chame mais",
    "Número errado",
    "foi engano",
    "pare de mandar mensagem"
  ])("stops on %s", (body) => expect(isExplicitProspectingRefusal(body)).toBe(true));

  it.each([
    "Agora não posso, me chama amanhã",
    "Quem é?",
    "Tenho interesse sim",
    "já temos um sistema, mas como funciona o de vocês?",
    "não entendi"
  ])("keeps the agent on %s", (body) => expect(isExplicitProspectingRefusal(body)).toBe(false));
});
