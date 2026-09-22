import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { AgentsPage } from "./AgentsPage";
import type { AiAgentDto, AiAgentImprovementDto, TagDto } from "../../app/api";

vi.mock("../../app/auth", () => ({
  useTalkAuth: () => ({
    getToken: vi.fn(async () => "test-token")
  })
}));

vi.mock("../../app/api", () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(message: string, public readonly debug?: Record<string, unknown>) {
      super(message);
    }
  },
  apiCreateAgent: vi.fn(),
  apiCreateAgentKnowledge: vi.fn(),
  apiApproveAgentImprovement: vi.fn(),
  apiDeleteAgent: vi.fn(),
  apiDeleteAgentKnowledge: vi.fn(),
  apiGetAgentImprovements: vi.fn(async () => []),
  apiGetAgentKnowledge: vi.fn(),
  apiGetAgents: vi.fn(async () => []),
  apiGetTags: vi.fn(async () => [
    {
      id: "tag-1",
      workspaceId: "workspace-1",
      name: "Lead quente",
      color: "#2f6b57",
      useGuide: "Quando o cliente pedir preço, proposta ou demonstração.",
      isActive: true,
      agentCount: 1,
      conversationCount: 3,
      createdAt: "2026-07-05T12:00:00.000Z",
      updatedAt: "2026-07-05T12:00:00.000Z"
    }
  ]),
  apiNormalizeAgentImprovement: vi.fn(),
  apiSendAgentTestChatMessage: vi.fn(),
  apiUpdateAgent: vi.fn(),
  apiUpdateAgentImprovement: vi.fn(),
  apiUpdateAgentKnowledge: vi.fn(),
  apiUploadAgentKnowledge: vi.fn()
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.doUnmock("react");
  vi.doUnmock("../../app/auth");
  vi.doUnmock("../../app/api");
  vi.resetModules();
});

const baseTag: TagDto = {
  id: "tag-1",
  workspaceId: "workspace-1",
  name: "Lead quente",
  color: "#2f6b57",
  useGuide: "Quando o cliente pedir preço, proposta ou demonstração.",
  isActive: true,
  agentCount: 1,
  conversationCount: 3,
  createdAt: "2026-07-05T12:00:00.000Z",
  updatedAt: "2026-07-05T12:00:00.000Z"
};

const baseAgent: AiAgentDto = {
  id: "agent-1",
  workspaceId: "workspace-1",
  name: "Agente comercial",
  description: null,
  status: "active",
  providerMode: "prymeira_managed",
  provider: "simulated",
  model: "prymeira-simulated",
  systemPrompt: "Atenda bem.",
  behaviorConfig: {},
  handoffConfig: {},
  limitsConfig: {},
  allowedActions: ["send_message", "add_tag"],
  allowedTags: [],
  createdAt: "2026-07-05T12:00:00.000Z",
  updatedAt: "2026-07-05T12:00:00.000Z"
};

const baseImprovement: AiAgentImprovementDto = {
  id: "improvement-1",
  workspaceId: "workspace-1",
  agentId: baseAgent.id,
  conversationId: "conversation-1",
  sourceMessageId: "message-1",
  status: "pending",
  kind: "not_sold",
  title: "Produto não comercializado — revisar",
  content: "Não comercializamos este produto.",
  rationale: "O humano confirmou uma decisão comercial reutilizável.",
  sourceCustomerMessage: "Vocês têm barra chata galvanizada?",
  sourceHumanReply: "Não trabalhamos com esse produto.",
  detector: { confidence: 0.95 },
  clarification: {
    questions: [
      {
        id: "scope",
        question: "A decisão vale para todas as medidas?",
        help: "Delimite o escopo."
      },
      {
        id: "exceptions",
        question: "Quais exceções existem?",
        help: "Escreva Nenhuma se não houver."
      }
    ],
    answers: {},
    normalization: null
  },
  reviewedAt: null,
  acceptedKnowledgeSourceId: null,
  createdAt: "2026-09-22T14:00:00.000Z",
  updatedAt: "2026-09-22T14:00:00.000Z"
};

