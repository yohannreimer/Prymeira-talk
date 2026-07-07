# Contact Board Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make contact boards route contacts by channel and tag rules, with readable stage headers and a manual sync action.

**Architecture:** Extend the existing boards module instead of introducing a generic automation engine. Persist board-channel and stage-tag mappings in Prisma, expose them through existing board DTOs, and add a focused board-rules service that all tag-writing paths can call. Split the React board surface into small helpers/components while keeping existing drag/drop and board APIs compatible.

**Tech Stack:** Prisma, Fastify, Zod, React, DnD Kit, Vitest, TypeScript.

---

## File Structure

- Modify `apps/api/prisma/schema.prisma`: add board-channel/stage-tag models, `isPrimaryPipeline`, and movement source metadata.
- Modify `packages/shared/src/domain.ts`: enrich board, stage, and membership DTO schemas.
- Modify `packages/shared/src/domain.test.ts`: verify enriched board/stage/membership DTOs parse.
- Modify `apps/api/src/modules/boards/boards.service.ts`: include channel/tag relations in DTOs and persist board/stage rule settings.
- Modify `apps/api/src/modules/boards/boards.service.test.ts`: cover persistence, uniqueness, enriched DTOs, and movement metadata.
- Modify `apps/api/src/modules/boards/boards.routes.ts`: validate new request bodies and add sync endpoint.
- Create `apps/api/src/modules/boards/board-rules.service.ts`: contain all tag-to-board movement rules.
- Create `apps/api/src/modules/boards/board-rules.service.test.ts`: unit test channel matching, stage resolution, advancement, and sync scopes.
- Modify `apps/api/src/modules/conversations/conversations.service.ts`: call board rule hook after `add_tag`.
- Modify `apps/api/src/modules/conversations/conversations.routes.ts`: instantiate the rule service and publish returned membership updates.
- Modify `apps/api/src/modules/agents/agent-tool-executor.ts`: return applied tag metadata so the runtime caller can trigger board rules consistently.
- Modify `apps/api/src/modules/automations/automation-runner.ts`: call board rules after `add_tag`.
- Modify `apps/web/src/app/api.ts`: update board client DTO parsing and add `apiSyncBoardRules`.
- Modify `apps/web/src/app/api.test.ts`: cover new payloads and sync endpoint.
- Create `apps/web/src/features/contacts/board-display.ts`: helpers for channels, stage tags, duplicate tag checks, and readable labels.
- Create `apps/web/src/features/contacts/board-display.test.ts`: helper tests.
- Modify `apps/web/src/features/contacts/ContactsPage.tsx`: use richer board command bar, rules panel, stage editor, and sync controls.
- Modify `apps/web/src/styles.css`: stage header, tag chips, channel chips, sync controls, and wrapping fixes.

---

### Task 1: Prisma And Shared DTO Contract

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `packages/shared/src/domain.ts`
- Test: `packages/shared/src/domain.test.ts`

- [ ] **Step 1: Write failing shared DTO tests**

Add tests near the existing contact board tests in `packages/shared/src/domain.test.ts`:

```ts
it("validates enriched contact board data with channels and primary pipeline flag", () => {
  expect(
    contactBoardSchema.parse({
      id: "board_1",
      workspaceId: "workspace_1",
      name: "Vendas",
      description: null,
      isPrimaryPipeline: true,
      channels: [
        {
          id: "channel_1",
          displayName: "WhatsApp Vendas",
          provider: "evolution",
          phoneNumber: "+5511999990000"
        }
      ],
      createdAt: "2026-07-07T12:00:00.000Z"
    })
  ).toMatchObject({
    name: "Vendas",
    isPrimaryPipeline: true,
    channels: [{ id: "channel_1" }]
  });
});

it("validates contact board stages with tag triggers", () => {
  expect(
    contactBoardStageSchema.parse({
      id: "stage_1",
      workspaceId: "workspace_1",
      boardId: "board_1",
      name: "Interesse forte",
      color: "#d63a22",
      order: 2,
      tagTriggers: [
        {
          id: "tag_1",
          name: "interesse_forte",
          color: "#d63a22",
          isActive: true
        }
      ]
    })
  ).toMatchObject({
    name: "Interesse forte",
    tagTriggers: [{ name: "interesse_forte" }]
  });
});

it("validates board memberships with movement metadata", () => {
  expect(
    contactBoardMembershipSchema.parse({
      id: "membership_1",
      workspaceId: "workspace_1",
      contactId: "contact_1",
      boardId: "board_1",
      stageId: "stage_1",
      isPrimary: true,
      lastMovedBy: "rule",
      lastRuleAppliedAt: "2026-07-07T12:30:00.000Z",
      updatedAt: "2026-07-07T12:31:00.000Z"
    })
  ).toMatchObject({
    lastMovedBy: "rule",
    lastRuleAppliedAt: "2026-07-07T12:30:00.000Z"
  });
});
```

- [ ] **Step 2: Run shared tests to verify failure**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/shared exec vitest run src/domain.test.ts
```

Expected: FAIL because `contactBoardSchema`, `contactBoardStageSchema`, and `contactBoardMembershipSchema` do not yet include the new fields.

- [ ] **Step 3: Extend shared schemas**

Modify `packages/shared/src/domain.ts`:

```ts
export const contactBoardChannelSummarySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
  provider: channelProviderSchema,
  phoneNumber: z.string().nullable()
});
export type ContactBoardChannelSummaryDto = z.infer<typeof contactBoardChannelSummarySchema>;

export const contactBoardStageTagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  isActive: z.boolean()
});
export type ContactBoardStageTagDto = z.infer<typeof contactBoardStageTagSchema>;
```

Extend the existing schemas:

```ts
export const contactBoardSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  isPrimaryPipeline: z.boolean().default(false),
  channels: contactBoardChannelSummarySchema.array().default([]),
  createdAt: z.string().datetime()
});

export const contactBoardStageSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  boardId: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  order: z.number().int().min(0),
  tagTriggers: contactBoardStageTagSchema.array().default([])
});

export const contactBoardMoveSourceSchema = z.enum(["manual", "rule"]);
export type ContactBoardMoveSource = z.infer<typeof contactBoardMoveSourceSchema>;

export const contactBoardMembershipSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  contactId: z.string().min(1),
  boardId: z.string().min(1),
  stageId: z.string().min(1),
  isPrimary: z.boolean(),
  lastMovedBy: contactBoardMoveSourceSchema.default("manual"),
  lastRuleAppliedAt: z.string().datetime().nullable().default(null),
  updatedAt: z.string().datetime()
});
```

- [ ] **Step 4: Add Prisma schema changes**

Modify `apps/api/prisma/schema.prisma`:

```prisma
enum ContactBoardMoveSource {
  manual
  rule
}
```

Extend `Channel`:

```prisma
  contactBoards ContactBoardChannel[]
