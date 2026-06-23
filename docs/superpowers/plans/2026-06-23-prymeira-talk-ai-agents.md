# Prymeira Talk AI Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class autonomous AI agents to Prymeira Talk, callable from automations and controllable from Atendimento with human takeover.

**Architecture:** Build a new `agents` backend module with durable agent config, knowledge sources, conversation sessions, structured runtime execution, tool execution, and auditable runs. Add a supported automation block `run_agent` that calls the runtime, and add conversation-level AI control so humans can assume and later release a conversation. Evolve the existing IA frontend surface into an agents hub while keeping existing Assistant actions available during the transition.

**Tech Stack:** TypeScript, Fastify, Prisma/Postgres, Zod, React/Vite, Vitest, pnpm workspace, existing Prymeira Talk realtime and conversation send services.

---

## Target Repository

```bash
cd "/Users/yohannreimer/Downloads/Locais/prymeira/Prymeira Talk"
git status --short
```

Expected current state before implementation:

```txt
?? tmp/
```

Do not stage or modify `tmp/`.

## Scope Check

This plan implements the approved MVP only:

- autonomous agents as a product module;
- level 2 actions: reply, tags, priority, internal notes, user/department assignment;
- automation block `run_agent`;
- conversation-level human takeover and release;
- prompt/FAQ/text knowledge, with file metadata support and plain text content;
- simulated/Prymeira-managed provider gateway first, with the API shaped for a real provider later.

It does not implement arbitrary webhooks, autonomous campaigns, complex multi-agent routing, or destructive business operations.

## File Map

Create:

- `apps/api/src/modules/agents/agents.service.ts` - CRUD for agents, knowledge sources, sessions, and run listing.
- `apps/api/src/modules/agents/agents.routes.ts` - Fastify routes for agents and knowledge.
- `apps/api/src/modules/agents/agents.service.test.ts` - Backend unit tests for agent and knowledge management.
- `apps/api/src/modules/agents/provider-gateway.ts` - Small AI provider abstraction with a deterministic simulated provider.
- `apps/api/src/modules/agents/provider-gateway.test.ts` - Tests for structured provider output.
- `apps/api/src/modules/agents/agent-runtime.ts` - Loads context, calls provider, validates output, executes tools, logs runs.
- `apps/api/src/modules/agents/agent-runtime.test.ts` - Runtime tests for replies, handoff, and human-block skip.
- `apps/api/src/modules/agents/agent-tool-executor.ts` - Executes allowed level 2 agent tools.
- `apps/api/src/modules/agents/agent-tool-executor.test.ts` - Tool validation and execution tests.
- `apps/api/prisma/migrations/20260623190000_ai_agents/migration.sql` - Prisma migration for agents and AI control.
- `apps/web/src/features/assistant/AgentsPage.tsx` - New agents hub replacing the old simulated-only Assistant screen.
- `apps/web/src/features/assistant/AgentsPage.test.tsx` - Frontend tests for rendering and controls.

Modify:

- `apps/api/prisma/schema.prisma` - Add agent models and conversation AI control fields.
- `packages/shared/src/domain.ts` - Add agent schemas/DTOs, AI control fields, and automation block type.
- `packages/shared/src/domain.test.ts` - Cover schemas.
- `packages/shared/src/automation-flow.ts` - Add `run_agent` block.
- `apps/api/src/app.ts` - Register `agentsRoutes` and pass runtime into automations.
- `apps/api/src/modules/automations/automation-runner.ts` - Add agent runtime dependency and execute `run_agent`.
- `apps/api/src/modules/automations/automations.routes.ts` - Pass agent runtime into runner.
- `apps/api/src/modules/automations/automations.service.test.ts` - Cover `run_agent` validation and simulation result.
- `apps/api/src/modules/conversations/conversations.service.ts` - Add AI control DTO fields and assume/release methods.
- `apps/api/src/modules/conversations/conversations.routes.ts` - Add assume/release actions.
- `apps/api/src/modules/conversations/conversations.service.test.ts` - Cover AI control transitions.
- `apps/web/src/app/api.ts` - Add agent API DTOs/functions and AI control action type.
- `apps/web/src/features/shell/moduleRegistry.ts` - Keep key `ia`, rename label to `Agentes`.
- `apps/web/src/features/shell/TalkSuiteShell.tsx` - Render `AgentsPage` for `ia`.
- `apps/web/src/features/automations/AutomationNodeInspector.tsx` - Configure `run_agent`.
- `apps/web/src/features/automations/AutomationBlockLibrary.tsx` - Show `run_agent`.
- `apps/web/src/features/inbox/InboxPage.tsx` - Show AI control status and assume/release buttons.
- `apps/web/src/features/inbox/InboxPage.test.tsx` - Cover AI status helper/UI guard.

---

### Task 1: Add Shared Schemas And Database Models

**Files:**

- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/domain.test.ts`
- Modify: `packages/shared/src/automation-flow.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260623190000_ai_agents/migration.sql`

- [ ] **Step 1: Write the failing shared domain tests**

Add these tests to `packages/shared/src/domain.test.ts`:

```ts
import {
  aiAgentSchema,
  aiAgentRunSchema,
  aiAgentSessionSchema,
  conversationSchema
} from "./domain.js";

it("accepts AI control fields on conversations", () => {
  const conversation = conversationSchema.parse({
    id: "conversation_1",
    workspaceId: "workspace_a",
    channelId: "channel_1",
    contactId: "contact_1",
    status: "open",
    assignedUserId: null,
    departmentId: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unreadCount: 0,
    priority: "normal",
    aiControlStatus: "human_controlled",
    activeAgentName: "Secretaria IA",
    activeAgentSessionStatus: "paused_by_human",
    handoffReason: null
  });

  expect(conversation.aiControlStatus).toBe("human_controlled");
  expect(conversation.activeAgentName).toBe("Secretaria IA");
});

it("accepts AI agent DTOs", () => {
  const agent = aiAgentSchema.parse({
    id: "agent_1",
    workspaceId: "workspace_a",
    name: "Secretaria IA",
    description: "Atende novos contatos.",
    status: "active",
    providerMode: "prymeira_managed",
    provider: "simulated",
    model: "prymeira-simulated",
    systemPrompt: "Voce atende contatos com clareza.",
    behaviorConfig: {},
    handoffConfig: { confidenceThreshold: 0.55 },
    limitsConfig: { maxMessagesPerSession: 12 },
    allowedActions: ["send_message", "add_tag", "create_internal_note"],
    createdAt: "2026-06-23T18:00:00.000Z",
    updatedAt: "2026-06-23T18:00:00.000Z"
  });

  expect(agent.allowedActions).toContain("send_message");
});

it("accepts AI session and run DTOs", () => {
  expect(
    aiAgentSessionSchema.parse({
      id: "session_1",
      workspaceId: "workspace_a",
      agentId: "agent_1",
      conversationId: "conversation_1",
      status: "handoff_requested",
      messageCount: 3,
      lastRunAt: "2026-06-23T18:00:00.000Z",
      handoffReason: "low_confidence",
      createdAt: "2026-06-23T18:00:00.000Z",
      updatedAt: "2026-06-23T18:00:00.000Z"
    }).status
  ).toBe("handoff_requested");

  expect(
    aiAgentRunSchema.parse({
      id: "run_1",
      workspaceId: "workspace_a",
      agentId: "agent_1",
      sessionId: "session_1",
      conversationId: "conversation_1",
      trigger: "automation",
      input: { messageId: "message_1" },
      output: { reply: "Oi!" },
      actions: [{ type: "send_message" }],
      status: "completed",
      confidence: 0.91,
      errorMessage: null,
      createdAt: "2026-06-23T18:00:00.000Z"
    }).status
  ).toBe("completed");
});
```

- [ ] **Step 2: Run the shared tests and verify they fail**

```bash
pnpm --filter @prymeira-talk/shared test -- domain.test.ts
```

Expected: FAIL because `aiAgentSchema`, `aiAgentSessionSchema`, `aiAgentRunSchema`, and conversation AI fields do not exist yet.

- [ ] **Step 3: Add shared schemas**

In `packages/shared/src/domain.ts`, add these schemas after the message schemas:

```ts
export const aiControlStatusSchema = z.enum(["agent_allowed", "human_controlled"]);
export type AiControlStatus = z.infer<typeof aiControlStatusSchema>;

export const aiAgentStatusSchema = z.enum(["active", "inactive"]);
export type AiAgentStatus = z.infer<typeof aiAgentStatusSchema>;

export const aiProviderModeSchema = z.enum(["prymeira_managed", "workspace_key"]);
export type AiProviderMode = z.infer<typeof aiProviderModeSchema>;

export const aiAgentSessionStatusSchema = z.enum([
  "active",
  "paused_by_human",
  "handoff_requested",
  "closed"
]);
export type AiAgentSessionStatus = z.infer<typeof aiAgentSessionStatusSchema>;

export const aiAgentRunStatusSchema = z.enum([
  "completed",
  "handoff_requested",
  "failed",
  "skipped"
]);
export type AiAgentRunStatus = z.infer<typeof aiAgentRunStatusSchema>;

export const aiAgentAllowedActionSchema = z.enum([
  "send_message",
  "add_tag",
  "remove_tag",
  "change_priority",
  "create_internal_note",
  "assign_user",
  "assign_department",
  "request_handoff"
]);
export type AiAgentAllowedAction = z.infer<typeof aiAgentAllowedActionSchema>;

export const aiAgentSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: aiAgentStatusSchema,
  providerMode: aiProviderModeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string().min(1),
  behaviorConfig: z.record(z.string(), z.unknown()),
  handoffConfig: z.record(z.string(), z.unknown()),
  limitsConfig: z.record(z.string(), z.unknown()),
  allowedActions: z.array(aiAgentAllowedActionSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AiAgentDto = z.infer<typeof aiAgentSchema>;

export const aiKnowledgeSourceSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  type: z.enum(["faq", "text", "file"]),
  title: z.string().min(1),
  content: z.string().nullable(),
  fileUrl: z.string().nullable(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  status: z.enum(["ready", "processing", "failed"]),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AiKnowledgeSourceDto = z.infer<typeof aiKnowledgeSourceSchema>;

export const aiAgentSessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  status: aiAgentSessionStatusSchema,
  messageCount: z.number().int().min(0),
  lastRunAt: z.string().datetime().nullable(),
  handoffReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AiAgentSessionDto = z.infer<typeof aiAgentSessionSchema>;

export const aiAgentRunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  conversationId: z.string().min(1).nullable(),
  trigger: z.enum(["automation", "manual_test"]),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
  actions: z.array(z.record(z.string(), z.unknown())),
  status: aiAgentRunStatusSchema,
  confidence: z.number().min(0).max(1).nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime()
});
export type AiAgentRunDto = z.infer<typeof aiAgentRunSchema>;
```

Extend `conversationSchema` in the same file with:

```ts
  aiControlStatus: aiControlStatusSchema.optional(),
  activeAgentName: z.string().nullable().optional(),
  activeAgentSessionStatus: aiAgentSessionStatusSchema.nullable().optional(),
  handoffReason: z.string().nullable().optional(),
