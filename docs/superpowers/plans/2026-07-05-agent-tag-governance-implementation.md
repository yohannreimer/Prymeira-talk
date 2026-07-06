# Agent Tag Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build global tag governance so each AI agent can only apply selected workspace tags, while internal notes remain free-form context.

**Architecture:** Add a global tag catalog with `useGuide` and `isActive`, link agents to permitted tags through a join table, expose tag catalog APIs, pass permitted tags into the agent harness, and validate agent `add_tag` actions against that allowed catalog. Frontend changes add a global tag manager and an agent-level selector; existing inbox tag display and note display remain mostly unchanged.

**Tech Stack:** Prisma, Fastify, Zod, Vitest, React, Vite, TypeScript, pnpm.

---

## File Structure

- Modify `apps/api/prisma/schema.prisma`: extend `Tag`, add `AiAgentAllowedTag`, and wire relations.
- Modify `packages/shared/src/domain.ts`: add `tagSchema`, `agentAllowedTagSchema`, and `allowedTags` on `aiAgentSchema`.
- Modify `packages/shared/src/domain.test.ts`: verify shared schemas parse tag catalog and agent allowed tags.
- Create `apps/api/src/modules/tags/tags.service.ts`: catalog CRUD and DTO mapping.
- Create `apps/api/src/modules/tags/tags.routes.ts`: authenticated API routes for global tags.
- Create `apps/api/src/modules/tags/tags.service.test.ts`: service and route tests for tag catalog.
- Modify `apps/api/src/app.ts`: register `tagsRoutes`.
- Modify `apps/api/src/modules/agents/agents.service.ts`: include allowed tags on agents and replace agent allowed-tag selections.
- Modify `apps/api/src/modules/agents/agents.routes.ts`: accept `allowedTagIds` on create/update.
- Modify `apps/api/src/modules/agents/agents.service.test.ts`: cover persistence and DTO behavior.
- Modify `apps/api/src/modules/agents/agent-runtime.ts`: load allowed tags, pass them to provider context, and include counts/logs.
- Modify `apps/api/src/modules/agents/agent-test-chat.ts`: load allowed tags and pass them to test harness debug/context.
- Modify `apps/api/src/modules/agents/provider-gateway.ts`: instruct providers to use only `context.allowedTags`.
- Modify `apps/api/src/modules/agents/agent-tool-executor.ts`: validate `add_tag` against allowed tags and apply the canonical tag id.
- Modify tests in `apps/api/src/modules/agents/*test.ts`: update mocks and add coverage for allowed tag behavior.
- Modify `apps/web/src/app/api.ts`: add tag DTOs and tag API helpers; extend agent create/update bodies with `allowedTagIds`.
- Modify `apps/web/src/features/settings/SettingsPage.tsx`: add global tag catalog manager.
- Modify `apps/web/src/features/assistant/AgentsPage.tsx`: add allowed tag selector per agent.
- Modify frontend tests in `apps/web/src/features/settings` and `apps/web/src/features/assistant`.

---

### Task 1: Schema And Shared DTOs

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/domain.test.ts`

- [ ] **Step 1: Write shared schema tests first**

Add tests to `packages/shared/src/domain.test.ts`:

```ts
it("parses workspace tag catalog DTOs", () => {
  const tag = tagSchema.parse({
    id: "tag_1",
    workspaceId: "workspace_a",
    name: "Lead quente",
    color: "#2f6b57",
    useGuide: "Quando o cliente pedir preço, proposta ou demonstração.",
    isActive: true,
    agentCount: 1,
    conversationCount: 3,
    createdAt: "2026-07-05T12:00:00.000Z",
    updatedAt: "2026-07-05T12:00:00.000Z"
  });

  expect(tag.name).toBe("Lead quente");
  expect(tag.useGuide).toContain("preço");
});

it("parses agents with selected allowed tags", () => {
  const agent = aiAgentSchema.parse({
    id: "agent_1",
    workspaceId: "workspace_a",
    name: "Prymeira Vendedora",
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
    allowedTags: [
      {
        id: "tag_1",
        name: "Lead quente",
        color: "#2f6b57",
        useGuide: "Quando o cliente pedir preço, proposta ou demonstração."
      }
    ],
    createdAt: "2026-07-05T12:00:00.000Z",
    updatedAt: "2026-07-05T12:00:00.000Z"
  });

  expect(agent.allowedTags).toEqual([
    expect.objectContaining({ name: "Lead quente" })
  ]);
});
```

- [ ] **Step 2: Run shared tests and confirm failure**

Run:

```bash
pnpm --filter @prymeira-talk/shared test -- src/domain.test.ts
```

Expected: FAIL because `tagSchema` and `allowedTags` do not exist yet.

- [ ] **Step 3: Update Prisma schema**

Edit `apps/api/prisma/schema.prisma`:

```prisma
model Tag {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String   @map("workspace_id")
  name        String
  color       String
  useGuide    String   @default("") @map("use_guide")
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  conversations ConversationTag[]
  allowedAgents AiAgentAllowedTag[]

  @@unique([workspaceId, id])
  @@unique([workspaceId, name])
  @@map("tags")
}

model AiAgent {
  id             String         @id @default(uuid()) @db.Uuid
  workspaceId    String         @map("workspace_id")
  name           String
  description    String?
  status         AiAgentStatus  @default(inactive)
  providerMode   AiProviderMode @default(prymeira_managed) @map("provider_mode")
  provider       String         @default("simulated")
  model          String         @default("prymeira-simulated")
  systemPrompt   String         @map("system_prompt")
  behaviorConfig Json           @default("{}") @map("behavior_config")
  handoffConfig  Json           @default("{}") @map("handoff_config")
  limitsConfig   Json           @default("{}") @map("limits_config")
  allowedActions Json           @default("[]") @map("allowed_actions")
  createdAt      DateTime       @default(now()) @map("created_at")
  updatedAt      DateTime       @updatedAt @map("updated_at")

  knowledgeSources AiKnowledgeSource[]
  sessions         AiAgentSession[]
  runs             AiAgentRun[]
  pendingReplies   AiAgentPendingReply[]
  allowedTags      AiAgentAllowedTag[]

  @@unique([workspaceId, id])
  @@index([workspaceId, status])
  @@map("ai_agents")
}