```

Extend `Tag`:

```prisma
  boardStageTriggers ContactBoardStageTag[]
```

Extend `ContactBoard`:

```prisma
  isPrimaryPipeline Boolean @default(false) @map("is_primary_pipeline")
  channels          ContactBoardChannel[]
```

Extend `ContactBoardStage`:

```prisma
  tagTriggers ContactBoardStageTag[]
```

Extend `ContactBoardMembership`:

```prisma
  lastMovedBy       ContactBoardMoveSource @default(manual) @map("last_moved_by")
  lastRuleAppliedAt DateTime?              @map("last_rule_applied_at")
```

Add models:

```prisma
model ContactBoardChannel {
  workspaceId String   @map("workspace_id")
  boardId     String   @map("board_id") @db.Uuid
  channelId   String   @map("channel_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  board   ContactBoard @relation(fields: [workspaceId, boardId], references: [workspaceId, id], onDelete: Cascade)
  channel Channel      @relation(fields: [workspaceId, channelId], references: [workspaceId, id], onDelete: Cascade)

  @@id([workspaceId, boardId, channelId])
  @@index([workspaceId, channelId])
  @@map("contact_board_channels")
}

model ContactBoardStageTag {
  workspaceId String   @map("workspace_id")
  boardId     String   @map("board_id") @db.Uuid
  stageId     String   @map("stage_id") @db.Uuid
  tagId       String   @map("tag_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  stage ContactBoardStage @relation(fields: [workspaceId, boardId, stageId], references: [workspaceId, boardId, id], onDelete: Cascade)
  tag   Tag               @relation(fields: [workspaceId, tagId], references: [workspaceId, id], onDelete: Cascade)

  @@id([workspaceId, boardId, tagId])
  @@index([workspaceId, boardId, stageId])
  @@map("contact_board_stage_tags")
}
```

- [ ] **Step 5: Generate Prisma client**

Run:

```bash
npx pnpm@10.0.0 prisma:generate
```

Expected: Prisma client generation succeeds.

- [ ] **Step 6: Run shared tests**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/shared exec vitest run src/domain.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma packages/shared/src/domain.ts packages/shared/src/domain.test.ts
git commit -m "feat: add board rule data contract"
```

---

### Task 2: Enrich Board Service Persistence

**Files:**
- Modify: `apps/api/src/modules/boards/boards.service.ts`
- Test: `apps/api/src/modules/boards/boards.service.test.ts`

- [ ] **Step 1: Write failing board service tests**

Add these tests inside `describe("boards service", ...)`:

```ts
it("creates a board with selected channels and primary pipeline setting", async () => {
  const prisma = createMockPrisma();
  const service = createBoardsService(prisma);

  await service.createBoard({
    workspaceId: "workspace_a",
    name: "Vendas",
    description: "",
    channelIds: ["00000000-0000-4000-8000-000000000060"],
    isPrimaryPipeline: true
  });

  expect(prisma.contactBoard.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        isPrimaryPipeline: true,
        channels: {
          createMany: {
            data: [
              {
                workspaceId: "workspace_a",
                channelId: "00000000-0000-4000-8000-000000000060"
              }
            ],
            skipDuplicates: true
          }
        }
      })
    })
  );
});

it("updates stage tag triggers by replacing mappings for that stage", async () => {
  const prisma = createMockPrisma();
  const service = createBoardsService(prisma);

  await service.updateStage({
    workspaceId: "workspace_a",
    boardId,
    stageId,
    tagIds: ["00000000-0000-4000-8000-000000000070"]
  });

  expect(prisma.contactBoardStageTag.deleteMany).toHaveBeenCalledWith({
    where: { workspaceId: "workspace_a", boardId, stageId }
  });
  expect(prisma.contactBoardStageTag.createMany).toHaveBeenCalledWith({
    data: [
      {
        workspaceId: "workspace_a",
        boardId,
        stageId,
        tagId: "00000000-0000-4000-8000-000000000070"
      }
    ],
    skipDuplicates: true
  });
});
```

Extend `MockPrisma` in the test with:

```ts
contactBoardChannel: {
  deleteMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
};
contactBoardStageTag: {
  deleteMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
};
```

And add default mocks:

```ts
contactBoardChannel: {
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  createMany: vi.fn().mockResolvedValue({ count: 1 })
},
contactBoardStageTag: {
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  createMany: vi.fn().mockResolvedValue({ count: 1 })
}
```

- [ ] **Step 2: Run board service tests to verify failure**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/api exec vitest run src/modules/boards/boards.service.test.ts
```

Expected: FAIL because service inputs and Prisma persistence do not support `channelIds`, `isPrimaryPipeline`, or `tagIds`.

- [ ] **Step 3: Update board service types and DTO converters**

Modify `apps/api/src/modules/boards/boards.service.ts` record interfaces:

```ts
interface BoardChannelRecord {
  channel: {
    id: string;
    displayName: string | null;
    provider: ChannelProvider;
    phoneNumber: string | null;
  };
}

interface StageTagRecord {
  tag: {
    id: string;
    name: string;
    color: string;
    isActive: boolean;
  };
}
```

Extend records:

```ts
interface BoardRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  isPrimaryPipeline: boolean;
  channels?: BoardChannelRecord[];
  createdAt: DateLike;
}

interface StageRecord {
  id: string;
  workspaceId: string;
  boardId: string;
  name: string;
  color: string;
  order: number;
  tagTriggers?: StageTagRecord[];
}
```

Update converters:

```ts
function toBoardDto(record: BoardRecord): ContactBoardDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description,
    isPrimaryPipeline: record.isPrimaryPipeline,
    channels: record.channels?.map((link) => ({
      id: link.channel.id,
      displayName: link.channel.displayName,
      provider: link.channel.provider,
      phoneNumber: link.channel.phoneNumber
    })) ?? [],
    createdAt: toIsoString(record.createdAt)
  };
}

function toStageDto(record: StageRecord): ContactBoardStageDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    boardId: record.boardId,
    name: record.name,
    color: record.color,
    order: record.order,
    tagTriggers: record.tagTriggers?.map((link) => ({
      id: link.tag.id,
      name: link.tag.name,
      color: link.tag.color,
      isActive: link.tag.isActive
    })) ?? []
  };
}
```

- [ ] **Step 4: Add reusable include object**

Add near converters:

```ts
const boardRuleInclude = {
  channels: {
    include: {
      channel: {
        select: {
          id: true,
          displayName: true,
          provider: true,
          phoneNumber: true
        }
      }
    }
  },
  stages: {
    orderBy: { order: "asc" as const },
    include: {
      tagTriggers: {
        include: {
          tag: {
            select: {
              id: true,
              name: true,
              color: true,
              isActive: true
            }
          }
        }
      }
    }
  }
};
```

- [ ] **Step 5: Persist board channels and primary flag**

Change `createBoard` input:

```ts
async createBoard(input: {
  workspaceId: string;
  name: string;
  description?: string;
  channelIds?: string[];
  isPrimaryPipeline?: boolean;
}): Promise<ContactBoardWithStagesDto>
```

Use:

```ts
const channelIds = [...new Set(input.channelIds ?? [])];
const board = await prisma.contactBoard.create({
  data: {
    workspaceId: input.workspaceId,
    name: input.name.trim(),
    description: normalizeOptional(input.description) ?? null,
    isPrimaryPipeline: input.isPrimaryPipeline ?? false,
    channels:
      channelIds.length > 0
        ? {
            createMany: {
              data: channelIds.map((channelId) => ({
                workspaceId: input.workspaceId,
                channelId
              })),
              skipDuplicates: true
            }
          }
        : undefined
  },
  include: boardRuleInclude
});

