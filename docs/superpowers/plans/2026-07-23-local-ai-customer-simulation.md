# Local AI Customer Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o apresentador envie uma mensagem inbound simulada pela caixa de entrada local e veja o agente responder, aplicar tags, criar notas e solicitar handoff.

**Architecture:** Um endpoint protegido por `PRYMEIRA_LOCAL_DEMO_ENABLED` persiste a mensagem inbound na conversa selecionada e executa o runtime real com o agente semeado e o provedor determinístico local. A interface alterna explicitamente o compositor entre atendente e cliente, usa realtime para mensagens/contexto e mantém um indicador de análise durante a execução.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, React 19, Vite, Zod, Vitest, WebSocket realtime.

---

## Mapa de arquivos

- `apps/api/src/modules/agents/provider-gateway.ts`: classificar intenções da demonstração e produzir respostas/ações estruturadas.
- `apps/api/src/modules/agents/provider-gateway.test.ts`: cobrir orçamento, suporte, handoff e fallback do provedor local.
- `apps/api/src/modules/agents/agent-runtime.ts`: permitir a mensagem de confirmação antes de concluir um handoff.
- `apps/api/src/modules/agents/agent-runtime.test.ts`: garantir resposta persistida e publicada nos handoffs.
- `apps/api/src/modules/demo/demo-scenario.ts`: persistir o inbound, publicar realtime e acionar o agente de demonstração.
- `apps/api/src/modules/demo/demo-scenario.test.ts`: testar o fluxo de serviço e as permissões de tags semeadas.
- `apps/api/src/modules/demo/demo.routes.ts`: validar e expor `POST /demo/conversations/:conversationId/customer-message`.
- `apps/api/src/modules/demo/demo.routes.test.ts`: testar acesso, payload e delegação da nova rota.
- `apps/api/src/app.ts`: criar o runtime antes das rotas demo e injetá-lo no serviço.
- `apps/web/src/app/api.ts`: tipar e chamar a nova rota.
- `apps/web/src/app/api.test.ts`: verificar URL, autorização, corpo e parsing do cliente HTTP.
- `apps/web/src/features/inbox/InboxPage.tsx`: alternar o compositor, enviar como cliente e exibir análise.
- `apps/web/src/features/inbox/InboxPage.test.tsx`: testar os textos/estados derivados do modo de simulação.
- `apps/web/src/styles.css`: diferenciar visualmente o modo cliente e o indicador da IA.

### Task 1: Tornar o provedor local comercial e determinístico

**Files:**
- Modify: `apps/api/src/modules/agents/provider-gateway.ts:549-582`
- Test: `apps/api/src/modules/agents/provider-gateway.test.ts:120-176`

- [ ] **Step 1: Escrever os testes que falham para os quatro comportamentos**

Substituir o teste genérico de resposta normal e acrescentar os cenários abaixo:

```ts
it("qualifies a budget request with a hot-budget tag and internal note", async () => {
  const output = await createSimulatedAgentProvider().generate({
    model: "prymeira-simulated",
    systemPrompt: "Qualifique pedidos comerciais.",
    userPrompt: "Preciso de orçamento urgente para 120 unidades.",
    context: {}
  });

  expect(output.handoff.required).toBe(false);
  expect(output.reply).toContain("120 unidades");
  expect(output.actions).toEqual([
    { type: "add_tag", tagName: "Orçamento quente" },
    {
      type: "create_internal_note",
      note: "IA identificou pedido de orçamento urgente para 120 unidades. Confirmar prazo e condição de pagamento."
    }
  ]);
});

it("classifies delivery trouble as support without inventing tags", async () => {
  const output = await createSimulatedAgentProvider().generate({
    model: "prymeira-simulated",
    systemPrompt: "Atenda clientes.",
    userPrompt: "Meu pedido está atrasado.",
    context: {}
  });

  expect(output.handoff.required).toBe(false);
  expect(output.actions).toEqual([
    { type: "add_tag", tagName: "Suporte" },
    {
      type: "create_internal_note",
      note: "IA identificou uma solicitação de suporte relacionada a pedido ou entrega."
    }
  ]);
});

it("answers a common delivery question without applying a tag", async () => {
  const output = await createSimulatedAgentProvider().generate({
    model: "prymeira-simulated",
    systemPrompt: "Atenda clientes.",
    userPrompt: "Vocês atendem empresas de Santa Catarina?",
    context: {}
  });

  expect(output.handoff.required).toBe(false);
  expect(output.reply).toContain("região Sul");
  expect(output.actions).toEqual([]);
});

it("acknowledges an upset customer and requests human handoff", async () => {
  const output = await createSimulatedAgentProvider().generate({
    model: "prymeira-simulated",
    systemPrompt: "Atenda clientes.",
    userPrompt: "Estou irritado com o atraso e quero falar com uma pessoa.",
    context: {}
  });

  expect(output.reply).toContain("pessoa do nosso time");
  expect(output.handoff.required).toBe(true);
  expect(output.actions).toEqual([
    { type: "add_tag", tagName: "Suporte" },
    {
      type: "create_internal_note",
      note: "IA identificou insatisfação e solicitação de atendimento humano."
    },
    {
      type: "request_handoff",
      reason: "Cliente demonstrou insatisfação ou pediu atendimento humano."
    }
  ]);
});

it("asks for context without applying a tag to a generic message", async () => {
  const output = await createSimulatedAgentProvider().generate({
    model: "prymeira-simulated",
    systemPrompt: "Atenda clientes.",
    userPrompt: "Olá, tudo bem?",
    context: {}
  });

  expect(output.handoff.required).toBe(false);
  expect(output.reply).toContain("Como posso ajudar");
  expect(output.actions).toEqual([]);
});
```