model AiAgentAllowedTag {
  workspaceId String   @map("workspace_id")
  agentId     String   @map("agent_id") @db.Uuid
  tagId       String   @map("tag_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  agent AiAgent @relation(fields: [workspaceId, agentId], references: [workspaceId, id], onDelete: Cascade)
  tag   Tag     @relation(fields: [workspaceId, tagId], references: [workspaceId, id], onDelete: Cascade)

  @@id([workspaceId, agentId, tagId])
  @@index([workspaceId, tagId])
  @@map("ai_agent_allowed_tags")
}
```

- [ ] **Step 4: Update shared schemas**

Edit `packages/shared/src/domain.ts` near `aiAgentSchema`:

```ts
export const tagSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  useGuide: z.string(),
  isActive: z.boolean(),
  agentCount: z.number().int().min(0).optional(),
  conversationCount: z.number().int().min(0).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type TagDto = z.infer<typeof tagSchema>;

export const agentAllowedTagSchema = tagSchema.pick({
  id: true,
  name: true,
  color: true,
  useGuide: true
});
export type AgentAllowedTagDto = z.infer<typeof agentAllowedTagSchema>;
```

Then add `allowedTags` inside `aiAgentSchema`:

```ts
  allowedActions: z.array(aiAgentAllowedActionSchema),
  allowedTags: z.array(agentAllowedTagSchema).default([]),
```

- [ ] **Step 5: Generate Prisma client and run shared tests**

Run:

```bash
pnpm prisma:generate
pnpm --filter @prymeira-talk/shared test -- src/domain.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit schema and shared DTOs**

```bash
git add apps/api/prisma/schema.prisma packages/shared/src/domain.ts packages/shared/src/domain.test.ts
git commit -m "feat: add governed tag schema"
```

---

### Task 2: Global Tag Catalog API

**Files:**
- Create: `apps/api/src/modules/tags/tags.service.ts`
- Create: `apps/api/src/modules/tags/tags.routes.ts`
- Create: `apps/api/src/modules/tags/tags.service.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write service and route tests**

Create `apps/api/src/modules/tags/tags.service.test.ts`:

```ts
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createTagsService } from "./tags.service.js";
import { tagsRoutes } from "./tags.routes.js";

const now = new Date("2026-07-05T12:00:00.000Z");

function buildPrisma(overrides: Record<string, any> = {}) {
  return {
    tag: {
      findMany: overrides.tag?.findMany ?? vi.fn().mockResolvedValue([]),
      findFirst: overrides.tag?.findFirst ?? vi.fn().mockResolvedValue(null),
      create: overrides.tag?.create ?? vi.fn().mockResolvedValue({
        id: "tag_1",
        workspaceId: "workspace_a",
        name: "Lead quente",
        color: "#2f6b57",
        useGuide: "Quando o cliente pedir preço ou demonstração.",
        isActive: true,
        createdAt: now,
        updatedAt: now,
        _count: { allowedAgents: 0, conversations: 0 }
      }),
      update: overrides.tag?.update ?? vi.fn().mockResolvedValue({
        id: "tag_1",
        workspaceId: "workspace_a",
        name: "Lead quente",
        color: "#2f6b57",
        useGuide: "Quando o cliente pedir preço.",
        isActive: true,
        createdAt: now,
        updatedAt: now,
        _count: { allowedAgents: 1, conversations: 2 }
      })
    },
    ...(overrides as object)
  };
}

describe("createTagsService", () => {
  it("creates a workspace tag with name, color and use guide", async () => {
    const prisma = buildPrisma();
    const service = createTagsService(prisma as any);

    const tag = await service.createTag({
      workspaceId: "workspace_a",
      name: " Lead quente ",
      color: "#2f6b57",
      useGuide: " Quando o cliente pedir preço. "
    });

    expect(tag).toEqual(expect.objectContaining({
      name: "Lead quente",
      useGuide: "Quando o cliente pedir preço.",
      isActive: true
    }));
    expect(prisma.tag.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_a",
        name: "Lead quente",
        color: "#2f6b57",
        useGuide: "Quando o cliente pedir preço.",
        isActive: true
      },
      include: { _count: { select: { allowedAgents: true, conversations: true } } }
    });
  });

  it("lists active and inactive tags with usage counts", async () => {
    const prisma = buildPrisma({
      tag: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "tag_1",
            workspaceId: "workspace_a",
            name: "Lead quente",
            color: "#2f6b57",
            useGuide: "Quando pedir preço.",
            isActive: true,
            createdAt: now,
            updatedAt: now,
            _count: { allowedAgents: 2, conversations: 4 }
          }
        ])
      }
    });
    const service = createTagsService(prisma as any);

    await expect(service.listTags({ workspaceId: "workspace_a" })).resolves.toEqual([
      expect.objectContaining({ agentCount: 2, conversationCount: 4 })
    ]);
  });
});

