import {
  apiCreateAutomation,
  apiGetAutomations,
  type AutomationActionsDto,
  type AutomationRuleDto,
  type AutomationRunDto
} from "../../app/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  automationActionsToTrigger,
  buildAutomationSavePayload,
  defaultAutomationEventKey,
  mergeAutomationRun
} from "./AutomationsPage";
import { automationCanvasStateFromValue } from "./AutomationCanvas";
import { keywordConfigToInputValue, keywordInputToConfig } from "./AutomationNodeInspector";
import {
  createAutomationNode,
  createDefaultAutomationFlow,
  flowToAutomationPayload,
  replaceAutomationNodeType,
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
  vi.clearAllMocks();
  vi.doUnmock("react");
  vi.doUnmock("../../app/auth");
  vi.doUnmock("../../app/api");
  vi.resetModules();
  vi.unstubAllGlobals();
});

const pureAutomationComponents = new Set([
  "AutomationsPageView",
  "AutomationHubView",
  "AutomationEditorView",
  "AutomationHistoryDrawer"
]);

function expandPureComponents(node: ReactNode): ReactNode {
  if (Array.isArray(node)) {
    return node.map(expandPureComponents);
  }

  if (!isValidElement(node)) {
    return node;
  }

  const element = node as ReactElement<{ children?: ReactNode }>;
  const Component = element.type;
  const componentName = typeof Component === "function" ? Component.name : "";

  if (typeof Component === "function" && pureAutomationComponents.has(componentName)) {
    return expandPureComponents((Component as (props: typeof element.props) => ReactNode)(element.props));
  }

  return {
    ...element,
    props: {
      ...element.props,
      children: expandPureComponents(element.props.children)
    }
  };
}

function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }

  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(textContent).join("");
  }

  if (!isValidElement(node)) {
    return "";
  }

  return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<{ children?: ReactNode }>) => boolean
): ReactElement<{ children?: ReactNode }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);

      if (match) {
        return match;
      }
    }

    return null;
  }

  if (!isValidElement(node)) {
    return null;
  }

  const element = node as ReactElement<{ children?: ReactNode }>;

  if (predicate(element)) {
    return element;
  }

  return findElement(element.props.children, predicate);
}

function hasText(node: ReactNode, matcher: string | RegExp) {
  const content = textContent(node);
  return typeof matcher === "string" ? content.includes(matcher) : matcher.test(content);
}

function findButtonByName(node: ReactNode, matcher: string | RegExp) {
  return findElement(
    node,
    (element) => element.type === "button" && hasText(element.props.children, matcher)
  );
}

function clickButton(node: ReactNode, matcher: string | RegExp) {
  const button = findButtonByName(node, matcher) as ReactElement<{
    children?: ReactNode;
    onClick: () => void | Promise<void>;
  }> | null;

  expect(button).not.toBeNull();
  return button?.props.onClick();
}

function submitEditorForm(node: ReactNode) {
  const form = findElement(
    node,
    (element) => element.type === "form" && typeof (element.props as { onSubmit?: unknown }).onSubmit === "function"
  ) as ReactElement<{
    onSubmit: (event: { preventDefault: () => void }) => void | Promise<void>;
  }> | null;

  expect(form).not.toBeNull();
  return form?.props.onSubmit({ preventDefault: vi.fn() });
}

function depsChanged(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) {
  if (!previous || !next || previous.length !== next.length) {
    return true;
  }

  return next.some((value, index) => !Object.is(value, previous[index]));
}