```

- [ ] **Step 4: Add the automation block schema/catalog entry**

In `packages/shared/src/automation-flow.ts`, add `"run_agent"` to `automationBlockTypeSchema` near the AI blocks:

```ts
  "run_agent",
```

Add this catalog item near the AI/integration entries:

```ts
  {
    type: "run_agent",
    category: "integration",
    label: "Executar agente",
    description: "Aciona um agente de IA autonomo nesta conversa.",
    support: "supported"
  },
```

- [ ] **Step 5: Update Prisma schema**

In `apps/api/prisma/schema.prisma`, add these enums after `AutomationStatus`:

```prisma
enum AiAgentStatus {
  active
  inactive
}

enum AiProviderMode {
  prymeira_managed
  workspace_key
}

enum AiKnowledgeSourceType {
  faq
  text
  file
}

enum AiKnowledgeSourceStatus {
  ready
  processing
  failed
}

enum AiAgentSessionStatus {
  active
  paused_by_human
  handoff_requested
  closed
}

enum AiAgentRunStatus {
  completed
  handoff_requested
  failed
  skipped
}

enum AiAgentRunTrigger {
  automation
  manual_test
}

enum AiControlStatus {
  agent_allowed
  human_controlled
}
```

Add these fields to `Conversation`:

```prisma
  aiControlStatus     AiControlStatus @default(agent_allowed) @map("ai_control_status")
  aiControlUpdatedAt  DateTime?       @map("ai_control_updated_at")
  aiControlUpdatedById String?        @map("ai_control_updated_by_id") @db.Uuid
  activeAgentSessionId String?        @map("active_agent_session_id") @db.Uuid
```

Add these models before `AiActionLog`:

```prisma
model AiAgent {
  id             String        @id @default(uuid()) @db.Uuid
  workspaceId    String        @map("workspace_id")
  name           String
  description    String?
  status         AiAgentStatus @default(inactive)
  providerMode   AiProviderMode @default(prymeira_managed) @map("provider_mode")
  provider       String        @default("simulated")
  model          String        @default("prymeira-simulated")
  systemPrompt   String        @map("system_prompt")
  behaviorConfig Json          @default("{}") @map("behavior_config")
  handoffConfig  Json          @default("{}") @map("handoff_config")
  limitsConfig   Json          @default("{}") @map("limits_config")
  allowedActions Json          @default("[]") @map("allowed_actions")
  createdAt      DateTime      @default(now()) @map("created_at")
  updatedAt      DateTime      @updatedAt @map("updated_at")

  knowledgeSources AiKnowledgeSource[]
  sessions         AiAgentSession[]
  runs             AiAgentRun[]

  @@unique([workspaceId, id])
  @@index([workspaceId, status])
  @@map("ai_agents")
}

model AiKnowledgeSource {
  id          String                  @id @default(uuid()) @db.Uuid
  workspaceId String                  @map("workspace_id")
  agentId     String                  @map("agent_id") @db.Uuid
  type        AiKnowledgeSourceType
  title       String
  content     String?
  fileUrl     String?                 @map("file_url")
  fileName    String?                 @map("file_name")
  mimeType    String?                 @map("mime_type")
  status      AiKnowledgeSourceStatus @default(ready)
  metadata    Json                    @default("{}")
  createdAt   DateTime                @default(now()) @map("created_at")
  updatedAt   DateTime                @updatedAt @map("updated_at")

  agent AiAgent @relation(fields: [workspaceId, agentId], references: [workspaceId, id], onDelete: Cascade)

  @@unique([workspaceId, id])
  @@index([workspaceId, agentId])
  @@map("ai_knowledge_sources")
}

model AiAgentSession {
  id             String               @id @default(uuid()) @db.Uuid
  workspaceId    String               @map("workspace_id")
  agentId        String               @map("agent_id") @db.Uuid
  conversationId String               @map("conversation_id") @db.Uuid
  status         AiAgentSessionStatus @default(active)
  messageCount   Int                  @default(0) @map("message_count")
  lastRunAt      DateTime?            @map("last_run_at")
  handoffReason  String?              @map("handoff_reason")
  metadata       Json                 @default("{}")
  createdAt      DateTime             @default(now()) @map("created_at")
  updatedAt      DateTime             @updatedAt @map("updated_at")

  agent AiAgent @relation(fields: [workspaceId, agentId], references: [workspaceId, id], onDelete: Cascade)
  runs  AiAgentRun[]

  @@unique([workspaceId, id])
  @@unique([workspaceId, agentId, conversationId])
  @@index([workspaceId, conversationId, status])
  @@map("ai_agent_sessions")
}

model AiAgentRun {
  id             String            @id @default(uuid()) @db.Uuid
  workspaceId    String            @map("workspace_id")
  agentId        String            @map("agent_id") @db.Uuid
  sessionId      String?           @map("session_id") @db.Uuid
  conversationId String?           @map("conversation_id") @db.Uuid
  trigger        AiAgentRunTrigger
  input          Json              @default("{}")
  contextSummary Json              @default("{}") @map("context_summary")
  knowledgeMatches Json            @default("[]") @map("knowledge_matches")
  model          String
  output         Json              @default("{}")
  confidence     Float?
  actions        Json              @default("[]")
  status         AiAgentRunStatus
  errorMessage   String?           @map("error_message")
  costEstimate   Json              @default("{}") @map("cost_estimate")
  createdAt      DateTime          @default(now()) @map("created_at")

  agent   AiAgent         @relation(fields: [workspaceId, agentId], references: [workspaceId, id], onDelete: Cascade)
  session AiAgentSession? @relation(fields: [workspaceId, sessionId], references: [workspaceId, id], onDelete: SetNull)

  @@unique([workspaceId, id])
  @@index([workspaceId, agentId, createdAt])
  @@index([workspaceId, conversationId, createdAt])
  @@map("ai_agent_runs")
}
```

- [ ] **Step 6: Create the migration SQL**

Create `apps/api/prisma/migrations/20260623190000_ai_agents/migration.sql` with SQL equivalent to the Prisma changes. Use this migration name exactly so plan steps can reference it. The enum/table names generated by Prisma for PostgreSQL should match model/enum names; inspect existing migration style before finalizing.

Include these required ALTER statements for conversations:

```sql
ALTER TYPE "AiControlStatus" ADD VALUE IF NOT EXISTS 'agent_allowed';
```

If the enum does not exist yet, create it instead:

```sql
CREATE TYPE "AiControlStatus" AS ENUM ('agent_allowed', 'human_controlled');
ALTER TABLE "conversations"
  ADD COLUMN "ai_control_status" "AiControlStatus" NOT NULL DEFAULT 'agent_allowed',
  ADD COLUMN "ai_control_updated_at" TIMESTAMP(3),
  ADD COLUMN "ai_control_updated_by_id" UUID,
  ADD COLUMN "active_agent_session_id" UUID;
```

Then add the `CREATE TYPE` statements and `CREATE TABLE` statements for `ai_agents`, `ai_knowledge_sources`, `ai_agent_sessions`, and `ai_agent_runs` matching the Prisma schema.

- [ ] **Step 7: Verify shared and Prisma**

```bash
pnpm --filter @prymeira-talk/shared test -- domain.test.ts
pnpm --filter @prymeira-talk/shared test -- automation-flow
pnpm prisma:generate
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass. If `automation-flow` is not a test file pattern in this package, run:

```bash
pnpm --filter @prymeira-talk/shared test
```

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/domain.ts packages/shared/src/domain.test.ts packages/shared/src/automation-flow.ts apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260623190000_ai_agents/migration.sql
git commit -m "feat: add AI agent data model"
```

---

### Task 2: Add Agent Management Service And Routes

**Files:**

- Create: `apps/api/src/modules/agents/agents.service.ts`
- Create: `apps/api/src/modules/agents/agents.routes.ts`
- Create: `apps/api/src/modules/agents/agents.service.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write service tests**

Create `apps/api/src/modules/agents/agents.service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AgentsServiceError, createAgentsService } from "./agents.service.js";

const now = new Date("2026-06-23T18:00:00.000Z");

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    aiAgent: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000101",
        workspaceId: "workspace_a",
        name: "Secretaria IA",
        description: null,
        status: "inactive",
        providerMode: "prymeira_managed",
        provider: "simulated",
        model: "prymeira-simulated",
        systemPrompt: "Atenda com clareza.",
        behaviorConfig: {},
        handoffConfig: { confidenceThreshold: 0.55 },
        limitsConfig: { maxMessagesPerSession: 12 },
        allowedActions: ["send_message"],
        createdAt: now,
        updatedAt: now
      }),
      update: vi.fn()
    },
    aiKnowledgeSource: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000201",
        workspaceId: "workspace_a",
        agentId: "00000000-0000-4000-8000-000000000101",
        type: "faq",
        title: "Horario",
        content: "Atendemos das 8h as 18h.",
        fileUrl: null,
        fileName: null,
        mimeType: null,
        status: "ready",
        metadata: {},
        createdAt: now,
        updatedAt: now
      })
    },
    ...(overrides as object)
  };
}

describe("createAgentsService", () => {
  it("creates an inactive agent with safe defaults", async () => {
    const prisma = buildPrisma();
    const service = createAgentsService(prisma);

    const agent = await service.createAgent({
      workspaceId: "workspace_a",
      name: "Secretaria IA",
      systemPrompt: "Atenda com clareza."
    });

    expect(agent.status).toBe("inactive");
    expect(agent.allowedActions).toEqual(["send_message"]);
    expect(prisma.aiAgent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_a",
        name: "Secretaria IA",
        providerMode: "prymeira_managed",
        provider: "simulated",
        model: "prymeira-simulated"
      })
    });
  });

  it("rejects activating an agent without send_message permission", async () => {
    const service = createAgentsService(buildPrisma());

    await expect(
      service.updateAgent({
        workspaceId: "workspace_a",
        agentId: "00000000-0000-4000-8000-000000000101",
        data: { status: "active", allowedActions: ["add_tag"] }
      })
    ).rejects.toMatchObject({ code: "AGENT_INVALID_CONFIG" });
  });

  it("creates a knowledge source for an existing agent", async () => {
    const prisma = buildPrisma({
      aiAgent: {
        findFirst: vi.fn().mockResolvedValue({
          id: "00000000-0000-4000-8000-000000000101",
          workspaceId: "workspace_a"
        })
      }
    });
    const service = createAgentsService(prisma);

    const source = await service.createKnowledgeSource({
      workspaceId: "workspace_a",
      agentId: "00000000-0000-4000-8000-000000000101",
      type: "faq",
      title: "Horario",
      content: "Atendemos das 8h as 18h."
    });

    expect(source.status).toBe("ready");
    expect(prisma.aiKnowledgeSource.create).toHaveBeenCalled();
  });

  it("throws when creating knowledge for a missing agent", async () => {
    const service = createAgentsService(buildPrisma());

    await expect(
      service.createKnowledgeSource({
        workspaceId: "workspace_a",
        agentId: "00000000-0000-4000-8000-000000000404",
        type: "text",
        title: "Base",
        content: "Conteudo"
      })
    ).rejects.toBeInstanceOf(AgentsServiceError);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
pnpm --filter @prymeira-talk/api test -- agents.service.test.ts
```