describe("tagsRoutes", () => {
  it("creates tags through the API", async () => {
    const app = Fastify();
    app.decorate("prisma", buildPrisma());
    app.decorateRequest("talk", null);
    app.addHook("preHandler", async (request) => {
      request.talk = { workspaceId: "workspace_a", role: "owner" } as any;
    });
    await app.register(tagsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/tags",
      payload: {
        name: "Lead quente",
        color: "#2f6b57",
        useGuide: "Quando o cliente pedir preço."
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(expect.objectContaining({ name: "Lead quente" }));
    await app.close();
  });
});
```

- [ ] **Step 2: Run tag tests and confirm failure**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/tags/tags.service.test.ts
```

Expected: FAIL because the tags module does not exist.

- [ ] **Step 3: Implement `tags.service.ts`**

Create `apps/api/src/modules/tags/tags.service.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type { TagDto } from "@prymeira-talk/shared";

type DateLike = Date | string;

type TagRecord = {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  useGuide: string;
  isActive: boolean;
  createdAt: DateLike;
  updatedAt: DateLike;
  _count?: {
    allowedAgents?: number;
    conversations?: number;
  };
};

type TagFindManyArgs = Parameters<PrismaClient["tag"]["findMany"]>[0];
type TagFindFirstArgs = Parameters<PrismaClient["tag"]["findFirst"]>[0];
type TagCreateArgs = Parameters<PrismaClient["tag"]["create"]>[0];
type TagUpdateArgs = Parameters<PrismaClient["tag"]["update"]>[0];

export interface TagsPrismaLike {
  tag: {
    findMany(args: TagFindManyArgs): Promise<TagRecord[]>;
    findFirst(args: TagFindFirstArgs): Promise<TagRecord | null>;
    create(args: TagCreateArgs): Promise<TagRecord>;
    update(args: TagUpdateArgs): Promise<TagRecord>;
  };
}

export class TagsServiceError extends Error {
  constructor(
    public readonly code: "TAG_NOT_FOUND" | "TAG_DUPLICATE" | "TAG_INVALID_INPUT",
    message: string
  ) {
    super(message);
    this.name = "TagsServiceError";
  }
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeColor(color: string) {
  const trimmed = color.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : "#24564a";
}

function toDto(record: TagRecord): TagDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    color: record.color,
    useGuide: record.useGuide,
    isActive: record.isActive,
    agentCount: record._count?.allowedAgents ?? 0,
    conversationCount: record._count?.conversations ?? 0,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

const countInclude = {
  _count: { select: { allowedAgents: true, conversations: true } }
} as const;

export function createTagsService(prisma: TagsPrismaLike) {
  return {
    async listTags(input: { workspaceId: string }): Promise<TagDto[]> {
      const tags = await prisma.tag.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
        include: countInclude
      });

      return tags.map(toDto);
    },

    async createTag(input: {
      workspaceId: string;
      name: string;
      color: string;
      useGuide: string;
    }): Promise<TagDto> {
      const name = input.name.trim();
      const useGuide = input.useGuide.trim();

      if (!name || !useGuide) {
        throw new TagsServiceError("TAG_INVALID_INPUT", "Tag name and usage guide are required.");
      }

      const tag = await prisma.tag.create({
        data: {
          workspaceId: input.workspaceId,
          name,
          color: normalizeColor(input.color),
          useGuide,
          isActive: true
        },
        include: countInclude
      });

      return toDto(tag);
    },

    async updateTag(input: {
      workspaceId: string;
      tagId: string;
      data: Partial<{ name: string; color: string; useGuide: string; isActive: boolean }>;
    }): Promise<TagDto> {
      const existing = await prisma.tag.findFirst({
        where: { workspaceId: input.workspaceId, id: input.tagId }
      });

      if (!existing) {
        throw new TagsServiceError("TAG_NOT_FOUND", "Tag not found.");
      }

      const tag = await prisma.tag.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.tagId } },
        data: {
          ...(input.data.name !== undefined ? { name: input.data.name.trim() } : {}),
          ...(input.data.color !== undefined ? { color: normalizeColor(input.data.color) } : {}),
          ...(input.data.useGuide !== undefined ? { useGuide: input.data.useGuide.trim() } : {}),
          ...(input.data.isActive !== undefined ? { isActive: input.data.isActive } : {})
        },
        include: countInclude
      });

      return toDto(tag);
    }
  };
}
```

- [ ] **Step 4: Implement `tags.routes.ts`**

Create `apps/api/src/modules/tags/tags.routes.ts`:

```ts
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { canPerform } from "../access/roles.js";
import { createTagsService, TagsServiceError, type TagsPrismaLike } from "./tags.service.js";

const uuidSchema = z.string().uuid();

const createTagSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().min(1).max(24),
  useGuide: z.string().trim().min(1).max(1000)
});

const updateTagSchema = createTagSchema.partial().extend({
  isActive: z.boolean().optional()
}).refine((body) => Object.keys(body).length > 0, "At least one tag field is required.");

function requireTagManage(role: Parameters<typeof canPerform>[0], reply: FastifyReply) {
  if (canPerform(role, "automation.manage")) {
    return true;
  }

  reply.code(403).send({
    code: "TAG_MANAGE_FORBIDDEN",
    error: "Tag management permission required."
  });
  return false;
}

function handleTagsError(reply: FastifyReply, error: unknown) {
  if (error instanceof TagsServiceError) {
    return reply.code(error.code === "TAG_NOT_FOUND" ? 404 : 400).send({
      code: error.code,
      error: error.message
    });
  }

  throw error;
}

export const tagsRoutes: FastifyPluginAsync = async (app) => {
  const service = createTagsService(app.prisma as unknown as TagsPrismaLike);

  app.get("/tags", async (request) =>
    service.listTags({ workspaceId: request.talk.workspaceId })
  );

  app.post("/tags", async (request, reply) => {
    if (!requireTagManage(request.talk.role, reply)) return reply;

    const body = createTagSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid tag request." });
    }

    try {
      const tag = await service.createTag({
        workspaceId: request.talk.workspaceId,
        ...body.data
      });
      return reply.code(201).send(tag);
    } catch (error) {
      return handleTagsError(reply, error);
    }
  });

  app.patch("/tags/:tagId", async (request, reply) => {
    if (!requireTagManage(request.talk.role, reply)) return reply;

    const params = z.object({ tagId: uuidSchema }).safeParse(request.params);
    const body = updateTagSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid tag update request." });
    }

    try {
      return await service.updateTag({
        workspaceId: request.talk.workspaceId,
        tagId: params.data.tagId,
        data: body.data
      });
    } catch (error) {
      return handleTagsError(reply, error);
    }
  });
};
```

- [ ] **Step 5: Register routes**

Edit `apps/api/src/app.ts`:

```ts
import { tagsRoutes } from "./modules/tags/tags.routes.js";
```

Register after `teamRoutes` and before `agentsRoutes`:

```ts
  await app.register(teamRoutes);
  await app.register(tagsRoutes);
  await app.register(agentsRoutes);
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/tags/tags.service.test.ts
pnpm --filter @prymeira-talk/api build
```

Expected: PASS.

- [ ] **Step 7: Commit tag catalog API**

```bash
git add apps/api/src/modules/tags apps/api/src/app.ts
git commit -m "feat: add tag catalog api"
```

---

### Task 3: Agent Allowed Tags Persistence

**Files:**
- Modify: `apps/api/src/modules/agents/agents.service.ts`
- Modify: `apps/api/src/modules/agents/agents.routes.ts`
- Modify: `apps/api/src/modules/agents/agents.service.test.ts`

- [ ] **Step 1: Add failing service tests**

Add to `apps/api/src/modules/agents/agents.service.test.ts`:

```ts
it("returns allowed tags on agent DTOs", async () => {
  const prisma = buildPrisma({
    aiAgent: {
      findMany: vi.fn().mockResolvedValue([
        {
          ...baseAgent,
          allowedTags: [
            {
              tag: {
                id: "tag_1",
                name: "Lead quente",
                color: "#2f6b57",
                useGuide: "Quando pedir preço.",
                isActive: true
              }
            }
          ]
        }
      ])
    }
  });
  const service = createAgentsService(prisma as any);

  await expect(service.listAgents({ workspaceId: "workspace_a" })).resolves.toEqual([
    expect.objectContaining({
      allowedTags: [
        {
          id: "tag_1",
          name: "Lead quente",
          color: "#2f6b57",
          useGuide: "Quando pedir preço."
        }
      ]
    })
  ]);
});

it("replaces selected allowed tags when updating an agent", async () => {
  const transaction = vi.fn(async (callback) => callback({
    aiAgentAllowedTag: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 2 })
    }
  }));
  const prisma = buildPrisma({
    $transaction: transaction,
    aiAgent: {
      findFirst: vi.fn().mockResolvedValue(baseAgent),
      update: vi.fn().mockResolvedValue({ ...baseAgent, allowedTags: [] })
    },
    tag: {
      count: vi.fn().mockResolvedValue(2)
    }
  });
  const service = createAgentsService(prisma as any);

  await service.updateAgent({
    workspaceId: "workspace_a",
    agentId: "agent_1",
    data: {
      allowedTagIds: ["tag_1", "tag_2"]
    }
  });

  expect(prisma.tag.count).toHaveBeenCalledWith({
    where: {
      workspaceId: "workspace_a",
      id: { in: ["tag_1", "tag_2"] },
      isActive: true
    }
  });
  expect(transaction).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests and confirm failure**

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/agents/agents.service.test.ts
```

Expected: FAIL because agent DTOs and service input do not support allowed tags yet.

- [ ] **Step 3: Extend `AgentsPrismaLike` and DTO mapping**

In `apps/api/src/modules/agents/agents.service.ts`, add record types:

```ts
type AgentAllowedTagRecord = {
  tag: {
    id: string;
    name: string;
    color: string;
    useGuide: string;
    isActive: boolean;
  };
};
```

Add to `AiAgentRecord`:

```ts
  allowedTags?: AgentAllowedTagRecord[];
```

Add Prisma-like members:

```ts
type AgentAllowedTagDeleteManyArgs = Parameters<PrismaClient["aiAgentAllowedTag"]["deleteMany"]>[0];
type AgentAllowedTagCreateManyArgs = Parameters<PrismaClient["aiAgentAllowedTag"]["createMany"]>[0];
type TagCountArgs = Parameters<PrismaClient["tag"]["count"]>[0];
```

Extend `AgentsPrismaLike`:

```ts
  tag: {
    count(args: TagCountArgs): Promise<number>;
  };
  aiAgentAllowedTag: {
    deleteMany(args: AgentAllowedTagDeleteManyArgs): Promise<{ count: number }>;
    createMany(args: AgentAllowedTagCreateManyArgs): Promise<{ count: number }>;
  };
  $transaction<T>(callback: (tx: Pick<AgentsPrismaLike, "aiAgentAllowedTag">) => Promise<T>): Promise<T>;
```

Update `toAgentDto`:

```ts
    allowedTags:
      record.allowedTags
        ?.filter((item) => item.tag.isActive)
        .map((item) => ({
          id: item.tag.id,
          name: item.tag.name,
          color: item.tag.color,
          useGuide: item.tag.useGuide
        })) ?? [],
```

- [ ] **Step 4: Include allowed tags in agent queries**

In `listAgents`, `ensureAgent`, `createAgent`, and `updateAgent`, include:

```ts
const agentInclude = {
  allowedTags: {
    include: { tag: true },
    orderBy: { tag: { name: "asc" } }
  }
} as const;
```

Use it like:

```ts
const agents = await prisma.aiAgent.findMany({
  where: { workspaceId: input.workspaceId },
  orderBy: [{ createdAt: "asc" }],
  include: agentInclude
});
```

- [ ] **Step 5: Replace allowed tag selections**

Add helper:

```ts
async function replaceAllowedTags(input: {
  workspaceId: string;
  agentId: string;
  tagIds: string[];
}) {
  const uniqueTagIds = [...new Set(input.tagIds)];
  const activeTagCount = uniqueTagIds.length
    ? await prisma.tag.count({
        where: {
          workspaceId: input.workspaceId,
          id: { in: uniqueTagIds },
          isActive: true
        }
      })
    : 0;

  if (activeTagCount !== uniqueTagIds.length) {
    throw new AgentsServiceError("AGENT_INVALID_CONFIG", "Allowed tags must exist and be active.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.aiAgentAllowedTag.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        agentId: input.agentId
      }
    });

    if (uniqueTagIds.length > 0) {
      await tx.aiAgentAllowedTag.createMany({
        data: uniqueTagIds.map((tagId) => ({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          tagId
        }))
      });
    }
  });
}
```

Add `allowedTagIds?: string[]` to create and update input types. After creating or updating the agent, call `replaceAllowedTags` when `allowedTagIds` is provided, then reload the agent through `ensureAgent` and return `toAgentDto(reloaded)`.

- [ ] **Step 6: Update routes**

In `apps/api/src/modules/agents/agents.routes.ts`, add:

```ts
  allowedTagIds: z.array(uuidSchema).max(100).optional()
```

to `createAgentBodySchema`; `updateAgentBodySchema` inherits it through `.partial()`.

- [ ] **Step 7: Run tests**

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/agents/agents.service.test.ts
pnpm --filter @prymeira-talk/api build
```

Expected: PASS.

- [ ] **Step 8: Commit agent allowed tags**

```bash
git add apps/api/src/modules/agents/agents.service.ts apps/api/src/modules/agents/agents.routes.ts apps/api/src/modules/agents/agents.service.test.ts
git commit -m "feat: persist agent allowed tags"
```

---

### Task 4: Harness And Executor Validation

**Files:**
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/agents/agent-test-chat.ts`
- Modify: `apps/api/src/modules/agents/provider-gateway.ts`
- Modify: `apps/api/src/modules/agents/agent-tool-executor.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.test.ts`
- Modify: `apps/api/src/modules/agents/agent-test-chat.test.ts`
- Modify: `apps/api/src/modules/agents/provider-gateway.test.ts`
- Modify: `apps/api/src/modules/agents/agent-tool-executor.test.ts`

- [ ] **Step 1: Add failing executor tests**

Add to `apps/api/src/modules/agents/agent-tool-executor.test.ts`:

```ts
it("applies only canonical allowed agent tags", async () => {
  const prisma = buildPrisma();

  const results = await executeAgentActions(prisma, {
    ...baseInput,
    allowedTags: [
      {
        id: "tag_42",
        name: "Lead quente",
        color: "#2f6b57",
        useGuide: "Quando pedir preço."
      }
    ],
    actions: [{ type: "add_tag", tagName: " lead quente " }]
  });

  expect(results).toEqual([{ type: "add_tag", status: "completed" }]);
  expect(prisma.tag.upsert).not.toHaveBeenCalled();
  expect(prisma.conversationTag.upsert).toHaveBeenCalledWith({
    where: {
      workspaceId_conversationId_tagId: {
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        tagId: "tag_42"
      }
    },
    create: {
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      tagId: "tag_42"
    },
    update: {}
  });
});

it("skips agent tags that are not selected for the agent", async () => {
  const prisma = buildPrisma();

  const results = await executeAgentActions(prisma, {
    ...baseInput,
    allowedTags: [
      {
        id: "tag_42",
        name: "Lead quente",
        color: "#2f6b57",
        useGuide: "Quando pedir preço."
      }
    ],
    actions: [{ type: "add_tag", tagName: "Aguardar comercial" }]
  });

  expect(results).toEqual([
    {
      type: "add_tag",
      status: "skipped",
      reason: "Agent tag Aguardar comercial is not in this agent's allowed tag list."
    }
  ]);
  expect(prisma.conversationTag.upsert).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add failing runtime context test**

Update the first test in `apps/api/src/modules/agents/agent-runtime.test.ts` so `baseAgent` includes:

```ts
  allowedTags: [
    {
      tag: {
        id: "tag_hot",
        name: "Lead quente",
        color: "#2f6b57",
        useGuide: "Quando pedir preço.",
        isActive: true
      }
    }
  ]
```

Expect provider context:

```ts
allowedTags: [
  {
    id: "tag_hot",
    name: "Lead quente",
    color: "#2f6b57",
    useGuide: "Quando pedir preço."
  }
]
```

- [ ] **Step 3: Run targeted tests and confirm failure**

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/agents/agent-tool-executor.test.ts src/modules/agents/agent-runtime.test.ts
```

Expected: FAIL because allowed tags are not loaded or validated yet.

- [ ] **Step 4: Extend executor input and validation**

In `apps/api/src/modules/agents/agent-tool-executor.ts`, add:

```ts
type AllowedAgentTag = {
  id: string;
  name: string;
  color?: string | null;
  useGuide?: string | null;
};
```

Add `allowedTags?: readonly AllowedAgentTag[];` to `executeAgentActions` input.

Add helper:

```ts
function normalizeTagName(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
```

Change `addTag` signature:

```ts
async function addTag(
  prisma: AgentToolExecutorPrismaLike,
  input: {
    workspaceId: string;
    conversationId: string;
    allowedTags?: readonly AllowedAgentTag[];
  },
  action: AgentAction
)
```

Replace the `tag.upsert` block with:

```ts
  const allowedTags = input.allowedTags ?? [];
  const allowedTag = allowedTags.find((tag) => normalizeTagName(tag.name) === normalizeTagName(name));

  if (!allowedTag) {
    throw new AgentToolExecutionError(
      "TOOL_INVALID_INPUT",
      `Agent tag ${name} is not in this agent's allowed tag list.`
    );
  }

  await prisma.conversationTag.upsert({
    where: {
      workspaceId_conversationId_tagId: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        tagId: allowedTag.id
      }
    },
    create: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      tagId: allowedTag.id
    },
    update: {}
  });