- [ ] **Step 2: Rodar o teste e confirmar a falha**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- provider-gateway.test.ts
```

Expected: FAIL porque o provedor atual sempre responde com o texto genérico e tenta aplicar `Atendido pela IA`.

- [ ] **Step 3: Implementar a classificação mínima**

Adicionar antes de `createSimulatedAgentProvider`:

```ts
function normalizeSimulatedText(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function includesAny(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term));
}

function readQuantity(value: string) {
  return value.match(/\b\d+\s*(?:unidades?|pecas?|itens?)?\b/)?.[0] ?? null;
}

function simulatedOutputFor(value: string) {
  const normalized = normalizeSimulatedText(value);
  const asksForHuman = includesAny(normalized, [
    "nao sei",
    "irritado",
    "insatisfeito",
    "falar com uma pessoa",
    "falar com alguem",
    "atendente humano"
  ]);
  const isSupport = includesAny(normalized, [
    "atrasado",
    "atraso",
    "pedido",
    "rastreio",
    "suporte",
    "problema"
  ]);
  const isBudget = includesAny(normalized, [
    "orcamento",
    "proposta",
    "quanto custa",
    "comprar",
    "unidades"
  ]);
  const isCommercialQuestion = includesAny(normalized, [
    "prazo de entrega",
    "santa catarina",
    "regiao sul",
    "forma de pagamento"
  ]);

  if (asksForHuman) {
    return {
      reply: "Entendi. Vou registrar o contexto e chamar uma pessoa do nosso time para continuar com você.",
      confidence: 0.92,
      actions: [
        { type: "add_tag", tagName: "Suporte" },
        {
          type: "create_internal_note",
          note: "IA identificou insatisfação e solicitação de atendimento humano."
        },
        {
          type: "request_handoff",
          reason: "Cliente demonstrou insatisfação ou pediu atendimento humano."
        }
      ],
      handoff: {
        required: true,
        reason: "Cliente demonstrou insatisfação ou pediu atendimento humano."
      }
    };
  }

  if (isSupport && !isBudget) {
    return {
      reply: "Entendi. Vou organizar as informações do pedido para que possamos verificar a entrega com rapidez.",
      confidence: 0.9,
      actions: [
        { type: "add_tag", tagName: "Suporte" },
        {
          type: "create_internal_note",
          note: "IA identificou uma solicitação de suporte relacionada a pedido ou entrega."
        }
      ],
      handoff: { required: false, reason: null }
    };
  }

  if (isBudget) {
    const quantity = readQuantity(normalized);
    const quantityLabel = quantity ? ` para ${quantity}` : "";
    return {
      reply: `Perfeito! Posso ajudar com esse orçamento${quantityLabel}. Qual é o prazo desejado e a cidade de entrega?`,
      confidence: 0.94,
      actions: [
        { type: "add_tag", tagName: "Orçamento quente" },
        {
          type: "create_internal_note",
          note: quantity
            ? `IA identificou pedido de orçamento urgente para ${quantity}. Confirmar prazo e condição de pagamento.`
            : "IA identificou intenção de compra e pedido de orçamento. Confirmar quantidade, prazo e condição de pagamento."
        }
      ],
      handoff: { required: false, reason: null }
    };
  }

  if (isCommercialQuestion) {
    return {
      reply: "Atendemos empresas em toda a região Sul. Depois da qualificação, o vendedor confirma disponibilidade, prazo e condição de pagamento.",
      confidence: 0.91,
      actions: [],
      handoff: { required: false, reason: null }
    };
  }

  return {
    reply: "Olá! Como posso ajudar com orçamento, prazo de entrega ou suporte ao seu pedido?",
    confidence: 0.82,
    actions: [],
    handoff: { required: false, reason: null }
  };
}
```

Trocar o corpo de `generate` por:

```ts
async generate(input) {
  const messageBody =
    typeof input.context.messageBody === "string" ? input.context.messageBody : "";
  return parseAgentOutput(
    simulatedOutputFor(`${input.userPrompt}\n${messageBody}`)
  );
}
```

- [ ] **Step 4: Rodar os testes do provedor**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- provider-gateway.test.ts
```