Expected: FAIL because `agents.service.ts` does not exist.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/agents/agents.service.ts`:

```ts
import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AiAgentAllowedAction,
  AiAgentDto,
  AiKnowledgeSourceDto
} from "@prymeira-talk/shared";

type DateLike = Date | string;

type AiAgentRecord = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  providerMode: "prymeira_managed" | "workspace_key";
  provider: string;
  model: string;
  systemPrompt: string;
  behaviorConfig: Prisma.JsonValue;
  handoffConfig: Prisma.JsonValue;
  limitsConfig: Prisma.JsonValue;
  allowedActions: Prisma.JsonValue;
  createdAt: DateLike;
  updatedAt: DateLike;
};

type KnowledgeRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  type: "faq" | "text" | "file";
  title: string;
  content: string | null;
  fileUrl: string | null;
  fileName: string | null;
  mimeType: string | null;
  status: "ready" | "processing" | "failed";
  metadata: Prisma.JsonValue;
  createdAt: DateLike;
  updatedAt: DateLike;
};

type AgentCreateArgs = Parameters<PrismaClient["aiAgent"]["create"]>[0];
type AgentFindManyArgs = Parameters<PrismaClient["aiAgent"]["findMany"]>[0];
type AgentFindFirstArgs = Parameters<PrismaClient["aiAgent"]["findFirst"]>[0];
type AgentUpdateArgs = Parameters<PrismaClient["aiAgent"]["update"]>[0];
type KnowledgeCreateArgs = Parameters<PrismaClient["aiKnowledgeSource"]["create"]>[0];
type KnowledgeFindManyArgs = Parameters<PrismaClient["aiKnowledgeSource"]["findMany"]>[0];

export interface AgentsPrismaLike {
  aiAgent: {
    findMany(args: AgentFindManyArgs): Promise<AiAgentRecord[]>;
    findFirst(args: AgentFindFirstArgs): Promise<Pick<AiAgentRecord, "id" | "workspaceId"> | AiAgentRecord | null>;
    create(args: AgentCreateArgs): Promise<AiAgentRecord>;
    update(args: AgentUpdateArgs): Promise<AiAgentRecord>;
  };
  aiKnowledgeSource: {
    findMany(args: KnowledgeFindManyArgs): Promise<KnowledgeRecord[]>;
    create(args: KnowledgeCreateArgs): Promise<KnowledgeRecord>;
  };
}

export class AgentsServiceError extends Error {
  constructor(
    public code: "AGENT_NOT_FOUND" | "AGENT_INVALID_CONFIG",
    message: string
  ) {
    super(message);
    this.name = "AgentsServiceError";
  }
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function readAllowedActions(value: Prisma.JsonValue): AiAgentAllowedAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AiAgentAllowedAction => typeof item === "string") as AiAgentAllowedAction[];
}

function toRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toAgentDto(record: AiAgentRecord): AiAgentDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description,
    status: record.status,
    providerMode: record.providerMode,
    provider: record.provider,
    model: record.model,
    systemPrompt: record.systemPrompt,
    behaviorConfig: toRecord(record.behaviorConfig),
    handoffConfig: toRecord(record.handoffConfig),
    limitsConfig: toRecord(record.limitsConfig),
    allowedActions: readAllowedActions(record.allowedActions),
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toKnowledgeDto(record: KnowledgeRecord): AiKnowledgeSourceDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    agentId: record.agentId,
    type: record.type,
    title: record.title,
    content: record.content,
    fileUrl: record.fileUrl,
    fileName: record.fileName,
    mimeType: record.mimeType,
    status: record.status,
    metadata: toRecord(record.metadata),
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function validateAgentConfig(input: {
  status?: "active" | "inactive";
  allowedActions?: AiAgentAllowedAction[];
}) {
  if (input.status === "active" && input.allowedActions && !input.allowedActions.includes("send_message")) {
    throw new AgentsServiceError(
      "AGENT_INVALID_CONFIG",
      "Active autonomous agents must be allowed to send messages."
    );
  }
}

export function createAgentsService(prisma: AgentsPrismaLike) {
  async function ensureAgent(input: { workspaceId: string; agentId: string }) {
    const agent = await prisma.aiAgent.findFirst({
      where: { workspaceId: input.workspaceId, id: input.agentId }
    });

    if (!agent) {
      throw new AgentsServiceError("AGENT_NOT_FOUND", "Agent not found.");
    }

    return agent;
  }

  return {
    async listAgents(input: { workspaceId: string }): Promise<AiAgentDto[]> {
      const agents = await prisma.aiAgent.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ createdAt: "asc" }]
      });
      return agents.map(toAgentDto);
    },

    async createAgent(input: {
      workspaceId: string;
      name: string;
      description?: string | null;
      systemPrompt: string;
      allowedActions?: AiAgentAllowedAction[];
    }): Promise<AiAgentDto> {
      const allowedActions = input.allowedActions ?? ["send_message"];
      validateAgentConfig({ status: "inactive", allowedActions });

      const agent = await prisma.aiAgent.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          status: "inactive",
          providerMode: "prymeira_managed",
          provider: "simulated",
          model: "prymeira-simulated",
          systemPrompt: input.systemPrompt.trim(),
          behaviorConfig: {},
          handoffConfig: { confidenceThreshold: 0.55 },
          limitsConfig: { maxMessagesPerSession: 12 },
          allowedActions
        }
      });

      return toAgentDto(agent);
    },

    async updateAgent(input: {
      workspaceId: string;
      agentId: string;
      data: Partial<{
        name: string;
        description: string | null;
        status: "active" | "inactive";
        systemPrompt: string;
        allowedActions: AiAgentAllowedAction[];
      }>;
    }): Promise<AiAgentDto> {
      validateAgentConfig({
        status: input.data.status,
        allowedActions: input.data.allowedActions
      });
      await ensureAgent(input);

      const agent = await prisma.aiAgent.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.agentId
          }
        },
        data: {
          ...(input.data.name ? { name: input.data.name.trim() } : {}),
          ...(input.data.description !== undefined ? { description: input.data.description } : {}),
          ...(input.data.status ? { status: input.data.status } : {}),
          ...(input.data.systemPrompt ? { systemPrompt: input.data.systemPrompt.trim() } : {}),
          ...(input.data.allowedActions ? { allowedActions: input.data.allowedActions } : {})
        }
      });

      return toAgentDto(agent);
    },

    async listKnowledgeSources(input: {
      workspaceId: string;
      agentId: string;
    }): Promise<AiKnowledgeSourceDto[]> {
      await ensureAgent(input);
      const sources = await prisma.aiKnowledgeSource.findMany({
        where: { workspaceId: input.workspaceId, agentId: input.agentId },
        orderBy: [{ createdAt: "asc" }]
      });
      return sources.map(toKnowledgeDto);
    },

    async createKnowledgeSource(input: {
      workspaceId: string;
      agentId: string;
      type: "faq" | "text" | "file";
      title: string;
      content?: string | null;
      fileUrl?: string | null;
      fileName?: string | null;
      mimeType?: string | null;
    }): Promise<AiKnowledgeSourceDto> {
      await ensureAgent(input);
      const source = await prisma.aiKnowledgeSource.create({
        data: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          type: input.type,
          title: input.title.trim(),
          content: input.content?.trim() || null,
          fileUrl: input.fileUrl ?? null,
          fileName: input.fileName ?? null,
          mimeType: input.mimeType ?? null,
          status: "ready",
          metadata: {}
        }
      });
      return toKnowledgeDto(source);
    }
  };
}
```

- [ ] **Step 4: Implement routes**

Create `apps/api/src/modules/agents/agents.routes.ts`:

```ts
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import { AgentsServiceError, createAgentsService } from "./agents.service.js";
import type { AgentsPrismaLike } from "./agents.service.js";

const uuidSchema = z.string().uuid();

const createAgentBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  systemPrompt: z.string().trim().min(10).max(8000),
  allowedActions: z.array(z.enum([
    "send_message",
    "add_tag",
    "remove_tag",
    "change_priority",
    "create_internal_note",
    "assign_user",
    "assign_department",
    "request_handoff"
  ])).optional()
});

const updateAgentBodySchema = createAgentBodySchema.partial().extend({
  status: z.enum(["active", "inactive"]).optional()
}).refine((body) => Object.keys(body).length > 0, "At least one field is required.");

const createKnowledgeBodySchema = z.object({
  type: z.enum(["faq", "text", "file"]),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().max(20000).nullable().optional(),
  fileUrl: z.string().trim().max(1000).nullable().optional(),
  fileName: z.string().trim().max(240).nullable().optional(),
  mimeType: z.string().trim().max(160).nullable().optional()
});

function handleAgentsError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentsServiceError) {
    return reply
      .code(error.code === "AGENT_INVALID_CONFIG" ? 400 : 404)
      .send({ code: error.code, error: error.message });
  }
  throw error;
}

function requireManage(role: Parameters<typeof canPerform>[0], reply: FastifyReply) {
  if (canPerform(role, "automation.manage")) return true;
  reply.code(403).send({
    code: "AGENT_MANAGE_FORBIDDEN",
    error: "Agent management permission required."
  });
  return false;
}