return toBoardWithStagesDto(board);
```

- [ ] **Step 6: Persist updates for board channels**

Change `updateBoard` input to include:

```ts
channelIds?: string[];
isPrimaryPipeline?: boolean;
```

Inside `updateBoard`, update scalar data:

```ts
if (input.isPrimaryPipeline !== undefined) {
  data.isPrimaryPipeline = input.isPrimaryPipeline;
}
```

After updating the board, replace channel mappings only when `channelIds` is provided:

```ts
if (input.channelIds !== undefined) {
  const channelIds = [...new Set(input.channelIds)];
  await prisma.$transaction(async (tx) => {
    await tx.contactBoardChannel.deleteMany({
      where: { workspaceId: input.workspaceId, boardId: input.boardId }
    });
    if (channelIds.length > 0) {
      await tx.contactBoardChannel.createMany({
        data: channelIds.map((channelId) => ({
          workspaceId: input.workspaceId,
          boardId: input.boardId,
          channelId
        })),
        skipDuplicates: true
      });
    }
  });
}
```

Then fetch with `include: boardRuleInclude`.

- [ ] **Step 7: Persist stage tag triggers**

Change `createStage` and `updateStage` inputs to include `tagIds?: string[]`.

After creating a stage:

```ts
const tagIds = [...new Set(input.tagIds ?? [])];
if (tagIds.length > 0) {
  await prisma.contactBoardStageTag.createMany({
    data: tagIds.map((tagId) => ({
      workspaceId: input.workspaceId,
      boardId: input.boardId,
      stageId: stage.id,
      tagId
    })),
    skipDuplicates: true
  });
}
```

After updating a stage, replace mappings only if `tagIds` is provided:

```ts
if (input.tagIds !== undefined) {
  const tagIds = [...new Set(input.tagIds)];
  await prisma.$transaction(async (tx) => {
    await tx.contactBoardStageTag.deleteMany({
      where: { workspaceId: input.workspaceId, boardId: input.boardId, stageId: input.stageId }
    });
    if (tagIds.length > 0) {
      await tx.contactBoardStageTag.createMany({
        data: tagIds.map((tagId) => ({
          workspaceId: input.workspaceId,
          boardId: input.boardId,
          stageId: input.stageId,
          tagId
        })),
        skipDuplicates: true
      });
    }
  });
}
```

Fetch and return the updated stage with tag triggers.

- [ ] **Step 8: Mark manual movement metadata**

In `addContactToBoard`, set create/update data:

```ts
lastMovedBy: "manual",
lastRuleAppliedAt: null
```

In `moveContactToStage`, set:

```ts
lastMovedBy: "manual",
lastRuleAppliedAt: null
```

- [ ] **Step 9: Run board service tests**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/api exec vitest run src/modules/boards/boards.service.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/boards/boards.service.ts apps/api/src/modules/boards/boards.service.test.ts
git commit -m "feat: persist board channel and tag rules"
```

---

### Task 3: Board Routes And Web API Client

**Files:**
- Modify: `apps/api/src/modules/boards/boards.routes.ts`
- Modify: `apps/web/src/app/api.ts`
- Test: `apps/api/src/modules/boards/boards.service.test.ts`
- Test: `apps/web/src/app/api.test.ts`

- [ ] **Step 1: Write failing route/client tests**

In `apps/web/src/app/api.test.ts`, update the board helper test fixture:

```ts
const board = {
  id: "board-1",
  workspaceId: "workspace_a",
  name: "Vendas",
  description: null,
  isPrimaryPipeline: true,
  channels: [
    {
      id: "channel-1",
      displayName: "WhatsApp Vendas",
      provider: "evolution",
      phoneNumber: "+5511999990000"
    }
  ],
  createdAt: "2026-05-24T12:00:00.000Z",
  stages: []
};
const stage = {
  id: "stage-1",
  workspaceId: "workspace_a",
  boardId: "board-1",
  name: "Novo",
  color: "#24564a",
  order: 0,
  tagTriggers: [{ id: "tag-1", name: "lead_quente", color: "#24564a", isActive: true }]
};
const syncResult = {
  evaluated: 12,
  added: 4,
  moved: 2,
  ignored: 6,
  conflicts: 0
};
```

Add expectations:

```ts
await expect(
  apiCreateBoard(async () => null, {
    name: "Vendas",
    description: "",
    channelIds: ["channel-1"],
    isPrimaryPipeline: true
  })
).resolves.toMatchObject({ isPrimaryPipeline: true, channels: [{ id: "channel-1" }] });

await expect(
  apiCreateBoardStage(async () => null, "board-1", {
    name: "Novo",
    color: "#24564a",
    order: 0,
    tagIds: ["tag-1"]
  })
).resolves.toMatchObject({ tagTriggers: [{ id: "tag-1" }] });

await expect(apiSyncBoardRules(async () => null, "board-1", "all")).resolves.toEqual(syncResult);
```

Add an assertion:

```ts
expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
  channelIds: ["channel-1"],
  isPrimaryPipeline: true
});
```

- [ ] **Step 2: Run web API tests to verify failure**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/web exec vitest run src/app/api.test.ts
```

Expected: FAIL because client helpers do not accept/send new fields and `apiSyncBoardRules` does not exist.

- [ ] **Step 3: Update board route schemas**

In `apps/api/src/modules/boards/boards.routes.ts`, add:

```ts
const boardRuleFieldsSchema = z.object({
  channelIds: uuidParamSchema.array().optional(),
  isPrimaryPipeline: z.boolean().optional()
});

const stageRuleFieldsSchema = z.object({
  tagIds: uuidParamSchema.array().optional()
});

const syncRulesBodySchema = z.object({
  scope: z.enum(["active", "closed", "all"])
});
```

Merge schemas:

```ts
const createBoardBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(500).optional()
}).merge(boardRuleFieldsSchema);

const updateBoardBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(500).optional()
  })
  .merge(boardRuleFieldsSchema)
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required"
  });

const createStageBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: z.string().trim().min(1).max(40),
  order: z.number().int().min(0)
}).merge(stageRuleFieldsSchema);
```

And update `updateStageBodySchema` similarly with `stageRuleFieldsSchema`.

- [ ] **Step 4: Update web API types and parsers**

In `apps/web/src/app/api.ts`, add:

```ts
export type BoardSyncScope = "active" | "closed" | "all";

export interface BoardSyncResultDto {
  evaluated: number;
  added: number;
  moved: number;
  ignored: number;
  conflicts: number;
}
```

Update board payload types:

```ts
type BoardRulePayload = Partial<{
  channelIds: string[];
  isPrimaryPipeline: boolean;
}>;

type StageRulePayload = Partial<{
  tagIds: string[];
}>;
```

Extend function signatures:

```ts
export async function apiCreateBoard(
  getToken: () => Promise<string | null>,
  body: { name: string; description?: string } & BoardRulePayload
)
```

```ts
export async function apiUpdateBoard(
  getToken: () => Promise<string | null>,
  boardId: string,
  body: Partial<{ name: string; description: string }> & BoardRulePayload
)
```

```ts
export async function apiCreateBoardStage(
  getToken: () => Promise<string | null>,
  boardId: string,
  body: { name: string; color: string; order: number } & StageRulePayload
)
```

```ts
export async function apiUpdateBoardStage(
  getToken: () => Promise<string | null>,
  boardId: string,
  stageId: string,
  body: Partial<{ name: string; color: string }> & StageRulePayload
)
```

- [ ] **Step 5: Add sync client helper**

Add in `apps/web/src/app/api.ts`:

```ts
export async function apiSyncBoardRules(
  getToken: () => Promise<string | null>,
  boardId: string,
  scope: BoardSyncScope
): Promise<BoardSyncResultDto> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/boards/${boardId}/sync-rules`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ scope })
  });

  const payload = await parseJsonResponse(response, "Invalid board sync response.");
  return z.object({
    evaluated: z.number().int().min(0),
    added: z.number().int().min(0),
    moved: z.number().int().min(0),
    ignored: z.number().int().min(0),
    conflicts: z.number().int().min(0)
  }).parse(payload);
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/web exec vitest run src/app/api.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/boards/boards.routes.ts apps/api/src/modules/boards/boards.service.ts apps/web/src/app/api.ts apps/web/src/app/api.test.ts
git commit -m "feat: expose board rule API"
```

---

### Task 4: Board Rule Service

**Files:**
- Create: `apps/api/src/modules/boards/board-rules.service.ts`
- Test: `apps/api/src/modules/boards/board-rules.service.test.ts`
- Modify: `apps/api/src/modules/boards/boards.service.ts`
- Modify: `apps/api/src/modules/boards/boards.routes.ts`

- [ ] **Step 1: Write failing rule service tests**

Create `apps/api/src/modules/boards/board-rules.service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createBoardRulesService } from "./board-rules.service.js";

const workspaceId = "workspace_a";
const conversationId = "00000000-0000-4000-8000-000000000101";
const contactId = "00000000-0000-4000-8000-000000000102";
const channelId = "00000000-0000-4000-8000-000000000103";
const boardId = "00000000-0000-4000-8000-000000000104";
const earlyStageId = "00000000-0000-4000-8000-000000000105";
const lateStageId = "00000000-0000-4000-8000-000000000106";
const tagId = "00000000-0000-4000-8000-000000000107";

function createRulePrisma(overrides = {}) {
  return {
    conversation: {
      findFirst: vi.fn().mockResolvedValue({
        id: conversationId,
        workspaceId,
        contactId,
        channelId,
        status: "open",
        tags: [{ tagId }]
      }),
      findMany: vi.fn().mockResolvedValue([
        { id: conversationId, workspaceId, contactId, channelId, status: "open", tags: [{ tagId }] }
      ])
    },
    contactBoard: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: boardId,
          workspaceId,
          isPrimaryPipeline: true,
          channels: [{ channelId }],
          stages: [
            { id: earlyStageId, order: 0, tagTriggers: [] },
            { id: lateStageId, order: 1, tagTriggers: [{ tagId }] }
          ]
        }
      ]),
      findFirst: vi.fn().mockResolvedValue({ id: boardId, workspaceId })
    },
    contactBoardMembership: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({
        id: "membership_1",
        workspaceId,
        contactId,
        boardId,
        stageId: lateStageId,
        isPrimary: true,
        lastMovedBy: "rule",
        lastRuleAppliedAt: new Date("2026-07-07T12:00:00.000Z"),
        updatedAt: new Date("2026-07-07T12:00:00.000Z"),
        contact: {
          id: contactId,
          workspaceId,
          name: "Yohann",
          phone: "+5511999990000",
          email: null,
          company: null,
          avatarUrl: null,
          customFields: {},
          atomicCrmContactId: null,
          atomicCrmLeadId: null,
          createdAt: new Date("2026-07-07T11:00:00.000Z"),
          updatedAt: new Date("2026-07-07T11:00:00.000Z")
        }
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 })
    },
    $transaction: vi.fn(async (callback) => callback(createRulePrisma(overrides))),
    ...overrides
  };
}

describe("board rules service", () => {
  it("adds a contact to the rightmost matching stage for the conversation channel", async () => {
    const prisma = createRulePrisma();
    const service = createBoardRulesService(prisma);

    const result = await service.applyBoardRulesForConversationTags({ workspaceId, conversationId });

    expect(prisma.contactBoardMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          boardId,
          stageId: lateStageId,
          isPrimary: true,
          lastMovedBy: "rule"
        })
      })
    );
    expect(result.updatedMemberships).toHaveLength(1);
  });

  it("does not move a membership backward", async () => {
    const prisma = createRulePrisma({
      contactBoardMembership: {
        findFirst: vi.fn().mockResolvedValue({
          id: "membership_1",
          workspaceId,
          contactId,
          boardId,
          stageId: lateStageId,
          isPrimary: true
        }),
        upsert: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 })
      }
    });
    const service = createBoardRulesService(prisma);

    const result = await service.applyBoardRulesForConversationTags({ workspaceId, conversationId });

    expect(prisma.contactBoardMembership.upsert).not.toHaveBeenCalled();
    expect(result.ignored).toBe(1);
  });

  it("syncs only conversations from the requested scope", async () => {
    const prisma = createRulePrisma();
    const service = createBoardRulesService(prisma);

    await service.syncBoardRules({ workspaceId, boardId, scope: "closed" });

    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId, status: "closed" })
      })
    );
  });
});
```

- [ ] **Step 2: Run rule service tests to verify failure**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/api exec vitest run src/modules/boards/board-rules.service.test.ts
```

Expected: FAIL because `board-rules.service.ts` does not exist.

- [ ] **Step 3: Create rule service result types**

Create `apps/api/src/modules/boards/board-rules.service.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type { ConversationStatus } from "@prisma/client";
import type { ContactBoardMembershipDto, RealtimeEvent } from "@prymeira-talk/shared";
import { toContactDto } from "../contacts/contacts.service.js";

