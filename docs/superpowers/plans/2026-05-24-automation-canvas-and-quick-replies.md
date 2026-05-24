# Automation Canvas and Quick Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable quick replies to the inbox composer and replace the current automation editor with a React Flow canvas that saves a versioned block graph.

**Architecture:** Keep the first cut deliberately split: quick replies are a normal workspace CRUD module used by the inbox, while automation flow definitions are a shared contract consumed by API validation and the React Flow UI. The API keeps `AutomationRule.actions` as JSON for now, storing `{ version, nodes, edges }` without a new table, and manual test runs simulate supported nodes in graph order.

**Tech Stack:** TypeScript, Fastify, Prisma, React 19, Vite, Vitest, `@xyflow/react`, existing `lucide-react`, existing app CSS.

---

## File Map

- Create `packages/shared/src/automation-flow.ts`: shared block ids, support states, node/edge schemas, validation helpers.
- Modify `packages/shared/src/domain.ts`: export automation flow types if needed by app code.
- Create `packages/shared/src/automation-flow.test.ts`: contract tests for block catalog and flow validation.
- Modify `apps/api/prisma/schema.prisma`: add `QuickReply` model.
- Create `apps/api/prisma/migrations/20260524152000_add_quick_replies/migration.sql`: quick replies table.
- Create `apps/api/src/modules/quick-replies/quick-replies.service.ts`: workspace scoped CRUD and DTO mapping.
- Create `apps/api/src/modules/quick-replies/quick-replies.routes.ts`: HTTP routes.
- Create `apps/api/src/modules/quick-replies/quick-replies.service.test.ts`: service and route tests.
- Modify `apps/api/src/app.ts`: register quick replies routes.
- Modify `apps/api/src/modules/automations/automations.service.ts`: accept and validate flow definitions, simulate graph runs.
- Modify `apps/api/src/modules/automations/automations.routes.ts`: widen `actions` schema to support graph JSON.
- Modify `apps/api/src/modules/automations/automations.service.test.ts`: flow validation and run simulation tests.
- Modify `apps/web/package.json`: add `@xyflow/react`.
- Modify `apps/web/src/app/api.ts`: add quick replies DTO/client functions and widen automation actions payload type.
- Create `apps/web/src/features/inbox/QuickRepliesPopover.tsx`: popover UI for list/search/create/edit/delete/insert.
- Modify `apps/web/src/features/inbox/InboxPage.tsx`: wire composer button to quick replies popover.
- Modify `apps/web/src/features/inbox/InboxPage.test.tsx`: quick reply insertion helper tests.
- Create `apps/web/src/features/automations/automationFlow.ts`: UI helpers for node creation, labels, defaults, and conversion to API payload.
- Create `apps/web/src/features/automations/AutomationCanvas.tsx`: React Flow canvas shell.
- Create `apps/web/src/features/automations/AutomationNode.tsx`: custom node card.
- Create `apps/web/src/features/automations/AutomationBlockLibrary.tsx`: block picker.
- Create `apps/web/src/features/automations/AutomationNodeInspector.tsx`: selected node config panel.
- Modify `apps/web/src/features/automations/AutomationsPage.tsx`: replace form editor with canvas-based editor.
- Modify `apps/web/src/features/automations/AutomationsPage.test.tsx`: flow helper tests.
- Modify `apps/web/src/app/styles.css`: composer quick replies and automation canvas styles.

---

### Task 1: Shared Automation Flow Contract

**Files:**
- Create: `packages/shared/src/automation-flow.ts`
- Create: `packages/shared/src/automation-flow.test.ts`
- Modify: `packages/shared/src/domain.ts`

- [ ] **Step 1: Write the failing shared tests**

Create `packages/shared/src/automation-flow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  automationBlockCatalog,
  automationFlowSchema,
  getAutomationBlock,
  validateAutomationFlowForStatus
} from "./automation-flow";

describe("automation flow contract", () => {
  it("contains the first-cut supported blocks", () => {
    expect(getAutomationBlock("trigger_first_message")?.support).toBe("supported");
    expect(getAutomationBlock("send_message")?.support).toBe("supported");
    expect(getAutomationBlock("send_file")?.support).toBe("supported");
    expect(getAutomationBlock("add_tag")?.support).toBe("supported");
    expect(getAutomationBlock("move_board_stage")?.support).toBe("supported");
    expect(getAutomationBlock("ai_classify_message")?.support).toBe("coming_soon");
  });

  it("parses a valid versioned flow", () => {
    const flow = automationFlowSchema.parse({
      version: 1,
      nodes: [
        {
          id: "trigger-1",
          type: "trigger_first_message",
          position: { x: 0, y: 0 },
          data: { title: "Primeira mensagem", config: {} }
        },
        {
          id: "message-1",
          type: "send_message",
          position: { x: 260, y: 0 },
          data: { title: "Enviar mensagem", config: { text: "Ola!" } }
        }
      ],
      edges: [{ id: "edge-1", source: "trigger-1", target: "message-1" }]
    });

    expect(flow.version).toBe(1);
    expect(flow.nodes).toHaveLength(2);
  });

  it("rejects enabled flows that contain coming soon blocks", () => {
    const result = validateAutomationFlowForStatus(
      {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_first_message",
            position: { x: 0, y: 0 },
            data: { title: "Primeira mensagem", config: {} }
          },
          {
            id: "ai-1",
            type: "ai_classify_message",
            position: { x: 260, y: 0 },
            data: { title: "Classificar", config: {} }
          }
        ],
        edges: [{ id: "edge-1", source: "trigger-1", target: "ai-1" }]
      },
      "enabled"
    );

    expect(result.success).toBe(false);
    expect(result.errors).toContain("O bloco Classificar mensagem ainda nao pode ser usado em fluxos ativos.");
  });

  it("requires at least one trigger node", () => {
    const result = validateAutomationFlowForStatus(
      {
        version: 1,
        nodes: [
          {
            id: "message-1",
            type: "send_message",
            position: { x: 260, y: 0 },
            data: { title: "Enviar mensagem", config: { text: "Ola!" } }
          }
        ],
        edges: []
      },
      "disabled"
    );

    expect(result.success).toBe(false);
    expect(result.errors).toContain("O fluxo precisa ter pelo menos um gatilho.");
  });

  it("keeps block ids unique in the catalog", () => {
    const ids = automationBlockCatalog.map((block) => block.type);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @prymeira-talk/shared test -- src/automation-flow.test.ts
```

Expected: fail because `automation-flow.ts` does not exist.

- [ ] **Step 3: Implement the shared contract**

Create `packages/shared/src/automation-flow.ts`:

```ts
import { z } from "zod";

export const automationBlockSupportSchema = z.enum(["supported", "visual_only", "coming_soon"]);
export type AutomationBlockSupport = z.infer<typeof automationBlockSupportSchema>;

export const automationBlockCategorySchema = z.enum([
  "trigger",
  "communication",
  "decision",
  "time",
  "crm",
  "integration",
  "control"
]);
export type AutomationBlockCategory = z.infer<typeof automationBlockCategorySchema>;

export const automationBlockTypeSchema = z.enum([
  "trigger_first_message",
  "trigger_reengagement",
  "trigger_keyword",
  "trigger_tag_added",
  "trigger_board_stage_changed",
  "trigger_conversation_closed",
  "trigger_schedule",
  "trigger_webhook",
  "send_message",
  "send_quick_reply",
  "send_image",
  "send_file",
  "send_audio",
  "ask_open_reply",
  "ask_options",
  "send_template",
  "notify_team",
  "condition_tag",
  "condition_channel",
  "condition_time",
  "condition_text",
  "condition_board_stage",
  "condition_assignee",
  "condition_source",
  "condition_status",
  "wait_time",
  "wait_until",
  "wait_reply",
  "limit_repetition",
  "business_hours",
  "add_tag",
  "remove_tag",
  "move_board_stage",
  "assign_user",
  "change_priority",
  "create_internal_note",
  "close_conversation",
  "upsert_contact",
  "create_task",
  "http_request",
  "ai_classify_message",
  "ai_generate_summary",
  "ai_suggest_reply",
  "enrich_contact",
  "external_system",
  "end_flow",
  "skip_step",
  "dedupe_guard",
  "mark_error",
  "log_event"
]);
export type AutomationBlockType = z.infer<typeof automationBlockTypeSchema>;

export interface AutomationBlockDefinition {
  type: AutomationBlockType;
  category: AutomationBlockCategory;
  label: string;
  description: string;
  support: AutomationBlockSupport;
}

export const automationBlockCatalog: AutomationBlockDefinition[] = [
  { type: "trigger_first_message", category: "trigger", label: "Primeira mensagem", description: "Dispara quando o contato nunca falou antes.", support: "supported" },
  { type: "trigger_reengagement", category: "trigger", label: "Retorno apos pausa", description: "Dispara quando o contato volta apos X dias sem mensagem.", support: "supported" },
  { type: "trigger_keyword", category: "trigger", label: "Palavra-chave", description: "Dispara por texto recebido.", support: "visual_only" },
  { type: "trigger_tag_added", category: "trigger", label: "Tag adicionada", description: "Dispara quando uma tag entra no contato.", support: "visual_only" },
  { type: "trigger_board_stage_changed", category: "trigger", label: "Etapa alterada", description: "Dispara quando o contato muda de etapa.", support: "supported" },
  { type: "trigger_conversation_closed", category: "trigger", label: "Conversa encerrada", description: "Dispara quando atendimento fecha.", support: "supported" },
  { type: "trigger_schedule", category: "trigger", label: "Horario/agendamento", description: "Dispara por horario configurado.", support: "visual_only" },
  { type: "trigger_webhook", category: "trigger", label: "Webhook externo", description: "Dispara por evento externo.", support: "coming_soon" },
  { type: "send_message", category: "communication", label: "Enviar mensagem", description: "Envia texto pelo WhatsApp.", support: "supported" },
  { type: "send_quick_reply", category: "communication", label: "Enviar mensagem padrao", description: "Usa uma mensagem padrao salva.", support: "supported" },
  { type: "send_image", category: "communication", label: "Enviar imagem", description: "Envia imagem.", support: "supported" },
  { type: "send_file", category: "communication", label: "Enviar arquivo", description: "Envia documento/arquivo.", support: "supported" },
  { type: "send_audio", category: "communication", label: "Enviar audio", description: "Envia audio gravado.", support: "visual_only" },
  { type: "ask_open_reply", category: "communication", label: "Pedir resposta", description: "Pede uma resposta aberta.", support: "supported" },
  { type: "ask_options", category: "communication", label: "Pedir escolha", description: "Mostra opcoes para o contato.", support: "visual_only" },
  { type: "send_template", category: "communication", label: "Enviar template", description: "Envia template aprovado.", support: "coming_soon" },
  { type: "notify_team", category: "communication", label: "Notificar equipe", description: "Cria alerta interno.", support: "visual_only" },
  { type: "condition_tag", category: "decision", label: "Condicao por tag", description: "Ramifica por tag.", support: "supported" },
  { type: "condition_channel", category: "decision", label: "Condicao por canal", description: "Ramifica por canal.", support: "supported" },
  { type: "condition_time", category: "decision", label: "Condicao por horario", description: "Ramifica por horario.", support: "supported" },
  { type: "condition_text", category: "decision", label: "Condicao por texto", description: "Ramifica por texto recebido.", support: "supported" },
  { type: "condition_board_stage", category: "decision", label: "Condicao por etapa", description: "Ramifica por etapa do CRM.", support: "supported" },
  { type: "condition_assignee", category: "decision", label: "Condicao por responsavel", description: "Ramifica por responsavel.", support: "visual_only" },
  { type: "condition_source", category: "decision", label: "Condicao por origem", description: "Ramifica por origem.", support: "visual_only" },
  { type: "condition_status", category: "decision", label: "Condicao por status", description: "Ramifica por status da conversa.", support: "visual_only" },
  { type: "wait_time", category: "time", label: "Aguardar tempo", description: "Espera minutos/horas/dias.", support: "supported" },
  { type: "wait_until", category: "time", label: "Aguardar ate horario", description: "Espera horario especifico.", support: "visual_only" },
  { type: "wait_reply", category: "time", label: "Aguardar resposta", description: "Espera resposta do contato.", support: "supported" },
  { type: "limit_repetition", category: "time", label: "Limitar repeticao", description: "Evita repeticao em janela.", support: "visual_only" },
  { type: "business_hours", category: "time", label: "Horario comercial", description: "Respeita janela de atendimento.", support: "visual_only" },
  { type: "add_tag", category: "crm", label: "Adicionar tag", description: "Adiciona tag.", support: "supported" },
  { type: "remove_tag", category: "crm", label: "Remover tag", description: "Remove tag.", support: "supported" },
  { type: "move_board_stage", category: "crm", label: "Mover no CRM", description: "Move contato para etapa.", support: "supported" },
  { type: "assign_user", category: "crm", label: "Atribuir responsavel", description: "Define responsavel.", support: "supported" },
  { type: "change_priority", category: "crm", label: "Alterar prioridade", description: "Altera prioridade.", support: "supported" },
  { type: "create_internal_note", category: "crm", label: "Criar nota interna", description: "Cria nota no contato.", support: "supported" },
  { type: "close_conversation", category: "crm", label: "Fechar conversa", description: "Fecha atendimento.", support: "supported" },
  { type: "upsert_contact", category: "crm", label: "Criar/atualizar contato", description: "Atualiza cadastro.", support: "visual_only" },
  { type: "create_task", category: "crm", label: "Criar tarefa", description: "Cria tarefa no CRM.", support: "visual_only" },
  { type: "http_request", category: "integration", label: "HTTP request", description: "Chama endpoint externo.", support: "coming_soon" },
  { type: "ai_classify_message", category: "integration", label: "Classificar mensagem", description: "Classifica com IA.", support: "coming_soon" },
  { type: "ai_generate_summary", category: "integration", label: "Gerar resumo", description: "Resume conversa com IA.", support: "coming_soon" },
  { type: "ai_suggest_reply", category: "integration", label: "Sugerir resposta", description: "Sugere resposta com IA.", support: "coming_soon" },
  { type: "enrich_contact", category: "integration", label: "Enriquecer contato", description: "Busca dados externos.", support: "coming_soon" },
  { type: "external_system", category: "integration", label: "Sistema externo", description: "Envia para sistema externo.", support: "coming_soon" },
  { type: "end_flow", category: "control", label: "Finalizar fluxo", description: "Encerra automacao.", support: "supported" },
  { type: "skip_step", category: "control", label: "Pular etapa", description: "Pula proximo passo.", support: "visual_only" },
  { type: "dedupe_guard", category: "control", label: "Evitar duplicidade", description: "Bloqueia duplicidade.", support: "visual_only" },
  { type: "mark_error", category: "control", label: "Marcar erro", description: "Registra falha.", support: "visual_only" },
  { type: "log_event", category: "control", label: "Registrar evento", description: "Registra evento no run.", support: "supported" }
];

export const automationNodeSchema = z.object({
  id: z.string().min(1),
  type: automationBlockTypeSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.object({
    title: z.string().min(1),
    config: z.record(z.string(), z.unknown()).default({})
  })
});
export type AutomationNodeDefinition = z.infer<typeof automationNodeSchema>;

export const automationEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional()
});
export type AutomationEdgeDefinition = z.infer<typeof automationEdgeSchema>;

export const automationFlowSchema = z.object({
  version: z.literal(1),
  nodes: z.array(automationNodeSchema),
  edges: z.array(automationEdgeSchema)
});
export type AutomationFlowDefinition = z.infer<typeof automationFlowSchema>;

export function getAutomationBlock(type: string) {
  return automationBlockCatalog.find((block) => block.type === type);
}

function hasTrigger(flow: AutomationFlowDefinition) {
  return flow.nodes.some((node) => getAutomationBlock(node.type)?.category === "trigger");
}

export function validateAutomationFlowForStatus(
  flow: AutomationFlowDefinition,
  status: "enabled" | "disabled"
): { success: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const node of flow.nodes) {
    if (ids.has(node.id)) {
      errors.push(`O bloco ${node.id} esta duplicado.`);
    }
    ids.add(node.id);

    const block = getAutomationBlock(node.type);
    if (!block) {
      errors.push(`O bloco ${node.type} nao existe.`);
      continue;
    }

    if (status === "enabled" && block.support !== "supported") {
      errors.push(`O bloco ${block.label} ainda nao pode ser usado em fluxos ativos.`);
    }
  }

  if (!hasTrigger(flow)) {
    errors.push("O fluxo precisa ter pelo menos um gatilho.");
  }

  for (const edge of flow.edges) {
    if (!ids.has(edge.source)) {
      errors.push(`A conexao ${edge.id} sai de um bloco inexistente.`);
    }
    if (!ids.has(edge.target)) {
      errors.push(`A conexao ${edge.id} aponta para um bloco inexistente.`);
    }
  }

  return { success: errors.length === 0, errors };
}
```