export const agentsRoutes: FastifyPluginAsync = async (app) => {
  const service = createAgentsService(app.prisma as unknown as AgentsPrismaLike);

  app.get("/agents", async (request) =>
    service.listAgents({ workspaceId: request.talk.workspaceId })
  );

  app.post("/agents", async (request, reply) => {
    if (!requireManage(request.talk.role, reply)) return reply;
    const body = createAgentBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid agent request." });

    try {
      const agent = await service.createAgent({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });
      return reply.code(201).send(agent);
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });

  app.patch("/agents/:agentId", async (request, reply) => {
    if (!requireManage(request.talk.role, reply)) return reply;
    const params = z.object({ agentId: uuidSchema }).safeParse(request.params);
    const body = updateAgentBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid agent update request." });
    }

    try {
      return await service.updateAgent({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        data: body.data
      });
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });

  app.get("/agents/:agentId/knowledge", async (request, reply) => {
    const params = z.object({ agentId: uuidSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid knowledge request." });

    try {
      return await service.listKnowledgeSources({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId
      });
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });

  app.post("/agents/:agentId/knowledge", async (request, reply) => {
    if (!requireManage(request.talk.role, reply)) return reply;
    const params = z.object({ agentId: uuidSchema }).safeParse(request.params);
    const body = createKnowledgeBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid knowledge source request." });
    }

    try {
      const source = await service.createKnowledgeSource({
        workspaceId: request.talk.workspaceId,
        agentId: params.data.agentId,
        ...body.data
      });
      return reply.code(201).send(source);
    } catch (error) {
      return handleAgentsError(reply, error);
    }
  });
};
```

- [ ] **Step 5: Register routes**

In `apps/api/src/app.ts`, add:

```ts
import { agentsRoutes } from "./modules/agents/agents.routes.js";
```

Register before `assistantRoutes`:

```ts
  await app.register(agentsRoutes);
```

- [ ] **Step 6: Verify**

```bash
pnpm --filter @prymeira-talk/api test -- agents.service.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/agents/agents.service.ts apps/api/src/modules/agents/agents.routes.ts apps/api/src/modules/agents/agents.service.test.ts apps/api/src/app.ts
git commit -m "feat: add AI agent management API"
```

---

### Task 3: Add Provider Gateway And Agent Tool Executor

**Files:**

- Create: `apps/api/src/modules/agents/provider-gateway.ts`
- Create: `apps/api/src/modules/agents/provider-gateway.test.ts`
- Create: `apps/api/src/modules/agents/agent-tool-executor.ts`
- Create: `apps/api/src/modules/agents/agent-tool-executor.test.ts`

- [ ] **Step 1: Write provider tests**

Create `apps/api/src/modules/agents/provider-gateway.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSimulatedAgentProvider, parseAgentOutput } from "./provider-gateway.js";

describe("provider gateway", () => {
  it("parses valid structured output", () => {
    const output = parseAgentOutput({
      confidence: 0.8,
      reply: "Oi, posso ajudar.",
      actions: [{ type: "add_tag", tagName: "onboarding" }],
      handoff: { required: false, reason: null }
    });

    expect(output.reply).toBe("Oi, posso ajudar.");
    expect(output.actions[0]).toEqual({ type: "add_tag", tagName: "onboarding" });
  });

  it("rejects malformed structured output", () => {
    expect(() => parseAgentOutput({ confidence: 2, actions: "bad" })).toThrow(
      "Invalid agent output."
    );
  });

  it("simulates low confidence when context asks for unknown information", async () => {
    const provider = createSimulatedAgentProvider();
    const result = await provider.generate({
      model: "prymeira-simulated",
      systemPrompt: "Atenda.",
      userPrompt: "nao sei responder",
      context: { messageBody: "nao sei responder" }
    });

    expect(result.confidence).toBeLessThan(0.55);
    expect(result.handoff.required).toBe(true);
  });
});
```

- [ ] **Step 2: Implement provider gateway**

Create `apps/api/src/modules/agents/provider-gateway.ts`:

```ts
import { z } from "zod";

export const agentOutputSchema = z.object({
  confidence: z.number().min(0).max(1),
  reply: z.string().trim().max(4000).nullable().optional(),
  actions: z.array(z.record(z.string(), z.unknown())).default([]),
  handoff: z.object({
    required: z.boolean(),
    reason: z.string().nullable()
  })
});

export type AgentOutput = z.infer<typeof agentOutputSchema>;

export interface AgentProviderInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  context: Record<string, unknown>;
}

export interface AgentProvider {
  generate(input: AgentProviderInput): Promise<AgentOutput>;
}

export function parseAgentOutput(value: unknown): AgentOutput {
  const parsed = agentOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid agent output.");
  }
  return parsed.data;
}

export function createSimulatedAgentProvider(): AgentProvider {
  return {
    async generate(input) {
      const text = `${input.userPrompt} ${String(input.context.messageBody ?? "")}`.toLowerCase();
      if (text.includes("nao sei") || text.includes("não sei") || text.includes("irritado")) {
        return {
          confidence: 0.32,
          reply: "Vou chamar uma pessoa do time para te ajudar melhor.",
          actions: [
            {
              type: "request_handoff",
              reason: text.includes("irritado") ? "repetition_or_irritation" : "low_confidence"
            },
            {
              type: "create_internal_note",
              body: "Agente solicitou handoff automatico."
            }
          ],
          handoff: {
            required: true,
            reason: text.includes("irritado") ? "repetition_or_irritation" : "low_confidence"
          }
        };
      }

      return {
        confidence: 0.86,
        reply: "Oi! Sou a assistente virtual. Posso te ajudar com seu atendimento por aqui.",
        actions: [{ type: "add_tag", tagName: "ia-atendeu" }],
        handoff: { required: false, reason: null }
      };
    }
  };
}
```

- [ ] **Step 3: Write tool executor tests**

Create `apps/api/src/modules/agents/agent-tool-executor.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AgentToolExecutionError, executeAgentActions } from "./agent-tool-executor.js";

function buildPrisma() {
  return {
    tag: {
      upsert: vi.fn().mockResolvedValue({ id: "tag_1", name: "ia-atendeu", color: "#2f5f4f" })
    },
    conversationTag: {
      create: vi.fn().mockResolvedValue({})
    },
    conversation: {
      update: vi.fn().mockResolvedValue({ id: "conversation_1" })
    },
    contactNote: {
      create: vi.fn().mockResolvedValue({ id: "note_1" })
    }
  };
}

describe("executeAgentActions", () => {
  it("executes allowed light actions", async () => {
    const prisma = buildPrisma();
    const results = await executeAgentActions({
      prisma,
      workspaceId: "workspace_a",
      conversationId: "conversation_1",
      contactId: "contact_1",
      allowedActions: ["add_tag", "create_internal_note"],
      actions: [
        { type: "add_tag", tagName: "ia-atendeu" },
        { type: "create_internal_note", body: "Nota da IA." }
      ]
    });

    expect(results).toHaveLength(2);
    expect(prisma.tag.upsert).toHaveBeenCalled();
    expect(prisma.contactNote.create).toHaveBeenCalled();
  });

  it("rejects disallowed actions", async () => {
    await expect(
      executeAgentActions({
        prisma: buildPrisma(),
        workspaceId: "workspace_a",
        conversationId: "conversation_1",
        contactId: "contact_1",
        allowedActions: ["send_message"],
        actions: [{ type: "add_tag", tagName: "blocked" }]
      })
    ).rejects.toBeInstanceOf(AgentToolExecutionError);
  });
});
```

- [ ] **Step 4: Implement tool executor**

Create `apps/api/src/modules/agents/agent-tool-executor.ts`:

```ts
import type { AiAgentAllowedAction } from "@prymeira-talk/shared";

type AgentAction = Record<string, unknown>;

export class AgentToolExecutionError extends Error {
  constructor(
    public code: "TOOL_NOT_ALLOWED" | "TOOL_INVALID_INPUT",
    message: string
  ) {
    super(message);
    this.name = "AgentToolExecutionError";
  }
}

interface ToolPrisma {
  tag: {
    upsert(args: unknown): Promise<{ id: string; name: string; color?: string }>;
  };
  conversationTag: {
    create(args: unknown): Promise<unknown>;
  };
  conversation: {
    update(args: unknown): Promise<unknown>;
  };
  contactNote: {
    create(args: unknown): Promise<unknown>;
  };
}

function readString(action: AgentAction, key: string) {
  const value = action[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ensureAllowed(type: string, allowedActions: AiAgentAllowedAction[]) {
  if (!allowedActions.includes(type as AiAgentAllowedAction)) {
    throw new AgentToolExecutionError("TOOL_NOT_ALLOWED", `Agent tool ${type} is not allowed.`);
  }
}

export async function executeAgentActions(input: {
  prisma: ToolPrisma;
  workspaceId: string;
  conversationId: string;
  contactId: string;
  allowedActions: AiAgentAllowedAction[];
  actions: AgentAction[];
}) {
  const results: Array<{ type: string; status: "completed" }> = [];

  for (const action of input.actions) {
    const type = readString(action, "type");
    if (!type || type === "send_message") continue;

    ensureAllowed(type, input.allowedActions);

    if (type === "add_tag") {
      const tagName = readString(action, "tagName") ?? readString(action, "name");
      if (!tagName) throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Tag name is required.");
      const tag = await input.prisma.tag.upsert({
        where: { workspaceId_name: { workspaceId: input.workspaceId, name: tagName } },
        create: { workspaceId: input.workspaceId, name: tagName, color: "#2f5f4f" },
        update: {}
      });
      await input.prisma.conversationTag.create({
        data: { workspaceId: input.workspaceId, conversationId: input.conversationId, tagId: tag.id }
      }).catch(() => undefined);
      results.push({ type, status: "completed" });
      continue;
    }

    if (type === "change_priority") {
      const priority = readString(action, "priority");
      if (!priority || !["low", "normal", "high"].includes(priority)) {
        throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Valid priority is required.");
      }
      await input.prisma.conversation.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
        data: { priority }
      });
      results.push({ type, status: "completed" });
      continue;
    }

    if (type === "create_internal_note") {
      const body = readString(action, "body");
      if (!body) throw new AgentToolExecutionError("TOOL_INVALID_INPUT", "Note body is required.");
      await input.prisma.contactNote.create({
        data: {
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          conversationId: input.conversationId,
          body,
          createdById: null
        }
      });
      results.push({ type, status: "completed" });
      continue;
    }

    if (type === "request_handoff") {
      await input.prisma.conversation.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
        data: { priority: "high" }
      });
      results.push({ type, status: "completed" });
      continue;
    }

    throw new AgentToolExecutionError("TOOL_INVALID_INPUT", `Agent tool ${type} is not implemented.`);
  }

  return results;
}
```

- [ ] **Step 5: Verify**

```bash
pnpm --filter @prymeira-talk/api test -- provider-gateway.test.ts agent-tool-executor.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/agents/provider-gateway.ts apps/api/src/modules/agents/provider-gateway.test.ts apps/api/src/modules/agents/agent-tool-executor.ts apps/api/src/modules/agents/agent-tool-executor.test.ts
git commit -m "feat: add AI agent provider and tools"
```

---

### Task 4: Add Agent Runtime

**Files:**

- Create: `apps/api/src/modules/agents/agent-runtime.ts`
- Create: `apps/api/src/modules/agents/agent-runtime.test.ts`

- [ ] **Step 1: Write runtime tests**

Create `apps/api/src/modules/agents/agent-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime } from "./agent-runtime.js";
import { createSimulatedAgentProvider } from "./provider-gateway.js";