function depsChanged(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) {
  if (!previous || !next || previous.length !== next.length) {
    return true;
  }

  return next.some((value, index) => !Object.is(value, previous[index]));
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

function hasText(node: ReactNode, matcher: string | RegExp) {
  const content = textContent(node);
  return typeof matcher === "string" ? content.includes(matcher) : matcher.test(content);
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

function findButtonByName(node: ReactNode, matcher: string | RegExp) {
  return findElement(
    node,
    (element) => element.type === "button" && hasText(element.props.children, matcher)
  );
}

async function renderAgentsPageContainer() {
  let ComponentUnderTest: (() => ReactElement) | null = null;
  let tree: ReactNode = null;
  let stateCursor = 0;
  let effectCursor = 0;
  let memoCursor = 0;
  let refCursor = 0;
  const refValues: Array<{ current: unknown }> = [];
  const stateValues: unknown[] = [];
  const effectDeps: Array<readonly unknown[] | undefined> = [];
  const memoValues: Array<{ deps: readonly unknown[] | undefined; value: unknown }> = [];
  const scheduledEffects: Array<() => void | (() => void)> = [];
  const getToken = vi.fn(async () => "test-token");
  const apiGetAgentsMock = vi
    .fn()
    .mockResolvedValueOnce([baseAgent])
    .mockResolvedValueOnce([
      {
        ...baseAgent,
        allowedTags: []
      }
    ]);
  const apiGetTagsMock = vi.fn(async () => [baseTag]);
  const apiGetAgentImprovementsMock = vi.fn(async () => [baseImprovement]);
  const apiSendTestMock = vi.fn().mockResolvedValue({
    message: { role: "assistant", content: "Qual cidade?" },
    processedMessage: { role: "user", content: "[Texto do PDF — conteúdo enviado pelo cliente]\n8 chapas A36" },
    output: { actions: [], handoff: { required: false } }, knowledgeMatches: [],
    debug: { media: { status: "processed", extractedText: "8 chapas A36" } }
  });
  const apiUpdateAgentMock = vi.fn(async (
    _getToken: () => Promise<string | null>,
    agentId: string,
    body: Partial<AiAgentDto> & { allowedTagIds?: string[] }
  ) => ({
    ...baseAgent,
    ...body,
    id: agentId,
    allowedTags: (body.allowedTagIds ?? []).map((tagId) => ({
      id: tagId,
      name: baseTag.name,
      color: baseTag.color,
      useGuide: baseTag.useGuide
    }))
  }));

  function render() {
    if (!ComponentUnderTest) return;
    stateCursor = 0;
    effectCursor = 0;
    memoCursor = 0;
    refCursor = 0;
    tree = ComponentUnderTest();
  }

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

  vi.resetModules();
  vi.doMock("react", async (importOriginal) => {
    const original = await importOriginal<typeof import("react")>();

    return {
      ...original,
      useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
        const index = effectCursor++;

        if (!depsChanged(effectDeps[index], deps)) {
          return;
        }

        effectDeps[index] = deps;
        scheduledEffects.push(effect);
      },
      useMemo: useMemoMock,
      useRef: (value: unknown) => {
        const index = refCursor++;
        return refValues[index] ?? (refValues[index] = { current: value });
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
          stateValues[index] =
            typeof nextValue === "function"
              ? (nextValue as (current: T) => T)(currentValue)
              : nextValue;
          render();
        };

        return [stateValues[index], setValue] as const;
      }
    };
  });
  vi.doMock("../../app/auth", () => ({
    useTalkAuth: () => ({ getToken })
  }));
  vi.doMock("../../app/api", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../app/api")>();

    return {
      ...original,
      apiCreateAgent: vi.fn(),
      apiCreateAgentKnowledge: vi.fn(),
      apiApproveAgentImprovement: vi.fn(),
      apiDeleteAgent: vi.fn(),
      apiDeleteAgentKnowledge: vi.fn(),
      apiGetAgentImprovements: apiGetAgentImprovementsMock,
      apiGetAgentKnowledge: vi.fn(async () => []),
      apiGetAgents: apiGetAgentsMock,
      apiGetTags: apiGetTagsMock,
      apiNormalizeAgentImprovement: vi.fn(),
      apiSendAgentTestChatMessage: apiSendTestMock,
      apiUpdateAgent: apiUpdateAgentMock,
      apiUpdateAgentImprovement: vi.fn(),
      apiUpdateAgentKnowledge: vi.fn(),
      apiUploadAgentKnowledge: vi.fn()
    };
  });

  const imported = await import("./AgentsPage");
  ComponentUnderTest = imported.AgentsPage;
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
    get tree() {
      return tree;
    },
    apiGetAgentsMock,
    apiGetAgentImprovementsMock,
    apiGetTagsMock,
    apiUpdateAgentMock,
    apiSendTestMock,
    settle
  };
}