Modify `packages/shared/src/domain.ts` to export the contract:

```ts
export * from "./automation-flow";
```

- [ ] **Step 4: Verify shared tests pass**

Run:

```bash
pnpm --filter @prymeira-talk/shared test -- src/automation-flow.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/automation-flow.ts packages/shared/src/automation-flow.test.ts packages/shared/src/domain.ts
git commit -m "Add automation flow contract"
```

---

### Task 2: Quick Replies API

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260524152000_add_quick_replies/migration.sql`
- Create: `apps/api/src/modules/quick-replies/quick-replies.service.ts`
- Create: `apps/api/src/modules/quick-replies/quick-replies.routes.ts`
- Create: `apps/api/src/modules/quick-replies/quick-replies.service.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Add failing quick reply route tests**

Create `apps/api/src/modules/quick-replies/quick-replies.service.test.ts`:

```ts
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { quickRepliesRoutes } from "./quick-replies.routes";

const workspaceId = "local_workspace";
const quickReply = {
  id: "00000000-0000-4000-8000-000000000901",
  workspaceId,
  title: "Boas-vindas",
  body: "Ola! Como posso ajudar?",
  category: "Atendimento",
  createdAt: new Date("2026-05-24T12:00:00.000Z"),
  updatedAt: new Date("2026-05-24T12:00:00.000Z")
};

function createApp(overrides: Partial<Record<"findMany" | "create" | "update" | "delete", ReturnType<typeof vi.fn>>> = {}) {
  const app = Fastify();
  app.decorate("prisma", {
    quickReply: {
      findMany: overrides.findMany ?? vi.fn().mockResolvedValue([quickReply]),
      create: overrides.create ?? vi.fn().mockResolvedValue(quickReply),
      update: overrides.update ?? vi.fn().mockResolvedValue({ ...quickReply, title: "Atualizada" }),
      delete: overrides.delete ?? vi.fn().mockResolvedValue(quickReply)
    }
  });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId, role: "manager" };
  });
  return app.register(quickRepliesRoutes);
}

describe("quick replies routes", () => {
  it("lists workspace quick replies", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: "/quick-replies" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        ...quickReply,
        createdAt: "2026-05-24T12:00:00.000Z",
        updatedAt: "2026-05-24T12:00:00.000Z"
      }
    ]);
  });

  it("creates a quick reply", async () => {
    const create = vi.fn().mockResolvedValue(quickReply);
    const app = await createApp({ create });
    const response = await app.inject({
      method: "POST",
      url: "/quick-replies",
      payload: { title: "Boas-vindas", body: "Ola!", category: "Atendimento" }
    });

    expect(response.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith({
      data: {
        workspaceId,
        title: "Boas-vindas",
        body: "Ola!",
        category: "Atendimento"
      }
    });
  });

  it("updates a quick reply inside the workspace", async () => {
    const update = vi.fn().mockResolvedValue({ ...quickReply, title: "Atualizada" });
    const app = await createApp({ update });
    const response = await app.inject({
      method: "PATCH",
      url: `/quick-replies/${quickReply.id}`,
      payload: { title: "Atualizada" }
    });

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: quickReply.id } },
      data: { title: "Atualizada" }
    });
  });

  it("deletes a quick reply inside the workspace", async () => {
    const remove = vi.fn().mockResolvedValue(quickReply);
    const app = await createApp({ delete: remove });
    const response = await app.inject({ method: "DELETE", url: `/quick-replies/${quickReply.id}` });

    expect(response.statusCode).toBe(204);
    expect(remove).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: quickReply.id } }
    });
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/quick-replies/quick-replies.service.test.ts
```

Expected: fail because routes do not exist.

- [ ] **Step 3: Add Prisma model and migration**

Add to `apps/api/prisma/schema.prisma` after `AutomationRun`:

```prisma
model QuickReply {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String   @map("workspace_id")
  title       String
  body        String
  category    String?
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@unique([workspaceId, id])
  @@index([workspaceId, category])
  @@index([workspaceId, updatedAt])
  @@map("quick_replies")
}
```

Create `apps/api/prisma/migrations/20260524152000_add_quick_replies/migration.sql`:

```sql
CREATE TABLE "quick_replies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quick_replies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quick_replies_workspace_id_id_key" ON "quick_replies"("workspace_id", "id");
CREATE INDEX "quick_replies_workspace_id_category_idx" ON "quick_replies"("workspace_id", "category");
CREATE INDEX "quick_replies_workspace_id_updated_at_idx" ON "quick_replies"("workspace_id", "updated_at");
```