async function renderAutomationsPageContainer({
  automations = [baseAutomation]
}: {
  automations?: AutomationRuleDto[];
} = {}) {
  let ComponentUnderTest: (() => ReactElement) | null = null;
  let tree: ReactNode = null;
  let stateCursor = 0;
  let effectCursor = 0;
  let memoCursor = 0;
  let refCursor = 0;
  const stateValues: unknown[] = [];
  const effectDeps: Array<readonly unknown[] | undefined> = [];
  const memoValues: Array<{ deps: readonly unknown[] | undefined; value: unknown }> = [];
  const refValues: Array<{ current: unknown }> = [];
  const scheduledEffects: Array<() => void | (() => void)> = [];
  const apiUpdateAutomationMock = vi.fn(
    async (
      _getToken: () => Promise<string | null>,
      automationId: string,
      body: Partial<AutomationRuleDto>
    ) => ({
      ...(automations.find((automation) => automation.id === automationId) ?? baseAutomation),
      ...body,
      id: automationId,
      updatedAt: "2026-05-22T12:10:00.000Z"
    })
  );

  function render() {
    if (!ComponentUnderTest) return;
    stateCursor = 0;
    effectCursor = 0;
    memoCursor = 0;
    refCursor = 0;
    tree = ComponentUnderTest();
  }

  vi.resetModules();
  vi.doMock("react", async (importOriginal) => {
    const original = await importOriginal<typeof import("react")>();

    return {
      ...original,
      useCallback: <T extends (...args: unknown[]) => unknown>(callback: T, deps?: readonly unknown[]) =>
        useMemoMock(() => callback, deps),
      useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
        const index = effectCursor++;

        if (!depsChanged(effectDeps[index], deps)) {
          return;
        }

        effectDeps[index] = deps;
        scheduledEffects.push(effect);
      },
      useMemo: useMemoMock,
      useRef: <T,>(initialValue: T) => {
        const index = refCursor++;

        if (!(index in refValues)) {
          refValues[index] = { current: initialValue };
        }

        return refValues[index] as { current: T };
      },
      useState: <T,>(initialValue: T | (() => T)) => {
        const index = stateCursor++;

        if (!(index in stateValues)) {
          stateValues[index] =
            typeof initialValue === "function"
              ? (initialValue as () => T)()
              : initialValue;
        }

        const setValue = (nextValue: T | ((current: T) => T)) => {
          const currentValue = stateValues[index] as T;
          const resolvedValue =
            typeof nextValue === "function"
              ? (nextValue as (current: T) => T)(currentValue)
              : nextValue;

          if (Object.is(currentValue, resolvedValue)) {
            return;
          }

          stateValues[index] = resolvedValue;
          render();
        };

        return [stateValues[index], setValue] as const;
      }
    };
  });
  const getToken = async () => "token";
  vi.doMock("../../app/auth", () => ({
    useTalkAuth: () => ({ getToken })
  }));
  vi.doMock("../../app/api", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../app/api")>();

    return {
      ...original,
      apiGetAutomationRuns: vi.fn().mockResolvedValue([]),
      apiGetAutomations: vi.fn().mockResolvedValue(automations),
      apiUpdateAutomation: apiUpdateAutomationMock
    };
  });

  function useMemoMock<T>(factory: () => T, deps?: readonly unknown[]) {
    const index = memoCursor++;
    const previous = memoValues[index];

    if (!previous || depsChanged(previous.deps, deps)) {
      const value = factory();
      memoValues[index] = { deps, value };
      return value;
    }

    return previous.value as T;
  }

  const imported = await import("./AutomationsPage");
  ComponentUnderTest = imported.AutomationsPage;
  render();

  async function settle() {
    for (let cycle = 0; cycle < 8; cycle += 1) {
      const effects = scheduledEffects.splice(0);
      effects.forEach((effect) => effect());
      await Promise.resolve();
      await Promise.resolve();

      if (scheduledEffects.length === 0) {
        break;
      }
    }
  }

  await settle();

  return {
    get expandedTree() {
      return expandPureComponents(tree);
    },
    apiUpdateAutomationMock,
    settle
  };
}