type Scope = "active" | "closed" | "all";
type PrismaLike = Pick<PrismaClient, "conversation" | "contactBoard" | "contactBoardMembership" | "$transaction">;
const activeConversationStatuses: ConversationStatus[] = ["open", "pending"];

export interface BoardRuleApplyResult {
  updatedMemberships: ContactBoardMembershipDto[];
  evaluated: number;
  added: number;
  moved: number;
  ignored: number;
  conflicts: number;
}

export interface BoardRuleSyncResult {
  evaluated: number;
  added: number;
  moved: number;
  ignored: number;
  conflicts: number;
}
```

- [ ] **Step 4: Implement converters and stage resolver**

Add:

```ts
type RuleConversationRecord = {
  id: string;
  workspaceId: string;
  contactId: string;
  channelId: string;
  tags: Array<{ tagId: string }>;
};

type RuleStageRecord = {
  id: string;
  order: number;
  tagTriggers: Array<{ tagId: string }>;
};

type RuleBoardRecord = {
  id: string;
  workspaceId: string;
  isPrimaryPipeline: boolean;
  stages: RuleStageRecord[];
};

type RuleMembershipRecord = {
  id: string;
  workspaceId: string;
  contactId: string;
  boardId: string;
  stageId: string;
  isPrimary: boolean;
  lastMovedBy?: "manual" | "rule";
  lastRuleAppliedAt?: Date | string | null;
  updatedAt: Date | string;
};

function toIsoString(value: Date | string | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toMembershipDto(record: RuleMembershipRecord): ContactBoardMembershipDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    contactId: record.contactId,
    boardId: record.boardId,
    stageId: record.stageId,
    isPrimary: record.isPrimary,
    lastMovedBy: record.lastMovedBy ?? "manual",
    lastRuleAppliedAt: toIsoString(record.lastRuleAppliedAt),
    updatedAt: toIsoString(record.updatedAt) ?? new Date().toISOString()
  };
}

function resolveWinningStage(board: RuleBoardRecord, tagIds: Set<string>) {
  return [...board.stages]
    .filter((stage) => stage.tagTriggers.some((trigger) => tagIds.has(trigger.tagId)))
    .sort((left, right) => right.order - left.order)[0] ?? null;
}
```

- [ ] **Step 5: Implement `applyBoardRulesForConversationTags`**

Add:

```ts
export function createBoardRulesService(prisma: PrismaLike) {
  async function applyBoardRulesForConversationTags(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<BoardRuleApplyResult> {
    const conversation = await prisma.conversation.findFirst({
      where: { workspaceId: input.workspaceId, id: input.conversationId },
      include: { tags: true }
    });

    if (!conversation) {
      return { updatedMemberships: [], evaluated: 0, added: 0, moved: 0, ignored: 0, conflicts: 0 };
    }

    return applyRulesForConversationRecord(conversation);
  }

  async function applyRulesForConversationRecord(conversation: RuleConversationRecord): Promise<BoardRuleApplyResult> {
    const tagIds = new Set(conversation.tags.map((tag) => tag.tagId));
    if (tagIds.size === 0) {
      return { updatedMemberships: [], evaluated: 1, added: 0, moved: 0, ignored: 1, conflicts: 0 };
    }

    const boards = await prisma.contactBoard.findMany({
      where: {
        workspaceId: conversation.workspaceId,
        channels: { some: { channelId: conversation.channelId } }
      },
      include: {
        channels: true,
        stages: {
          orderBy: { order: "asc" },
          include: { tagTriggers: true }
        }
      }
    });

    const updatedMemberships: ContactBoardMembershipDto[] = [];
    let added = 0;
    let moved = 0;
    let ignored = 0;

    for (const board of boards) {
      const targetStage = resolveWinningStage(board, tagIds);
      if (!targetStage) {
        ignored += 1;
        continue;
      }

      const currentMembership = await prisma.contactBoardMembership.findFirst({
        where: {
          workspaceId: conversation.workspaceId,
          contactId: conversation.contactId,
          boardId: board.id
        }
      });

      const currentStage = currentMembership
        ? board.stages.find((stage: { id: string }) => stage.id === currentMembership.stageId)
        : null;

      if (currentStage && currentStage.order >= targetStage.order) {
        ignored += 1;
        continue;
      }

      const membership = await prisma.$transaction(async (tx: PrismaLike) => {
        if (board.isPrimaryPipeline) {
          await tx.contactBoardMembership.updateMany({
            where: {
              workspaceId: conversation.workspaceId,
              contactId: conversation.contactId,
              isPrimary: true
            },
            data: { isPrimary: false }
          });
        }

        return tx.contactBoardMembership.upsert({
          where: {
            workspaceId_contactId_boardId: {
              workspaceId: conversation.workspaceId,
              contactId: conversation.contactId,
              boardId: board.id
            }
          },
          create: {
            workspaceId: conversation.workspaceId,
            contactId: conversation.contactId,
            boardId: board.id,
            stageId: targetStage.id,
            isPrimary: board.isPrimaryPipeline,
            lastMovedBy: "rule",
            lastRuleAppliedAt: new Date()
          },
          update: {
            stageId: targetStage.id,
            isPrimary: board.isPrimaryPipeline,
            lastMovedBy: "rule",
            lastRuleAppliedAt: new Date()
          }
        });
      });

      updatedMemberships.push(toMembershipDto(membership));
      if (currentMembership) moved += 1;
      else added += 1;
    }

    return {
      updatedMemberships,
      evaluated: 1,
      added,
      moved,
      ignored,
      conflicts: 0
    };
  }

  return { applyBoardRulesForConversationTags, syncBoardRules };
}
```

- [ ] **Step 6: Implement `syncBoardRules`**

Inside `createBoardRulesService`, add before the return:

```ts
async function syncBoardRules(input: {
  workspaceId: string;
  boardId: string;
  scope: Scope;
  publish?: (event: RealtimeEvent) => void;
}): Promise<BoardRuleSyncResult> {
  const board = await prisma.contactBoard.findFirst({
    where: { workspaceId: input.workspaceId, id: input.boardId }
  });

  if (!board) {
    throw new Error("BOARD_NOT_FOUND");
  }

  const statusWhere =
    input.scope === "active"
      ? { in: activeConversationStatuses }
      : input.scope === "closed"
        ? "closed"
        : undefined;

  const conversations = await prisma.conversation.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(statusWhere ? { status: statusWhere } : {})
    },
    include: { tags: true }
  });

  const summary: BoardRuleSyncResult = { evaluated: 0, added: 0, moved: 0, ignored: 0, conflicts: 0 };

  for (const conversation of conversations) {
    const result = await applyRulesForConversationRecord(conversation);
    summary.evaluated += result.evaluated;
    summary.added += result.added;
    summary.moved += result.moved;
    summary.ignored += result.ignored;
    summary.conflicts += result.conflicts;

    for (const membership of result.updatedMemberships) {
      input.publish?.({
        type: "board_membership.updated",
        workspaceId: input.workspaceId,
        payload: membership
      });
    }
  }

  return summary;
}
```

- [ ] **Step 7: Wire sync route to rule service**

In `apps/api/src/modules/boards/boards.routes.ts`, import:

```ts
import { createBoardRulesService } from "./board-rules.service.js";
```

Create both services:

```ts
const service = createBoardsService(app.prisma as unknown as PrismaLike);
const ruleService = createBoardRulesService(app.prisma);
```

Change sync route to:

```ts
return await ruleService.syncBoardRules({
  workspaceId: request.talk.workspaceId,
  boardId: params.data.boardId,
  scope: body.data.scope,
  publish: (event) => app.realtime.publish(event)
});
```

When the board is missing, throw `new BoardsServiceError("BOARD_NOT_FOUND", "Board not found.")` directly from the rule service so the existing route error mapper returns 404.

- [ ] **Step 8: Run rule tests**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/api exec vitest run src/modules/boards/board-rules.service.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/boards/board-rules.service.ts apps/api/src/modules/boards/board-rules.service.test.ts apps/api/src/modules/boards/boards.routes.ts apps/api/src/modules/boards/boards.service.ts
git commit -m "feat: apply contact board tag rules"
```