- [ ] **Step 4: Implement service and routes**

Create `apps/api/src/modules/quick-replies/quick-replies.service.ts`:

```ts
type DateLike = Date | string;

interface QuickReplyRecord {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  category: string | null;
  createdAt: DateLike;
  updatedAt: DateLike;
}

export interface QuickReplyDto {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrismaLike {
  quickReply: {
    findMany(args: { where: { workspaceId: string }; orderBy: Array<{ updatedAt: "desc" }> }): Promise<QuickReplyRecord[]>;
    create(args: { data: { workspaceId: string; title: string; body: string; category?: string | null } }): Promise<QuickReplyRecord>;
    update(args: { where: { workspaceId_id: { workspaceId: string; id: string } }; data: Partial<{ title: string; body: string; category: string | null }> }): Promise<QuickReplyRecord>;
    delete(args: { where: { workspaceId_id: { workspaceId: string; id: string } } }): Promise<QuickReplyRecord>;
  };
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toDto(record: QuickReplyRecord): QuickReplyDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    body: record.body,
    category: record.category ?? null,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

export function createQuickRepliesService(prisma: PrismaLike) {
  return {
    async list(input: { workspaceId: string }) {
      const records = await prisma.quickReply.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ updatedAt: "desc" }]
      });
      return records.map(toDto);
    },

    async create(input: { workspaceId: string; title: string; body: string; category?: string | null }) {
      const record = await prisma.quickReply.create({
        data: {
          workspaceId: input.workspaceId,
          title: input.title.trim(),
          body: input.body.trim(),
          category: input.category?.trim() || null
        }
      });
      return toDto(record);
    },

    async update(input: { workspaceId: string; id: string; data: Partial<{ title: string; body: string; category: string | null }> }) {
      const data = Object.fromEntries(
        Object.entries(input.data).map(([key, value]) => [
          key,
          typeof value === "string" ? value.trim() || (key === "category" ? null : value.trim()) : value
        ])
      );
      const record = await prisma.quickReply.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.id } },
        data
      });
      return toDto(record);
    },

    async delete(input: { workspaceId: string; id: string }) {
      await prisma.quickReply.delete({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.id } }
      });
    }
  };
}
```

Create `apps/api/src/modules/quick-replies/quick-replies.routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createQuickRepliesService } from "./quick-replies.service";
import type { PrismaLike } from "./quick-replies.service";

const paramsSchema = z.object({ quickReplyId: z.string().uuid() });

const bodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  category: z.string().trim().max(80).nullable().optional()
});

const updateBodySchema = bodySchema.partial().refine((body) => Object.keys(body).length > 0, {
  message: "At least one field is required."
});

export const quickRepliesRoutes: FastifyPluginAsync = async (app) => {
  const service = createQuickRepliesService(app.prisma as unknown as PrismaLike);

  app.get("/quick-replies", async (request) =>
    service.list({ workspaceId: request.talk.workspaceId })
  );

  app.post("/quick-replies", async (request, reply) => {
    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid quick reply request." });
    }

    const quickReply = await service.create({
      workspaceId: request.talk.workspaceId,
      ...body.data
    });

    return reply.code(201).send(quickReply);
  });

  app.patch("/quick-replies/:quickReplyId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = updateBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid quick reply request." });
    }

    return service.update({
      workspaceId: request.talk.workspaceId,
      id: params.data.quickReplyId,
      data: body.data
    });
  });

  app.delete("/quick-replies/:quickReplyId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid quick reply request." });
    }

    await service.delete({
      workspaceId: request.talk.workspaceId,
      id: params.data.quickReplyId
    });

    return reply.code(204).send();
  });
};
```

Modify `apps/api/src/app.ts`:

```ts
import { quickRepliesRoutes } from "./modules/quick-replies/quick-replies.routes.js";
```

Register after conversations:

```ts
await app.register(quickRepliesRoutes);
```

- [ ] **Step 5: Verify quick replies API**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/quick-replies/quick-replies.service.test.ts
pnpm --filter @prymeira-talk/api build
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/app.ts apps/api/src/modules/quick-replies
git commit -m "Add quick replies API"
```

---

### Task 3: Quick Replies in Inbox Composer

**Files:**
- Modify: `apps/web/src/app/api.ts`
- Create: `apps/web/src/features/inbox/QuickRepliesPopover.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.test.tsx`
- Modify: `apps/web/src/app/styles.css`

- [ ] **Step 1: Add failing UI helper tests**

Append to `apps/web/src/features/inbox/InboxPage.test.tsx`:

```ts
import { quickReplyMatchesQuery } from "./QuickRepliesPopover";