describe("AgentsPage", () => {
  it("discards a previous agent response if an import changes the selected agent", async () => {
    const page = await renderAgentsPageContainer();
    let resolveResponse: (value: unknown) => void = () => {};
    page.apiSendTestMock.mockImplementationOnce(() => new Promise((resolve) => { resolveResponse = resolve; }));
    const input = findElement(page.tree, (el) => el.type === "textarea" && (el.props as any).placeholder === "Oi, tudo bem?") as ReactElement<any>;
    input.props.onChange({ target: { value: "Dados exclusivos do agente A" } });
    (findElement(page.tree, (el) => el.type === "form" && hasText(el.props.children, "Mensagem de teste")) as ReactElement<any>).props.onSubmit({ preventDefault: vi.fn() });
    await page.settle();
    const packagePanel = findElement(page.tree, (el) => typeof (el.props as any).onImported === "function") as ReactElement<any>;
    packagePanel.props.onImported({ ...baseAgent, id: "agent-b", name: "Agente B" });
    resolveResponse({ message: { role: "assistant", content: "Resposta antiga do agente A" },
      output: {}, knowledgeMatches: [], processedMessage: { role: "user", content: "Extração exclusiva de A" } });
    await page.settle();
    expect(hasText(page.tree, "Resposta antiga do agente A")).toBe(false);
    expect(hasText(page.tree, "Extração exclusiva de A")).toBe(false);
  });
  it("uploads a file once and retains extracted content for the next message", async () => {
    const page = await renderAgentsPageContainer();
    const fileInput = findElement(page.tree, (el) => el.type === "input" && (el.props as any)["aria-label"] === "Anexo de teste") as ReactElement<any>;
    const bytes = new TextEncoder().encode("%PDF-test");
    fileInput.props.onChange({ currentTarget: { files: [{ name: "pedido.pdf", type: "application/pdf", size: bytes.length, arrayBuffer: async () => bytes.buffer }] } });
    const submit = () => (findElement(page.tree, (el) => el.type === "form" && hasText(el.props.children, "Mensagem de teste")) as ReactElement<any>).props.onSubmit({ preventDefault: vi.fn() });
    submit();
    await page.settle();
    expect(page.apiSendTestMock).toHaveBeenCalledTimes(1);
    expect(page.apiSendTestMock.mock.calls[0][2].attachment).toEqual({ fileName: "pedido.pdf", mimeType: "application/pdf", base64Content: btoa("%PDF-test") });
    expect(hasText(page.tree, "8 chapas A36")).toBe(true);
    const messageInput = findElement(page.tree, (el) => el.type === "textarea" && (el.props as any).placeholder === "Oi, tudo bem?") as ReactElement<any>;
    messageInput.props.onChange({ target: { value: "Joinville" } });
    submit();
    await page.settle();
    expect(page.apiSendTestMock.mock.calls[1][2].attachment).toBeUndefined();
    expect(page.apiSendTestMock.mock.calls[1][2].messages[0].content).toContain("8 chapas A36");
    const reset = findButtonByName(page.tree, "Resetar teste") as ReactElement<any>;
    reset.props.onClick();
    expect(hasText(page.tree, "8 chapas A36")).toBe(false);
  });
  it("requires a scoped team answer before a pending improvement can be approved", async () => {
    const page = await renderAgentsPageContainer();
    const improvementsTab = findButtonByName(page.tree, "Aprimoramentos") as ReactElement<{
      onClick: () => void;
    }> | null;

    expect(improvementsTab).not.toBeNull();
    improvementsTab?.props.onClick();
    await page.settle();

    expect(page.apiGetAgentImprovementsMock).toHaveBeenCalled();
    expect(hasText(page.tree, "Complete o escopo antes de incluir")).toBe(true);
    expect(hasText(page.tree, "A decisão vale para todas as medidas?")).toBe(true);
    expect(hasText(page.tree, "Interpretar com JEV")).toBe(true);
    const approveButton = findButtonByName(page.tree, "Aprovar e incluir") as ReactElement<{
      disabled: boolean;
    }> | null;
    expect(approveButton?.props.disabled).toBe(true);
  });
  it("renders the agents management controls", () => {
    const html = renderToStaticMarkup(<AgentsPage />);

    expect(html).toContain("Agentes");
    expect(html).toContain("Novo agente");
    expect(html).toContain("Status do agente");
    expect(html).toContain("Inativo");
    expect(html).toContain("Ativo");
    expect(html).toContain("Prompt do sistema");
    expect(html).toContain("Ações permitidas");
    expect(html).toContain("Enviar anexo");
    expect(html).toContain("Responder só conversas novas");
    expect(html).toContain("Tags permitidas");
    expect(html).toContain("Selecione as tags que este agente pode aplicar.");
    expect(html).toContain("Teste do agente");
    expect(html).toContain("Mensagem de teste");
    expect(html).toContain("Anexo de teste");
    expect(html).toContain("PDF, imagem ou áudio");
    expect(html).toContain("não envia mensagens ao WhatsApp");
    expect(html).toContain("Resetar teste");
    expect(html).toContain("Logs do teste");
    expect(html).toContain("Conhecimento");
    expect(html).toContain("Aprimoramentos");
    expect(html).toContain("Fontes de conhecimento salvas");
    expect(html).toContain("Arquivo PDF ou TXT");
    expect(html).toContain("Subir documento");
    expect(html).toContain("Adicionar conhecimento");
    expect(html).toContain("Preços");
    expect(html).toContain("FAQ");
  });

  it("syncs refreshed selected agent tags before submitting updates", async () => {
    const page = await renderAgentsPageContainer();

    expect(page.apiGetTagsMock).toHaveBeenCalledTimes(1);
    expect(hasText(page.tree, "Lead quente")).toBe(true);

    const tagsSection = findElement(
      page.tree,
      (element) =>
        element.type === "section" &&
        (element.props as { "aria-label"?: string })["aria-label"] === "Tags permitidas"
    );
    expect(tagsSection).not.toBeNull();

    const tagCheckbox = findElement(
      tagsSection?.props.children,
      (element) => element.type === "input" && (element.props as { type?: string }).type === "checkbox"
    ) as ReactElement<{
      checked: boolean;
      onChange: () => void;
      type: string;
    }> | null;
    expect(tagCheckbox).not.toBeNull();
    expect(tagCheckbox?.props.checked).toBe(false);

    tagCheckbox?.props.onChange();

    const refreshButton = findButtonByName(page.tree, "Atualizar") as ReactElement<{
      onClick: () => void | Promise<void>;
    }> | null;
    expect(refreshButton).not.toBeNull();
    await refreshButton?.props.onClick();
    await page.settle();

    expect(page.apiGetAgentsMock).toHaveBeenCalledTimes(2);

    const form = findElement(
      page.tree,
      (element) => element.type === "form" && typeof (element.props as { onSubmit?: unknown }).onSubmit === "function"
    ) as ReactElement<{
      onSubmit: (event: { preventDefault: () => void }) => void | Promise<void>;
    }> | null;
    expect(form).not.toBeNull();

    await form?.props.onSubmit({ preventDefault: vi.fn() });

    expect(page.apiUpdateAgentMock).toHaveBeenCalledWith(
      expect.any(Function),
      "agent-1",
      expect.objectContaining({
        allowedTagIds: []
      })
    );
  });

  it("shows a guarded agent deletion control after an agent is selected", async () => {
    const page = await renderAgentsPageContainer();
    const deleteButton = findButtonByName(page.tree, "Excluir agente") as ReactElement<{
      disabled: boolean;
    }> | null;

    expect(deleteButton).not.toBeNull();
    expect(deleteButton?.props.disabled).toBe(true);
    expect(hasText(page.tree, "Inative e salve o agente antes de excluí-lo.")).toBe(true);
  });
});
