import { describe, expect, it } from "vitest";
import {
  applyFixes,
  templatize,
  lineDiff,
  planFleetSync,
  planHasChanges,
  planHasErrors,
  renderTemplate,
  type FleetAgent,
  type NewKnowledgeEntry,
  type TextFix
} from "./agent-fleet-sync.js";

const BASE = "Faça o pré-atendimento por WhatsApp e reúna para {{seller_name}} o necessário.\nRegras de produto.\nTom curto.";
const EXTRA = "CORREÇÃO DE COTAÇÃO TRAVADA: handoff com resumo completo.";
const SCOPE = "O agente qualifica o pedido e entrega a conversa para {{seller_name}} preparar a proposta, sem exigir confirmação final.";
const OLD_SCOPE = "O agente qualifica o pedido e entrega a conversa para {{seller_name}} preparar a proposta, sem exigir confirmação.";

function agent(input: { workspaceId: string; seller: string; template: string; scope: string; extraKnowledge?: FleetAgent["knowledge"] }): FleetAgent {
  const vars = { seller_name: input.seller };
  return {
    workspaceId: input.workspaceId,
    id: `agent_${input.workspaceId}`,
    name: `Pré-atendimento — ${input.seller}`,
    systemPrompt: renderTemplate(input.template, vars),
    behaviorConfig: { packagePromptTemplate: input.template, deploymentVariables: vars },
    knowledge: [
      {
        id: `scope_${input.workspaceId}`,
        type: "text",
        title: "Escopo operacional aprovado",
        content: renderTemplate(input.scope, vars),
        metadata: { packageKnowledgeKey: "scope", packageContentTemplate: input.scope }
      },
      ...(input.extraKnowledge ?? [])
    ]
  };
}

const fixes: TextFix[] = [{ from: /\bJuniorr\b/g, to: "Junior", label: "typo" }];
const entry: NewKnowledgeEntry = {
  key: "balcao_cpf",
  type: "text",
  title: "Venda no balcão",
  content: "Vendemos no balcão para CPF.",
  category: "stock_and_availability",
  aliases: ["balcão"],
  source: "Triagem 01/10/2026"
};
const common = { fixes, approvedBy: "Yohann", approvedAt: "2026-10-01T12:00:00.000Z" };

describe("planFleetSync", () => {
  const source = agent({ workspaceId: "w5", seller: "Junior", template: `${BASE}\n${EXTRA}`, scope: SCOPE });
  const target = agent({ workspaceId: "w2", seller: "CLEITON PRESTES", template: BASE, scope: OLD_SCOPE });

  it("propagates the new paragraph and keeps each seller's own name", () => {
    const plan = planFleetSync({ source, targets: [target], newKnowledge: [], ...common });
    const [t] = plan.targets;

    expect(planHasErrors(plan)).toBe(false);
    expect(t.prompt.changed).toBe(true);
    expect(t.prompt.after).toContain("CLEITON PRESTES");
    expect(t.prompt.after).not.toContain("Junior");
    expect(lineDiff(t.prompt.before, t.prompt.after)).toEqual({ removed: [], added: [EXTRA] });
    expect(t.template.after).toContain("{{seller_name}}");
    expect(t.knowledgeUpdates).toHaveLength(1);
    expect(t.knowledgeUpdates[0].after).toContain("CLEITON PRESTES preparar a proposta, sem exigir confirmação final.");
  });

  it("is idempotent: applying the plan and planning again changes nothing", () => {
    const first = planFleetSync({ source, targets: [target], newKnowledge: [entry], ...common }).targets[0];
    const synced: FleetAgent = {
      ...target,
      systemPrompt: first.prompt.after,
      behaviorConfig: { ...target.behaviorConfig, packagePromptTemplate: first.template.after },
      knowledge: [
        ...target.knowledge.map((item) => {
          const update = first.knowledgeUpdates.find((candidate) => candidate.id === item.id);
          return update ? { ...item, content: update.after, metadata: update.metadata } : item;
        }),
        ...first.knowledgeCreates.map((create, index) => ({ id: `new_${index}`, type: create.type, title: create.title, content: create.content, metadata: create.metadata }))
      ]
    };

    const second = planFleetSync({ source, targets: [synced], newKnowledge: [entry], ...common });
    expect(planHasChanges(second)).toBe(false);
  });

  it("creates new approved knowledge with approval metadata for the target", () => {
    const [t] = planFleetSync({ source, targets: [target], newKnowledge: [entry], ...common }).targets;
    const created = t.knowledgeCreates.find((item) => item.key === "balcao_cpf");

    expect(created?.metadata).toMatchObject({
      category: "stock_and_availability",
      approvalStatus: "confirmed",
      approvedBy: "Yohann",
      packageKnowledgeKey: "balcao_cpf"
    });
  });

  it("fixes the 'Juniorr' typo in the master before copying", () => {
    const typo = agent({ workspaceId: "w5", seller: "Junior", template: `${BASE}\n${EXTRA}`, scope: SCOPE.replace("{{seller_name}} preparar", "Juniorr preparar") });
    const [t] = planFleetSync({ source: typo, targets: [target, typo], newKnowledge: [], ...common }).targets;

    expect(t.knowledgeUpdates[0].after).not.toContain("Juniorr");
    expect(applyFixes("Juniorr e Junior", fixes)).toBe("Junior e Junior");
  });

  it("turns the master's literal seller name into a variable so other sellers keep their own name", () => {
    const literal = agent({ workspaceId: "w5", seller: "Junior", template: `${BASE}\n${EXTRA}`, scope: "Entrega a conversa para Juniorr preparar a proposta." });
    const [t] = planFleetSync({ source: literal, targets: [target], newKnowledge: [], ...common }).targets;

    expect(t.knowledgeUpdates[0].after).toBe("Entrega a conversa para CLEITON PRESTES preparar a proposta.");
    expect(t.knowledgeUpdates[0].after).not.toContain("Junior");
    expect(templatize("Fale com Junior hoje. {{seller_name}} e Juniors", { seller_name: "Junior" })).toBe("Fale com {{seller_name}} hoje. {{seller_name}} e {{seller_name}}s");
  });

  it("refuses to touch a target whose prompt is not its rendered template", () => {
    const edited: FleetAgent = { ...target, systemPrompt: `${target.systemPrompt}\nAjuste manual.` };
    const plan = planFleetSync({ source, targets: [edited], newKnowledge: [], ...common });

    expect(planHasErrors(plan)).toBe(true);
    expect(plan.targets[0].errors[0]).toContain("refusing to touch");
  });

  it("refuses when a deployment variable is missing", () => {
    const broken: FleetAgent = { ...target, behaviorConfig: { ...target.behaviorConfig, deploymentVariables: {} }, systemPrompt: renderTemplate(BASE, {}) };
    const plan = planFleetSync({ source, targets: [broken], newKnowledge: [], ...common });

    expect(plan.targets[0].errors.join(" ")).toContain("seller_name");
  });

  it("refuses to sync from a source whose prompt was edited outside its template", () => {
    const plan = planFleetSync({ source: { ...source, systemPrompt: `${source.systemPrompt}\nManual.` }, targets: [target], newKnowledge: [], ...common });

    expect(plan.errors[0]).toContain("Source prompt");
  });
});