Expected: PASS para parsing, modo simulado e gateway compatível com OpenAI.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agents/provider-gateway.ts apps/api/src/modules/agents/provider-gateway.test.ts
git commit -m "feat: add deterministic local agent scenarios"
```

### Task 2: Enviar uma confirmação antes do handoff

**Files:**
- Modify: `apps/api/src/modules/agents/agent-runtime.ts:512-558`
- Test: `apps/api/src/modules/agents/agent-runtime.test.ts:685-770`

- [ ] **Step 1: Alterar os testes de handoff para exigir a resposta**

Nos dois testes que hoje usam `expect(prisma.message.create).not.toHaveBeenCalled()`, exigir:

```ts
expect(prisma.message.create).toHaveBeenCalledWith({
  data: expect.objectContaining({
    workspaceId: ids.workspace,
    conversationId: ids.conversation,
    direction: "outbound",
    type: "text",
    body: expect.stringContaining("pessoa"),
    status: "pending",
    sentByUserId: null,
    metadata: {
      source: "ai_agent",
      agentId: ids.agent
    }
  })
});
```

No teste de handoff com alta confiança, usar a resposta `Vou chamar uma pessoa do time.` para que a mesma asserção seja válida.

- [ ] **Step 2: Rodar o teste e confirmar a falha**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts
```

Expected: FAIL porque o runtime atual suprime `providerOutput.reply` quando há handoff.

- [ ] **Step 3: Permitir resposta segura mesmo quando o handoff foi solicitado**

Trocar:

```ts
if (!handoffReason && providerOutput.reply && allowedActions.includes("send_message")) {
```

por:

```ts
if (providerOutput.reply && allowedActions.includes("send_message")) {
```

Manter inalterados o status da sessão, o `handoffReason` e o log do run. Assim a mensagem reconhece o cliente antes de a conversa entrar na fila humana.

- [ ] **Step 4: Rodar os testes do runtime**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts
```

Expected: PASS, incluindo baixa confiança, handoff explícito, envio Evolution e realtime.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts
git commit -m "feat: acknowledge customers before agent handoff"
```

### Task 3: Criar o serviço de mensagem inbound da demonstração

**Files:**
- Modify: `apps/api/src/modules/demo/demo-scenario.ts:1-35,579-598,901-912`
- Test: `apps/api/src/modules/demo/demo-scenario.test.ts`

- [ ] **Step 1: Escrever o teste de fluxo do serviço**

Importar `createDemoScenarioService` e adicionar:

```ts
describe("simulateCustomerMessage", () => {
  it("persists inbound, publishes it, and runs the seeded agent", async () => {
    const inbound = {
      id: "message-inbound",
      workspaceId: "demo_workspace",
      conversationId: "50000000-0000-4000-8000-000000000001",
      providerMessageId: "demo-customer-message",
      direction: "inbound",
      type: "text",
      body: "Preciso de orçamento urgente para 120 unidades.",
      status: "delivered",
      sentByUserId: null,
      createdAt: new Date("2026-07-23T12:00:00.000Z")
    };
    const prisma = {
      aiAgent: {
        findFirst: vi.fn().mockResolvedValue({
          id: "80000000-0000-4000-8000-000000000001",
          status: "active"
        })
      },
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          id: inbound.conversationId,
          workspaceId: "demo_workspace"
        }),
        update: vi.fn().mockResolvedValue({})
      },
      message: {
        create: vi.fn().mockResolvedValue(inbound)
      },
      $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
        operation(prisma)
      )
    };
    const realtime = { publish: vi.fn() };
    const agentRuntime = {
      runForMessage: vi.fn().mockResolvedValue({
        status: "completed",
        runId: "agent-run-1"
      })
    };
    const service = createDemoScenarioService(prisma as never, realtime, {
      agentRuntime,
      replyDelayMs: 0
    });

    await expect(
      service.simulateCustomerMessage("demo_workspace", {
        conversationId: inbound.conversationId,
        body: inbound.body
      })
    ).resolves.toEqual({
      workspaceId: "demo_workspace",
      conversationId: inbound.conversationId,
      messageId: inbound.id,
      agentStatus: "completed",
      runId: "agent-run-1"
    });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "demo_workspace",
        conversationId: inbound.conversationId,
        direction: "inbound",
        type: "text",
        body: inbound.body,
        status: "delivered"
      })
    });
    expect(agentRuntime.runForMessage).toHaveBeenCalledWith({
      workspaceId: "demo_workspace",
      agentId: "80000000-0000-4000-8000-000000000001",
      conversationId: inbound.conversationId,
      messageId: inbound.id,
      trigger: "automation",
      instruction: "Simulação local controlada de mensagem do cliente."
    });
    expect(realtime.publish).toHaveBeenCalledWith({
      type: "message.created",
      workspaceId: "demo_workspace",
      payload: expect.objectContaining({ id: inbound.id, direction: "inbound" })
    });
  });
});
```