```

Keep `tag.upsert` in `AgentToolExecutorTransactionLike` until all tests are updated, then remove it if TypeScript shows it is unused.

- [ ] **Step 5: Load allowed tags in runtime**

In `apps/api/src/modules/agents/agent-runtime.ts`, update the `aiAgent.findFirst` call to include:

```ts
include: {
  allowedTags: {
    include: { tag: true },
    orderBy: { tag: { name: "asc" } }
  }
}
```

Add helper:

```ts
function toAllowedTags(agent: AgentRecord) {
  return (
    agent.allowedTags
      ?.filter((item) => item.tag?.isActive)
      .map((item) => ({
        id: item.tag.id,
        name: item.tag.name,
        color: item.tag.color,
        useGuide: item.tag.useGuide
      })) ?? []
  );
}
```

In `buildContext`, add parameter `allowedTags` and return:

```ts
    allowedTags,
```

When calling `executeAgentActions`, pass:

```ts
allowedTags: toAllowedTags(agent)
```

Add to `contextSummary`:

```ts
allowedTagCount: allowedTags.length
```

- [ ] **Step 6: Update test chat harness**

In `apps/api/src/modules/agents/agent-test-chat.ts`, extend `AgentRecord`:

```ts
  allowedTags?: Array<{
    tag: {
      id: string;
      name: string;
      color: string;
      useGuide: string;
      isActive: boolean;
    };
  }>;
