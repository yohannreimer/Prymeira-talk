import { describe, expect, it, vi } from "vitest";
import { createScriptedModel, toolCall } from "../harness/core/model.js";
import { chaveDoCliente, createAgentEvaluationsScheduler, createAgentEvaluationsService, inicioDoSabado, type AgentEvaluationsPrismaLike } from "./agent-evaluations.service.js";

const now = new Date("2026-10-17T10:00:00.000Z"); // Saturday 07:00 in São Paulo
const villefer = (canal: string, regras?: string[]) => ({ harness: { agente: "atendimento", canais: [canal], cliente: "Villefer", ...(regras ? { regrasDoFollowup: regras } : {}) } });

type Row = Record<string, unknown>;
const matches = (record: Row, where: Row) => Object.entries(where).every(([key, value]) =>
  value instanceof Date ? (record[key] as Date).getTime() === value.getTime() : record[key] === value);

function setup(options: { regras?: string[] } = {}) {
  const records: Row[] = [];
  // Villefer runs the same agent in Vendas 02 and Vendas 05; another company has its own; one agent has the new agent off.
  const agents: Array<{ id: string; workspaceId: string; name: string; behaviorConfig: Record<string, unknown> }> = [
    { id: "a5", workspaceId: "ws-vendas-05", name: "Atendimento Villefer", behaviorConfig: villefer("canal-205", options.regras) },
    { id: "a2", workspaceId: "ws-vendas-02", name: "Atendimento Villefer", behaviorConfig: villefer("canal-202", options.regras) },
    { id: "b1", workspaceId: "ws-outra", name: "Agente Outra", behaviorConfig: { harness: { agente: "atendimento", canais: ["canal-9"] } } },
    { id: "c1", workspaceId: "ws-velha", name: "Antigo", behaviorConfig: {} }
  ];
  const followups: Row[] = [
    { workspaceId: "ws-vendas-05", agentId: "a5", id: "f1", conversationId: "c1", kind: "human_commercial", status: "cancelled", decision: { mode: "harness", analyzedAt: "2026-10-14T12:00:00.000Z" }, draftBody: "Conseguiu ver a entrega de segunda?", finalBody: null, sentByUserId: null, sentAt: null, cancelledByUserId: "u1" },
    { workspaceId: "ws-vendas-02", agentId: "a2", id: "f2", conversationId: "c2", kind: "human_commercial", status: "sent", decision: { mode: "harness", analyzedAt: "2026-10-13T12:00:00.000Z" }, draftBody: "Conseguiu ver o orçamento?", finalBody: "Conseguiu ver o orçamento?", sentByUserId: "u1", sentAt: new Date("2026-10-13T13:00:00.000Z"), cancelledByUserId: null },
    { workspaceId: "ws-vendas-02", agentId: "a2", id: "f3", conversationId: "c3", kind: "seller_reminder", status: "review", decision: { mode: "harness", analyzedAt: "2026-10-13T12:00:00.000Z" }, draftBody: null, finalBody: null, sentByUserId: null, sentAt: null, cancelledByUserId: null },
    { workspaceId: "ws-outra", agentId: "b1", id: "f4", conversationId: "c4", kind: "human_commercial", status: "sent", decision: { mode: "harness", analyzedAt: "2026-10-13T12:00:00.000Z" }, draftBody: "Oi", finalBody: "Oi", sentByUserId: "u9", sentAt: new Date("2026-10-13T13:00:00.000Z"), cancelledByUserId: null }
  ];
  const prisma = {
    integrationConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    aiAgent: {
      findMany: vi.fn(async () => agents),
      update: vi.fn(async (args: { where: { workspaceId_id: { workspaceId: string; id: string } }; data: { behaviorConfig: Record<string, unknown> } }) => {
        agents.find((agent) => agent.id === args.where.workspaceId_id.id)!.behaviorConfig = args.data.behaviorConfig;
        return {};
      })
    },
    workspaceMirror: { findMany: vi.fn(async () => [{ workspaceId: "ws-vendas-05", name: "Vendas 05" }, { workspaceId: "ws-vendas-02", name: "Vendas 02" }]) },
    aiAgentEvaluation: {
      findFirst: vi.fn(async (args: { where: Row }) => records.find((record) => matches(record, args.where)) ?? null),
      findMany: vi.fn(async (args: { where: Row }) => records.filter((record) => matches(record, args.where))),
      create: vi.fn(async (args: { data: Row }) => {
        const record = { id: `00000000-0000-4000-8000-00000000000${records.length + 1}`, summary: {}, cases: [], proposals: [], error: null, createdAt: now, updatedAt: now, ...args.data };
        records.push(record);
        return record;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Row }) => {
        const record = records.find((item) => item.id === args.where.id)!;
        Object.assign(record, args.data, { updatedAt: now });
        return record;
      })
    },
    conversationFollowup: {
      findMany: vi.fn(async (args: { where: { workspaceId: string; agentId: string } }) =>
        followups.filter((followup) => followup.workspaceId === args.where.workspaceId && followup.agentId === args.where.agentId))
    },
    message: {
      findMany: vi.fn(async () => [
        { id: "m2", direction: "outbound", type: "text", body: "Segunda-feira", metadata: { source: "ai_agent" }, sentByUserId: null, createdAt: new Date("2026-10-12T10:01:00.000Z") },
        { id: "m1", direction: "inbound", type: "text", body: "chega quando?", metadata: {}, sentByUserId: null, createdAt: new Date("2026-10-12T10:00:00.000Z") }
      ]),
      findFirst: vi.fn().mockResolvedValue(null)
    },
    aiKnowledgeSource: { findMany: vi.fn().mockResolvedValue([]) }
  };
  const analista = createScriptedModel("analista", (request) => {
    const ferramenta = request.tools?.[0]?.name;
    if (ferramenta === "registrar_avaliacao") return { content: null, toolCalls: [toolCall("registrar_avaliacao", { tipo: "nao_devia", explicacao: "A entrega já estava combinada." })] };
    if (ferramenta === "propor_regras") return { content: null, toolCalls: [toolCall("propor_regras", { regras: [{ regra: "Não mande follow-up sobre entrega já combinada.", porque: "Pós-venda.", casos: ["f1"] }] })] };
    return { content: null, toolCalls: [] };
  });
  const model = createScriptedModel("escritor", () => ({ content: null, toolCalls: [toolCall("responder", { texto: "não deveria sair" })] }));
  const service = createAgentEvaluationsService({
    prisma: prisma as unknown as AgentEvaluationsPrismaLike,
    modelFactory: () => ({ model, analista }),
    now: () => now
  });
  return { service, records, agents };
}