const now = new Date("2026-06-23T18:00:00.000Z");

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    aiAgent: {
      findFirst: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000101",
        workspaceId: "workspace_a",
        name: "Secretaria IA",
        status: "active",
        providerMode: "prymeira_managed",
        provider: "simulated",
        model: "prymeira-simulated",
        systemPrompt: "Atenda bem.",
        behaviorConfig: {},
        handoffConfig: { confidenceThreshold: 0.55 },
        limitsConfig: { maxMessagesPerSession: 12 },
        allowedActions: ["send_message", "add_tag", "create_internal_note", "request_handoff"]
      })
    },
    aiKnowledgeSource: {
      findMany: vi.fn().mockResolvedValue([
        { title: "Horario", content: "Atendemos das 8h as 18h." }
      ])
    },
    aiAgentSession: {
      upsert: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000301",
        workspaceId: "workspace_a",
        agentId: "00000000-0000-4000-8000-000000000101",
        conversationId: "00000000-0000-4000-8000-000000000401",
        status: "active",
        messageCount: 0,
        lastRunAt: null,
        handoffReason: null,
        createdAt: now,
        updatedAt: now
      }),
      update: vi.fn()
    },
    conversation: {
      findUnique: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000401",
        workspaceId: "workspace_a",
        contactId: "00000000-0000-4000-8000-000000000501",
        aiControlStatus: "agent_allowed",
        contact: { name: "Maria", phone: "5511999999999" },
        channel: { provider: "evolution", providerKey: "instancia" },
        tags: []
      }),
      update: vi.fn()
    },
    message: {
      findUnique: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000601",
        workspaceId: "workspace_a",
        conversationId: "00000000-0000-4000-8000-000000000401",
        body: "Oi",
        createdAt: now,
        conversation: {
          id: "00000000-0000-4000-8000-000000000401",
          workspaceId: "workspace_a",
          contactId: "00000000-0000-4000-8000-000000000501",
          aiControlStatus: "agent_allowed",
          contact: { name: "Maria", phone: "5511999999999" },
          channel: { provider: "evolution", providerKey: "instancia" },
          tags: []
        }
      }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({})
    },
    tag: { upsert: vi.fn().mockResolvedValue({ id: "tag_1", name: "ia-atendeu" }) },
    conversationTag: { create: vi.fn().mockResolvedValue({}) },
    contactNote: { create: vi.fn().mockResolvedValue({}) },
    aiAgentRun: {
      create: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000701",
        status: "completed"
      })
    },
    ...(overrides as object)
  };
}

describe("createAgentRuntime", () => {
  it("runs an agent and stores a completed run", async () => {
    const prisma = buildPrisma();
    const runtime = createAgentRuntime({ prisma, provider: createSimulatedAgentProvider() });

    const result = await runtime.runForMessage({
      workspaceId: "workspace_a",
      agentId: "00000000-0000-4000-8000-000000000101",
      conversationId: "00000000-0000-4000-8000-000000000401",
      messageId: "00000000-0000-4000-8000-000000000601",
      trigger: "automation"
    });

    expect(result.status).toBe("completed");
    expect(prisma.message.create).toHaveBeenCalled();
    expect(prisma.aiAgentRun.create).toHaveBeenCalled();
  });

  it("skips when human controls the conversation", async () => {
    const prisma = buildPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "00000000-0000-4000-8000-000000000401",
          workspaceId: "workspace_a",
          contactId: "00000000-0000-4000-8000-000000000501",
          aiControlStatus: "human_controlled",
          contact: { name: "Maria", phone: "5511999999999" },
          channel: { provider: "evolution", providerKey: "instancia" },
          tags: []
        })
      }
    });
    const runtime = createAgentRuntime({ prisma, provider: createSimulatedAgentProvider() });

    const result = await runtime.runForMessage({
      workspaceId: "workspace_a",
      agentId: "00000000-0000-4000-8000-000000000101",
      conversationId: "00000000-0000-4000-8000-000000000401",
      messageId: "00000000-0000-4000-8000-000000000601",
      trigger: "automation"
    });

    expect(result.status).toBe("skipped");
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement runtime**

Create `apps/api/src/modules/agents/agent-runtime.ts`:

```ts
import type { AiAgentAllowedAction } from "@prymeira-talk/shared";
import { executeAgentActions } from "./agent-tool-executor.js";
import type { AgentProvider } from "./provider-gateway.js";

interface AgentRuntimePrisma {
  aiAgent: { findFirst(args: unknown): Promise<any | null> };
  aiKnowledgeSource: { findMany(args: unknown): Promise<Array<{ title: string; content: string | null }>> };
  aiAgentSession: { upsert(args: unknown): Promise<any>; update(args: unknown): Promise<any> };
  conversation: { findUnique(args: unknown): Promise<any | null>; update(args: unknown): Promise<any> };
  message: { findUnique(args: unknown): Promise<any | null>; findMany(args: unknown): Promise<any[]>; create(args: unknown): Promise<any> };
  tag: { upsert(args: unknown): Promise<any> };
  conversationTag: { create(args: unknown): Promise<any> };
  contactNote: { create(args: unknown): Promise<any> };
  aiAgentRun: { create(args: unknown): Promise<{ id: string; status: string }> };
}

function readAllowedActions(value: unknown): AiAgentAllowedAction[] {
  return Array.isArray(value)
    ? value.filter((item): item is AiAgentAllowedAction => typeof item === "string") as AiAgentAllowedAction[]
    : [];
}

function readThreshold(agent: any) {
  const config = agent.handoffConfig;
  if (typeof config === "object" && config !== null && !Array.isArray(config)) {
    const value = (config as Record<string, unknown>).confidenceThreshold;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0.55;
}

export function createAgentRuntime(input: {
  prisma: AgentRuntimePrisma;
  provider: AgentProvider;
}) {
  return {
    async runForMessage(runInput: {
      workspaceId: string;
      agentId: string;
      conversationId: string;
      messageId: string;
      trigger: "automation" | "manual_test";
      instruction?: string | null;
    }): Promise<{ status: string; runId?: string; message?: string }> {
      const [agent, conversation, message] = await Promise.all([
        input.prisma.aiAgent.findFirst({
          where: {
            workspaceId: runInput.workspaceId,
            id: runInput.agentId,
            status: "active"
          }
        }),
        input.prisma.conversation.findUnique({
          where: { workspaceId_id: { workspaceId: runInput.workspaceId, id: runInput.conversationId } },
          include: {
            contact: { select: { name: true, phone: true } },
            channel: { select: { provider: true, providerKey: true } },
            tags: { include: { tag: true } }
          }
        }),
        input.prisma.message.findUnique({
          where: { workspaceId_id: { workspaceId: runInput.workspaceId, id: runInput.messageId } }
        })
      ]);

      if (!agent || !conversation || !message) {
        const run = await input.prisma.aiAgentRun.create({
          data: {
            workspaceId: runInput.workspaceId,
            agentId: runInput.agentId,
            conversationId: runInput.conversationId,
            trigger: runInput.trigger,
            model: agent?.model ?? "unknown",
            input: runInput,
            status: "failed",
            errorMessage: "Agent, conversation, or message was not found."
          }
        });
        return { status: "failed", runId: run.id };
      }

      if (conversation.aiControlStatus === "human_controlled") {
        const run = await input.prisma.aiAgentRun.create({
          data: {
            workspaceId: runInput.workspaceId,
            agentId: agent.id,
            conversationId: conversation.id,
            trigger: runInput.trigger,
            model: agent.model,
            input: runInput,
            output: {},
            actions: [],
            status: "skipped",
            errorMessage: "Conversation is controlled by a human."
          }
        });
        return { status: "skipped", runId: run.id, message: "Conversation is human controlled." };
      }

      const session = await input.prisma.aiAgentSession.upsert({
        where: {
          workspaceId_agentId_conversationId: {
            workspaceId: runInput.workspaceId,
            agentId: agent.id,
            conversationId: conversation.id
          }
        },
        create: {
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          conversationId: conversation.id,
          status: "active"
        },
        update: { status: "active" }
      });

      const knowledge = await input.prisma.aiKnowledgeSource.findMany({
        where: { workspaceId: runInput.workspaceId, agentId: agent.id, status: "ready" },
        orderBy: [{ createdAt: "asc" }],
        take: 8
      });

      const providerOutput = await input.provider.generate({
        model: agent.model,
        systemPrompt: agent.systemPrompt,
        userPrompt: [runInput.instruction, message.body].filter(Boolean).join("\n\n"),
        context: {
          messageBody: message.body,
          contactName: conversation.contact?.name ?? null,
          contactPhone: conversation.contact?.phone ?? null,
          tags: conversation.tags?.map((item: any) => item.tag?.name).filter(Boolean) ?? [],
          knowledge: knowledge.map((source) => ({ title: source.title, content: source.content }))
        }
      });

      const allowedActions = readAllowedActions(agent.allowedActions);
      const actionResults = await executeAgentActions({
        prisma: input.prisma,
        workspaceId: runInput.workspaceId,
        conversationId: conversation.id,
        contactId: conversation.contactId,
        allowedActions,
        actions: providerOutput.actions
      });

      if (providerOutput.reply && allowedActions.includes("send_message")) {
        await input.prisma.message.create({
          data: {
            workspaceId: runInput.workspaceId,
            conversationId: conversation.id,
            direction: "outbound",
            type: "text",
            body: providerOutput.reply,
            status: "pending",
            sentByUserId: null,
            metadata: { source: "ai_agent", agentId: agent.id }
          }
        });
        await input.prisma.conversation.update({
          where: { workspaceId_id: { workspaceId: runInput.workspaceId, id: conversation.id } },
          data: {
            lastMessageAt: new Date(),
            lastMessagePreview: providerOutput.reply
          }
        });
      }

      const threshold = readThreshold(agent);
      const shouldHandoff = providerOutput.handoff.required || providerOutput.confidence < threshold;
      const runStatus = shouldHandoff ? "handoff_requested" : "completed";

      await input.prisma.aiAgentSession.update({
        where: { workspaceId_id: { workspaceId: runInput.workspaceId, id: session.id } },
        data: {
          status: shouldHandoff ? "handoff_requested" : "active",
          handoffReason: shouldHandoff ? providerOutput.handoff.reason ?? "low_confidence" : null,
          lastRunAt: new Date(),
          messageCount: { increment: 1 }
        }
      });

      const run = await input.prisma.aiAgentRun.create({
        data: {
          workspaceId: runInput.workspaceId,
          agentId: agent.id,
          sessionId: session.id,
          conversationId: conversation.id,
          trigger: runInput.trigger,
          input: runInput,
          contextSummary: {
            contactName: conversation.contact?.name ?? null,
            knowledgeCount: knowledge.length
          },
          knowledgeMatches: knowledge.map((source) => ({ title: source.title })),
          model: agent.model,
          output: providerOutput,
          confidence: providerOutput.confidence,
          actions: actionResults,
          status: runStatus
        }
      });

      return { status: runStatus, runId: run.id };
    }
  };
}
```