describe("quick reply helpers", () => {
  it("matches quick replies by title, body, or category", () => {
    const reply = {
      id: "reply-1",
      workspaceId: "workspace-1",
      title: "Boas-vindas",
      body: "Ola, seja bem-vindo",
      category: "Atendimento",
      createdAt: "2026-05-24T12:00:00.000Z",
      updatedAt: "2026-05-24T12:00:00.000Z"
    };

    expect(quickReplyMatchesQuery(reply, "boas")).toBe(true);
    expect(quickReplyMatchesQuery(reply, "bem-vindo")).toBe(true);
    expect(quickReplyMatchesQuery(reply, "atendimento")).toBe(true);
    expect(quickReplyMatchesQuery(reply, "financeiro")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/features/inbox/InboxPage.test.tsx
```

Expected: fail because `QuickRepliesPopover` does not exist.

- [ ] **Step 3: Add web API client functions**

In `apps/web/src/app/api.ts`, add:

```ts
export interface QuickReplyDto {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseQuickReply(payload: unknown): QuickReplyDto {
  const record = asRecord(payload);
  return {
    id: String(record.id ?? ""),
    workspaceId: String(record.workspaceId ?? ""),
    title: String(record.title ?? ""),
    body: String(record.body ?? ""),
    category: typeof record.category === "string" ? record.category : null,
    createdAt: String(record.createdAt ?? ""),
    updatedAt: String(record.updatedAt ?? "")
  };
}

export async function apiGetQuickReplies(getToken: () => Promise<string | null>): Promise<QuickReplyDto[]> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/quick-replies`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to load quick replies: ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data.map(parseQuickReply) : [];
}

export async function apiCreateQuickReply(
  getToken: () => Promise<string | null>,
  body: { title: string; body: string; category?: string | null }
): Promise<QuickReplyDto> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/quick-replies`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Failed to create quick reply: ${response.status}`);
  }
  return parseQuickReply(await response.json());
}

export async function apiUpdateQuickReply(
  getToken: () => Promise<string | null>,
  quickReplyId: string,
  body: Partial<{ title: string; body: string; category: string | null }>
): Promise<QuickReplyDto> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/quick-replies/${quickReplyId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Failed to update quick reply: ${response.status}`);
  }
  return parseQuickReply(await response.json());
}

export async function apiDeleteQuickReply(
  getToken: () => Promise<string | null>,
  quickReplyId: string
): Promise<void> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/quick-replies/${quickReplyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to delete quick reply: ${response.status}`);
  }
}
```

- [ ] **Step 4: Create the popover component**

Create `apps/web/src/features/inbox/QuickRepliesPopover.tsx`:

```tsx
import { Plus, Pencil, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { QuickReplyDto } from "../../app/api";

export function quickReplyMatchesQuery(reply: QuickReplyDto, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [reply.title, reply.body, reply.category ?? ""].some((value) =>
    value.toLowerCase().includes(normalizedQuery)
  );
}

interface QuickRepliesPopoverProps {
  replies: QuickReplyDto[];
  isLoading: boolean;
  error: string | null;
  onInsert: (body: string) => void;
  onCreate: (input: { title: string; body: string; category?: string | null }) => Promise<void>;
  onUpdate: (id: string, input: Partial<{ title: string; body: string; category: string | null }>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function QuickRepliesPopover({
  replies,
  isLoading,
  error,
  onInsert,
  onCreate,
  onUpdate,
  onDelete
}: QuickRepliesPopoverProps) {
  const [query, setQuery] = useState("");
  const [editingReply, setEditingReply] = useState<QuickReplyDto | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");

  const filteredReplies = useMemo(
    () => replies.filter((reply) => quickReplyMatchesQuery(reply, query)),
    [query, replies]
  );

  function startCreate() {
    setEditingReply(null);
    setTitle("");
    setBody("");
    setCategory("");
  }

  function startEdit(reply: QuickReplyDto) {
    setEditingReply(reply);
    setTitle(reply.title);
    setBody(reply.body);
    setCategory(reply.category ?? "");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingReply) {
      await onUpdate(editingReply.id, { title, body, category: category || null });
    } else {
      await onCreate({ title, body, category: category || null });
    }
    startCreate();
  }

  return (
    <div className="quick-replies-popover" aria-label="Mensagens padrao">
      <div className="quick-replies-header">
        <strong>Mensagens padrao</strong>
        <button type="button" className="composer-tool" onClick={startCreate} aria-label="Nova mensagem padrao">
          <Plus size={15} aria-hidden="true" />
        </button>
      </div>
      <input
        className="quick-replies-search"
        placeholder="Buscar por titulo, texto ou categoria"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? <p className="error-note">{error}</p> : null}
      {isLoading ? <p className="list-note">Carregando mensagens...</p> : null}
      <div className="quick-replies-list">
        {filteredReplies.map((reply) => (
          <article className="quick-reply-item" key={reply.id}>
            <button type="button" className="quick-reply-insert" onClick={() => onInsert(reply.body)}>
              <strong>{reply.title}</strong>
              <span>{reply.body}</span>
              {reply.category ? <small>{reply.category}</small> : null}
            </button>
            <button type="button" className="icon-button" onClick={() => startEdit(reply)} aria-label="Editar mensagem padrao">
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button type="button" className="icon-button danger" onClick={() => void onDelete(reply.id)} aria-label="Apagar mensagem padrao">
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
      <form className="quick-reply-form" onSubmit={submit}>
        <input required placeholder="Titulo" value={title} onChange={(event) => setTitle(event.target.value)} />
        <input placeholder="Categoria" value={category} onChange={(event) => setCategory(event.target.value)} />
        <textarea required placeholder="Mensagem" value={body} onChange={(event) => setBody(event.target.value)} />
        <button className="primary-button" type="submit">
          {editingReply ? "Salvar" : "Criar"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: Wire the popover into `InboxPage.tsx`**

Add imports:

```tsx
import {
  apiCreateQuickReply,
  apiDeleteQuickReply,
  apiGetQuickReplies,
  apiUpdateQuickReply,
  type QuickReplyDto
} from "../../app/api";
import { QuickRepliesPopover } from "./QuickRepliesPopover";
```

Add state near composer state:

```tsx
const [showQuickReplies, setShowQuickReplies] = useState(false);
const [quickReplies, setQuickReplies] = useState<QuickReplyDto[]>([]);
const [isQuickRepliesLoading, setIsQuickRepliesLoading] = useState(false);
const [quickRepliesError, setQuickRepliesError] = useState<string | null>(null);
```

Add loader:

```tsx
useEffect(() => {
  if (!showQuickReplies) return;
  let isMounted = true;
  setIsQuickRepliesLoading(true);
  setQuickRepliesError(null);
  apiGetQuickReplies(getToken)
    .then((nextReplies) => {
      if (isMounted) setQuickReplies(nextReplies);
    })
    .catch((loadError: unknown) => {
      if (isMounted) setQuickRepliesError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar mensagens padrao.");
    })
    .finally(() => {
      if (isMounted) setIsQuickRepliesLoading(false);
    });
  return () => {
    isMounted = false;
  };
}, [getToken, showQuickReplies]);
```

Replace the existing `Respostas rápidas` button with:

```tsx
<button
  type="button"
  className="composer-quick-replies"
  disabled={!selectedConversation}
  onClick={() => setShowQuickReplies((current) => !current)}
>
  Mensagens padrão
</button>
```

Render after emoji picker:

```tsx
{showQuickReplies ? (
  <QuickRepliesPopover
    replies={quickReplies}
    isLoading={isQuickRepliesLoading}
    error={quickRepliesError}
    onInsert={(body) => {
      insertDraftText(body);
      setShowQuickReplies(false);
    }}
    onCreate={async (input) => {
      const created = await apiCreateQuickReply(getToken, input);
      setQuickReplies((current) => [created, ...current]);
    }}
    onUpdate={async (id, input) => {
      const updated = await apiUpdateQuickReply(getToken, id, input);
      setQuickReplies((current) => current.map((reply) => (reply.id === id ? updated : reply)));
    }}
    onDelete={async (id) => {
      await apiDeleteQuickReply(getToken, id);
      setQuickReplies((current) => current.filter((reply) => reply.id !== id));
    }}
  />
) : null}
```

- [ ] **Step 6: Add styles**

Add to `apps/web/src/app/styles.css`:

```css
.quick-replies-popover {
  position: absolute;
  right: 16px;
  bottom: 118px;
  width: min(460px, calc(100vw - 32px));
  max-height: 520px;
  overflow: auto;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 20px 50px rgba(30, 45, 39, 0.16);
  padding: 12px;
  z-index: 20;
}

.quick-replies-header,
.quick-reply-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quick-replies-header {
  justify-content: space-between;
  margin-bottom: 10px;
}

.quick-replies-search,
.quick-reply-form input,
.quick-reply-form textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font: inherit;
}

.quick-replies-list {
  display: grid;
  gap: 8px;
  margin: 12px 0;
}

.quick-reply-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
}

.quick-reply-insert {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  text-align: left;
  display: grid;
  gap: 4px;
  cursor: pointer;
}

.quick-reply-insert span {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-reply-form {
  display: grid;
  gap: 8px;
}
```

- [ ] **Step 7: Verify web quick replies**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/features/inbox/InboxPage.test.tsx
pnpm --filter @prymeira-talk/web build
```

Expected: tests and build pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/api.ts apps/web/src/features/inbox/QuickRepliesPopover.tsx apps/web/src/features/inbox/InboxPage.tsx apps/web/src/features/inbox/InboxPage.test.tsx apps/web/src/app/styles.css
git commit -m "Add inbox quick replies"
```

---

### Task 4: Automation Flow Validation in API

**Files:**
- Modify: `apps/api/src/modules/automations/automations.service.ts`
- Modify: `apps/api/src/modules/automations/automations.routes.ts`
- Modify: `apps/api/src/modules/automations/automations.service.test.ts`

- [ ] **Step 1: Add failing API tests for graph actions**

Append to `apps/api/src/modules/automations/automations.service.test.ts`:

```ts
it("rejects enabling an automation with a coming soon flow block", async () => {
  const prisma = createPrisma({
    automationRule: {
      findFirst: vi.fn().mockResolvedValue(baseAutomation)
    }
  });
  const service = createAutomationsService(prisma);

  await expect(
    service.updateAutomation({
      workspaceId,
      automationId,
      data: {
        status: "enabled",
        actions: {
          version: 1,
          nodes: [
            {
              id: "trigger-1",
              type: "trigger_first_message",
              position: { x: 0, y: 0 },
              data: { title: "Primeira mensagem", config: {} }
            },
            {
              id: "ai-1",
              type: "ai_classify_message",
              position: { x: 240, y: 0 },
              data: { title: "Classificar", config: {} }
            }
          ],
          edges: [{ id: "edge-1", source: "trigger-1", target: "ai-1" }]
        }
      }
    })
  ).rejects.toMatchObject({ code: "AUTOMATION_INVALID_FLOW" });
});

it("simulates graph nodes in manual test runs", async () => {
  const rule = {
    ...baseAutomation,
    actions: {
      version: 1,
      nodes: [
        {
          id: "trigger-1",
          type: "trigger_first_message",
          position: { x: 0, y: 0 },
          data: { title: "Primeira mensagem", config: {} }
        },
        {
          id: "message-1",
          type: "send_message",
          position: { x: 260, y: 0 },
          data: { title: "Enviar mensagem", config: { text: "Ola!" } }
        }
      ],
      edges: [{ id: "edge-1", source: "trigger-1", target: "message-1" }]
    }
  };
  const prisma = createPrisma({
    automationRule: {
      findFirst: vi.fn().mockResolvedValue(rule)
    },
    automationRun: {
      upsert: vi.fn().mockImplementation(async (args) => ({
        id: "run-1",
        workspaceId,
        ruleId: automationId,
        eventKey: args.create.eventKey,
        status: args.create.status,
        input: args.create.input,
        result: args.create.result,
        createdAt: new Date("2026-05-24T12:00:00.000Z"),
        updatedAt: new Date("2026-05-24T12:00:00.000Z")
      }))
    }
  });
  const service = createAutomationsService(prisma);

  const run = await service.testAutomation({ workspaceId, automationId });

  expect(run.result).toMatchObject({
    mode: "simulated",
    runner: "graph",
    actionResults: [
      { nodeId: "trigger-1", type: "trigger_first_message", status: "completed" },
      { nodeId: "message-1", type: "send_message", status: "completed" }
    ]
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/automations/automations.service.test.ts
```

Expected: fail because graph validation and graph run simulation are not implemented.

- [ ] **Step 3: Implement service validation and graph simulation**

Modify `apps/api/src/modules/automations/automations.service.ts`:

```ts
import {
  automationFlowSchema,
  getAutomationBlock,
  validateAutomationFlowForStatus
} from "@prymeira-talk/shared";
```

Update `AutomationsServiceError` code union:

```ts
public code: "AUTOMATION_NOT_FOUND" | "AUTOMATION_INVALID_FLOW",
```

Add helpers:

```ts
function parseFlow(actions: unknown) {
  const parsed = automationFlowSchema.safeParse(actions);
  return parsed.success ? parsed.data : null;
}

function assertValidFlow(actions: unknown, status: AutomationStatus) {
  const flow = parseFlow(actions);
  if (!flow) return;

  const validation = validateAutomationFlowForStatus(flow, status);
  if (!validation.success) {
    throw new AutomationsServiceError("AUTOMATION_INVALID_FLOW", validation.errors.join(" "));
  }
}

function buildGraphActionResults(rule: AutomationRuleRecord) {
  const flow = parseFlow(rule.actions);
  if (!flow) {
    return buildLocalActionResults(rule);
  }

  return flow.nodes.map((node) => ({
    nodeId: node.id,
    type: node.type,
    label: getAutomationBlock(node.type)?.label ?? node.type,
    status: "completed",
    mode: "simulated"
  }));
}
```

In `createAutomation`, call:

```ts
assertValidFlow(input.actions, input.status ?? "disabled");
```

before `prisma.automationRule.create`.

In `updateAutomation`, determine next status:

```ts
const currentRule = await findRuleForWorkspace(input);
const nextStatus = input.data.status ?? currentRule.status;
assertValidFlow(input.data.actions ?? currentRule.actions, nextStatus);
```

Use `currentRule` instead of calling `findRuleForWorkspace` without storing.

In `testAutomation`, change result:

```ts
const flow = parseFlow(rule.actions);
const result = {
  mode: "simulated",
  runner: flow ? "graph" : "local",
  actionResults: buildGraphActionResults(rule)
};
```

- [ ] **Step 4: Update route schemas for graph actions**

In `apps/api/src/modules/automations/automations.routes.ts`, change body schemas so `actions` accepts any JSON object or array:

```ts
actions: z.union([z.array(actionSchema), z.record(z.string(), z.unknown())]).optional()
```

Apply the same through `createAutomationBodySchema.partial()`.

- [ ] **Step 5: Verify API automation tests**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/automations/automations.service.test.ts
pnpm --filter @prymeira-talk/api build
```

Expected: tests and build pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/automations/automations.service.ts apps/api/src/modules/automations/automations.routes.ts apps/api/src/modules/automations/automations.service.test.ts
git commit -m "Support automation flow definitions"
```

---

### Task 5: Install React Flow and Add UI Flow Helpers

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/features/automations/automationFlow.ts`
- Modify: `apps/web/src/features/automations/AutomationsPage.test.tsx`

- [ ] **Step 1: Install React Flow**

Run:

```bash
pnpm --filter @prymeira-talk/web add @xyflow/react
```

Expected: `apps/web/package.json` and `pnpm-lock.yaml` update.

- [ ] **Step 2: Add failing helper tests**

Append to `apps/web/src/features/automations/AutomationsPage.test.tsx`:

```ts
import {
  createAutomationNode,
  createDefaultAutomationFlow,
  flowToAutomationPayload
} from "./automationFlow";

describe("automation flow helpers", () => {
  it("creates a default flow with a trigger node", () => {
    const flow = createDefaultAutomationFlow();
    expect(flow.nodes[0]).toMatchObject({ type: "trigger_first_message" });
    expect(flow.version).toBe(1);
  });

  it("creates node data from the shared block catalog", () => {
    const node = createAutomationNode("send_message", { x: 100, y: 120 });
    expect(node).toMatchObject({
      type: "send_message",
      position: { x: 100, y: 120 },
      data: { title: "Enviar mensagem" }
    });
  });

  it("converts React Flow state into the API payload", () => {
    const flow = createDefaultAutomationFlow();
    expect(flowToAutomationPayload(flow.nodes, flow.edges)).toEqual(flow);
  });
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/features/automations/AutomationsPage.test.tsx
```

Expected: fail because `automationFlow.ts` does not exist.

- [ ] **Step 4: Implement UI helpers**

Create `apps/web/src/features/automations/automationFlow.ts`:

```ts
import type { Edge, Node, XYPosition } from "@xyflow/react";
import {
  automationBlockCatalog,
  automationFlowSchema,
  getAutomationBlock,
  type AutomationBlockType,
  type AutomationFlowDefinition
} from "@prymeira-talk/shared";

export type AutomationCanvasNode = Node<{
  title: string;
  description: string;
  category: string;
  support: string;
  config: Record<string, unknown>;
}>;

export type AutomationCanvasEdge = Edge;

let nodeCounter = 0;

export function createAutomationNode(type: AutomationBlockType, position: XYPosition): AutomationCanvasNode {
  const block = getAutomationBlock(type);
  if (!block) {
    throw new Error(`Unknown automation block: ${type}`);
  }
  nodeCounter += 1;
  return {
    id: `${type}-${nodeCounter}`,
    type: "automationBlock",
    position,
    data: {
      title: block.label,
      description: block.description,
      category: block.category,
      support: block.support,
      config: {}
    }
  };
}

export function createDefaultAutomationFlow(): AutomationFlowDefinition {
  const trigger = createAutomationNode("trigger_first_message", { x: 80, y: 180 });
  return flowToAutomationPayload([trigger], []);
}

export function flowToAutomationPayload(
  nodes: AutomationCanvasNode[],
  edges: AutomationCanvasEdge[]
): AutomationFlowDefinition {
  const payload = {
    version: 1 as const,
    nodes: nodes.map((node) => {
      const type = node.id.split("-").slice(0, -1).join("-") as AutomationBlockType;
      return {
        id: node.id,
        type,
        position: node.position,
        data: {
          title: node.data.title,
          config: node.data.config ?? {}
        }
      };
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? undefined,
      targetHandle: edge.targetHandle ?? undefined
    }))
  };

  return automationFlowSchema.parse(payload);
}

export function supportedBlockTypes() {
  return automationBlockCatalog;
}
```

- [ ] **Step 5: Verify helper tests**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/features/automations/AutomationsPage.test.tsx
pnpm --filter @prymeira-talk/web build
```

Expected: tests and build pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/features/automations/automationFlow.ts apps/web/src/features/automations/AutomationsPage.test.tsx
git commit -m "Add automation canvas helpers"
```

---

### Task 6: Automation Canvas UI

**Files:**
- Create: `apps/web/src/features/automations/AutomationCanvas.tsx`
- Create: `apps/web/src/features/automations/AutomationNode.tsx`
- Create: `apps/web/src/features/automations/AutomationBlockLibrary.tsx`
- Create: `apps/web/src/features/automations/AutomationNodeInspector.tsx`
- Modify: `apps/web/src/features/automations/AutomationsPage.tsx`
- Modify: `apps/web/src/app/styles.css`

- [ ] **Step 1: Create custom node card**

Create `apps/web/src/features/automations/AutomationNode.tsx`:

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AutomationCanvasNode } from "./automationFlow";

export function AutomationNode({ data, selected }: NodeProps<AutomationCanvasNode>) {
  return (
    <article className={`automation-canvas-node ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="automation-node-title-row">
        <strong>{data.title}</strong>
        {data.support !== "supported" ? <span>{data.support === "coming_soon" ? "Em breve" : "Visual"}</span> : null}
      </div>
      <p>{data.description}</p>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
```

- [ ] **Step 2: Create block library**

Create `apps/web/src/features/automations/AutomationBlockLibrary.tsx`:

```tsx
import type { AutomationBlockType } from "@prymeira-talk/shared";
import { automationBlockCatalog } from "@prymeira-talk/shared";

interface AutomationBlockLibraryProps {
  onSelect: (type: AutomationBlockType) => void;
}

const categoryLabels: Record<string, string> = {
  trigger: "Entrada",
  communication: "Comunicacao",
  decision: "Decisao",
  time: "Tempo",
  crm: "CRM",
  integration: "Integracao",
  control: "Controle"
};

export function AutomationBlockLibrary({ onSelect }: AutomationBlockLibraryProps) {
  const categories = Array.from(new Set(automationBlockCatalog.map((block) => block.category)));
  return (
    <aside className="automation-block-library">
      <h3>Blocos</h3>
      {categories.map((category) => (
        <section key={category}>
          <h4>{categoryLabels[category] ?? category}</h4>
          <div className="automation-block-list">
            {automationBlockCatalog
              .filter((block) => block.category === category)
              .map((block) => (
                <button key={block.type} type="button" onClick={() => onSelect(block.type)}>
                  <strong>{block.label}</strong>
                  <span>{block.description}</span>
                  {block.support !== "supported" ? <small>{block.support === "coming_soon" ? "Em breve" : "Visual"}</small> : null}
                </button>
              ))}
          </div>
        </section>
      ))}
    </aside>
  );
}
```

- [ ] **Step 3: Create node inspector**

Create `apps/web/src/features/automations/AutomationNodeInspector.tsx`:

```tsx
import type { AutomationCanvasNode } from "./automationFlow";

interface AutomationNodeInspectorProps {
  node: AutomationCanvasNode | null;
  onConfigChange: (nodeId: string, config: Record<string, unknown>) => void;
}

export function AutomationNodeInspector({ node, onConfigChange }: AutomationNodeInspectorProps) {
  if (!node) {
    return (
      <aside className="automation-node-inspector">
        <h3>Configuração</h3>
        <p className="list-note">Selecione um bloco para editar.</p>
      </aside>
    );
  }

  const textValue = String(node.data.config.text ?? "");
  const fileName = String(node.data.config.fileName ?? "");
  const tagName = String(node.data.config.tagName ?? "");

  return (
    <aside className="automation-node-inspector">
      <h3>{node.data.title}</h3>
      <p>{node.data.description}</p>
      {node.id.startsWith("send_message") || node.id.startsWith("ask_open_reply") ? (
        <label className="form-field">
          <span>Mensagem</span>
          <textarea
            value={textValue}
            onChange={(event) => onConfigChange(node.id, { ...node.data.config, text: event.target.value })}
          />
        </label>
      ) : null}
      {node.id.startsWith("send_file") || node.id.startsWith("send_image") ? (
        <label className="form-field">
          <span>Arquivo</span>
          <input
            value={fileName}
            onChange={(event) => onConfigChange(node.id, { ...node.data.config, fileName: event.target.value })}
            placeholder="Ex: proposta.pdf"
          />
        </label>
      ) : null}
      {node.id.startsWith("add_tag") || node.id.startsWith("remove_tag") ? (
        <label className="form-field">
          <span>Tag</span>
          <input
            value={tagName}
            onChange={(event) => onConfigChange(node.id, { ...node.data.config, tagName: event.target.value })}
          />
        </label>
      ) : null}
      {node.data.support !== "supported" ? (
        <p className="list-note">Este bloco ainda nao executa em fluxos ativos.</p>
      ) : null}
    </aside>
  );
}
```

- [ ] **Step 4: Create canvas component**

Create `apps/web/src/features/automations/AutomationCanvas.tsx`:

```tsx
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import type { AutomationBlockType } from "@prymeira-talk/shared";
import { AutomationBlockLibrary } from "./AutomationBlockLibrary";
import { AutomationNode } from "./AutomationNode";
import { AutomationNodeInspector } from "./AutomationNodeInspector";
import {
  createAutomationNode,
  createDefaultAutomationFlow,
  flowToAutomationPayload,
  type AutomationCanvasNode
} from "./automationFlow";

const nodeTypes = { automationBlock: AutomationNode };

interface AutomationCanvasProps {
  onChange: (payload: ReturnType<typeof flowToAutomationPayload>) => void;
}

export function AutomationCanvas({ onChange }: AutomationCanvasProps) {
  const defaultFlow = useMemo(() => createDefaultAutomationFlow(), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<AutomationCanvasNode>(
    defaultFlow.nodes.map((node) => ({
      id: node.id,
      type: "automationBlock",
      position: node.position,
      data: {
        title: node.data.title,
        description: "",
        category: "trigger",
        support: "supported",
        config: node.data.config
      }
    }))
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(defaultFlow.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(nodes[0]?.id ?? null);

  function publish(nextNodes = nodes, nextEdges = edges) {
    onChange(flowToAutomationPayload(nextNodes, nextEdges));
  }

  function addBlock(type: AutomationBlockType) {
    const node = createAutomationNode(type, { x: 160 + nodes.length * 60, y: 120 + nodes.length * 40 });
    const nextNodes = [...nodes, node];
    setNodes(nextNodes);
    setSelectedNodeId(node.id);
    publish(nextNodes, edges);
  }

  function connect(connection: Connection) {
    const nextEdges = addEdge(connection, edges);
    setEdges(nextEdges);
    publish(nodes, nextEdges);
  }

  function updateConfig(nodeId: string, config: Record<string, unknown>) {
    const nextNodes = nodes.map((node) =>
      node.id === nodeId ? { ...node, data: { ...node.data, config } } : node
    );
    setNodes(nextNodes);
    publish(nextNodes, edges);
  }

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  return (
    <div className="automation-canvas-shell">
      <AutomationBlockLibrary onSelect={addBlock} />
      <div className="automation-canvas-surface">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(changes) => {
            onNodesChange(changes);
            window.requestAnimationFrame(() => publish());
          }}
          onEdgesChange={onEdgesChange}
          onConnect={connect}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
      <AutomationNodeInspector node={selectedNode} onConfigChange={updateConfig} />
    </div>
  );
}
```

- [ ] **Step 5: Wire canvas into `AutomationsPage.tsx`**

Replace the existing central form editor body with `AutomationCanvas`.

Import:

```tsx
import { AutomationCanvas } from "./AutomationCanvas";
import type { AutomationFlowDefinition } from "@prymeira-talk/shared";
```

Add state:

```tsx
const [flowPayload, setFlowPayload] = useState<AutomationFlowDefinition | null>(null);
```

In `saveAutomation`, change payload:

```ts
const payload = {
  name: form.name,
  trigger: flowPayload?.nodes.find((node) => node.type.startsWith("trigger_"))?.type ?? form.trigger,
  conditions: { summary: form.conditionSummary },
  actions: flowPayload ?? [{ type: form.actionType, label: form.actionLabel }]
};
```

Render in the editor panel:

```tsx
<AutomationCanvas onChange={setFlowPayload} />
```

- [ ] **Step 6: Add canvas styles**

Add to `apps/web/src/app/styles.css`:

```css
.automation-canvas-shell {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 300px;
  min-height: calc(100vh - 180px);
  border-top: 1px solid var(--border);
}

.automation-block-library,
.automation-node-inspector {
  background: #fff;
  border-right: 1px solid var(--border);
  padding: 14px;
  overflow: auto;
}

.automation-node-inspector {
  border-right: 0;
  border-left: 1px solid var(--border);
}

.automation-block-list {
  display: grid;
  gap: 8px;
  margin-bottom: 18px;
}

.automation-block-list button {
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  padding: 10px;
  display: grid;
  gap: 4px;
  cursor: pointer;
}

.automation-block-list span,
.automation-canvas-node p {
  color: var(--muted);
  font-size: 12px;
}

.automation-canvas-surface {
  min-height: 640px;
  background: #f6f8fb;
}

.automation-canvas-node {
  width: 230px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  box-shadow: 0 10px 28px rgba(31, 45, 39, 0.1);
}

.automation-canvas-node.is-selected {
  border-color: var(--brand);
  box-shadow: 0 0 0 2px rgba(47, 93, 80, 0.16);
}

.automation-node-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
```

- [ ] **Step 7: Verify UI build**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/features/automations/AutomationsPage.test.tsx
pnpm --filter @prymeira-talk/web build
```

Expected: tests and build pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/automations apps/web/src/app/styles.css
git commit -m "Add automation canvas UI"
```

---

### Task 7: End-to-End Verification and Browser QA

**Files:**
- No expected source changes unless verification finds defects.

- [ ] **Step 1: Run full tests and builds**

Run:

```bash
pnpm --filter @prymeira-talk/shared test
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/web test
pnpm --filter @prymeira-talk/shared build
pnpm --filter @prymeira-talk/api build
pnpm --filter @prymeira-talk/web build
git diff --check
```

Expected: all commands pass. Vite may still warn about chunk size; that is acceptable if build exits successfully.

- [ ] **Step 2: Start local app**

Run:

```bash
pnpm dev
```

Expected: API and web dev servers start. Use existing ports from project scripts: web on `5176`.

- [ ] **Step 3: Browser QA for inbox quick replies**

Open `http://localhost:5176`.

Check:

- Atendimento page loads.
- Composer has `Mensagens padrão`.
- Popover opens above composer.
- Create a quick reply.
- Click the quick reply.
- Body is inserted into composer, not sent immediately.
- Existing selected conversation details remain visible on the right.

- [ ] **Step 4: Browser QA for automation canvas**

Open Automacoes.

Check:

- Page shows canvas with dotted/grid background.
- `+ Bloco`/library area lists categories.
- Adding blocks creates cards.
- Blocks can connect.
- Inspector edits message text/tag/file name.
- Save persists flow without error.
- Test run creates a run with graph action results.

- [ ] **Step 5: Fix QA defects**

For each defect, add the smallest targeted test when feasible, fix it, and rerun the relevant command from Step 1.

- [ ] **Step 6: Final commit if QA fixes were needed**

```bash
git status --short
git add apps/web/src/features/inbox/QuickRepliesPopover.tsx apps/web/src/features/inbox/InboxPage.tsx apps/web/src/features/automations/AutomationCanvas.tsx apps/web/src/features/automations/AutomationNode.tsx apps/web/src/features/automations/AutomationBlockLibrary.tsx apps/web/src/features/automations/AutomationNodeInspector.tsx apps/web/src/features/automations/AutomationsPage.tsx apps/web/src/app/styles.css apps/api/src/modules/automations/automations.service.ts apps/api/src/modules/automations/automations.routes.ts
git commit -m "Polish automation canvas and quick replies"
```

---

## Self-Review

- Spec coverage: quick replies, block catalog, canvas, graph JSON, validation, simulated run, and testing are each covered by tasks.
- Scope control: real webhook execution is intentionally excluded and remains for the next cut.
- Type consistency: shared `AutomationFlowDefinition` is the source of truth; API and web consume it.
- Red-flag scan: no intentionally vague implementation steps remain.