---

### Task 5: Trigger Board Rules When Tags Are Applied

**Files:**
- Modify: `apps/api/src/modules/conversations/conversations.service.ts`
- Modify: `apps/api/src/modules/conversations/conversations.service.test.ts`
- Modify: `apps/api/src/modules/conversations/conversations.routes.ts`
- Modify: `apps/api/src/modules/agents/agent-tool-executor.ts`
- Modify: `apps/api/src/modules/agents/agent-tool-executor.test.ts`
- Modify: `apps/api/src/modules/automations/automation-runner.ts`
- Modify: `apps/api/src/modules/automations/automation-runner.test.ts`

- [ ] **Step 1: Write failing conversation action test**

In `apps/api/src/modules/conversations/conversations.service.test.ts`, add:

```ts
it("returns applied tag metadata so board rules can run after adding a tag", async () => {
  const prisma = createMockPrisma();
  const service = createConversationsService(prisma);

  const result = await service.runConversationAction({
    workspaceId: "workspace_a",
    conversationId: "conversation_1",
    currentClerkUserId: "clerk_user",
    action: "add_tag",
    name: "lead_quente"
  });

  expect(result.appliedTag).toEqual({
    conversationId: "conversation_1",
    tagId: "tag_1"
  });
});
```

- [ ] **Step 2: Update conversation action result type**

In `apps/api/src/modules/conversations/conversations.service.ts`, extend `ConversationActionResultDto`:

```ts
appliedTag?: {
  conversationId: string;
  tagId: string;
};
boardMemberships?: ContactBoardMembershipDto[];
```

Inside the `add_tag` action, after upsert:

```ts
appliedTag = {
  conversationId: input.conversationId,
  tagId: tag.id
};
```

Return it:

```ts
return {
  conversation: toConversationDto(updatedConversation),
  context,
  ...(appliedTag ? { appliedTag } : {}),
  ...(boardMemberships.length > 0 ? { boardMemberships } : {}),
  ...
};
```

- [ ] **Step 3: Wire conversations route to board rules**

In `apps/api/src/modules/conversations/conversations.routes.ts`, import `createBoardRulesService`.

After a successful `service.runConversationAction`, add:

```ts
if (result.appliedTag) {
  const ruleService = createBoardRulesService(app.prisma);
  const boardRuleResult = await ruleService.applyBoardRulesForConversationTags({
    workspaceId: request.talk.workspaceId,
    conversationId: result.appliedTag.conversationId
  });

  for (const membership of boardRuleResult.updatedMemberships) {
    app.realtime.publish({
      type: "board_membership.updated",
      workspaceId: request.talk.workspaceId,
      payload: membership
    });
  }
}
```

Do this before returning `result`.

- [ ] **Step 4: Update agent tool executor to report applied tags**

In `apps/api/src/modules/agents/agent-tool-executor.ts`, change the completed add tag result from:

```ts
return { type: "add_tag", status: "completed" };
```

to:

```ts
return {
  type: "add_tag",
  status: "completed",
  conversationId: input.conversationId,
  tagId: allowedTag.id
};
```

Update the relevant tests to expect the extra fields:

```ts
expect(results).toEqual([
  {
    type: "add_tag",
    status: "completed",
    conversationId: "conversation_1",
    tagId: "tag_allowed_ai"
  }
]);
```

- [ ] **Step 5: Call board rules from automation runner**

In `apps/api/src/modules/automations/automation-runner.ts`, add an optional dependency:

```ts
boardRules?: {
  applyBoardRulesForConversationTags(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<BoardRuleApplyResult>;
};
```

After `conversationTag.create` succeeds in the `add_tag` node:

```ts
await options.boardRules?.applyBoardRulesForConversationTags({
  workspaceId: context.workspaceId,
  conversationId: context.conversationId
});
```

Add test expectation:

```ts
expect(boardRules.applyBoardRulesForConversationTags).toHaveBeenCalledWith({
  workspaceId: "workspace_a",
  conversationId: "conversation_1"
});
```

- [ ] **Step 6: Run focused API tests**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/api exec vitest run src/modules/conversations/conversations.service.test.ts src/modules/agents/agent-tool-executor.test.ts src/modules/automations/automation-runner.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/conversations/conversations.service.ts apps/api/src/modules/conversations/conversations.service.test.ts apps/api/src/modules/conversations/conversations.routes.ts apps/api/src/modules/agents/agent-tool-executor.ts apps/api/src/modules/agents/agent-tool-executor.test.ts apps/api/src/modules/automations/automation-runner.ts apps/api/src/modules/automations/automation-runner.test.ts
git commit -m "feat: trigger board rules from applied tags"
```

---

### Task 6: Board UI Helpers And API State

**Files:**
- Create: `apps/web/src/features/contacts/board-display.ts`
- Test: `apps/web/src/features/contacts/board-display.test.ts`
- Modify: `apps/web/src/features/contacts/ContactsPage.tsx`

- [ ] **Step 1: Write helper tests**

Create `apps/web/src/features/contacts/board-display.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  findDuplicateStageTag,
  formatBoardChannelLabel,
  stageTagIdsByStage
} from "./board-display";