Acrescentar outro teste em que `conversation.findUnique` retorna `null` e verificar rejeição com `DEMO_CONVERSATION_NOT_FOUND`, sem criar mensagem.

- [ ] **Step 2: Rodar o teste e confirmar a falha**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- demo-scenario.test.ts
```

Expected: FAIL porque o serviço ainda não expõe `simulateCustomerMessage`.

- [ ] **Step 3: Permitir as tags aprovadas no seed**

Trocar o único `aiAgentAllowedTag.create` por:

```ts
await prisma.aiAgentAllowedTag.createMany({
  data: [tags[0], tags[1], tags[3]].map((tag) => ({
    workspaceId,
    agentId: ids.agent,
    tagId: tag.id
  }))
});
```

Isso libera somente `Orçamento quente`, `Follow-up` e `Suporte`.

- [ ] **Step 4: Implementar tipos, erros e dependência do runtime**

Adicionar:

```ts
export interface DemoCustomerMessageResult {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  agentStatus: "completed" | "handoff_requested" | "failed" | "skipped";
  runId?: string;
}

export class DemoScenarioError extends Error {
  constructor(
    public readonly code:
      | "DEMO_CONVERSATION_NOT_FOUND"
      | "DEMO_AGENT_UNAVAILABLE",
    message: string
  ) {
    super(message);
  }
}

interface DemoAgentRuntime {
  runForMessage(input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    messageId: string;
    trigger: "automation";
    instruction?: string | null;
  }): Promise<{
    status: "completed" | "handoff_requested" | "failed" | "skipped";
    runId?: string;
    message?: string;
  }>;
}
```

- [ ] **Step 5: Implementar persistência, realtime, atraso e execução**

Adicionar:

```ts
async function simulateCustomerMessage(
  prisma: PrismaClient,
  workspaceId: string,
  input: { conversationId: string; body: string },
  realtime: DemoRealtime | undefined,
  options: { agentRuntime?: DemoAgentRuntime; replyDelayMs: number }
): Promise<DemoCustomerMessageResult> {
  const [conversation, agent] = await Promise.all([
    prisma.conversation.findUnique({
      where: {
        workspaceId_id: {
          workspaceId,
          id: input.conversationId
        }
      },
      select: { id: true, workspaceId: true }
    }),
    prisma.aiAgent.findFirst({
      where: { workspaceId, id: ids.agent, status: "active" },
      select: { id: true }
    })
  ]);

  if (!conversation) {
    throw new DemoScenarioError(
      "DEMO_CONVERSATION_NOT_FOUND",
      "A conversa selecionada não pertence ao cenário local."
    );
  }
  if (!agent || !options.agentRuntime) {
    throw new DemoScenarioError(
      "DEMO_AGENT_UNAVAILABLE",
      "O agente da demonstração não está disponível. Restaure o cenário."
    );
  }

  const now = new Date();
  const message = await prisma.$transaction(async (transaction) => {
    const created = await transaction.message.create({
      data: {
        workspaceId,
        conversationId: conversation.id,
        providerEventId: `demo-customer:${conversation.id}:${now.getTime()}`,
        providerMessageId: `demo-customer-msg:${conversation.id}:${now.getTime()}`,
        direction: "inbound",
        type: "text",
        body: input.body,
        status: "delivered",
        sentByUserId: null,
        createdAt: now
      }
    });
    await transaction.conversation.update({
      where: {
        workspaceId_id: { workspaceId, id: conversation.id }
      },
      data: {
        status: "open",
        lastMessageAt: now,
        lastMessagePreview: input.body,
        unreadCount: { increment: 1 },
        aiControlStatus: "agent_allowed",
        aiControlUpdatedAt: now,
        aiControlUpdatedById: null
      }
    });
    return created;
  });

  realtime?.publish({
    type: "message.created",
    workspaceId,
    payload: toMessageDto(message)
  });

  if (options.replyDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.replyDelayMs));
  }

  const run = await options.agentRuntime.runForMessage({
    workspaceId,
    agentId: agent.id,
    conversationId: conversation.id,
    messageId: message.id,
    trigger: "automation",
    instruction: "Simulação local controlada de mensagem do cliente."
  });

  return {
    workspaceId,
    conversationId: conversation.id,
    messageId: message.id,
    agentStatus: run.status,
    ...(run.runId ? { runId: run.runId } : {})
  };
}
```

Atualizar a fábrica:

```ts
export function createDemoScenarioService(
  prisma: PrismaClient,
  realtime?: DemoRealtime,
  options: { agentRuntime?: DemoAgentRuntime; replyDelayMs?: number } = {}
) {
  return {
    reset(workspaceId: string) {
      return resetDemoWorkspace(prisma, workspaceId);
    },
    simulateLead(workspaceId: string) {
      return simulateLead(prisma, workspaceId, realtime);
    },
    simulateCustomerMessage(
      workspaceId: string,
      input: { conversationId: string; body: string }
    ) {
      return simulateCustomerMessage(prisma, workspaceId, input, realtime, {
        agentRuntime: options.agentRuntime,
        replyDelayMs: options.replyDelayMs ?? 1_200
      });
    }
  };
}
```

- [ ] **Step 6: Rodar os testes do cenário**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- demo-scenario.test.ts
```

