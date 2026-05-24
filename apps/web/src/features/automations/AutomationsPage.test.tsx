import {
  apiCreateAutomation,
  apiGetAutomations,
  type AutomationActionsDto,
  type AutomationRuleDto,
  type AutomationRunDto
} from "../../app/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAutomationSavePayload,
  defaultAutomationEventKey,
  mergeAutomationRun
} from "./AutomationsPage";

const baseRun: AutomationRunDto = {
  id: "run-1",
  workspaceId: "workspace-1",
  ruleId: "rule-1",
  eventKey: "message.received:manual-test:rule-1",
  status: "completed",
  input: { source: "manual_test" },
  result: { mode: "simulated" },
  createdAt: "2026-05-22T12:00:00.000Z",
  updatedAt: "2026-05-22T12:00:00.000Z"
};

const graphActions = {
  version: 1,
  nodes: [
    {
      id: "trigger-1",
      type: "trigger_first_message",
      position: { x: 0, y: 0 },
      data: { title: "Primeira mensagem", config: {} }
    }
  ],
  edges: []
} satisfies AutomationActionsDto;

const baseAutomation: AutomationRuleDto = {
  id: "automation-1",
  workspaceId: "workspace-1",
  name: "Boas-vindas",
  status: "disabled",
  trigger: "message.received",
  conditions: {},
  actions: graphActions,
  createdAt: "2026-05-22T12:00:00.000Z",
  updatedAt: "2026-05-22T12:00:00.000Z"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("automation run helpers", () => {
  it("builds a stable default manual test event key", () => {
    expect(defaultAutomationEventKey("message.received", "rule-1")).toBe(
      "message.received:manual-test:rule-1"
    );
  });

  it("merges a run at the top without duplicating an existing run", () => {
    const updatedRun = {
      ...baseRun,
      status: "completed",
      updatedAt: "2026-05-22T12:05:00.000Z"
    };

    expect(mergeAutomationRun([baseRun], updatedRun)).toEqual([updatedRun]);
  });
});

describe("automation form helpers", () => {
  it("builds legacy array actions when saving a legacy automation", () => {
    expect(
      buildAutomationSavePayload(
        {
          name: "Boas-vindas editada",
          trigger: "message.received",
          conditionSummary: "Condicao editada",
          actionType: "add_tag",
          actionLabel: "Adicionar tag"
        },
        {
          ...baseAutomation,
          actions: [{ type: "send_message", label: "Enviar mensagem" }]
        }
      )
    ).toMatchObject({
      actions: [{ type: "add_tag", label: "Adicionar tag" }]
    });
  });

  it("preserves graph actions when saving an existing automation", () => {
    expect(
      buildAutomationSavePayload(
        {
          name: "Boas-vindas editada",
          trigger: "message.received",
          conditionSummary: "Condicao editada",
          actionType: "send_message",
          actionLabel: "Enviar saudacao em modo simulado"
        },
        baseAutomation
      )
    ).toMatchObject({
      name: "Boas-vindas editada",
      trigger: "message.received",
      conditions: { summary: "Condicao editada" },
      actions: graphActions
    });
  });
});

describe("automation API helpers", () => {
  it("preserves graph actions returned by the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [baseAutomation]
      })
    );

    const automations = await apiGetAutomations(async () => "token");

    expect(automations[0]?.actions).toEqual(graphActions);
  });

  it("sends graph actions when creating an automation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => baseAutomation
    });
    vi.stubGlobal("fetch", fetchMock);

    await apiCreateAutomation(async () => "token", {
      name: "Boas-vindas",
      status: "disabled",
      trigger: "message.received",
      conditions: {},
      actions: graphActions
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.actions).toEqual(graphActions);
  });
});