describe("board display helpers", () => {
  it("formats channel labels for board chips", () => {
    expect(
      formatBoardChannelLabel({
        id: "channel_1",
        displayName: "WhatsApp Vendas",
        provider: "evolution",
        phoneNumber: "+5511999990000"
      })
    ).toBe("WhatsApp Vendas");
  });

  it("detects duplicate stage tags inside one board", () => {
    const duplicate = findDuplicateStageTag(
      {
        stage_a: ["tag_hot"],
        stage_b: ["tag_warm"]
      },
      "stage_b",
      ["tag_hot", "tag_warm"]
    );

    expect(duplicate).toEqual({ tagId: "tag_hot", stageId: "stage_a" });
  });

  it("indexes tag ids by stage", () => {
    expect(
      stageTagIdsByStage([
        { id: "stage_a", tagTriggers: [{ id: "tag_hot" }] },
        { id: "stage_b", tagTriggers: [] }
      ])
    ).toEqual({ stage_a: ["tag_hot"], stage_b: [] });
  });
});
```

- [ ] **Step 2: Implement helpers**

Create `apps/web/src/features/contacts/board-display.ts`:

```ts
import type { ContactBoardChannelSummaryDto, ContactBoardStageDto } from "@prymeira-talk/shared";

export function formatBoardChannelLabel(channel: ContactBoardChannelSummaryDto) {
  return channel.displayName ?? channel.phoneNumber ?? channel.provider;
}

export function stageTagIdsByStage(
  stages: Array<Pick<ContactBoardStageDto, "id" | "tagTriggers">>
) {
  return Object.fromEntries(
    stages.map((stage) => [stage.id, stage.tagTriggers.map((tag) => tag.id)])
  );
}

export function findDuplicateStageTag(
  tagIdsByStage: Record<string, string[]>,
  currentStageId: string,
  nextTagIds: string[]
) {
  const nextTagSet = new Set(nextTagIds);

  for (const [stageId, tagIds] of Object.entries(tagIdsByStage)) {
    if (stageId === currentStageId) continue;
    const duplicatedTagId = tagIds.find((tagId) => nextTagSet.has(tagId));
    if (duplicatedTagId) {
      return { tagId: duplicatedTagId, stageId };
    }
  }

  return null;
}
```

- [ ] **Step 3: Add UI state for board rules**

In `ContactsPage.tsx`, extend form state:

```ts
interface BoardFormState {
  name: string;
  description: string;
  channelIds: string[];
  isPrimaryPipeline: boolean;
}

interface StageFormState {
  name: string;
  color: string;
  tagIds: string[];
}
```

Update empty states:

```ts
const emptyBoardForm: BoardFormState = {
  name: "",
  description: "",
  channelIds: [],
  isPrimaryPipeline: false
};

const emptyStageForm: StageFormState = {
  name: "",
  color: "#24564a",
  tagIds: []
};
```

- [ ] **Step 4: Populate edit forms from DTOs**

Update selected board effect:

```ts
setBoardEditForm(
  selectedBoard
    ? {
        name: selectedBoard.name,
        description: selectedBoard.description ?? "",
        channelIds: selectedBoard.channels.map((channel) => channel.id),
        isPrimaryPipeline: selectedBoard.isPrimaryPipeline
      }
    : emptyBoardForm
);
```

Update stage forms:

```ts
setStageEditForms(
  Object.fromEntries(
    boardStages.map((stage) => [
      stage.id,
      {
        name: stage.name,
        color: stage.color,
        tagIds: stage.tagTriggers.map((tag) => tag.id)
      }
    ])
  )
);
```

- [ ] **Step 5: Send rule payloads in create/update calls**

Update `apiCreateBoard` call:

```ts
const board = await apiCreateBoard(getToken, {
  name,
  description: newBoardForm.description,
  channelIds: newBoardForm.channelIds,
  isPrimaryPipeline: newBoardForm.isPrimaryPipeline
});
```

Update `apiUpdateBoard` call:

```ts
const board = await apiUpdateBoard(getToken, selectedBoard.id, {
  name,
  description: boardEditForm.description,
  channelIds: boardEditForm.channelIds,
  isPrimaryPipeline: boardEditForm.isPrimaryPipeline
});
```

Update stage create/update calls:

```ts
const stage = await apiCreateBoardStage(getToken, selectedBoardId, {
  name,
  color,
  order: boardStages.length,
  tagIds: newStageForm.tagIds
});
```

```ts
const stage = await apiUpdateBoardStage(getToken, selectedBoardId, stageId, {
  name: form.name,
  color: form.color,
  tagIds: form.tagIds
});
```

- [ ] **Step 6: Run helper and page tests**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/web exec vitest run src/features/contacts/board-display.test.ts src/app/api.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/contacts/board-display.ts apps/web/src/features/contacts/board-display.test.ts apps/web/src/features/contacts/ContactsPage.tsx
git commit -m "feat: prepare board rule UI state"
```

---

### Task 7: Board UI Controls And Visual Polish

**Files:**
- Modify: `apps/web/src/features/contacts/ContactsPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/features/contacts/board-display.test.ts`

- [ ] **Step 1: Add board command bar chips and sync button**

In `ContactsPage.tsx`, import `apiSyncBoardRules` and helper `formatBoardChannelLabel`.

Render after board selector:

```tsx
<div className="board-rule-summary" aria-label="Regras do board selecionado">
  {selectedBoard?.channels.length ? (
    selectedBoard.channels.map((channel) => (
      <span className="board-rule-chip" key={channel.id}>
        {formatBoardChannelLabel(channel)}
      </span>
    ))
  ) : (
    <span className="board-rule-chip is-muted">Sem canais</span>
  )}
  {selectedBoard?.isPrimaryPipeline ? (
    <span className="board-rule-chip is-primary">Funil principal</span>
  ) : null}
</div>
```

Add a `Sincronizar` action button:

```tsx
<button
  className={boardPanelMode === "sync-rules" ? "is-active" : ""}
  disabled={!selectedBoard}
  onClick={() => setBoardPanelMode((current) => current === "sync-rules" ? null : "sync-rules")}
  type="button"
>
  <RefreshCw size={16} aria-hidden="true" />
  Sincronizar
</button>
```

Extend `BoardPanelMode` with `"sync-rules"`.

- [ ] **Step 2: Add board rules fields in manage panel**

Inside the edit-board form, add:

```tsx
<fieldset className="board-rules-fieldset">
  <legend>Regras do board</legend>
  <label className="board-toggle-row">
    <input
      checked={boardEditForm.isPrimaryPipeline}
      disabled={!selectedBoard || isBoardSaving}
      onChange={(event) =>
        setBoardEditForm((current) => ({
          ...current,
          isPrimaryPipeline: event.target.checked
        }))
      }
      type="checkbox"
    />
    Usar como funil principal
  </label>
  <div className="board-checkbox-grid">
    {channels.map((channel) => (
      <label key={channel.id}>
        <input
          checked={boardEditForm.channelIds.includes(channel.id)}
          disabled={!selectedBoard || isBoardSaving}
          onChange={(event) =>
            setBoardEditForm((current) => ({
              ...current,
              channelIds: event.target.checked
                ? [...current.channelIds, channel.id]
                : current.channelIds.filter((channelId) => channelId !== channel.id)
            }))
          }
          type="checkbox"
        />
        {channel.displayName ?? channel.phoneNumber ?? channel.provider}
      </label>
    ))}
  </div>
</fieldset>
```