describe("weekly agent evaluation", () => {
  it("finds the Saturday that starts the São Paulo week", () => {
    expect(inicioDoSabado(now).toISOString()).toBe("2026-10-17T03:00:00.000Z");
    expect(inicioDoSabado(new Date("2026-10-17T02:59:00.000Z")).toISOString()).toBe("2026-10-10T03:00:00.000Z");
    expect(inicioDoSabado(new Date("2026-10-22T15:00:00.000Z")).toISOString()).toBe("2026-10-17T03:00:00.000Z");
  });

  it("groups a customer's agents across workspaces; an agent without a customer stands alone", async () => {
    const { service } = setup({ regras: ["Regra antiga."] });
    expect(chaveDoCliente({ id: "x" }, { agente: "atendimento", canais: ["c"], cliente: "Aço São José" })).toBe("aco-sao-jose");
    expect(await service.clients()).toEqual([
      expect.objectContaining({ key: "agente-b1", name: "Agente Outra", agents: [expect.objectContaining({ workspaceId: "ws-outra", workspaceName: null })], rules: [] }),
      expect.objectContaining({
        key: "villefer", name: "Villefer", rules: ["Regra antiga."], latest: null, pendingProposals: 0,
        agents: [
          { workspaceId: "ws-vendas-02", workspaceName: "Vendas 02", agentId: "a2", agentName: "Atendimento Villefer", channels: 1 },
          { workspaceId: "ws-vendas-05", workspaceName: "Vendas 05", agentId: "a5", agentName: "Atendimento Villefer", channels: 1 }
        ]
      })
    ]);
  });

  it("evaluates the follow-ups of every workspace of the customer in one report with tested rules", async () => {
    const { service, records } = setup();
    const result = await service.runWeek({ clientKey: "villefer" });
    expect(result.status).toBe("ready");
    expect(result.periodStart).toBe("2026-10-10T03:00:00.000Z");
    expect(result.summary).toMatchObject({ rotulos: { aprovado: 1, descartado: 1, editado: 0 }, aprovacao: 0.5, decisoes: { mensagem: 2, lembrete: 1, nada: 0 } });
    expect(result.cases.map((caso) => [caso.followupId, caso.workspaceId, caso.rotulo])).toEqual([["f2", "ws-vendas-02", "aprovado"], ["f1", "ws-vendas-05", "descartado"]]);
    expect(result.cases[1].ultimas).toEqual([{ autor: "contato", texto: "chega quando?" }, { autor: "agente", texto: "Segunda-feira" }]);
    // The scripted analyst registers nothing, so the agent without the rule already stays quiet: nothing to measure.
    expect(result.proposals).toEqual([expect.objectContaining({ regra: "Não mande follow-up sobre entrega já combinada.", status: "pendente", validacao: { corrige: 0, erradosTestados: 0, quebra: 0, bonsTestados: 0 } })]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ clientKey: "villefer", agents: [{ workspaceId: "ws-vendas-02", agentId: "a2" }, { workspaceId: "ws-vendas-05", agentId: "a5" }] });

    const again = await service.runWeek({ clientKey: "villefer" });
    expect(again.id).toBe(result.id);
    expect(records).toHaveLength(1);
    await expect(service.runWeek({ clientKey: "agente-c1" })).rejects.toThrow(/sem o agente novo/);
  });

  it("an approved rule goes to every agent of the customer; it cannot be decided twice", async () => {
    const { service, agents } = setup({ regras: ["Regra antiga."] });
    const evaluation = await service.runWeek({ clientKey: "villefer" });
    const decided = await service.decideProposal({ clientKey: "villefer", evaluationId: evaluation.id, proposalId: "r1", decision: "approve" });
    expect(decided.proposals[0].status).toBe("aprovada");
    expect(decided.rules).toEqual(["Regra antiga.", "Não mande follow-up sobre entrega já combinada."]);
    for (const id of ["a2", "a5"]) {
      expect((agents.find((agent) => agent.id === id)!.behaviorConfig.harness as Record<string, unknown>).regrasDoFollowup)
        .toEqual(["Regra antiga.", "Não mande follow-up sobre entrega já combinada."]);
    }
    expect(agents.find((agent) => agent.id === "b1")!.behaviorConfig.harness).not.toHaveProperty("regrasDoFollowup");
    await expect(service.decideProposal({ clientKey: "villefer", evaluationId: evaluation.id, proposalId: "r1", decision: "reject" })).rejects.toThrow(/já foi decidida/);
    expect(await service.removeRule({ clientKey: "villefer", rule: "Regra antiga." })).toEqual({ rules: ["Não mande follow-up sobre entrega já combinada."] });
    expect((agents.find((agent) => agent.id === "a2")!.behaviorConfig.harness as Record<string, unknown>).regrasDoFollowup).toEqual(["Não mande follow-up sobre entrega já combinada."]);
  });

  it("the Saturday job runs once per customer with the new agent on, after 06:00", async () => {
    const { service, records } = setup();
    const early = createAgentEvaluationsScheduler({ service, now: () => new Date("2026-10-17T08:00:00.000Z") });
    await early.runOnce();
    expect(records).toHaveLength(0);
    const scheduler = createAgentEvaluationsScheduler({ service, now: () => now });
    await scheduler.runOnce();
    expect(records.map((record) => [record.clientKey, record.status])).toEqual([["villefer", "ready"], ["agente-b1", "ready"]]);
  });
});
