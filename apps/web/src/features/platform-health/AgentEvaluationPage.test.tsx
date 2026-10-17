// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAgentImprovementDto } from "../../app/api";
import type { AgentEvaluation, EvaluationClient } from "../../app/supervision-api";

const mocks = vi.hoisted(() => ({ clients: vi.fn(), list: vi.fn(), run: vi.fn(), decide: vi.fn(), remove: vi.fn(), improvements: vi.fn(), approveImprovement: vi.fn() }));
vi.mock("../../app/auth", () => ({ useTalkAuth: () => ({ getToken: async () => "t" }) }));
vi.mock("../../app/supervision-api", async (original) => ({
  ...(await original<typeof import("../../app/supervision-api")>()),
  apiEvaluationClients: mocks.clients,
  apiClientEvaluations: mocks.list,
  apiRunClientEvaluation: mocks.run,
  apiDecideClientProposal: mocks.decide,
  apiRemoveClientRule: mocks.remove,
  apiClientImprovements: mocks.improvements,
  apiApproveClientImprovement: mocks.approveImprovement,
  apiUpdateClientImprovement: vi.fn(),
  apiNormalizeClientImprovement: vi.fn()
}));

import { AgentEvaluationPage } from "./AgentEvaluationPage";

const villefer: EvaluationClient = {
  key: "villefer", name: "Villefer", rules: [], latest: null, pendingProposals: 1, pendingImprovements: 1,
  agents: [
    { workspaceId: "ws-02", workspaceName: "Vendas 02", agentId: "a2", agentName: "Atendimento", channels: 1 },
    { workspaceId: "ws-05", workspaceName: "Vendas 05", agentId: "a5", agentName: "Atendimento", channels: 2 }
  ]
};
const evaluation: AgentEvaluation = {
  id: "ev1", clientKey: "villefer", periodStart: "2026-10-10T03:00:00.000Z", periodEnd: "2026-10-17T03:00:00.000Z", status: "ready",
  summary: { rotulos: { aprovado: 3, editado: 0, descartado: 1, respondeu: 0, sem_resposta: 0 }, aprovacao: 0.75, resposta: null, erros: { nao_devia: 1, assunto: 0, texto: 0 }, decisoes: { mensagem: 4, lembrete: 2, nada: 9 } },
  cases: [{ followupId: "f1", conversationId: "c1", workspaceId: "ws-05", decididoEm: "2026-10-14T12:00:00.000Z", rotulo: "descartado", rascunho: "Conseguiu ver a entrega?", enviado: null, resposta: null, ultimas: [{ autor: "contato", texto: "chega quando?" }], erro: { tipo: "nao_devia", explicacao: "Entrega combinada." } }],
  proposals: [{ id: "r1", regra: "Não mande follow-up sobre entrega combinada.", porque: "Pós-venda.", casos: ["f1"], validacao: { corrige: 1, erradosTestados: 1, quebra: 0, bonsTestados: 3 }, status: "pendente" }],
  rules: [], error: null, createdAt: "2026-10-17T09:00:00.000Z"
};

// Learned in Vendas 05, scope answered and prepared by the AI: ready to approve.
const improvement: AiAgentImprovementDto = {
  id: "improvement-1", workspaceId: "ws-05", agentId: "a5", conversationId: "conversation-1", sourceMessageId: "message-1",
  status: "pending", kind: "not_sold", title: "Barra galvanizada furada: não vendemos", content: "Não comercializamos barra galvanizada furada.",
  rationale: null, sourceCustomerMessage: "Tem barra galvanizada furada?", sourceHumanReply: "Não trabalhamos com esse produto.", detector: {},
  clarification: {
    questions: [{ id: "scope", question: "Vale para todas as medidas?", help: "" }],
    answers: { scope: "Sim" },
    normalization: { scope: "requested_item_variations", confidence: 0.9, requiresHandoffOutsideScope: true } as AiAgentImprovementDto["clarification"]["normalization"]
  },
  reviewedAt: null, acceptedKnowledgeSourceId: null, createdAt: "2026-10-15T14:00:00.000Z", updatedAt: "2026-10-15T14:00:00.000Z"
};

let container: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (text: string) => Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);

describe("AgentEvaluationPage", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.clients.mockResolvedValue([villefer]);
    mocks.list.mockResolvedValue([evaluation]);
    mocks.improvements.mockResolvedValue([improvement]);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

  it("shows one customer's workspaces together and approves a rule for all of them", async () => {
    mocks.decide.mockResolvedValue({ ...evaluation, proposals: [{ ...evaluation.proposals[0], status: "aprovada" }], rules: ["Não mande follow-up sobre entrega combinada."] });
    await act(async () => { root.render(<AgentEvaluationPage />); });
    await settle();
    expect(mocks.list).toHaveBeenCalledWith("villefer", expect.any(Function));
    expect(container.querySelector(".evaluation-workspaces")?.textContent).toBe("Vendas 021 númeroVendas 052 números");
    expect(container.textContent).toContain("75%");
    expect(container.textContent).toContain("Corrigiu 1 de 1 caso errado; cancelou 0 de 3 follow-ups bons.");
    expect(container.querySelector(".evaluation-case summary")?.textContent).toContain("Vendas 05");

    await act(async () => button("Aprovar")?.click());
    expect(mocks.decide).toHaveBeenCalledWith("villefer", "ev1", "r1", "approve", expect.any(Function));
    expect(container.textContent).toContain("Regra aprovada nos 2 workspaces");
    expect(container.querySelector(".evaluation-rules")?.textContent).toContain("Não mande follow-up sobre entrega combinada.");
  });

  it("reviews the customer's improvements from every workspace; an approved one goes to all of them", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.approveImprovement.mockResolvedValue({ ...improvement, status: "accepted" });
    await act(async () => { root.render(<AgentEvaluationPage />); });
    await settle();
    await act(async () => Array.from(container.querySelectorAll(".evaluation-tabs button")).find((item) => item.textContent?.startsWith("Aprimoramentos"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mocks.improvements).toHaveBeenCalledWith("villefer", expect.any(Function));
    expect(container.querySelector(".agent-improvement-card")?.textContent).toContain("Vendas 05");
    expect(container.textContent).toContain("em qualquer workspace do cliente");

    await act(async () => button("Aprovar e incluir")?.click());
    expect(window.confirm).toHaveBeenCalledWith("Aprovar esta sugestão e incluí-la na base de conhecimento dos 2 workspaces de Villefer?");
    expect(mocks.approveImprovement).toHaveBeenCalledWith("villefer", "improvement-1", {}, expect.any(Function));
    expect(container.textContent).toContain("Sugestão aprovada e adicionada à base dos 2 workspaces.");
  });

  it("is closed to anyone who is not a Hub admin", async () => {
    const { SupervisionApiError } = await import("../../app/supervision-api");
    mocks.clients.mockRejectedValue(new SupervisionApiError(403, "Acesso administrativo necessário."));
    await act(async () => { root.render(<AgentEvaluationPage />); });
    await settle();
    expect(container.textContent).toContain("Esta tela é só para administradores do Hub.");
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