Add the same channel and primary fields to the create-board panel.

- [ ] **Step 3: Add stage tag editor controls**

Use existing tags endpoint if available in `api.ts`; if no tag list helper exists, add `apiGetTags(getToken)` using `tagSchema.array()`.

Render in create-stage and stage edit UI:

```tsx
<div className="stage-tag-picker">
  {tags.map((tag) => (
    <label key={tag.id}>
      <input
        checked={newStageForm.tagIds.includes(tag.id)}
        onChange={(event) =>
          setNewStageForm((current) => ({
            ...current,
            tagIds: event.target.checked
              ? [...current.tagIds, tag.id]
              : current.tagIds.filter((tagId) => tagId !== tag.id)
          }))
        }
        type="checkbox"
      />
      <span style={{ backgroundColor: tag.color }} aria-hidden="true" />
      {tag.name}
    </label>
  ))}
</div>
```

Before saving a stage, call `findDuplicateStageTag`. If duplicate exists:

```ts
setBoardError("Esta tag já está ligada a outra etapa deste board.");
return;
```

- [ ] **Step 4: Add sync panel and handler**

Add state:

```ts
const [syncScope, setSyncScope] = useState<BoardSyncScope>("active");
const [syncResult, setSyncResult] = useState<BoardSyncResultDto | null>(null);
```

Add handler:

```ts
async function handleSyncBoardRules(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (!selectedBoard) return;

  setIsBoardSaving(true);
  setBoardError(null);
  setSyncResult(null);

  try {
    const result = await apiSyncBoardRules(getToken, selectedBoard.id, syncScope);
    setSyncResult(result);
    setSaveMessage(`Sincronizacao concluida: ${result.added} adicionados, ${result.moved} movidos.`);
    await apiGetBoardContacts(getToken, selectedBoard.id).then(setBoardContacts);
  } catch (syncError) {
    setBoardError(syncError instanceof Error ? syncError.message : "Nao foi possivel sincronizar o board.");
  } finally {
    setIsBoardSaving(false);
  }
}
```

Render:

```tsx
{boardPanelMode === "sync-rules" ? (
  <form className="board-sync-form" onSubmit={handleSyncBoardRules}>
    <label>
      Escopo
      <select value={syncScope} onChange={(event) => setSyncScope(event.target.value as BoardSyncScope)}>
        <option value="active">Ativas</option>
        <option value="closed">Finalizadas</option>
        <option value="all">Todas</option>
      </select>
    </label>
    <button className="secondary-button icon-button-label" disabled={isBoardSaving} type="submit">
      <RefreshCw size={16} aria-hidden="true" />
      Sincronizar agora
    </button>
    {syncResult ? (
      <p className="board-sync-result">
        {syncResult.evaluated} avaliados, {syncResult.added} adicionados, {syncResult.moved} movidos, {syncResult.ignored} sem mudanca.
      </p>
    ) : null}
  </form>
) : null}
```

- [ ] **Step 5: Replace stage header with rich header**

Change each `board-column header` content to:

```tsx
<div className="stage-rich-heading">
  <span className="stage-color-swatch" style={{ backgroundColor: stage.color }} aria-hidden="true" />
  <div>
    <strong>{stage.name}</strong>
    <div className="stage-tag-chips">
      {stage.tagTriggers.length > 0 ? (
        stage.tagTriggers.map((tag) => (
          <span key={tag.id}>{tag.name}</span>
        ))
      ) : (
        <span className="is-muted">Manual</span>
      )}
    </div>
  </div>
</div>
<span className="stage-count-pill">{memberships.length}</span>
```

Move edit inputs into the stage edit panel instead of keeping them always visible in every column header.

- [ ] **Step 6: Add CSS**

In `apps/web/src/styles.css`, add:

```css
.board-rule-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.board-rule-chip,
.stage-tag-chips span {
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-full);
  background: var(--color-brand-50);
  color: var(--color-brand-700);
  font-size: 11px;
  font-weight: 700;
  padding: 3px 8px;
}

.board-rule-chip.is-muted,
.stage-tag-chips .is-muted {
  background: var(--color-surface-subtle);
  color: var(--color-text-muted);
}

.board-rule-chip.is-primary {
  background: #e7f7ed;
  color: #1f6b45;
}

.board-rules-fieldset {
  display: grid;
  gap: 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 12px;
}

.board-checkbox-grid,
.stage-tag-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.board-checkbox-grid label,
.stage-tag-picker label,
.board-toggle-row {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface-card);
  padding: 5px 10px;
  text-transform: none;
}

.contacts-board {
  grid-auto-columns: minmax(300px, 360px);
}

.board-column header {
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: start;
}

.stage-rich-heading {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
}

.stage-rich-heading strong {
  display: block;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.25;
  white-space: normal;
}

.stage-color-swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  margin-top: 2px;
}

.stage-tag-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}

.board-contact strong {
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.board-sync-form {
  display: grid;
  grid-template-columns: minmax(140px, 220px) auto minmax(0, 1fr);
  gap: 10px;
  align-items: end;
}

.board-sync-result {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}
```

- [ ] **Step 7: Run web tests and build**

Run:

```bash
npx pnpm@10.0.0 --filter @prymeira-talk/web exec vitest run src/features/contacts/board-display.test.ts src/app/api.test.ts
npx pnpm@10.0.0 --filter @prymeira-talk/web build
```

Expected: PASS. Vite may emit existing chunk-size warnings.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/contacts/ContactsPage.tsx apps/web/src/styles.css apps/web/src/app/api.ts apps/web/src/app/api.test.ts apps/web/src/features/contacts/board-display.ts apps/web/src/features/contacts/board-display.test.ts
git commit -m "feat: add intelligent board controls"
```

---

### Task 8: Full Verification And Push

**Files:**
- No source changes expected unless verification finds regressions.

- [ ] **Step 1: Regenerate Prisma after schema changes**

Run:

```bash
npx pnpm@10.0.0 prisma:generate
```

Expected: Generated Prisma Client successfully.

- [ ] **Step 2: Run all tests**

Run:

```bash
npx pnpm@10.0.0 -r test
```

Expected: all shared, API, and web tests pass.

- [ ] **Step 3: Run all builds**

Run:

```bash
npx pnpm@10.0.0 -r build
```

Expected: all TypeScript builds pass; Vite chunk-size warnings are acceptable if unchanged.

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short --branch
```

Expected: only intended tracked changes are present; `.DS_Store`, `tmp/`, and `.superpowers/` files are not staged.

- [ ] **Step 5: Push branch**

Run:

```bash
git push origin codex/prymeira-talk-foundation
```

Expected: branch pushes successfully.