- [ ] **Step 3: Verify**

```bash
pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts
git commit -m "feat: add AI agent runtime"
```

---

### Task 5: Add Conversation AI Control

**Files:**

- Modify: `apps/api/src/modules/conversations/conversations.service.ts`
- Modify: `apps/api/src/modules/conversations/conversations.routes.ts`
- Modify: `apps/api/src/modules/conversations/conversations.service.test.ts`
- Modify: `packages/shared/src/domain.ts`

- [ ] **Step 1: Add service tests**

In `apps/api/src/modules/conversations/conversations.service.test.ts`, add tests:

```ts
it("marks a conversation as human controlled", async () => {
  const update = vi.fn().mockResolvedValue({
    ...conversationRecord,
    aiControlStatus: "human_controlled",
    aiControlUpdatedAt: new Date("2026-06-23T18:00:00.000Z")
  });
  const service = createConversationsService(buildPrisma({ conversation: { update } }));

  const result = await service.updateAiControl({
    workspaceId: "workspace_a",
    conversationId,
    status: "human_controlled",
    actorUserId: null
  });

  expect(result.aiControlStatus).toBe("human_controlled");
  expect(update).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ aiControlStatus: "human_controlled" })
  }));
});

it("releases a conversation back to AI", async () => {
  const update = vi.fn().mockResolvedValue({
    ...conversationRecord,
    aiControlStatus: "agent_allowed",
    aiControlUpdatedAt: new Date("2026-06-23T18:00:00.000Z")
  });
  const service = createConversationsService(buildPrisma({ conversation: { update } }));

  const result = await service.updateAiControl({
    workspaceId: "workspace_a",
    conversationId,
    status: "agent_allowed",
    actorUserId: null
  });

  expect(result.aiControlStatus).toBe("agent_allowed");
});
```

Use existing test fixtures in the file. If fixture names differ, adapt only the variable names, keeping expected behavior unchanged.

- [ ] **Step 2: Update DTO mapping**

In `ConversationRecord` in `conversations.service.ts`, add:

```ts
  aiControlStatus?: "agent_allowed" | "human_controlled";
  activeAgentSessionId?: string | null;
```

In `toConversationDto`, add:

```ts
    aiControlStatus: record.aiControlStatus ?? "agent_allowed",
    activeAgentName: null,
    activeAgentSessionStatus: null,
    handoffReason: null,
```

- [ ] **Step 3: Add service method**

Inside the returned object from `createConversationsService`, add:

```ts
    async updateAiControl(input: {
      workspaceId: string;
      conversationId: string;
      status: "agent_allowed" | "human_controlled";
      actorUserId: string | null;
    }): Promise<ConversationDto> {
      const conversation = await prisma.conversation.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.conversationId
          }
        },
        data: {
          aiControlStatus: input.status,
          aiControlUpdatedAt: new Date(),
          aiControlUpdatedById: input.actorUserId
        },
        include: conversationDtoInclude
      });

      return toConversationDto(conversation);
    },
```

- [ ] **Step 4: Add route actions**

In `conversations.routes.ts`, extend `conversationActionBodySchema` with:

```ts
  z.object({
    action: z.literal("assume_ai_control")
  }),
  z.object({
    action: z.literal("release_ai_control")
  }),
```

In the `/conversations/:conversationId/actions` handler, before `service.runConversationAction`, add:

```ts
    if (body.data.action === "assume_ai_control" || body.data.action === "release_ai_control") {
      const conversation = await service.updateAiControl({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId,
        status: body.data.action === "assume_ai_control" ? "human_controlled" : "agent_allowed",
        actorUserId: null
      }).catch((error: unknown) => {
        if (error instanceof ConversationNotFoundError) return null;
        throw error;
      });

      if (!conversation) {
        return reply
          .code(404)
          .send({ code: "CONVERSATION_NOT_FOUND", error: "Conversation not found." });
      }

      app.realtime.publish({
        type: "conversation.updated",
        workspaceId: request.talk.workspaceId,
        payload: conversation
      });

      return { conversation, context: await service.getContactContext({
        workspaceId: request.talk.workspaceId,
        conversationId: params.data.conversationId
      }) };
    }
```

- [ ] **Step 5: Update web API action type**

In `apps/web/src/app/api.ts`, extend `ConversationActionBody`:

```ts
  | { action: "assume_ai_control" }
  | { action: "release_ai_control" };
```

- [ ] **Step 6: Verify**

```bash
pnpm --filter @prymeira-talk/api test -- conversations.service.test.ts
pnpm --filter @prymeira-talk/api typecheck
pnpm --filter @prymeira-talk/web typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/conversations/conversations.service.ts apps/api/src/modules/conversations/conversations.routes.ts apps/api/src/modules/conversations/conversations.service.test.ts apps/web/src/app/api.ts packages/shared/src/domain.ts
git commit -m "feat: add conversation AI control"
```

---

### Task 6: Wire Agents Into Automation Runner

**Files:**

- Modify: `apps/api/src/modules/automations/automation-runner.ts`
- Modify: `apps/api/src/modules/automations/automations.routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/modules/automations/automations.service.test.ts`

- [ ] **Step 1: Add runner test**

In `apps/api/src/modules/automations/automations.service.test.ts` or the existing automation runner test file if present, add:

```ts
it("executes run_agent blocks with the selected agent", async () => {
  const agentRuntime = {
    runForMessage: vi.fn().mockResolvedValue({
      status: "completed",
      runId: "00000000-0000-4000-8000-000000000701"
    })
  };
  const prisma = buildAutomationRunnerPrisma({
    ruleActions: {
      version: 1,
      nodes: [
        {
          id: "trigger",
          type: "trigger_first_message",
          position: { x: 0, y: 0 },
          data: { title: "Primeira mensagem", config: {} }
        },
        {
          id: "agent",
          type: "run_agent",
          position: { x: 200, y: 0 },
          data: {
            title: "Executar agente",
            config: {
              agentId: "00000000-0000-4000-8000-000000000101",
              instruction: "Faca onboarding."
            }
          }
        }
      ],
      edges: [{ id: "edge", source: "trigger", target: "agent" }]
    }
  });
  const runner = createAutomationRunner({ prisma, agentRuntime });

  const runs = await runner.runForInboundMessage({
    workspaceId: "workspace_a",
    messageId: "00000000-0000-4000-8000-000000000601",
    eventKey: "message.received:test"
  });

  expect(agentRuntime.runForMessage).toHaveBeenCalledWith(expect.objectContaining({
    agentId: "00000000-0000-4000-8000-000000000101",
    trigger: "automation"
  }));
  expect(runs[0].status).toBe("completed");
});
```

If the test helpers do not exist, create a focused `automation-runner.agent.test.ts` beside `automation-runner.ts` and build the minimal mock Prisma needed by `runForInboundMessage`.

- [ ] **Step 2: Add runtime interface**

In `automation-runner.ts`, add:

```ts
export interface AutomationRunnerAgentRuntime {
  runForMessage(input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    messageId: string;
    trigger: "automation";
    instruction?: string | null;
  }): Promise<{ status: string; runId?: string; message?: string }>;
}
```

Add to `AutomationRunnerOptions`:

```ts
  agentRuntime?: AutomationRunnerAgentRuntime;
```

- [ ] **Step 3: Execute `run_agent`**

In `executeNode`, before the final skipped return, add:

```ts
  if (node.type === "run_agent") {
    const agentId = configValue(node, ["agentId"]);
    const instruction = configValue(node, ["instruction", "prompt", "message"]);

    if (!agentId) {
      return {
        result: resultFor(node, "failed", { error: "Agent ID is required." }),
        stop: true
      };
    }

    if (!options.agentRuntime) {
      return {
        result: resultFor(node, "failed", { error: "Agent runtime is not configured." }),
        stop: true
      };
    }

    const agentResult = await options.agentRuntime.runForMessage({
      workspaceId: context.message.workspaceId,
      agentId,
      conversationId: context.conversation.id,
      messageId: context.message.id,
      trigger: "automation",
      instruction
    });

    return {
      result: resultFor(node, agentResult.status === "failed" ? "failed" : "completed", {
        message: agentResult.message,
        branch: agentResult.status,
        runId: agentResult.runId
      } as any),
      branch: agentResult.status === "handoff_requested" ? "handoff" : "success"
    };
  }
```

- [ ] **Step 4: Create runtime in app**

In `apps/api/src/app.ts`, import:

```ts
import { createAgentRuntime } from "./modules/agents/agent-runtime.js";
import { createSimulatedAgentProvider } from "./modules/agents/provider-gateway.js";
```

After `evolutionRuntime`, create:

