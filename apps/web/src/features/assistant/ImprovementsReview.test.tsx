import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiAgentImprovementDto } from "../../app/api";
import { ImprovementsReview } from "./ImprovementsReview";

const pending: AiAgentImprovementDto = {
  id: "improvement-1", workspaceId: "workspace-1", agentId: "agent-1", conversationId: "conversation-1", sourceMessageId: "message-1",
  status: "pending", kind: "not_sold", title: "Produto não comercializado — revisar", content: "Não comercializamos este produto.",
  rationale: "O humano confirmou uma decisão comercial reutilizável.", sourceCustomerMessage: "Vocês têm barra chata galvanizada?",
  sourceHumanReply: "Não trabalhamos com esse produto.", detector: { confidence: 0.95 },
  clarification: {
    questions: [
      { id: "scope", question: "A decisão vale para todas as medidas?", help: "Delimite o escopo." },
      { id: "exceptions", question: "Quais exceções existem?", help: "Escreva Nenhuma se não houver." }
    ],
    answers: {}, normalization: null
  },
  reviewedAt: null, acceptedKnowledgeSourceId: null, createdAt: "2026-09-22T14:00:00.000Z", updatedAt: "2026-09-22T14:00:00.000Z"
};

function render(origin?: (improvement: AiAgentImprovementDto) => string | null) {
  return renderToStaticMarkup(<ImprovementsReview
    improvements={[pending]} loading={false} ready
    api={{ update: vi.fn(), normalize: vi.fn(), approve: vi.fn() }}
    onUpdated={vi.fn()} onError={vi.fn()} onNotice={vi.fn()}
    intro="Intro" approveConfirm="Aprovar?" approvedNotice="Aprovada." origin={origin}
  />);
}

describe("ImprovementsReview", () => {
  it("requires a scoped team answer before a pending improvement can be approved", () => {
    const html = render();
    expect(html).toContain("Complete o escopo antes de incluir");
    expect(html).toContain("A decisão vale para todas as medidas?");
    expect(html).toContain("Preparar regra com IA");
    expect(html).toMatch(/<button class="primary-button" type="button" disabled="">[^]*?Aprovar e incluir/);
  });

  it("names the workspace a suggestion came from when one list covers several", () => {
    expect(render(() => "Vendas 05")).toContain("Vendas 05");
  });
});
