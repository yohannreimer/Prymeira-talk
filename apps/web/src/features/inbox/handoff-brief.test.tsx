import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HandoffBrief } from "./HandoffBrief";
import type { HandoffBriefDto } from "../../../../../packages/shared/src/assistant";

const ready: HandoffBriefDto = {
  status: "ready", nextAction: "Verifique se trabalhamos com o material solicitado.",
  summary: "Ricardo, da Fetti Fundição, pediu quatro peças de aço 1045 para porcas oxicortadas. Medidas: 220 × 125 × 160 mm. Viabilidade ainda não confirmada.",
  contextKey: "one", updatedAt: "2026-09-22T19:00:00Z", error: null
};

describe("private seller brief", () => {
  it("shows a concrete action and concise summary without repeated transcript blocks", () => {
    const html = renderToStaticMarkup(<HandoffBrief brief={ready} busy={false} onComplete={() => undefined} />);
    expect(html).toContain("Faça agora");
    expect(html).toContain("Resumo");
    expect(html).toContain("Verifique se trabalhamos");
    expect(html).toContain("220 × 125 × 160 mm");
    expect(html).not.toContain("O cliente informou");
    expect(html).not.toContain("O que já foi dito");
    expect(html).not.toContain("Motivo do repasse");
    expect(html).not.toContain("Enviar resposta");
    expect(html).toContain("Marcar como concluído");
  });
  it("shows honest pending, stale and failure states", () => {
    expect(renderToStaticMarkup(<HandoffBrief brief={{ ...ready, status: "pending", nextAction: null, summary: null }} busy={false} onComplete={() => undefined} />)).toContain("Preparando próximo passo");
    expect(renderToStaticMarkup(<HandoffBrief brief={{ ...ready, status: "stale" }} busy={false} onComplete={() => undefined} />)).toContain("Atualizando");
    expect(renderToStaticMarkup(<HandoffBrief brief={{ ...ready, status: "failed", nextAction: null, summary: null, error: "Indisponível" }} busy={false} onComplete={() => undefined} />)).toContain("Indisponível");
  });
});