Expected: PASS para portfólio Vincula, reset atômico, sessões e mensagem simulada.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/demo/demo-scenario.ts apps/api/src/modules/demo/demo-scenario.test.ts
git commit -m "feat: run local agent from simulated customer messages"
```

### Task 4: Expor a rota protegida e injetar o runtime

**Files:**
- Modify: `apps/api/src/modules/demo/demo.routes.ts`
- Modify: `apps/api/src/modules/demo/demo.routes.test.ts`
- Modify: `apps/api/src/app.ts:100-175`

- [ ] **Step 1: Escrever os testes da rota**

No serviço falso de `buildDemoApp`, adicionar:

```ts
const customerMessageResult = {
  workspaceId: "demo_workspace",
  conversationId: "50000000-0000-4000-8000-000000000001",
  messageId: "90000000-0000-4000-8000-000000000001",
  agentStatus: "completed" as const,
  runId: "91000000-0000-4000-8000-000000000001"
};

simulateCustomerMessage: vi.fn().mockResolvedValue(customerMessageResult)
```

Adicionar:

```ts
it("validates and delegates a simulated customer message", async () => {
  const { app, service } = await buildDemoApp();
  const conversationId = customerMessageResult.conversationId;

  try {
    const response = await app.inject({
      method: "POST",
      url: `/demo/conversations/${conversationId}/customer-message`,
      payload: { body: "Preciso de orçamento urgente para 120 unidades." }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(customerMessageResult);
    expect(service.simulateCustomerMessage).toHaveBeenCalledWith(
      "demo_workspace",
      {
        conversationId,
        body: "Preciso de orçamento urgente para 120 unidades."
      }
    );
  } finally {
    await app.close();
  }
});

it.each([{ body: "" }, { body: "x".repeat(1001) }])(
  "rejects invalid customer message payload %#",
  async (payload) => {
    const { app, service } = await buildDemoApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/demo/conversations/${customerMessageResult.conversationId}/customer-message`,
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(service.simulateCustomerMessage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }
);
```

Reutilizar os testes existentes de demo desabilitada, workspace divergente e papel sem owner para a nova URL.

- [ ] **Step 2: Rodar o teste e confirmar a falha**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- demo.routes.test.ts
```

Expected: FAIL com 404 para a nova rota.

- [ ] **Step 3: Implementar schema e rota**

Adicionar imports:

```ts
import { z } from "zod";
import { DemoScenarioError } from "./demo-scenario.js";
```

Adicionar schemas:

```ts
const customerMessageParamsSchema = z.object({
  conversationId: z.string().uuid()
});

const customerMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(1000)
});
```

Ampliar o tipo:

```ts
service?: Pick<
  DemoScenarioService,
  "reset" | "simulateLead" | "simulateCustomerMessage"
>;
```

Adicionar a rota:

```ts
app.post(
  "/demo/conversations/:conversationId/customer-message",
  async (request, reply) => {
    if (!requireDemoAccess(request, reply)) return reply;

    const params = customerMessageParamsSchema.safeParse(request.params);
    const body = customerMessageBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        code: "INVALID_DEMO_CUSTOMER_MESSAGE",
        error: "Informe uma mensagem de até 1000 caracteres."
      });
    }

    try {
      return await service.simulateCustomerMessage(request.talk.workspaceId, {
        conversationId: params.data.conversationId,
        body: body.data.body
      });
    } catch (error) {
      if (error instanceof DemoScenarioError) {
        return reply.code(error.code === "DEMO_CONVERSATION_NOT_FOUND" ? 404 : 503).send({
          code: error.code,
          error: error.message
        });
      }
      throw error;
    }
  }
);
```

- [ ] **Step 4: Reordenar a montagem do app e injetar o runtime**

Em `apps/api/src/app.ts`, mover o registro de `demoRoutes` para depois da criação de `evolutionRuntime`, `agentRuntime` e `agentReplyScheduler`. Registrar:

```ts
await app.register(demoRoutes, {
  enabled: env.PRYMEIRA_LOCAL_DEMO_ENABLED,
  demoWorkspaceId: env.PRYMEIRA_LOCAL_WORKSPACE_ID,
  service:
    options.prismaEnabled === false
      ? undefined
      : createDemoScenarioService(app.prisma, app.realtime, {
          agentRuntime,
          replyDelayMs: 1_200
        }),
  vinculaClient:
    env.PRYMEIRA_LOCAL_DEMO_ENABLED && env.VINCULA_CRM_STRICT_REAL
      ? createVinculaDemoClient({
          resetUrl: env.VINCULA_CRM_RESET_URL,
          token: env.VINCULA_CRM_RESET_TOKEN
        })
      : undefined,
  requireVinculaReset:
    env.PRYMEIRA_LOCAL_DEMO_ENABLED && env.VINCULA_CRM_STRICT_REAL
});
```

Adicionar o import de `createDemoScenarioService` em `app.ts`. Manter a rota registrada antes das rotas de canais/conversas para não alterar precedência.

- [ ] **Step 5: Rodar testes e typecheck da API**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- demo.routes.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: PASS e nenhum erro TypeScript na injeção do runtime.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/demo/demo.routes.ts apps/api/src/modules/demo/demo.routes.test.ts apps/api/src/app.ts
git commit -m "feat: expose protected local customer simulation"
```