```

Include allowed tags in `aiAgent.findFirst`, convert them with the same `toAllowedTags` helper, add to provider context:

```ts
allowedTags
```

and add debug field:

```ts
allowedTags: allowedTags.map((tag) => tag.name)
```

- [ ] **Step 7: Strengthen provider instructions**

In `apps/api/src/modules/agents/provider-gateway.ts`, update the JSON contract instructions:

```ts
"- for tags use {\"type\":\"add_tag\",\"tagName\":\"...\"} and choose tagName only from context.allowedTags[].name",
"- if context.allowedTags is empty, do not call add_tag",
"- use create_internal_note for conversation-specific details that should not become a reusable tag",
```

Also include `allowedTags` in the human-readable context block:

```ts
const allowedTags = Array.isArray(context.allowedTags) ? context.allowedTags : [];
if (allowedTags.length > 0) {
  sections.push([
    "Allowed tags:",
    ...allowedTags.map((tag) => `- ${tag.name}: ${tag.useGuide}`)
  ].join("\n"));
}
```

- [ ] **Step 8: Run agent tests**

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/agents/agent-tool-executor.test.ts src/modules/agents/agent-runtime.test.ts src/modules/agents/agent-test-chat.test.ts src/modules/agents/provider-gateway.test.ts
pnpm --filter @prymeira-talk/api build
```