```ts
  const agentRuntime =
    options.prismaEnabled === false
      ? undefined
      : createAgentRuntime({
          prisma: app.prisma as any,
          provider: createSimulatedAgentProvider()
        });
```

Pass it to automations:

```ts
  await app.register(automationsRoutes, { evolution: evolutionRuntime, agentRuntime });
```

- [ ] **Step 5: Update automations routes options**

In `automations.routes.ts`, import `AutomationRunnerAgentRuntime` and update options:

```ts
interface AutomationsRoutesOptions {
  evolution?: AutomationRunnerEvolution;
  agentRuntime?: AutomationRunnerAgentRuntime;
}
```

Pass it into `createAutomationRunner` in both runner creation sites:

```ts
agentRuntime: options.agentRuntime,
```

- [ ] **Step 6: Verify**

```bash
pnpm --filter @prymeira-talk/api test -- automation
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all automation tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/automations/automation-runner.ts apps/api/src/modules/automations/automations.routes.ts apps/api/src/modules/automations/automations.service.test.ts apps/api/src/app.ts
git commit -m "feat: run AI agents from automations"
```

---

### Task 7: Add Web API Functions And Agents Page

**Files:**

- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/shell/moduleRegistry.ts`
- Modify: `apps/web/src/features/shell/TalkSuiteShell.tsx`
- Create: `apps/web/src/features/assistant/AgentsPage.tsx`
- Create: `apps/web/src/features/assistant/AgentsPage.test.tsx`

- [ ] **Step 1: Add API DTO imports and functions**

In `apps/web/src/app/api.ts`, import:

```ts
  aiAgentSchema,
  aiKnowledgeSourceSchema,
  type AiAgentAllowedAction,
  type AiAgentDto,
  type AiKnowledgeSourceDto,
```

Add functions near the Assistant functions:

```ts
export async function apiGetAgents(getToken: TokenGetter): Promise<AiAgentDto[]> {
  return apiRequest("/agents", aiAgentSchema.array(), getToken);
}