### Task 5: Adicionar o cliente HTTP do frontend

**Files:**
- Modify: `apps/web/src/app/api.ts:50-75,2880-2930`
- Test: `apps/web/src/app/api.test.ts`

- [ ] **Step 1: Escrever o teste do cliente**

Adicionar:

```ts
describe("apiSimulateDemoCustomerMessage", () => {
  it("posts the selected conversation and parses the agent result", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          workspaceId: "demo_workspace",
          conversationId: "50000000-0000-4000-8000-000000000001",
          messageId: "90000000-0000-4000-8000-000000000001",
          agentStatus: "completed",
          runId: "91000000-0000-4000-8000-000000000001"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const { apiSimulateDemoCustomerMessage } = await import("./api");
    await expect(
      apiSimulateDemoCustomerMessage(
        async () => null,
        "50000000-0000-4000-8000-000000000001",
        "Preciso de orçamento."
      )
    ).resolves.toMatchObject({
      agentStatus: "completed",
      messageId: "90000000-0000-4000-8000-000000000001"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3002/demo/conversations/50000000-0000-4000-8000-000000000001/customer-message",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer local-dev-bypass",
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({ body: "Preciso de orçamento." })
      })
    );
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar a falha**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- api.test.ts
```

Expected: FAIL porque a função não existe.

- [ ] **Step 3: Implementar tipo e função**

Adicionar:

```ts
export interface DemoCustomerMessageResultDto {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  agentStatus: "completed" | "handoff_requested" | "failed" | "skipped";
  runId?: string;
}
```

Adicionar perto das outras APIs demo:

```ts
export async function apiSimulateDemoCustomerMessage(
  getToken: () => Promise<string | null>,
  conversationId: string,
  body: string
): Promise<DemoCustomerMessageResultDto> {
  return fetchJson(
    getToken,
    `/demo/conversations/${encodeURIComponent(conversationId)}/customer-message`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body })
    },
    (data) => {
      const payload = asRecord(data);
      const agentStatus = String(payload.agentStatus ?? "");
      if (!["completed", "handoff_requested", "failed", "skipped"].includes(agentStatus)) {
        throw new Error("Invalid demo customer message response.");
      }
      return {
        workspaceId: String(payload.workspaceId ?? ""),
        conversationId: String(payload.conversationId ?? ""),
        messageId: String(payload.messageId ?? ""),
        agentStatus: agentStatus as DemoCustomerMessageResultDto["agentStatus"],
        ...(typeof payload.runId === "string" ? { runId: payload.runId } : {})
      };
    },
    "Não foi possível simular a mensagem do cliente"
  );
}
```

- [ ] **Step 4: Rodar teste e typecheck do frontend**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- api.test.ts
pnpm --filter @prymeira-talk/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api.ts apps/web/src/app/api.test.ts
git commit -m "feat: add local customer simulation API client"
```

### Task 6: Construir o modo “Simular cliente” na caixa de entrada

**Files:**
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.test.tsx`
- Modify: `apps/web/src/styles.css:6514-6746`

- [ ] **Step 1: Escrever testes para a cópia e o estado do compositor**

Exportar futuramente `customerSimulationCopy` e adicionar ao teste:

```ts
describe("customerSimulationCopy", () => {
  it("labels normal attendant mode", () => {
    expect(customerSimulationCopy(false, "Ana Beatriz")).toEqual({
      placeholder: "Digite uma mensagem",
      sendLabel: "Enviar mensagem",
      banner: null
    });
  });

  it("makes simulated customer mode explicit", () => {
    expect(customerSimulationCopy(true, "Ana Beatriz")).toEqual({
      placeholder: "Escreva o que Ana Beatriz enviaria pelo WhatsApp",
      sendLabel: "Enviar como cliente",
      banner: "Você está simulando uma mensagem de Ana Beatriz"
    });
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar a falha**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- InboxPage.test.tsx
```

Expected: FAIL porque `customerSimulationCopy` não existe.

- [ ] **Step 3: Adicionar helper, import e estados**

Adicionar `apiSimulateDemoCustomerMessage` aos imports e:

```ts
export function customerSimulationCopy(
  isSimulatingCustomer: boolean,
  contactName: string
) {
  return isSimulatingCustomer
    ? {
        placeholder: `Escreva o que ${contactName} enviaria pelo WhatsApp`,
        sendLabel: "Enviar como cliente",
        banner: `Você está simulando uma mensagem de ${contactName}`
      }
    : {
        placeholder: "Digite uma mensagem",
        sendLabel: "Enviar mensagem",
        banner: null
      };
}
```

No componente:

```ts
const [isSimulatingCustomer, setIsSimulatingCustomer] = useState(false);
const [isAgentAnalyzing, setIsAgentAnalyzing] = useState(false);
```

Ao trocar a conversa:

```ts
useEffect(() => {
  setIsSimulatingCustomer(false);
  setIsAgentAnalyzing(false);
}, [selectedConversationId]);
```

Derivar:

```ts
const composerCopy = customerSimulationCopy(
  isSimulatingCustomer,
  selectedConversation ? contactDisplayName(selectedConversation) : "este contato"
);
```

- [ ] **Step 4: Implementar o envio inbound controlado**

No início de `handleSendMessage`, depois de obter `targetConversationId` e `messageBody`, adicionar:

```ts
if (isSimulatingCustomer) {
  setIsSending(true);
  setIsAgentAnalyzing(true);
  setMessageError(null);
  setDraft("");
  scheduleMessageThreadScroll("smooth");

  try {
    const result = await apiSimulateDemoCustomerMessage(
      getFreshToken,
      targetConversationId,
      messageBody
    );
    if (result.agentStatus === "failed" || result.agentStatus === "skipped") {
      setMessageError(
        "A mensagem chegou, mas o agente não conseguiu responder. Restaure o cenário e tente novamente."
      );
    }
  } catch (sendError) {
    if (selectedConversationIdRef.current === targetConversationId) {
      setMessageError(
        sendError instanceof Error
          ? sendError.message
          : "Não foi possível simular a mensagem do cliente."
      );
      setDraft((current) => (current.trim().length === 0 ? messageBody : current));
    }
  } finally {
    setIsAgentAnalyzing(false);
    setIsSending(false);
  }
  return;
}
```

O bloco outbound atual permanece abaixo, sem mudança de comportamento.

- [ ] **Step 5: Adicionar controles e feedback visível**

Antes do `<form>` do compositor:

```tsx
{localDemoEnabled && selectedConversation ? (
  <div className="customer-simulation-controls">
    <button
      aria-pressed={isSimulatingCustomer}
      className={isSimulatingCustomer ? "is-active" : ""}
      disabled={isSending}
      onClick={() => setIsSimulatingCustomer((current) => !current)}
      type="button"
    >
      <Bot size={14} aria-hidden="true" />
      {isSimulatingCustomer ? "Voltar ao atendente" : "Simular cliente"}
    </button>
    {composerCopy.banner ? <span>{composerCopy.banner}</span> : null}
  </div>
) : null}
```

No final de `.message-thread`, antes do botão de novas mensagens:

```tsx
{isAgentAnalyzing ? (
  <div className="agent-analysis-indicator" role="status">
    <Bot size={15} aria-hidden="true" />
    <span>Assistente Comercial IA está analisando</span>
    <span className="agent-analysis-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  </div>
) : null}
```

Atualizar o form, textarea e botão:

```tsx
<form
  aria-busy={isSending}
  className={`composer ${isSimulatingCustomer ? "is-customer-simulation" : ""}`}
  aria-label={isSimulatingCustomer ? "Simulador de mensagem do cliente" : "Compositor de mensagem"}
  onSubmit={handleSendMessage}
>
```

```tsx
placeholder={composerCopy.placeholder}
```

```tsx
aria-label={composerCopy.sendLabel}
disabled={!selectedConversation || !draft.trim() || isSending}
```