describe("AutomationsPage navigation", () => {
  it("opens on the hub and enters the editor when a flow is selected", async () => {
    const page = await renderAutomationsPageContainer();

    expect(findElement(page.expandedTree, (element) => element.type === "h1" && hasText(element, "Automações"))).not.toBeNull();
    expect(findButtonByName(page.expandedTree, /Boas-vindas/i)).not.toBeNull();
    expect(hasText(page.expandedTree, "Gatilho do canvas")).toBe(false);

    clickButton(page.expandedTree, /Boas-vindas/i);
    await page.settle();

    expect(findElement(page.expandedTree, (element) => element.type === "h2" && hasText(element, /Editar fluxo/i))).not.toBeNull();
    expect(hasText(page.expandedTree, "Gatilho do canvas")).toBe(true);
    expect(findButtonByName(page.expandedTree, /Voltar para automações/i)).not.toBeNull();

    clickButton(page.expandedTree, /Voltar para automações/i);
    await page.settle();

    expect(hasText(page.expandedTree, "Fluxos")).toBe(true);
    expect(findButtonByName(page.expandedTree, /Boas-vindas/i)).not.toBeNull();
    expect(hasText(page.expandedTree, "Gatilho do canvas")).toBe(false);

    await clickButton(page.expandedTree, /Criar fluxo/i);
    await page.settle();

    expect(findElement(page.expandedTree, (element) => element.type === "h2" && hasText(element, /Novo fluxo/i))).not.toBeNull();
    expect(hasText(page.expandedTree, "Gatilho do canvas")).toBe(true);
  });

  it("renders existing automations as flow cards", async () => {
    const enabledAutomation = {
      ...baseAutomation,
      id: "automation-2",
      name: "Mover para vendas",
      status: "enabled",
      trigger: "board.stage.changed"
    } satisfies AutomationRuleDto;
    const page = await renderAutomationsPageContainer({
      automations: [baseAutomation, enabledAutomation]
    });

    expect(hasText(page.expandedTree, "Fluxos")).toBe(true);
    expect(hasText(page.expandedTree, "2 fluxos")).toBe(true);
    expect(hasText(page.expandedTree, "Regras")).toBe(false);
    expect(hasText(page.expandedTree, "Pausado")).toBe(true);
    expect(hasText(page.expandedTree, "Ativo")).toBe(true);
    expect(hasText(page.expandedTree, "Mensagem recebida")).toBe(true);
    expect(hasText(page.expandedTree, "Etapa do board alterada")).toBe(true);
    expect(hasText(page.expandedTree, "Abrir editor")).toBe(true);
    expect(findButtonByName(page.expandedTree, /Mover para vendas/i)).not.toBeNull();
  });

  it("creates a draft from the empty hub and opens the editor", async () => {
    const page = await renderAutomationsPageContainer({ automations: [] });

    expect(hasText(page.expandedTree, "Nenhum fluxo criado")).toBe(true);
    expect(findButtonByName(page.expandedTree, /Criar fluxo/i)).not.toBeNull();

    await clickButton(page.expandedTree, /Criar fluxo/i);
    await page.settle();

    expect(findElement(page.expandedTree, (element) => element.type === "h2" && hasText(element, /Novo fluxo/i))).not.toBeNull();
    expect(
      findElement(
        page.expandedTree,
        (element) =>
          element.type === "input" &&
          (element.props as { value?: unknown }).value === "Boas-vindas local"
      )
    ).not.toBeNull();
  });

  it("uses flow status copy in the editor instead of standalone enable language", async () => {
    const enabledAutomation = {
      ...baseAutomation,
      id: "automation-2",
      name: "Mover para vendas",
      status: "enabled"
    } satisfies AutomationRuleDto;
    const page = await renderAutomationsPageContainer({
      automations: [baseAutomation, enabledAutomation]
    });

    clickButton(page.expandedTree, /Boas-vindas/i);
    await page.settle();

    expect(hasText(page.expandedTree, "Fluxo pausado")).toBe(true);
    expect(hasText(page.expandedTree, "Habilitar")).toBe(false);

    clickButton(page.expandedTree, /Voltar para automações/i);
    await page.settle();
    clickButton(page.expandedTree, /Mover para vendas/i);
    await page.settle();

    expect(hasText(page.expandedTree, "Fluxo ativo")).toBe(true);
    expect(hasText(page.expandedTree, "Desabilitar")).toBe(false);

    clickButton(page.expandedTree, /Voltar para automações/i);
    await page.settle();
    await clickButton(page.expandedTree, /Criar fluxo/i);
    await page.settle();

    expect(hasText(page.expandedTree, "Rascunho")).toBe(true);
    expect(hasText(page.expandedTree, "Habilitar")).toBe(false);
  });

  it("switches the editor canvas into focus mode", async () => {
    const page = await renderAutomationsPageContainer();

    clickButton(page.expandedTree, /Boas-vindas/i);
    await page.settle();

    expect(findButtonByName(page.expandedTree, "Modo foco")).not.toBeNull();
    expect(
      findElement(
        page.expandedTree,
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "AutomationCanvas" &&
          (element.props as { variant?: unknown }).variant === "editor"
      )
    ).not.toBeNull();

    clickButton(page.expandedTree, "Modo foco");
    await page.settle();

    expect(findButtonByName(page.expandedTree, "Sair do foco")).not.toBeNull();
    expect(
      findElement(
        page.expandedTree,
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "AutomationCanvas" &&
          (element.props as { variant?: unknown }).variant === "focus"
      )
    ).not.toBeNull();
  });

  it("keeps test history collapsed until requested", async () => {
    const page = await renderAutomationsPageContainer();

    clickButton(page.expandedTree, /Boas-vindas/i);
    await page.settle();

    expect(
      findElement(page.expandedTree, (element) => element.type === "h2" && hasText(element, /Teste & histórico/i))
    ).toBeNull();

    clickButton(page.expandedTree, /Histórico/i);
    await page.settle();

    expect(
      findElement(page.expandedTree, (element) => element.type === "h2" && hasText(element, /Teste & histórico/i))
    ).not.toBeNull();
  });

  it("preserves unsaved canvas edits after toggling flow status", async () => {
    const page = await renderAutomationsPageContainer();

    clickButton(page.expandedTree, /Boas-vindas/i);
    await page.settle();

    const editedFlow = {
      version: 1,
      nodes: [
        {
          id: "trigger-1",
          type: "trigger_first_message",
          position: { x: 0, y: 0 },
          data: { title: "Primeira mensagem", config: {} }
        },
        {
          id: "send-message-1",
          type: "send_message",
          position: { x: 280, y: 0 },
          data: {
            title: "Enviar mensagem",
            config: { message: "Ola pelo fluxo" }
          }
        }
      ],
      edges: [
        {
          id: "trigger-1-send-message-1",
          source: "trigger-1",
          target: "send-message-1",
          sourceHandle: "success",
          targetHandle: "input"
        }
      ]
    } satisfies AutomationFlowDefinition;
    const canvas = findElement(
      page.expandedTree,
      (element) => typeof element.type === "function" && element.type.name === "AutomationCanvas"
    ) as ReactElement<{ onChange: (payload: AutomationFlowDefinition) => void }> | null;

    expect(canvas).not.toBeNull();
    canvas?.props.onChange(editedFlow);
    await page.settle();

    await clickButton(page.expandedTree, /Fluxo pausado/i);
    await page.settle();
    await submitEditorForm(page.expandedTree);
    await page.settle();

    expect(page.apiUpdateAutomationMock).toHaveBeenCalledTimes(2);
    expect(page.apiUpdateAutomationMock.mock.calls[1]?.[2]).toMatchObject({
      actions: editedFlow
    });
  });
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

  it("keeps visual trigger metadata instead of falling back to the form trigger", () => {
    const scheduledFlow = {
      version: 1,
      nodes: [
        {
          id: "trigger-schedule-1",
          type: "trigger_schedule",
          position: { x: 0, y: 0 },
          data: { title: "Horario/agendamento", config: {} }
        }
      ],
      edges: []
    } satisfies AutomationFlowDefinition;

    expect(automationActionsToTrigger(scheduledFlow, "message.received")).toBe("schedule.tick");
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
  it("normalizes keyword trigger input into multiple keywords", () => {
    expect(keywordInputToConfig("catalogo, preço\nsuporte,,  proposta ")).toEqual({
      keywordInput: "catalogo, preço\nsuporte,,  proposta ",
      keywords: ["catalogo", "preço", "suporte", "proposta"]
    });
  });

  it("formats keyword trigger config from raw, multiple and legacy single values", () => {
    expect(keywordConfigToInputValue({ keywordInput: "catalogo, catálogo, catalogos," })).toBe(
      "catalogo, catálogo, catalogos,"
    );
    expect(keywordConfigToInputValue({ keywords: ["catalogo", "preço"] })).toBe("catalogo, preço");
    expect(keywordConfigToInputValue({ keyword: "catalogo" })).toBe("catalogo");
  });

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

  it("imports every legacy action into a graph instead of dropping later actions", () => {
    const state = automationCanvasStateFromValue([
      { type: "send_message", label: "Enviar saudacao", config: { text: "Ola" } },
      { type: "add_tag", label: "Marcar lead", config: { tagName: "Lead" } },
      { type: "create_crm_note", label: "Registrar nota", config: { note: "Entrada antiga" } }
    ]);

    expect(state.nodes.map((node) => node.data.blockType)).toEqual([
      "trigger_first_message",
      "send_message",
      "add_tag",
      "create_internal_note"
    ]);
    expect(state.edges).toHaveLength(3);
    expect(state.nodes[3]?.data.config).toMatchObject({
      legacyType: "create_crm_note",
      legacyLabel: "Registrar nota",
      note: "Entrada antiga"
    });
  });

  it("creates node ids that avoid existing persisted graph ids", () => {
    const node = createAutomationNode("trigger_first_message", { x: 0, y: 0 }, [
      "trigger_first_message-1",
      "trigger_first_message-2"
    ]);

    expect(["trigger_first_message-1", "trigger_first_message-2"]).not.toContain(node.id);
  });

  it("replaces the initial trigger type without requiring the trigger node to be deleted", () => {
    const trigger = createAutomationNode("trigger_first_message", { x: 80, y: 180 });
    const replaced = replaceAutomationNodeType(trigger, "trigger_keyword");

    expect(replaced).toMatchObject({
      id: trigger.id,
      type: "trigger_keyword",
      draggable: false,
      deletable: false,
      data: expect.objectContaining({
        blockType: "trigger_keyword",
        title: "Palavra-chave",
        config: {}
      })
    });
  });
});
