import { describe, expect, it } from "vitest";
import { findRepeatedQuestion } from "./repeated-question.js";

const opening = "Oi, tudo bem? Aqui é o João da Prymeira. Quem cuida do atendimento e dos orçamentos pelo WhatsApp aí na Casa Mil Materiais para Construção?";

describe("findRepeatedQuestion", () => {
  it("catches the campaign question asked again", () => {
    expect(findRepeatedQuestion("Boa tarde! Quem cuida do atendimento e dos orçamentos pelo WhatsApp aí na Casa Mil?", [opening]))
      .toBe("Quem cuida do atendimento e dos orçamentos pelo WhatsApp aí na Casa Mil?");
  });
  it("lets a new question through", () => {
    expect(findRepeatedQuestion("Entendi, vocês três dividem a loja e o WhatsApp.\n\nQuer entender como funcionaria aí?", [opening])).toBeNull();
  });
  it("ignores short social questions", () => {
    expect(findRepeatedQuestion("Tudo bem?", ["Oi, tudo bem?"])).toBeNull();
  });
});
