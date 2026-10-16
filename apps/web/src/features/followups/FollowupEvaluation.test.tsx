// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvaluation } from "../../app/api";

const mocks = vi.hoisted(() => ({
  agents: vi.fn(),
  list: vi.fn(),
  run: vi.fn(),
  decide: vi.fn(),
  remove: vi.fn()
}));
vi.mock("../../app/api", () => ({
  apiGetAgents: mocks.agents,
  apiListAgentEvaluations: mocks.list,
  apiRunAgentEvaluation: mocks.run,
  apiDecideEvaluationProposal: mocks.decide,
  apiRemoveEvaluationRule: mocks.remove
}));

import { FollowupEvaluation } from "./FollowupEvaluation";

const agent = { id: "a1", name: "Villefer", behaviorConfig: { harness: { agente: "atendimento", canais: ["c1"] } } };
const evaluation: AgentEvaluation = {
  id: "ev1", agentId: "a1", periodStart: "2026-10-10T03:00:00.000Z", periodEnd: "2026-10-17T03:00:00.000Z", status: "ready",
  summary: { rotulos: { aprovado: 3, editado: 0, descartado: 1, respondeu: 0, sem_resposta: 0 }, aprovacao: 0.75, resposta: null, erros: { nao_devia: 1, assunto: 0, texto: 0 }, decisoes: { mensagem: 4, lembrete: 2, nada: 9 } },
  cases: [{ followupId: "f1", conversationId: "c1", decididoEm: "2026-10-14T12:00:00.000Z", rotulo: "descartado", rascunho: "Conseguiu ver a entrega?", enviado: null, resposta: null, ultimas: [{ autor: "contato", texto: "chega quando?" }], erro: { tipo: "nao_devia", explicacao: "Entrega combinada." } }],
  proposals: [{ id: "r1", regra: "Não mande follow-up sobre entrega combinada.", porque: "Pós-venda.", casos: ["f1"], validacao: { corrige: 1, erradosTestados: 1, quebra: 0, bonsTestados: 3 }, status: "pendente" }],
  rules: [], error: null, createdAt: "2026-10-17T09:00:00.000Z"
};

let container: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (text: string) => Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);

describe("FollowupEvaluation", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.agents.mockResolvedValue([agent, { id: "a2", name: "Antigo", behaviorConfig: {} }]);
    mocks.list.mockResolvedValue([evaluation]);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

  it("shows the week's numbers and approves a tested rule", async () => {
    mocks.decide.mockResolvedValue({ ...evaluation, proposals: [{ ...evaluation.proposals[0], status: "aprovada" }], rules: ["Não mande follow-up sobre entrega combinada."] });
    await act(async () => { root.render(<FollowupEvaluation getToken={async () => "t"} />); });
    await settle();
    expect(mocks.list).toHaveBeenCalledWith(expect.any(Function), "a1");
    expect(container.textContent).toContain("75%");
    expect(container.textContent).toContain("Corrigiu 1 de 1 caso errado; cancelou 0 de 3 follow-ups bons.");
    expect(container.textContent).toContain("Não era caso de follow-up");

    await act(async () => button("Aprovar")?.click());
    expect(mocks.decide).toHaveBeenCalledWith(expect.any(Function), "a1", "ev1", "r1", "approve");
    expect(container.textContent).toContain("Regra aprovada");
    expect(container.querySelector(".followups-evaluation-rules")?.textContent).toContain("Não mande follow-up sobre entrega combinada.");
  });

  it("explains when the new agent is not on anywhere", async () => {
    mocks.agents.mockResolvedValue([{ id: "a2", name: "Antigo", behaviorConfig: {} }]);
    await act(async () => { root.render(<FollowupEvaluation getToken={async () => "t"} />); });
    await settle();
    expect(container.textContent).toContain("ainda não está ligado");
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