Expected: PASS.

- [ ] **Step 9: Commit harness validation**

```bash
git add apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-test-chat.ts apps/api/src/modules/agents/provider-gateway.ts apps/api/src/modules/agents/agent-tool-executor.ts apps/api/src/modules/agents/*test.ts
git commit -m "feat: validate agent tags against allowed catalog"
```

---

### Task 5: Frontend API Helpers

**Files:**
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/app/api.test.ts`

- [ ] **Step 1: Add API parsing tests**

Add to `apps/web/src/app/api.test.ts`:

```ts
it("loads workspace tags", async () => {
  mockFetchJsonOnce([
    {
      id: "tag_1",
      workspaceId: "workspace_a",
      name: "Lead quente",
      color: "#2f6b57",
      useGuide: "Quando pedir preço.",
      isActive: true,
      agentCount: 1,
      conversationCount: 2,
      createdAt: "2026-07-05T12:00:00.000Z",
      updatedAt: "2026-07-05T12:00:00.000Z"
    }
  ]);

  await expect(apiGetTags(async () => "token")).resolves.toEqual([
    expect.objectContaining({ name: "Lead quente" })
  ]);
});
```

Use the existing fetch mock helpers already present in `apps/web/src/app/api.test.ts`; keep the test shape consistent with neighboring API tests.

- [ ] **Step 2: Run tests and confirm failure**

```bash
pnpm --filter @prymeira-talk/web test -- src/app/api.test.ts
```

Expected: FAIL because tag helpers do not exist.

- [ ] **Step 3: Add tag DTO exports and API helpers**

In `apps/web/src/app/api.ts`, import and export:

```ts
  tagSchema,
  type TagDto,
  type AgentAllowedTagDto,
```

Update export line:

```ts
export type { AiAgentAllowedAction, AiAgentDto, AiKnowledgeSourceDto, TagDto, AgentAllowedTagDto } from "@prymeira-talk/shared";
```

Add parser:

```ts
function parseTag(data: unknown): TagDto {
  return tagSchema.parse(data);
}
```

Add helpers:

```ts
export async function apiGetTags(getToken: () => Promise<string | null>): Promise<TagDto[]> {
  return fetchJson(
    getToken,
    "/tags",
    {},
    (data) => (Array.isArray(data) ? data.map(parseTag) : []),
    "Failed to load tags"
  );
}

export async function apiCreateTag(
  getToken: () => Promise<string | null>,
  body: { name: string; color: string; useGuide: string }
): Promise<TagDto> {
  return fetchJson(
    getToken,
    "/tags",
    { method: "POST", body: JSON.stringify(body) },
    parseTag,
    "Failed to create tag"
  );
}

export async function apiUpdateTag(
  getToken: () => Promise<string | null>,
  tagId: string,
  body: Partial<{ name: string; color: string; useGuide: string; isActive: boolean }>
): Promise<TagDto> {
  return fetchJson(
    getToken,
    `/tags/${tagId}`,
    { method: "PATCH", body: JSON.stringify(body) },
    parseTag,
    "Failed to update tag"
  );
}
```

Extend create/update agent bodies:

```ts
allowedTagIds?: string[];
```

- [ ] **Step 4: Run frontend API tests**

```bash
pnpm --filter @prymeira-talk/web test -- src/app/api.test.ts
pnpm --filter @prymeira-talk/web build
```

Expected: PASS.

- [ ] **Step 5: Commit frontend API helpers**

```bash
git add apps/web/src/app/api.ts apps/web/src/app/api.test.ts
git commit -m "feat: add tag catalog frontend api"
```

---

### Task 6: Global Tag Settings UI

**Files:**
- Modify: `apps/web/src/features/settings/SettingsPage.tsx`
- Create: `apps/web/src/features/settings/SettingsPage.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add settings UI test**

Create `apps/web/src/features/settings/SettingsPage.test.tsx` with the same render-to-static-markup style used by `AgentsPage.test.tsx`:

```ts
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

vi.mock("../../app/auth", () => ({
  useTalkAuth: () => ({ getToken: vi.fn(async () => "test-token") })
}));

vi.mock("../../app/api", () => ({
  apiCreateTag: vi.fn(),
  apiGetAuditLog: vi.fn(async () => []),
  apiGetSettings: vi.fn(async () => ({ integrations: [] })),
  apiGetTags: vi.fn(async () => []),
  apiSyncMetaTemplates: vi.fn(),
  apiUpdateSettings: vi.fn(),
  apiUpdateTag: vi.fn()
}));

afterEach(() => vi.clearAllMocks());

describe("SettingsPage", () => {
  it("renders tag catalog controls", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain("Tags da IA");
    expect(html).toContain("Nome da tag");
    expect(html).toContain("Cor");
    expect(html).toContain("Quando usar");
    expect(html).toContain("Criar tag");
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

```bash
pnpm --filter @prymeira-talk/web test -- src/features/settings/SettingsPage.test.tsx
```

Expected: FAIL because the tag catalog controls do not exist.

- [ ] **Step 3: Add tag state and loading**

In `SettingsPage.tsx`, import:

```ts
  apiCreateTag,
  apiGetTags,
  apiUpdateTag,
  type TagDto
```

Add state:

```ts
const [tags, setTags] = useState<TagDto[]>([]);
const [tagForm, setTagForm] = useState({ name: "", color: "#2f6b57", useGuide: "" });
const [isSavingTag, setIsSavingTag] = useState(false);
```

Update `loadSettings` to load tags:

```ts
const [nextSettings, nextAuditLog, nextTags] = await Promise.all([
  apiGetSettings(getToken),
  apiGetAuditLog(getToken),
  apiGetTags(getToken)
]);
setTags(nextTags);
```

- [ ] **Step 4: Add create/update handlers**

Add:

```ts
async function saveTag(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (!tagForm.name.trim() || !tagForm.useGuide.trim()) {
    setError("Informe nome e quando usar para criar a tag.");
    return;
  }

  setIsSavingTag(true);
  setError(null);
  setNotice(null);

  try {
    const created = await apiCreateTag(getToken, {
      name: tagForm.name,
      color: tagForm.color,
      useGuide: tagForm.useGuide
    });
    setTags((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
    setTagForm({ name: "", color: "#2f6b57", useGuide: "" });
    setNotice("Tag criada.");
  } catch (saveError) {
    setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar a tag.");
  } finally {
    setIsSavingTag(false);
  }
}

async function toggleTag(tag: TagDto) {
  const updated = await apiUpdateTag(getToken, tag.id, { isActive: !tag.isActive });
  setTags((current) => current.map((item) => item.id === updated.id ? updated : item));
}
```

- [ ] **Step 5: Render global tag manager**

Add a new `module-panel` near the AI provider section:

```tsx
<section className="module-panel" aria-label="Tags da IA">
  <div className="panel-title-row">
    <h2>Tags da IA</h2>
    <span>{tags.length} tags</span>
  </div>

  <form className="settings-grid" onSubmit={(event) => void saveTag(event)}>
    <label className="form-field">
      Nome da tag
      <input
        value={tagForm.name}
        onChange={(event) => setTagForm((current) => ({ ...current, name: event.target.value }))}
        placeholder="Lead quente"
      />
    </label>
    <label className="form-field">
      Cor
      <input
        type="color"
        value={tagForm.color}
        onChange={(event) => setTagForm((current) => ({ ...current, color: event.target.value }))}
      />
    </label>
    <label className="form-field settings-grid-wide">
      Quando usar
      <textarea
        value={tagForm.useGuide}
        onChange={(event) => setTagForm((current) => ({ ...current, useGuide: event.target.value }))}
        placeholder="Quando o cliente pedir preço, proposta, demonstração ou perguntar como contratar."
        rows={3}
      />
    </label>
    <button className="primary-button" type="submit" disabled={isSavingTag}>
      <Save size={15} />
      {isSavingTag ? "Salvando" : "Criar tag"}
    </button>
  </form>

  <div className="assistant-log-list">
    {tags.map((tag) => (
      <article className="knowledge-source-card" key={tag.id}>
        <div className="assistant-log-header">
          <span className="status-badge" style={{ borderColor: tag.color }}>{tag.name}</span>
          <span className={`status-badge status-badge--${tag.isActive ? "open" : "closed"}`}>
            {tag.isActive ? "Ativa" : "Inativa"}
          </span>
        </div>
        <p className="assistant-log-result">{tag.useGuide}</p>
        <small>{tag.agentCount ?? 0} agentes · {tag.conversationCount ?? 0} conversas</small>
        <button className="secondary-button" type="button" onClick={() => void toggleTag(tag)}>
          {tag.isActive ? "Desativar" : "Ativar"}
        </button>
      </article>
    ))}
  </div>
</section>
```

Add CSS to `apps/web/src/styles.css`:

```css
.settings-grid-wide {
  grid-column: 1 / -1;
}
```

- [ ] **Step 6: Run UI tests and build**

```bash
pnpm --filter @prymeira-talk/web test -- src/features/settings/SettingsPage.test.tsx
pnpm --filter @prymeira-talk/web build
```

Expected: PASS.

- [ ] **Step 7: Commit settings UI**

```bash
git add apps/web/src/features/settings/SettingsPage.tsx apps/web/src/features/settings/SettingsPage.test.tsx apps/web/src/styles.css
git commit -m "feat: manage global agent tags"
```

---

### Task 7: Agent Tag Selector UI

**Files:**
- Modify: `apps/web/src/features/assistant/AgentsPage.tsx`
- Modify: `apps/web/src/features/assistant/AgentsPage.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add failing AgentsPage test**

Update the existing test in `apps/web/src/features/assistant/AgentsPage.test.tsx`:

```ts
expect(html).toContain("Tags permitidas");
expect(html).toContain("Selecione as tags que este agente pode aplicar.");
```

Update the API mock:

```ts
apiGetTags: vi.fn(async () => [
  {
    id: "tag_1",
    workspaceId: "workspace_a",
    name: "Lead quente",
    color: "#2f6b57",
    useGuide: "Quando pedir preço.",
    isActive: true,
    agentCount: 0,
    conversationCount: 0,
    createdAt: "2026-07-05T12:00:00.000Z",
    updatedAt: "2026-07-05T12:00:00.000Z"
  }
]),
```

- [ ] **Step 2: Run test and confirm failure**

```bash
pnpm --filter @prymeira-talk/web test -- src/features/assistant/AgentsPage.test.tsx
```

Expected: FAIL because the selector does not exist.

- [ ] **Step 3: Load tags in AgentsPage**

In `AgentsPage.tsx`, import:

```ts
  apiGetTags,
  type TagDto
```

Extend `AgentFormState`:

```ts
  allowedTagIds: string[];
```

Update `emptyAgentForm`:

```ts
allowedTagIds: []
```

Add state:

```ts
const [tags, setTags] = useState<TagDto[]>([]);
```

In `loadAgents`, load both:

```ts
const [loadedAgents, loadedTags] = await Promise.all([
  apiGetAgents(getToken),
  apiGetTags(getToken)
]);
setTags(loadedTags.filter((tag) => tag.isActive));
```

In `selectAgent`, set:

```ts
allowedTagIds: agent.allowedTags.map((tag) => tag.id)
```

- [ ] **Step 4: Save selected tag ids**

In `saveAgent`, include:

```ts
allowedTagIds: agentForm.allowedTagIds
```

in both `apiUpdateAgent` and `apiCreateAgent` payloads.

Add toggler:

```ts
function toggleAllowedTag(tagId: string) {
  setAgentForm((current) => ({
    ...current,
    allowedTagIds: current.allowedTagIds.includes(tagId)
      ? current.allowedTagIds.filter((id) => id !== tagId)
      : [...current.allowedTagIds, tagId]
  }));
}
```

- [ ] **Step 5: Render selector below system prompt**

Add this block after `Prompt do sistema` and before save button:

```tsx
<section className="agent-tag-selector" aria-label="Tags permitidas">
  <div className="panel-title-row compact">
    <h3>Tags permitidas</h3>
    <span>{agentForm.allowedTagIds.length} selecionadas</span>
  </div>
  <p className="list-note">Selecione as tags que este agente pode aplicar.</p>
  <div className="tag-option-grid">
    {tags.length === 0 ? (
      <span className="context-empty-label">Crie tags em Ajustes antes de selecionar.</span>
    ) : tags.map((tag) => (
      <label className="tag-option-card" key={tag.id}>
        <input
          type="checkbox"
          checked={agentForm.allowedTagIds.includes(tag.id)}
          onChange={() => toggleAllowedTag(tag.id)}
        />
        <span className="context-tag" style={{ borderColor: tag.color }}>{tag.name}</span>
        <small>{tag.useGuide}</small>
      </label>
    ))}
  </div>
</section>
```

Add CSS in `apps/web/src/styles.css`:

```css
.agent-tag-selector {
  display: grid;
  gap: 0.75rem;
}

.tag-option-grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.tag-option-card {
  align-items: flex-start;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
}
```

- [ ] **Step 6: Run frontend tests and build**

```bash
pnpm --filter @prymeira-talk/web test -- src/features/assistant/AgentsPage.test.tsx
pnpm --filter @prymeira-talk/web build
```

Expected: PASS.

- [ ] **Step 7: Commit agent selector UI**

```bash
git add apps/web/src/features/assistant/AgentsPage.tsx apps/web/src/features/assistant/AgentsPage.test.tsx apps/web/src/styles.css
git commit -m "feat: select allowed tags per agent"
```

---

### Task 8: Final Integration Verification

**Files:**
- No planned source edits unless tests reveal integration issues.

- [ ] **Step 1: Push database schema locally**

Run:

```bash
pnpm prisma:generate
pnpm --filter @prymeira-talk/api prisma db push
```

Expected: Prisma applies `use_guide`, `is_active`, and `ai_agent_allowed_tags` without data loss.

- [ ] **Step 2: Run complete automated checks**

Run:

```bash
pnpm --filter @prymeira-talk/shared test
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/web test
pnpm -r build
```

Expected: all commands PASS.

- [ ] **Step 3: Manual product check**

Run:

```bash
pnpm demo:prymeira
```

Then verify in browser:

1. Open Ajustes.
2. Create tag `Lead quente` with color and `Quando usar`.
3. Open Agentes.
4. Select `Lead quente` for the sales agent.
5. Ask in the agent test chat: `Quero saber preço e contratar`.
6. Confirm debug context shows the allowed tag.
7. Use a real/simulated inbound conversation with the agent active.
8. Confirm the agent can apply `Lead quente`.
9. Confirm an invented tag is skipped and visible in logs.
10. Confirm notes still appear under Notas internas when the model creates `create_internal_note`.

- [ ] **Step 4: Commit any integration fixes**

If Step 2 or Step 3 requires source fixes, inspect `git status --short`, add only files changed by the integration fix, and commit them:

```bash
git status --short
git add apps/api/src/modules/agents apps/api/src/modules/tags apps/api/prisma/schema.prisma apps/web/src/app/api.ts apps/web/src/features/assistant apps/web/src/features/settings apps/web/src/styles.css packages/shared/src/domain.ts packages/shared/src/domain.test.ts
git commit -m "fix: polish agent tag governance integration"
```

- [ ] **Step 5: Push branch**

```bash
git status --short
git push
```

Expected: only existing untracked local files such as `.DS_Store` or `tmp/` remain uncommitted; branch pushes successfully.

---

## Self-Review

- Spec coverage: global tags, simple `nome/cor/quando usar`, selection per agent, harness context, backend validation, logs/debug, suggestions as non-automatic, and notes as free text are all covered by tasks. The only deliberately deferred item is a dedicated "suggested tags" approval UI; Task 4 logs skipped unknown tags so it is auditable in this iteration.
- Placeholder scan: the plan gives concrete files, commands, and code snippets for each task.
- Type consistency: frontend `TagDto` and backend `TagDto` come from `packages/shared/src/domain.ts`; agent selected tags use `allowedTags` for DTO output and `allowedTagIds` for create/update input.
