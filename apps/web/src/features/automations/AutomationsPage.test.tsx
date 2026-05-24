import {
  apiCreateAutomation,
  apiGetAutomations,
  type AutomationActionsDto,
  type AutomationRuleDto,
  type AutomationRunDto
} from "../../app/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  automationActionsToTrigger,
  buildAutomationSavePayload,
  defaultAutomationEventKey,
  mergeAutomationRun
} from "./AutomationsPage";
import {
  createAutomationNode,
  createDefaultAutomationFlow,
  flowToAutomationPayload,
  supportedBlockTypes
} from "./automationFlow";
import type { AutomationFlowDefinition } from "@prymeira-talk/shared";

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

  it("derives the save trigger from the graph trigger node", () => {
    const boardStageFlow = {
      version: 1,
      nodes: [
        {
          id: "trigger-board-1",
          type: "trigger_board_stage_changed",
          position: { x: 0, y: 0 },
          data: { title: "Etapa alterada", config: {} }
        }
      ],
      edges: []
    } satisfies AutomationFlowDefinition;

    expect(automationActionsToTrigger(boardStageFlow, "message.received")).toBe("board.stage.changed");
    expect(
      buildAutomationSavePayload(
        {
          name: "Board",
          trigger: "message.received",
          conditionSummary: "Quando mudar de etapa",
          actionType: "send_message",
          actionLabel: "Enviar mensagem"
        },
        baseAutomation,
        boardStageFlow
      )
    ).toMatchObject({
      trigger: "board.stage.changed",
      actions: boardStageFlow
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

describe("automation flow helpers", () => {
  it("creates a default version 1 flow with a first-message trigger", () => {
    const flow = createDefaultAutomationFlow();

    expect(flow).toMatchObject({
      version: 1,
      nodes: [
        {
          type: "trigger_first_message",
          data: { title: "Primeira mensagem", config: {} }
        }
      ],
      edges: []
    });
  });

  it("creates node data from the shared block catalog", () => {
    const node = createAutomationNode("send_message", { x: 100, y: 120 });

    expect(node).toMatchObject({
      type: "send_message",
      position: { x: 100, y: 120 },
      data: {
        blockType: "send_message",
        title: "Enviar mensagem",
        description: "Envia texto pelo WhatsApp.",
        category: "communication",
        support: "supported",
        config: {}
      }
    });
  });

  it("converts React Flow state into the shared automation payload", () => {
    const trigger = createAutomationNode("trigger_first_message", { x: 80, y: 180 });
    const message = createAutomationNode("send_message", { x: 320, y: 180 });

    const payload = flowToAutomationPayload(
      [trigger, message],
      [
        {
          id: "edge-1",
          source: trigger.id,
          target: message.id,
          sourceHandle: "success",
          targetHandle: "input"
        }
      ]
    );

    expect(payload).toEqual({
      version: 1,
      nodes: [
        {
          id: trigger.id,
          type: "trigger_first_message",
          position: { x: 80, y: 180 },
          data: { title: "Primeira mensagem", config: {} }
        },
        {
          id: message.id,
          type: "send_message",
          position: { x: 320, y: 180 },
          data: { title: "Enviar mensagem", config: {} }
        }
      ],
      edges: [
        {
          id: "edge-1",
          source: trigger.id,
          target: message.id,
          sourceHandle: "success",
          targetHandle: "input"
        }
      ]
    });
  });

  it("omits empty edge handles from the shared automation payload", () => {
    const trigger = createAutomationNode("trigger_first_message", { x: 80, y: 180 });
    const message = createAutomationNode("send_message", { x: 320, y: 180 });

    const payload = flowToAutomationPayload(
      [trigger, message],
      [{ id: "edge-2", source: trigger.id, target: message.id }]
    );

    expect(payload.edges[0]).toEqual({
      id: "edge-2",
      source: trigger.id,
      target: message.id
    });
  });

  it("returns the shared block catalog", () => {
    expect(supportedBlockTypes()).toContainEqual(
      expect.objectContaining({ type: "trigger_first_message", support: "supported" })
    );
  });
});