export async function apiCreateAgent(
  getToken: TokenGetter,
  body: {
    name: string;
    description?: string | null;
    systemPrompt: string;
    allowedActions?: AiAgentAllowedAction[];
  }
): Promise<AiAgentDto> {
  return apiRequest("/agents", aiAgentSchema, getToken, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export async function apiUpdateAgent(
  getToken: TokenGetter,
  agentId: string,
  body: Partial<{
    name: string;
    description: string | null;
    status: "active" | "inactive";
    systemPrompt: string;
    allowedActions: AiAgentAllowedAction[];
  }>
): Promise<AiAgentDto> {
  return apiRequest(`/agents/${agentId}`, aiAgentSchema, getToken, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}

export async function apiGetAgentKnowledge(
  getToken: TokenGetter,
  agentId: string
): Promise<AiKnowledgeSourceDto[]> {
  return apiRequest(`/agents/${agentId}/knowledge`, aiKnowledgeSourceSchema.array(), getToken);
}

export async function apiCreateAgentKnowledge(
  getToken: TokenGetter,
  agentId: string,
  body: {
    type: "faq" | "text" | "file";
    title: string;
    content?: string | null;
    fileUrl?: string | null;
    fileName?: string | null;
    mimeType?: string | null;
  }
): Promise<AiKnowledgeSourceDto> {
  return apiRequest(`/agents/${agentId}/knowledge`, aiKnowledgeSourceSchema, getToken, {
    method: "POST",
    body: JSON.stringify(body)
  });
}
```

- [ ] **Step 2: Create Agents page**

Create `apps/web/src/features/assistant/AgentsPage.tsx`:

```tsx
import { Bot, Plus, RefreshCw, Save } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useTalkAuth } from "../../app/auth";
import {
  apiCreateAgent,
  apiCreateAgentKnowledge,
  apiGetAgentKnowledge,
  apiGetAgents,
  apiUpdateAgent,
  type AiAgentDto,
  type AiKnowledgeSourceDto
} from "../../app/api";

const defaultPrompt = "Voce e uma secretaria virtual da Prymeira. Atenda com clareza, faca onboarding e responda usando a base cadastrada.";
const defaultAllowedActions = ["send_message", "add_tag", "create_internal_note", "request_handoff"] as const;

export function AgentsPage() {
  const { getToken } = useTalkAuth();
  const [agents, setAgents] = useState<AiAgentDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [knowledge, setKnowledge] = useState<AiKnowledgeSourceDto[]>([]);
  const [name, setName] = useState("Secretaria IA");
  const [systemPrompt, setSystemPrompt] = useState(defaultPrompt);
  const [knowledgeTitle, setKnowledgeTitle] = useState("FAQ inicial");
  const [knowledgeContent, setKnowledgeContent] = useState("Atendemos em horario comercial e encaminhamos casos complexos para o time.");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId]
  );

  async function loadAgents() {
    setIsLoading(true);
    setError(null);
    try {
      const nextAgents = await apiGetAgents(getToken);
      setAgents(nextAgents);
      setSelectedId((current) => current ?? nextAgents[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar agentes.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadAgents();
  }, [getToken]);

  useEffect(() => {
    if (!selectedAgent) return;
    setName(selectedAgent.name);
    setSystemPrompt(selectedAgent.systemPrompt);
    void apiGetAgentKnowledge(getToken, selectedAgent.id)
      .then(setKnowledge)
      .catch(() => setKnowledge([]));
  }, [getToken, selectedAgent]);

  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setNotice(null);
    setError(null);
    try {
      const agent = selectedAgent
        ? await apiUpdateAgent(getToken, selectedAgent.id, { name, systemPrompt })
        : await apiCreateAgent(getToken, {
            name,
            systemPrompt,
            allowedActions: [...defaultAllowedActions]
          });
      setAgents((current) => [agent, ...current.filter((item) => item.id !== agent.id)]);
      setSelectedId(agent.id);
      setNotice("Agente salvo.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel salvar agente.");
    } finally {
      setIsSaving(false);
    }
  }

  async function addKnowledge() {
    if (!selectedAgent) return;
    setIsSaving(true);
    setNotice(null);
    setError(null);
    try {
      const source = await apiCreateAgentKnowledge(getToken, selectedAgent.id, {
        type: "faq",
        title: knowledgeTitle,
        content: knowledgeContent
      });
      setKnowledge((current) => [...current, source]);
      setNotice("Base adicionada ao agente.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel salvar base.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="module-page" aria-label="Agentes">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Agentes</h1>
        </div>
        <div className="module-header-actions">
          <button className="secondary-button" type="button" onClick={() => void loadAgents()}>
            <RefreshCw size={14} />
            Atualizar
          </button>
          <button className="primary-button" type="button" onClick={() => setSelectedId(null)}>
            <Plus size={14} />
            Novo agente
          </button>
        </div>
      </header>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <div className="ops-grid">
        <aside className="module-panel">
          <div className="panel-title-row">
            <h2>Agentes</h2>
            <span>{isLoading ? "Carregando" : `${agents.length} agentes`}</span>
          </div>
          <div className="assistant-log-list">
            {agents.map((agent) => (
              <button
                className="assistant-log-card"
                key={agent.id}
                type="button"
                onClick={() => setSelectedId(agent.id)}
              >
                <span className="assistant-log-header">
                  <span className="status-badge status-badge--bot">{agent.status}</span>
                  <span>{agent.model}</span>
                </span>
                <strong>{agent.name}</strong>
              </button>
            ))}
          </div>
        </aside>

        <form className="module-panel module-form" onSubmit={(event) => void saveAgent(event)}>
          <div className="panel-title-row">
            <h2>{selectedAgent ? selectedAgent.name : "Novo agente"}</h2>
            <span className="status-badge status-badge--bot">Autonomo nivel 2</span>
          </div>
          <label className="form-field">
            Nome
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label className="form-field">
            Prompt do agente
            <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} required />
          </label>
          <button className="primary-button" type="submit" disabled={isSaving}>
            <Save size={16} />
            Salvar agente
          </button>
        </form>

        <aside className="module-panel module-form">
          <div className="panel-title-row">
            <h2>Base de conhecimento</h2>
            <Bot size={16} />
          </div>
          <label className="form-field">
            Titulo
            <input value={knowledgeTitle} onChange={(event) => setKnowledgeTitle(event.target.value)} />
          </label>
          <label className="form-field">
            Conteudo
            <textarea value={knowledgeContent} onChange={(event) => setKnowledgeContent(event.target.value)} />
          </label>
          <button className="secondary-button" type="button" disabled={!selectedAgent || isSaving} onClick={() => void addKnowledge()}>
            Adicionar base
          </button>
          <div className="assistant-log-list">
            {knowledge.map((source) => (
              <article className="assistant-log-card" key={source.id}>
                <strong>{source.title}</strong>
                <span>{source.type}</span>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Wire shell**

In `moduleRegistry.ts`, change the `ia` label:

```ts
{
  key: "ia",
  label: "Agentes",
  Icon: Sparkles
},
```

In `TalkSuiteShell.tsx`, replace the Assistant import/render with `AgentsPage`. Keep the route key `ia`.

- [ ] **Step 4: Write frontend test**

Create `apps/web/src/features/assistant/AgentsPage.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentsPage } from "./AgentsPage";

vi.mock("../../app/auth", () => ({
  useTalkAuth: () => ({ getToken: async () => "token" })
}));

vi.mock("../../app/api", () => ({
  apiGetAgents: async () => [],
  apiCreateAgent: vi.fn(),
  apiUpdateAgent: vi.fn(),
  apiGetAgentKnowledge: async () => [],
  apiCreateAgentKnowledge: vi.fn()
}));

describe("AgentsPage", () => {
  it("renders the agents module", async () => {
    render(<AgentsPage />);
    expect(await screen.findByRole("heading", { name: "Agentes" })).toBeInTheDocument();
    expect(screen.getByText("Autonomo nivel 2")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Verify**

```bash
pnpm --filter @prymeira-talk/web test -- AgentsPage.test.tsx
pnpm --filter @prymeira-talk/web typecheck
pnpm --filter @prymeira-talk/web build
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/api.ts apps/web/src/features/shell/moduleRegistry.ts apps/web/src/features/shell/TalkSuiteShell.tsx apps/web/src/features/assistant/AgentsPage.tsx apps/web/src/features/assistant/AgentsPage.test.tsx
git commit -m "feat: add agents web module"
```

---

### Task 8: Add Automation Builder Support For `run_agent`

**Files:**

- Modify: `apps/web/src/features/automations/AutomationNodeInspector.tsx`
- Modify: `apps/web/src/features/automations/AutomationsPage.tsx`
- Modify: `apps/web/src/features/automations/AutomationsPage.test.tsx`

- [ ] **Step 1: Load agents on Automations page**

In `AutomationsPage.tsx`, import `apiGetAgents` and `AiAgentDto`. Add state:

```ts
const [agents, setAgents] = useState<AiAgentDto[]>([]);
```

In the existing load effect, load agents with the other resources:

```ts
const [nextAutomations, nextAgents] = await Promise.all([
  apiGetAutomations(getToken),
  apiGetAgents(getToken).catch(() => [])
]);
setAutomations(nextAutomations);
setAgents(nextAgents);
```

Pass `agents={agents}` to `AutomationNodeInspector`.

- [ ] **Step 2: Add inspector controls**

In `AutomationNodeInspector.tsx`, add prop:

```ts
agents: AiAgentDto[];
```

For `selectedNode.type === "run_agent"`, render:

```tsx
<label className="form-field">
  Agente
  <select
    value={String(config.agentId ?? "")}
    onChange={(event) => updateConfig("agentId", event.target.value)}
  >
    <option value="">Selecione um agente</option>
    {agents.map((agent) => (
      <option key={agent.id} value={agent.id}>
        {agent.name}
      </option>
    ))}
  </select>
</label>
<label className="form-field">
  Instrucao desta etapa
  <textarea
    value={String(config.instruction ?? "")}
    onChange={(event) => updateConfig("instruction", event.target.value)}
    aria-label="Instrucao desta etapa"
  />
</label>
```

Use the file's existing `updateConfig` helper name. If it has a different name, use that local helper and keep the same data keys: `agentId`, `instruction`.

- [ ] **Step 3: Add frontend test**

In `AutomationsPage.test.tsx`, add a test that the block label appears in the block library:

```tsx
it("shows the run agent automation block", () => {
  render(<AutomationsPage />);
  expect(screen.getByText("Executar agente")).toBeInTheDocument();
});
```

If the page needs API mocks, extend the existing mocks with:

```ts
apiGetAgents: async () => [
  {
    id: "00000000-0000-4000-8000-000000000101",
    workspaceId: "workspace_a",
    name: "Secretaria IA",
    description: null,
    status: "active",
    providerMode: "prymeira_managed",
    provider: "simulated",
    model: "prymeira-simulated",
    systemPrompt: "Atenda.",
    behaviorConfig: {},
    handoffConfig: {},
    limitsConfig: {},
    allowedActions: ["send_message"],
    createdAt: "2026-06-23T18:00:00.000Z",
    updatedAt: "2026-06-23T18:00:00.000Z"
  }
]
```

- [ ] **Step 4: Verify**

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx
pnpm --filter @prymeira-talk/web typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/automations/AutomationNodeInspector.tsx apps/web/src/features/automations/AutomationsPage.tsx apps/web/src/features/automations/AutomationsPage.test.tsx
git commit -m "feat: configure agents in automations"
```

---

### Task 9: Add Atendimento AI Control UI

**Files:**

- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.test.tsx`

- [ ] **Step 1: Add helper tests**

In `InboxPage.test.tsx`, add:

```ts
import { aiControlLabel, aiControlActionLabel } from "./InboxPage";

it("labels AI control states", () => {
  expect(aiControlLabel({ aiControlStatus: "human_controlled" })).toBe("Humano no controle");
  expect(aiControlLabel({ aiControlStatus: "agent_allowed", activeAgentName: "Secretaria IA" })).toBe("IA ativa: Secretaria IA");
  expect(aiControlLabel({ aiControlStatus: "agent_allowed" })).toBe("IA liberada");
});

it("chooses the correct AI control action label", () => {
  expect(aiControlActionLabel({ aiControlStatus: "human_controlled" })).toBe("Liberar IA");
  expect(aiControlActionLabel({ aiControlStatus: "agent_allowed" })).toBe("Assumir");
});
```

- [ ] **Step 2: Add exported helpers**

In `InboxPage.tsx`, add near other exported helpers:

```ts
export function aiControlLabel(conversation: Pick<ConversationDto, "aiControlStatus" | "activeAgentName">) {
  if (conversation.aiControlStatus === "human_controlled") return "Humano no controle";
  if (conversation.activeAgentName) return `IA ativa: ${conversation.activeAgentName}`;
  return "IA liberada";
}

export function aiControlActionLabel(conversation: Pick<ConversationDto, "aiControlStatus">) {
  return conversation.aiControlStatus === "human_controlled" ? "Liberar IA" : "Assumir";
}
```

- [ ] **Step 3: Add action handler**

Inside `InboxPage`, add:

```ts
async function toggleAiControl() {
  if (!selectedConversation) return;
  setMutationError(null);
  try {
    const result = await apiRunConversationAction(getToken, selectedConversation.id, {
      action: selectedConversation.aiControlStatus === "human_controlled"
        ? "release_ai_control"
        : "assume_ai_control"
    });
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === result.conversation.id ? result.conversation : conversation
      )
    );
  } catch (actionError) {
    setMutationError(mutationErrorMessage(actionError, "Nao foi possivel alterar controle da IA."));
  }
}
```

Use the file's existing mutation error state names. If the names differ, map the same behavior into the current state variables.

- [ ] **Step 4: Render the header controls**

Near the selected conversation header, render:

```tsx
{selectedConversation ? (
  <div className="conversation-ai-control" aria-label="Controle da IA">
    <span className="status-badge status-badge--bot">
      {aiControlLabel(selectedConversation)}
    </span>
    <button className="secondary-button" type="button" onClick={() => void toggleAiControl()}>
      {aiControlActionLabel(selectedConversation)}
    </button>
  </div>
) : null}
```

- [ ] **Step 5: Verify**

```bash
pnpm --filter @prymeira-talk/web test -- InboxPage.test.tsx
pnpm --filter @prymeira-talk/web typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/inbox/InboxPage.tsx apps/web/src/features/inbox/InboxPage.test.tsx
git commit -m "feat: add inbox AI control"
```

---

### Task 10: End-To-End Verification And Demo Seed

**Files:**

- Modify: `apps/api/prisma/seed-demo.ts`
- Modify: `README.md`

- [ ] **Step 1: Seed a demo agent**

In `apps/api/prisma/seed-demo.ts`, after workspace setup, add:

```ts
const demoAgent = await prisma.aiAgent.upsert({
  where: {
    workspaceId_id: {
      workspaceId,
      id: "70000000-0000-4000-8000-000000000001"
    }
  },
  create: {
    id: "70000000-0000-4000-8000-000000000001",
    workspaceId,
    name: "Secretaria IA",
    description: "Agente autonomo de onboarding e triagem.",
    status: "active",
    providerMode: "prymeira_managed",
    provider: "simulated",
    model: "prymeira-simulated",
    systemPrompt: "Voce e a Secretaria IA da Prymeira Talk. Responda com clareza e encaminhe quando nao souber.",
    behaviorConfig: {},
    handoffConfig: { confidenceThreshold: 0.55 },
    limitsConfig: { maxMessagesPerSession: 12 },
    allowedActions: ["send_message", "add_tag", "create_internal_note", "request_handoff"]
  },
  update: {
    status: "active",
    systemPrompt: "Voce e a Secretaria IA da Prymeira Talk. Responda com clareza e encaminhe quando nao souber.",
    allowedActions: ["send_message", "add_tag", "create_internal_note", "request_handoff"]
  }
});

await prisma.aiKnowledgeSource.upsert({
  where: {
    workspaceId_id: {
      workspaceId,
      id: "71000000-0000-4000-8000-000000000001"
    }
  },
  create: {
    id: "71000000-0000-4000-8000-000000000001",
    workspaceId,
    agentId: demoAgent.id,
    type: "faq",
    title: "Horario de atendimento",
    content: "Atendemos em horario comercial e encaminhamos demandas complexas para o time.",
    status: "ready",
    metadata: {}
  },
  update: {
    content: "Atendemos em horario comercial e encaminhamos demandas complexas para o time.",
    status: "ready"
  }
});
```

Use the local variable name for workspace ID that exists in the seed file. If the seed loops over workspaces, run this once per demo workspace.

- [ ] **Step 2: Update README checklist**

In `README.md`, add to the suite verification checklist:

```md
- Agentes can create a Secretaria IA, add FAQ knowledge, and appear in Automacoes;
- Automacoes can run an "Executar agente" block in manual simulation;
- Atendimento can Assumir and Liberar IA for a conversation.
```

- [ ] **Step 3: Run full automated verification**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @prymeira-talk/api seed:demo
```

Expected: all pass. If the local database is not running, start it first:

```bash
docker compose -f docker-compose.dev.yml up -d
```

- [ ] **Step 4: Manual verification**

Start the app:

```bash
pnpm dev
```

Open `http://localhost:5176` with local bypass enabled. Verify:

- `Agentes` opens and lists `Secretaria IA`;
- adding FAQ knowledge succeeds;
- Automacoes shows `Executar agente`;
- a first-message automation can select `Secretaria IA`;
- manual automation simulation records a run;
- Atendimento shows AI status for the conversation;
- clicking `Assumir` changes the status to human controlled;
- sending another inbound simulation does not create an AI reply;
- clicking `Liberar IA` returns the status to AI allowed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/seed-demo.ts README.md
git commit -m "docs: add AI agents demo verification"
```

---

## Final Verification

Run:

```bash
git status --short
pnpm test
pnpm typecheck
pnpm build
```

Expected:

- only expected untracked `tmp/` remains;
- all tests pass;
- typecheck passes;
- build passes.

If frontend visual regressions are suspected, start the app and verify the three updated surfaces:

- `Agentes`;
- `Automacoes`;
- `Atendimento`.

## Self-Review

Spec coverage:

- First-class Agents module: Tasks 1, 2, 7.
- Autonomous level 2 agent runtime: Tasks 3, 4.
- Automation `Executar agente`: Tasks 1, 6, 8.
- Human takeover/release: Tasks 5, 9.
- Hybrid knowledge: Tasks 1, 2, 7, 10.
- Provider gateway: Tasks 3, 4.
- Auditable run logs: Tasks 1, 4.
- Guardrails and tests: Tasks 3, 4, 5, 6, 10.

No unresolved gaps are intentionally left in this plan. The only implementation choice deferred to execution is fitting snippets into the exact local test helpers where files already have helper names; the expected behavior, data shape, and commands are explicit.
