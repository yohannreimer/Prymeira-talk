import { describe, expect, it, vi } from "vitest";
import { createScriptedModel, toolCall } from "../harness/core/model.js";
import { createAgentEvaluationsScheduler, createAgentEvaluationsService, inicioDoSabado, type AgentEvaluationsPrismaLike } from "./agent-evaluations.service.js";

const workspaceId = "ws_1";
const agentId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-17T10:00:00.000Z"); // Saturday 07:00 in São Paulo
const harness = { agente: "atendimento", canais: ["canal-205"] };

function setup(options: { regras?: string[] } = {}) {
  const records: Array<Record<string, unknown>> = [];
  let behaviorConfig: Record<string, unknown> = { harness: { ...harness, ...(options.regras ? { regrasDoFollowup: options.regras } : {}) } };
  const prisma = {
    integrationConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    aiAgent: {
      findFirst: vi.fn(async () => ({ id: agentId, workspaceId, behaviorConfig })),
      findMany: vi.fn(async () => [{ id: agentId, workspaceId, behaviorConfig }, { id: "other", workspaceId, behaviorConfig: {} }]),
      update: vi.fn(async (args: { data: { behaviorConfig: Record<string, unknown> } }) => { behaviorConfig = args.data.behaviorConfig; return {}; })
    },
    aiAgentEvaluation: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => records.find((record) =>
        Object.entries(args.where).every(([key, value]) => value instanceof Date ? (record[key] as Date).getTime() === value.getTime() : record[key] === value)) ?? null),
      findMany: vi.fn(async () => records),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const record = { id: `ev${records.length + 1}`, summary: {}, cases: [], proposals: [], error: null, createdAt: now, updatedAt: now, ...args.data };
        records.push(record);
        return record;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = records.find((item) => item.id === args.where.id)!;
        Object.assign(record, args.data, { updatedAt: now });
        return record;
      })
    },
    conversationFollowup: {
      findMany: vi.fn(async () => [
        { id: "f1", conversationId: "c1", kind: "human_commercial", status: "cancelled", decision: { mode: "harness", analyzedAt: "2026-10-14T12:00:00.000Z" }, draftBody: "Conseguiu ver a entrega de segunda?", finalBody: null, sentByUserId: null, sentAt: null, cancelledByUserId: "u1" },
        { id: "f2", conversationId: "c2", kind: "human_commercial", status: "sent", decision: { mode: "harness", analyzedAt: "2026-10-13T12:00:00.000Z" }, draftBody: "Conseguiu ver o orçamento?", finalBody: "Conseguiu ver o orçamento?", sentByUserId: "u1", sentAt: new Date("2026-10-13T13:00:00.000Z"), cancelledByUserId: null },
        { id: "f3", conversationId: "c3", kind: "seller_reminder", status: "review", decision: { mode: "harness", analyzedAt: "2026-10-13T12:00:00.000Z" }, draftBody: null, finalBody: null, sentByUserId: null, sentAt: null, cancelledByUserId: null },
        { id: "f4", conversationId: "c4", kind: "human_commercial", status: "skipped", decision: { mode: "brain", analyzedAt: "2026-10-13T12:00:00.000Z" }, draftBody: null, finalBody: null, sentByUserId: null, sentAt: null, cancelledByUserId: null }
      ])
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
  return { service, prisma, records, behavior: () => behaviorConfig };
}

describe("weekly agent evaluation", () => {
  it("finds the Saturday that starts the São Paulo week", () => {
    expect(inicioDoSabado(now).toISOString()).toBe("2026-10-17T03:00:00.000Z");
    expect(inicioDoSabado(new Date("2026-10-17T02:59:00.000Z")).toISOString()).toBe("2026-10-10T03:00:00.000Z");
    expect(inicioDoSabado(new Date("2026-10-22T15:00:00.000Z")).toISOString()).toBe("2026-10-17T03:00:00.000Z");
  });

  it("evaluates the week's follow-ups of the new agent and saves a report with tested rules", async () => {
    const { service, records } = setup();
    const result = await service.runWeek({ workspaceId, agentId });
    expect(result.status).toBe("ready");
    expect(result.periodStart).toBe("2026-10-10T03:00:00.000Z");
    expect(result.summary).toMatchObject({ rotulos: { aprovado: 1, descartado: 1, editado: 0 }, aprovacao: 0.5, decisoes: { mensagem: 2, lembrete: 1, nada: 0 } });
    expect(result.cases.map((caso) => [caso.followupId, caso.rotulo])).toEqual([["f1", "descartado"], ["f2", "aprovado"]]);
    expect(result.cases[0].ultimas).toEqual([{ autor: "contato", texto: "chega quando?" }, { autor: "agente", texto: "Segunda-feira" }]);
    // The scripted analyst registers nothing, so the agent without the rule already stays quiet: nothing to measure.
    expect(result.proposals).toEqual([expect.objectContaining({ regra: "Não mande follow-up sobre entrega já combinada.", status: "pendente", validacao: { corrige: 0, erradosTestados: 0, quebra: 0, bonsTestados: 0 } })]);
    expect(records).toHaveLength(1);

    const again = await service.runWeek({ workspaceId, agentId });
    expect(again.id).toBe(result.id);
    expect(records).toHaveLength(1);
  });

  it("approving a rule adds it to the agent; it cannot be decided twice", async () => {
    const { service, behavior } = setup({ regras: ["Regra antiga."] });
    const evaluation = await service.runWeek({ workspaceId, agentId });
    const decided = await service.decideProposal({ workspaceId, agentId, evaluationId: evaluation.id, proposalId: "r1", decision: "approve" });
    expect(decided.proposals[0].status).toBe("aprovada");
    expect(decided.rules).toEqual(["Regra antiga.", "Não mande follow-up sobre entrega já combinada."]);
    expect(behavior()).toEqual({ harness: { ...harness, regrasDoFollowup: ["Regra antiga.", "Não mande follow-up sobre entrega já combinada."] } });
    await expect(service.decideProposal({ workspaceId, agentId, evaluationId: evaluation.id, proposalId: "r1", decision: "reject" })).rejects.toThrow(/já foi decidida/);
    expect(await service.removeRule({ workspaceId, agentId, rule: "Regra antiga." })).toEqual({ rules: ["Não mande follow-up sobre entrega já combinada."] });
  });

  it("the Saturday job runs only for agents with the new agent on, after 06:00", async () => {
    const { service, records } = setup();
    const early = createAgentEvaluationsScheduler({ service, now: () => new Date("2026-10-17T08:00:00.000Z") });
    await early.runOnce();
    expect(records).toHaveLength(0);
    const scheduler = createAgentEvaluationsScheduler({ service, now: () => now });
    await scheduler.runOnce();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ agentId, status: "ready" });
  });
});