Desabilitar anexo, formatação e mensagens padrão enquanto `isSimulatingCustomer`, pois a primeira versão aceita somente texto:

```tsx
disabled={!selectedConversation || isSimulatingCustomer}
```

- [ ] **Step 6: Estilizar o modo e a animação**

Adicionar em `apps/web/src/styles.css`:

```css
.customer-simulation-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 7px 12px;
  border-top: 1px solid rgba(107, 91, 181, 0.22);
  background: rgba(107, 91, 181, 0.08);
  color: #51458c;
  font-size: 11px;
  font-weight: 700;
}

.customer-simulation-controls button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(107, 91, 181, 0.3);
  border-radius: var(--radius-full);
  background: var(--color-surface-card);
  color: #51458c;
  padding: 6px 10px;
  font: inherit;
  cursor: pointer;
}

.customer-simulation-controls button.is-active {
  background: #6b5bb5;
  color: #fff;
}

.composer.is-customer-simulation {
  box-shadow: inset 3px 0 0 #6b5bb5;
  background: rgba(107, 91, 181, 0.035);
}

.agent-analysis-indicator {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 4px 12px 10px 48px;
  padding: 8px 11px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 14px;
  background: var(--color-surface-card);
  color: var(--color-text-secondary);
  font-size: 11px;
  box-shadow: var(--shadow-card);
}

.agent-analysis-dots {
  display: inline-flex;
  gap: 3px;
}

.agent-analysis-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #6b5bb5;
  animation: agent-analysis-pulse 1s ease-in-out infinite;
}

.agent-analysis-dots i:nth-child(2) { animation-delay: 0.15s; }
.agent-analysis-dots i:nth-child(3) { animation-delay: 0.3s; }

@keyframes agent-analysis-pulse {
  0%, 100% { opacity: 0.25; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

@media (prefers-reduced-motion: reduce) {
  .agent-analysis-dots i {
    animation: none;
    opacity: 0.7;
  }
}
```

- [ ] **Step 7: Rodar testes, typecheck e build do frontend**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- InboxPage.test.tsx
pnpm --filter @prymeira-talk/web typecheck
pnpm --filter @prymeira-talk/web build
```

Expected: PASS e bundle Vite gerado.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/inbox/InboxPage.tsx apps/web/src/features/inbox/InboxPage.test.tsx apps/web/src/styles.css
git commit -m "feat: add customer simulation mode to inbox"
```

### Task 7: Verificar o fluxo integrado e o reset

**Files:**
- Verify only; no source changes expected.

- [ ] **Step 1: Rodar toda a suíte**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: todas as suítes, typechecks e builds passam.

- [ ] **Step 2: Restaurar e iniciar o ambiente integrado**

Run:

```bash
pnpm demo:reset:all
pnpm demo:stack
pnpm demo:check
```

Expected: Talk web/API, Vincula web/API e Postgres saudáveis; verificação integrada verde.

- [ ] **Step 3: Validar orçamento no navegador**

1. Abrir `http://localhost:5176/?module=atendimento`.
2. Selecionar `Ana Beatriz`.
3. Clicar em `Simular cliente`.
4. Enviar `Preciso de orçamento urgente para 120 unidades.`
5. Confirmar mensagem inbound, indicador da IA e resposta.
6. Confirmar `Orçamento quente` e a nota interna no painel lateral.

Expected: todos os efeitos aparecem sem recarregar.

- [ ] **Step 4: Validar suporte e handoff**

1. Selecionar outra conversa.
2. Ativar `Simular cliente`.
3. Enviar `Estou irritado com o atraso e quero falar com uma pessoa.`
4. Confirmar resposta acolhedora, tag `Suporte` e `Humano necessário`.

Expected: o agente responde antes de entregar a conversa ao humano.

- [ ] **Step 5: Validar que o envio normal não mudou**

1. Clicar em `Voltar ao atendente`.
2. Enviar `Vou verificar isso para você.`
3. Confirmar bolha outbound e status de envio.

Expected: o fluxo existente continua funcionando e não chama a rota demo.

- [ ] **Step 6: Validar o reset**

1. Clicar em `Restaurar`.
2. Confirmar que Talk e Vincula retornam ao baseline.
3. Reabrir as conversas usadas.

Expected: mensagens, sessões, tags e notas criadas no teste desapareceram e os dados iniciais voltaram.

- [ ] **Step 7: Registrar o resultado final**

Se nenhum ajuste foi necessário, não criar commit vazio. Registrar no handoff:

```txt
Verificação concluída:
- API: testes, typecheck e build verdes
- Web: testes, typecheck e build verdes
- Orçamento: inbound + resposta + tag + nota
- Suporte: inbound + resposta + tag + handoff
- Envio atendente: preservado
- Reset integrado: baseline restaurado
```
