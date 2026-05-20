# Prymeira Talk Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working vertical slice of Prymeira Talk: monorepo, API, auth/tenant enforcement, database schema, realtime events, Evolution webhook ingestion, and a minimal operational inbox UI.

**Architecture:** Create a dedicated monorepo with `apps/web`, `apps/api`, and `packages/shared`. The API is the security boundary: it validates Clerk tokens, checks Prymeira Account access for `product_key: talk`, resolves `workspace_id`, filters every tenant-owned query, stores messages in Postgres through Prisma, and broadcasts realtime workspace events over WebSocket. The web app authenticates with Clerk, calls only the Talk API, and renders the WhatsApp-style inbox.

**Tech Stack:** pnpm workspaces, TypeScript, React/Vite, Fastify, Prisma/Postgres, Vitest, Zod, Clerk, `@prymeira/auth`, `@fastify/websocket`, WebSocket, Evolution API webhooks.

---

## Scope Split

The approved design covers a full MVP. This plan intentionally builds the foundation vertical slice first so the product becomes runnable and testable before adding higher-order modules.

This plan includes:

- repo/tooling scaffold.
- shared domain and realtime contracts.
- API health, env, auth context, role checks.
- Prisma schema for core inbox entities.
- tenant-safe conversation/message services.
- WebSocket event hub.
- Evolution webhook ingestion with idempotency.
- minimal React inbox shell wired to API and realtime.

Follow-up plans should cover:

- automations and linear flow runner.
- AI assistant actions.
- Atomic CRM integration.
- channels/settings/team management UI.
- reports and deployment hardening.

## File Structure

Create this structure:

```txt
package.json
pnpm-workspace.yaml
tsconfig.base.json
.env.example
docker-compose.dev.yml
README.md
apps/
  api/
    package.json
    tsconfig.json
    vitest.config.ts
    prisma/schema.prisma
    src/
      app.ts
      server.ts
      env.ts
      plugins/auth-context.ts
      plugins/prisma.ts
      modules/access/roles.ts
      modules/conversations/conversations.routes.ts
      modules/conversations/conversations.service.ts
      modules/evolution/evolution.schemas.ts
      modules/evolution/evolution.routes.ts
      modules/realtime/realtime-hub.ts
      modules/realtime/realtime.routes.ts
      test/build-app.ts
  web/
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    src/
      main.tsx
      app/App.tsx
      app/api.ts
      app/auth.tsx
      features/inbox/InboxPage.tsx
      features/inbox/useRealtimeEvents.ts
      styles.css
packages/
  shared/
    package.json
    tsconfig.json
    vitest.config.ts
    src/domain.ts
    src/realtime.ts
    src/index.ts
    src/domain.test.ts
```

## Task 1: Monorepo Tooling

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.env.example`
- Create: `docker-compose.dev.yml`
- Modify: `README.md`

- [ ] **Step 1: Create root package metadata**

Create `package.json`:

```json
{
  "name": "prymeira-talk",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "pnpm --parallel dev",
    "dev:api": "pnpm --filter @prymeira-talk/api dev",
    "dev:web": "pnpm --filter @prymeira-talk/web dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "prisma:generate": "pnpm --filter @prymeira-talk/api prisma generate",
    "prisma:migrate": "pnpm --filter @prymeira-talk/api prisma migrate dev"
  },
  "devDependencies": {
    "@types/node": "^22.16.5",
    "typescript": "^5.8.3"
  },
  "packageManager": "pnpm@10.0.0"
}
```

- [ ] **Step 2: Create pnpm workspace**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create shared TypeScript config**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

- [ ] **Step 4: Create local env example**

Create `.env.example`:

```txt
DATABASE_URL=postgresql://postgres:postgres@localhost:54329/prymeira_talk
API_PORT=3002
API_HOST=0.0.0.0
CORS_ORIGINS=http://localhost:5176
PRYMEIRA_ACCOUNT_API_URL=http://localhost:3001
PRYMEIRA_PRODUCT_KEY=talk
CLERK_SECRET_KEY=sk_test_replace_me
VITE_CLERK_PUBLISHABLE_KEY=pk_test_replace_me
VITE_API_URL=http://localhost:3002
EVOLUTION_WEBHOOK_SECRET=replace_me
```

- [ ] **Step 5: Create local Postgres compose**

Create `docker-compose.dev.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: prymeira_talk
    ports:
      - "54329:5432"
    volumes:
      - prymeira-talk-postgres:/var/lib/postgresql/data

volumes:
  prymeira-talk-postgres:
```

- [ ] **Step 6: Add README startup notes**

Create or replace `README.md`:

```md
# Prymeira Talk

Prymeira Talk is a multi-company WhatsApp operations SaaS for the Prymeira ecosystem.

## Local Development

1. Install dependencies:

```sh
pnpm install
```

2. Create `.env` from `.env.example`.

3. Start local Postgres:

```sh
docker compose -f docker-compose.dev.yml up -d
```

4. Generate Prisma client and run migrations:

```sh
pnpm prisma:generate
pnpm prisma:migrate
```

5. Start apps:

```sh
pnpm dev
```

Local URLs:

- API: `http://localhost:3002`
- Web: `http://localhost:5176`

Auth rule: Clerk authenticates, Prymeira Account authorizes `product_key=talk`, Prymeira Talk enforces workspace data boundaries in the API.
```

- [ ] **Step 7: Run install**

Run:

```sh
pnpm install
```

Expected: lockfile created and no dependency resolution errors.

- [ ] **Step 8: Commit tooling**

Run:

```sh
git add package.json pnpm-workspace.yaml tsconfig.base.json .env.example docker-compose.dev.yml README.md pnpm-lock.yaml
git commit -m "chore: scaffold Prymeira Talk workspace"
```

## Task 2: Shared Domain Contracts

**Files:**

- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/domain.ts`
- Create: `packages/shared/src/realtime.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/domain.test.ts`

- [ ] **Step 1: Create shared package**

Create `packages/shared/package.json`:

```json
{
  "name": "@prymeira-talk/shared",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^4.1.12"
  },
  "devDependencies": {
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 2: Create shared tsconfig**

Create `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Create shared Vitest config**

Create `packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node"
  }
});
```

- [ ] **Step 4: Write failing domain tests**

Create `packages/shared/src/domain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { conversationSchema, messageSchema } from "./domain";

describe("domain schemas", () => {
  it("accepts a tenant-owned open conversation", () => {
    const parsed = conversationSchema.parse({
      id: "conv_1",
      workspaceId: "workspace_1",
      channelId: "channel_1",
      contactId: "contact_1",
      status: "open",
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: "2026-05-20T12:00:00.000Z",
      lastMessagePreview: "Oi",
      unreadCount: 2,
      priority: "normal"
    });

    expect(parsed.workspaceId).toBe("workspace_1");
  });

  it("rejects an outbound message without a workspace id", () => {
    expect(() =>
      messageSchema.parse({
        id: "msg_1",
        conversationId: "conv_1",
        direction: "outbound",
        type: "text",
        body: "Oi",
        status: "pending",
        createdAt: "2026-05-20T12:00:00.000Z"
      })
    ).toThrow();
  });
});
```

- [ ] **Step 5: Run tests to verify failure**

Run:

```sh
pnpm --filter @prymeira-talk/shared test
```

Expected: FAIL because `./domain` does not exist.

- [ ] **Step 6: Implement domain schemas**

Create `packages/shared/src/domain.ts`:

```ts
import { z } from "zod";

export const userRoleSchema = z.enum(["owner", "manager", "agent"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const conversationStatusSchema = z.enum(["open", "pending", "closed"]);
export const conversationPrioritySchema = z.enum(["low", "normal", "high"]);

export const messageDirectionSchema = z.enum(["inbound", "outbound"]);
export const messageTypeSchema = z.enum(["text", "image", "audio", "file", "template", "system", "internal_note"]);
export const messageStatusSchema = z.enum(["pending", "sent", "delivered", "read", "failed"]);

export const conversationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  contactId: z.string().min(1),
  status: conversationStatusSchema,
  assignedUserId: z.string().nullable(),
  departmentId: z.string().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
  lastMessagePreview: z.string().nullable(),
  unreadCount: z.number().int().min(0),
  priority: conversationPrioritySchema
});
export type ConversationDto = z.infer<typeof conversationSchema>;

export const messageSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  providerMessageId: z.string().nullable().optional(),
  direction: messageDirectionSchema,
  type: messageTypeSchema,
  body: z.string().nullable(),
  mediaUrl: z.string().url().nullable().optional(),
  status: messageStatusSchema,
  sentByUserId: z.string().nullable().optional(),
  createdAt: z.string().datetime()
});
export type MessageDto = z.infer<typeof messageSchema>;
```

- [ ] **Step 7: Implement realtime event schemas**

Create `packages/shared/src/realtime.ts`:

```ts
import { z } from "zod";
import { conversationSchema, messageSchema } from "./domain";

export const realtimeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.created"),
    workspaceId: z.string().min(1),
    payload: messageSchema
  }),
  z.object({
    type: z.literal("message.status_changed"),
    workspaceId: z.string().min(1),
    payload: z.object({
      messageId: z.string().min(1),
      status: z.enum(["pending", "sent", "delivered", "read", "failed"])
    })
  }),
  z.object({
    type: z.literal("conversation.updated"),
    workspaceId: z.string().min(1),
    payload: conversationSchema
  })
]);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
```

- [ ] **Step 8: Export shared contracts**

Create `packages/shared/src/index.ts`:

```ts
export * from "./domain";
export * from "./realtime";
```

- [ ] **Step 9: Run shared tests**

Run:

```sh
pnpm --filter @prymeira-talk/shared test
pnpm --filter @prymeira-talk/shared typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit shared contracts**

Run:

```sh
git add packages/shared
git commit -m "feat: add shared Talk domain contracts"
```

## Task 3: API Scaffold And Health

**Files:**

- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/test/build-app.ts`
- Create: `apps/api/src/app.test.ts`

- [ ] **Step 1: Create API package**

Create `apps/api/package.json`:

```json
{
  "name": "@prymeira-talk/api",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prisma": "prisma"
  },
  "dependencies": {
    "@fastify/cors": "^11.1.0",
    "@fastify/websocket": "^11.2.0",
    "@prymeira-talk/shared": "workspace:*",
    "@prymeira/auth": "file:../../../Prymeira Account/packages/auth",
    "@prisma/client": "^6.19.0",
    "fastify": "^5.6.2",
    "zod": "^4.1.12"
  },
  "devDependencies": {
    "prisma": "^6.19.0",
    "tsx": "^4.21.0",
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 2: Create API tsconfig**

Create `apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "moduleResolution": "NodeNext",
    "module": "NodeNext"
  },
  "include": ["src", "prisma"]
}
```

- [ ] **Step 3: Create API Vitest config**

Create `apps/api/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node"
  }
});
```

- [ ] **Step 4: Write failing health test**

Create `apps/api/src/app.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "./test/build-app";

describe("app", () => {
  it("returns health status", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, product: "talk" });
  });
});
```

- [ ] **Step 5: Run test to verify failure**

Run:

```sh
pnpm --filter @prymeira-talk/api test
```

Expected: FAIL because `./test/build-app` does not exist.

- [ ] **Step 6: Implement env parsing**

Create `apps/api/src/env.ts`:

```ts
import { z } from "zod";

export const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3002),
  CORS_ORIGINS: z.string().default("http://localhost:5176"),
  DATABASE_URL: z.string().min(1),
  PRYMEIRA_ACCOUNT_API_URL: z.string().url(),
  PRYMEIRA_PRODUCT_KEY: z.string().default("talk"),
  CLERK_SECRET_KEY: z.string().min(1),
  EVOLUTION_WEBHOOK_SECRET: z.string().min(1)
});

export type AppEnv = z.infer<typeof envSchema>;

export function readEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(input);
}
```

- [ ] **Step 7: Implement Fastify app**

Create `apps/api/src/app.ts`:

```ts
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppEnv } from "./env";

export async function createApp(env: AppEnv) {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  });

  app.get("/health", async () => ({ ok: true, product: env.PRYMEIRA_PRODUCT_KEY }));

  return app;
}
```

- [ ] **Step 8: Implement test app builder**

Create `apps/api/src/test/build-app.ts`:

```ts
import { createApp } from "../app";
import type { AppEnv } from "../env";

export async function buildApp(overrides: Partial<AppEnv> = {}) {
  return createApp({
    API_HOST: "127.0.0.1",
    API_PORT: 0,
    CORS_ORIGINS: "http://localhost:5176",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:54329/prymeira_talk",
    PRYMEIRA_ACCOUNT_API_URL: "http://localhost:3001",
    PRYMEIRA_PRODUCT_KEY: "talk",
    CLERK_SECRET_KEY: "sk_test_replace_me",
    EVOLUTION_WEBHOOK_SECRET: "test_secret",
    ...overrides
  });
}
```

- [ ] **Step 9: Implement API server entrypoint**

Create `apps/api/src/server.ts`:

```ts
import { createApp } from "./app";
import { readEnv } from "./env";

const env = readEnv();
const app = await createApp(env);

await app.listen({
  host: env.API_HOST,
  port: env.API_PORT
});
```

- [ ] **Step 10: Run API tests and typecheck**

Run:

```sh
pnpm install
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/api typecheck
```

Expected: PASS.

- [ ] **Step 11: Commit API scaffold**

Run:

```sh
git add apps/api package.json pnpm-lock.yaml
git commit -m "feat: add Talk API scaffold"
```

## Task 4: API Auth Context And Roles

**Files:**

- Create: `apps/api/src/plugins/auth-context.ts`
- Create: `apps/api/src/modules/access/roles.ts`
- Create: `apps/api/src/modules/access/roles.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/test/build-app.ts`

- [ ] **Step 1: Write failing role tests**

Create `apps/api/src/modules/access/roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canPerform } from "./roles";

describe("role permissions", () => {
  it("allows managers to assign conversations", () => {
    expect(canPerform("manager", "conversation.assign")).toBe(true);
  });

  it("blocks agents from managing automations", () => {
    expect(canPerform("agent", "automation.manage")).toBe(false);
  });

  it("allows owners to manage workspace settings", () => {
    expect(canPerform("owner", "workspace.manage")).toBe(true);
  });
});
```

- [ ] **Step 2: Run role test to verify failure**

Run:

```sh
pnpm --filter @prymeira-talk/api test src/modules/access/roles.test.ts
```

Expected: FAIL because `./roles` does not exist.

- [ ] **Step 3: Implement role permissions**

Create `apps/api/src/modules/access/roles.ts`:

```ts
import type { UserRole } from "@prymeira-talk/shared";

export type Permission =
  | "conversation.read"
  | "conversation.reply"
  | "conversation.assign"
  | "tag.manage"
  | "automation.manage"
  | "workspace.manage";

const permissionsByRole: Record<UserRole, Set<Permission>> = {
  owner: new Set([
    "conversation.read",
    "conversation.reply",
    "conversation.assign",
    "tag.manage",
    "automation.manage",
    "workspace.manage"
  ]),
  manager: new Set([
    "conversation.read",
    "conversation.reply",
    "conversation.assign",
    "tag.manage",
    "automation.manage"
  ]),
  agent: new Set(["conversation.read", "conversation.reply"])
};

export function canPerform(role: UserRole, permission: Permission) {
  return permissionsByRole[role].has(permission);
}
```

- [ ] **Step 4: Add auth context plugin**

Create `apps/api/src/plugins/auth-context.ts`:

```ts
import fp from "fastify-plugin";
import { requireProductAccess } from "@prymeira/auth";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

const workspaceAccessSchema = z.object({
  allowed: z.literal(true),
  product_key: z.string(),
  status: z.string(),
  plan: z.string().optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
  reason: z.string(),
  workspace_id: z.string().min(1).optional(),
  workspace_role: z.string().optional(),
  product_role: z.string().optional()
});

declare module "fastify" {
  interface FastifyRequest {
    talk: {
      workspaceId: string;
      role: "owner" | "manager" | "agent";
      clerkToken: string;
    };
  }
}

function readBearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }

  const query = request.query as { token?: string } | undefined;
  return query?.token ?? null;
}

function normalizeRole(role: string | undefined): "owner" | "manager" | "agent" {
  if (role === "owner" || role === "admin") return "owner";
  if (role === "manager") return "manager";
  return "agent";
}

async function resolveWorkspaceAccess(input: {
  accountApiUrl: string;
  productKey: string;
  clerkToken: string;
}) {
  const response = await fetch(`${input.accountApiUrl.replace(/\/$/, "")}/me/products`, {
    headers: {
      Authorization: `Bearer ${input.clerkToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to resolve workspace access: ${response.status}`);
  }

  const data = z
    .object({
      workspace: z.object({
        id: z.string().min(1),
        role: z.string().optional()
      }),
      products: z.array(
        z.object({
          product_key: z.string(),
          allowed: z.boolean(),
          workspace_id: z.string().min(1),
          workspace_role: z.string().optional(),
          product_role: z.string().optional()
        })
      )
    })
    .parse(await response.json());

  const product = data.products.find((item) => item.product_key === input.productKey);
  if (!product?.allowed) {
    throw new Error("Product access denied.");
  }

  return {
    workspaceId: product.workspace_id,
    role: normalizeRole(product.product_role ?? product.workspace_role ?? data.workspace.role)
  };
}

export const authContextPlugin = fp(async (app, options: { accountApiUrl: string; productKey: string }) => {
  app.decorateRequest("talk");

  app.addHook("preHandler", async (request) => {
    if (request.url === "/health" || request.url.startsWith("/webhooks/evolution")) {
      return;
    }

    const clerkToken = readBearerToken(request);
    const access = await requireProductAccess(options.productKey, {
      accountApiUrl: options.accountApiUrl,
      clerkToken
    });
    workspaceAccessSchema.parse(access);
    const workspaceAccess = await resolveWorkspaceAccess({
      accountApiUrl: options.accountApiUrl,
      productKey: options.productKey,
      clerkToken: clerkToken!
    });

    request.talk = {
      workspaceId: workspaceAccess.workspaceId,
      role: workspaceAccess.role,
      clerkToken: clerkToken!
    };
  });
});
```

- [ ] **Step 5: Register auth plugin in app**

Modify `apps/api/src/app.ts`:

```ts
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppEnv } from "./env";
import { authContextPlugin } from "./plugins/auth-context";

export async function createApp(env: AppEnv, options: { authEnabled?: boolean } = {}) {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  });

  app.get("/health", async () => ({ ok: true, product: env.PRYMEIRA_PRODUCT_KEY }));

  if (options.authEnabled !== false) {
    await app.register(authContextPlugin, {
      accountApiUrl: env.PRYMEIRA_ACCOUNT_API_URL,
      productKey: env.PRYMEIRA_PRODUCT_KEY
    });
  }

  app.get("/me", async (request) => ({
    workspaceId: request.talk.workspaceId,
    role: request.talk.role
  }));

  return app;
}
```

- [ ] **Step 6: Disable auth in health tests**

Modify `apps/api/src/test/build-app.ts`:

```ts
import { createApp } from "../app";
import type { AppEnv } from "../env";

export async function buildApp(overrides: Partial<AppEnv> = {}, options: { authEnabled?: boolean } = { authEnabled: false }) {
  return createApp(
    {
      API_HOST: "127.0.0.1",
      API_PORT: 0,
      CORS_ORIGINS: "http://localhost:5176",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:54329/prymeira_talk",
      PRYMEIRA_ACCOUNT_API_URL: "http://localhost:3001",
      PRYMEIRA_PRODUCT_KEY: "talk",
      CLERK_SECRET_KEY: "sk_test_replace_me",
      EVOLUTION_WEBHOOK_SECRET: "test_secret",
      ...overrides
    },
    options
  );
}
```

- [ ] **Step 7: Run API tests**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/api typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit auth context**

Run:

```sh
git add apps/api/src
git commit -m "feat: add Talk API auth context"
```

## Task 5: Prisma Core Schema

**Files:**

- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/plugins/prisma.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Create Prisma schema**

Create `apps/api/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  owner
  manager
  agent
}

enum ChannelProvider {
  evolution
}

enum ChannelStatus {
  disconnected
  connecting
  connected
  failed
}

enum ConversationStatus {
  open
  pending
  closed
}

enum ConversationPriority {
  low
  normal
  high
}

enum MessageDirection {
  inbound
  outbound
}

enum MessageType {
  text
  image
  audio
  file
  template
  system
  internal_note
}

enum MessageStatus {
  pending
  sent
  delivered
  read
  failed
}

model WorkspaceMirror {
  workspaceId String   @id @map("workspace_id")
  name        String?
  plan        String?
  limits      Json     @default("{}")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@map("workspace_mirrors")
}

model UserProfile {
  id            String   @id @default(uuid()) @db.Uuid
  workspaceId   String   @map("workspace_id")
  clerkUserId   String   @map("clerk_user_id")
  role          UserRole @default(agent)
  displayName   String   @map("display_name")
  avatarUrl     String?  @map("avatar_url")
  presenceState String   @default("offline") @map("presence_state")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  sentMessages Message[]

  @@unique([workspaceId, clerkUserId])
  @@index([workspaceId, role])
  @@map("user_profiles")
}

model Channel {
  id              String        @id @default(uuid()) @db.Uuid
  workspaceId     String        @map("workspace_id")
  provider        ChannelProvider
  providerKey     String        @map("provider_key")
  phoneNumber     String?       @map("phone_number")
  displayName     String?       @map("display_name")
  status          ChannelStatus @default(disconnected)
  encryptedConfig Json          @default("{}") @map("encrypted_config")
  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")

  conversations Conversation[]

  @@unique([workspaceId, provider, providerKey])
  @@index([workspaceId, status])
  @@map("channels")
}

model Contact {
  id                 String   @id @default(uuid()) @db.Uuid
  workspaceId        String   @map("workspace_id")
  name               String?
  phone              String
  email              String?
  company            String?
  avatarUrl          String?  @map("avatar_url")
  customFields       Json     @default("{}") @map("custom_fields")
  atomicCrmContactId String?  @map("atomic_crm_contact_id")
  atomicCrmLeadId    String?  @map("atomic_crm_lead_id")
  createdAt          DateTime @default(now()) @map("created_at")
  updatedAt          DateTime @updatedAt @map("updated_at")

  conversations Conversation[]

  @@unique([workspaceId, phone])
  @@index([workspaceId, name])
  @@map("contacts")
}

model Department {
  id           String   @id @default(uuid()) @db.Uuid
  workspaceId  String   @map("workspace_id")
  name         String
  routingOrder Int      @default(0) @map("routing_order")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  conversations Conversation[]

  @@unique([workspaceId, name])
  @@map("departments")
}

model Conversation {
  id                 String               @id @default(uuid()) @db.Uuid
  workspaceId        String               @map("workspace_id")
  channelId          String               @map("channel_id") @db.Uuid
  contactId          String               @map("contact_id") @db.Uuid
  status             ConversationStatus   @default(open)
  assignedUserId     String?              @map("assigned_user_id") @db.Uuid
  departmentId       String?              @map("department_id") @db.Uuid
  lastMessageAt      DateTime?            @map("last_message_at")
  lastMessagePreview String?              @map("last_message_preview")
  unreadCount        Int                  @default(0) @map("unread_count")
  priority           ConversationPriority @default(normal)
  createdAt          DateTime             @default(now()) @map("created_at")
  updatedAt          DateTime             @updatedAt @map("updated_at")

  channel    Channel           @relation(fields: [channelId], references: [id], onDelete: Cascade)
  contact    Contact           @relation(fields: [contactId], references: [id], onDelete: Cascade)
  department Department?        @relation(fields: [departmentId], references: [id], onDelete: SetNull)
  messages   Message[]
  tags       ConversationTag[]

  @@unique([workspaceId, channelId, contactId])
  @@index([workspaceId, status, lastMessageAt])
  @@index([workspaceId, assignedUserId])
  @@map("conversations")
}

model Message {
  id                String           @id @default(uuid()) @db.Uuid
  workspaceId       String           @map("workspace_id")
  conversationId    String           @map("conversation_id") @db.Uuid
  providerMessageId String?          @map("provider_message_id")
  providerEventId   String?          @map("provider_event_id")
  direction         MessageDirection
  type              MessageType
  body              String?
  mediaUrl          String?          @map("media_url")
  metadata          Json             @default("{}")
  status            MessageStatus    @default(pending)
  sentByUserId      String?          @map("sent_by_user_id") @db.Uuid
  createdAt         DateTime         @default(now()) @map("created_at")
  updatedAt         DateTime         @updatedAt @map("updated_at")

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  sentBy       UserProfile? @relation(fields: [sentByUserId], references: [id], onDelete: SetNull)

  @@unique([workspaceId, providerEventId])
  @@unique([workspaceId, providerMessageId])
  @@index([workspaceId, conversationId, createdAt])
  @@map("messages")
}

model Tag {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String   @map("workspace_id")
  name        String
  color       String
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  conversations ConversationTag[]

  @@unique([workspaceId, name])
  @@map("tags")
}

model ConversationTag {
  conversationId String   @map("conversation_id") @db.Uuid
  tagId          String   @map("tag_id") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at")

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  tag          Tag          @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@id([conversationId, tagId])
  @@map("conversation_tags")
}
```

- [ ] **Step 2: Validate Prisma schema**

Run:

```sh
pnpm --filter @prymeira-talk/api prisma validate
pnpm --filter @prymeira-talk/api prisma generate
```

Expected: schema valid and Prisma client generated.

- [ ] **Step 3: Create Prisma plugin**

Create `apps/api/src/plugins/prisma.ts`:

```ts
import { PrismaClient } from "@prisma/client";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export const prismaPlugin = fp(async (app) => {
  const prisma = new PrismaClient();
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
```

- [ ] **Step 4: Register Prisma plugin**

Modify `apps/api/src/app.ts` so `createApp` registers Prisma before protected routes:

```ts
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppEnv } from "./env";
import { authContextPlugin } from "./plugins/auth-context";
import { prismaPlugin } from "./plugins/prisma";

export async function createApp(env: AppEnv, options: { authEnabled?: boolean; prismaEnabled?: boolean } = {}) {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  });

  if (options.prismaEnabled !== false) {
    await app.register(prismaPlugin);
  }

  app.get("/health", async () => ({ ok: true, product: env.PRYMEIRA_PRODUCT_KEY }));

  if (options.authEnabled !== false) {
    await app.register(authContextPlugin, {
      accountApiUrl: env.PRYMEIRA_ACCOUNT_API_URL,
      productKey: env.PRYMEIRA_PRODUCT_KEY
    });
  }

  app.get("/me", async (request) => ({
    workspaceId: request.talk.workspaceId,
    role: request.talk.role
  }));

  return app;
}
```

- [ ] **Step 5: Keep unit tests independent of Prisma**

Modify `apps/api/src/test/build-app.ts` to pass `prismaEnabled: false` by default:

```ts
import { createApp } from "../app";
import type { AppEnv } from "../env";

export async function buildApp(
  overrides: Partial<AppEnv> = {},
  options: { authEnabled?: boolean; prismaEnabled?: boolean } = { authEnabled: false, prismaEnabled: false }
) {
  return createApp(
    {
      API_HOST: "127.0.0.1",
      API_PORT: 0,
      CORS_ORIGINS: "http://localhost:5176",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:54329/prymeira_talk",
      PRYMEIRA_ACCOUNT_API_URL: "http://localhost:3001",
      PRYMEIRA_PRODUCT_KEY: "talk",
      CLERK_SECRET_KEY: "sk_test_replace_me",
      EVOLUTION_WEBHOOK_SECRET: "test_secret",
      ...overrides
    },
    options
  );
}
```

- [ ] **Step 6: Run checks**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/api typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit database schema**

Run:

```sh
git add apps/api/prisma apps/api/src/plugins apps/api/src/app.ts apps/api/src/test/build-app.ts pnpm-lock.yaml
git commit -m "feat: add Talk core Prisma schema"
```

## Task 6: Tenant-Safe Conversation Service

**Files:**

- Create: `apps/api/src/modules/conversations/conversations.service.ts`
- Create: `apps/api/src/modules/conversations/conversations.service.test.ts`
- Create: `apps/api/src/modules/conversations/conversations.routes.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write failing service tests**

Create `apps/api/src/modules/conversations/conversations.service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createConversationsService } from "./conversations.service";

describe("conversations service", () => {
  it("filters conversations by workspace id", async () => {
    const prisma = {
      conversation: {
        findMany: vi.fn().mockResolvedValue([])
      }
    };
    const service = createConversationsService(prisma as never);

    await service.listConversations({ workspaceId: "workspace_a" });

    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "workspace_a" })
      })
    );
  });

  it("creates outbound pending messages inside the caller workspace", async () => {
    const prisma = {
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: null,
          direction: "outbound",
          type: "text",
          body: "Oi",
          mediaUrl: null,
          status: "pending",
          sentByUserId: "user_1",
          createdAt: new Date("2026-05-20T12:00:00.000Z")
        })
      }
    };
    const service = createConversationsService(prisma as never);

    const message = await service.createPendingOutboundMessage({
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      body: "Oi",
      sentByUserId: "user_1"
    });

    expect(message.workspaceId).toBe("workspace_a");
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          status: "pending"
        })
      })
    );
  });
});
```

- [ ] **Step 2: Run service test to verify failure**

Run:

```sh
pnpm --filter @prymeira-talk/api test src/modules/conversations/conversations.service.test.ts
```

Expected: FAIL because `conversations.service` does not exist.

- [ ] **Step 3: Implement conversations service**

Create `apps/api/src/modules/conversations/conversations.service.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type { ConversationDto, MessageDto } from "@prymeira-talk/shared";

type PrismaLike = Pick<PrismaClient, "conversation" | "message">;

function toConversationDto(record: {
  id: string;
  workspaceId: string;
  channelId: string;
  contactId: string;
  status: "open" | "pending" | "closed";
  assignedUserId: string | null;
  departmentId: string | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  priority: "low" | "normal" | "high";
}): ConversationDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    channelId: record.channelId,
    contactId: record.contactId,
    status: record.status,
    assignedUserId: record.assignedUserId,
    departmentId: record.departmentId,
    lastMessageAt: record.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: record.lastMessagePreview,
    unreadCount: record.unreadCount,
    priority: record.priority
  };
}

function toMessageDto(record: {
  id: string;
  workspaceId: string;
  conversationId: string;
  providerMessageId?: string | null;
  direction: "inbound" | "outbound";
  type: "text" | "image" | "audio" | "file" | "template" | "system" | "internal_note";
  body: string | null;
  mediaUrl?: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  sentByUserId?: string | null;
  createdAt: Date;
}): MessageDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    conversationId: record.conversationId,
    providerMessageId: record.providerMessageId ?? null,
    direction: record.direction,
    type: record.type,
    body: record.body,
    mediaUrl: record.mediaUrl ?? null,
    status: record.status,
    sentByUserId: record.sentByUserId ?? null,
    createdAt: record.createdAt.toISOString()
  };
}

export function createConversationsService(prisma: PrismaLike) {
  return {
    async listConversations(input: { workspaceId: string }): Promise<ConversationDto[]> {
      const records = await prisma.conversation.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        take: 50
      });
      return records.map(toConversationDto);
    },

    async createPendingOutboundMessage(input: {
      workspaceId: string;
      conversationId: string;
      body: string;
      sentByUserId: string | null;
    }): Promise<MessageDto> {
      const record = await prisma.message.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          direction: "outbound",
          type: "text",
          body: input.body,
          status: "pending",
          sentByUserId: input.sentByUserId
        }
      });
      return toMessageDto(record);
    }
  };
}
```

- [ ] **Step 4: Implement conversation routes**

Create `apps/api/src/modules/conversations/conversations.routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createConversationsService } from "./conversations.service";

const sendMessageSchema = z.object({
  body: z.string().min(1).max(4000)
});

export const conversationsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/conversations", async (request) => {
    const service = createConversationsService(app.prisma);
    return service.listConversations({ workspaceId: request.talk.workspaceId });
  });

  app.post("/conversations/:conversationId/messages", async (request) => {
    const params = z.object({ conversationId: z.string().min(1) }).parse(request.params);
    const body = sendMessageSchema.parse(request.body);
    const service = createConversationsService(app.prisma);

    const message = await service.createPendingOutboundMessage({
      workspaceId: request.talk.workspaceId,
      conversationId: params.conversationId,
      body: body.body,
      sentByUserId: null
    });

    return message;
  });
};
```

- [ ] **Step 5: Register conversation routes**

Modify `apps/api/src/app.ts`:

```ts
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppEnv } from "./env";
import { conversationsRoutes } from "./modules/conversations/conversations.routes";
import { authContextPlugin } from "./plugins/auth-context";
import { prismaPlugin } from "./plugins/prisma";

export async function createApp(env: AppEnv, options: { authEnabled?: boolean; prismaEnabled?: boolean } = {}) {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  });

  if (options.prismaEnabled !== false) {
    await app.register(prismaPlugin);
  }

  app.get("/health", async () => ({ ok: true, product: env.PRYMEIRA_PRODUCT_KEY }));

  if (options.authEnabled !== false) {
    await app.register(authContextPlugin, {
      accountApiUrl: env.PRYMEIRA_ACCOUNT_API_URL,
      productKey: env.PRYMEIRA_PRODUCT_KEY
    });
  }

  app.get("/me", async (request) => ({
    workspaceId: request.talk.workspaceId,
    role: request.talk.role
  }));
  await app.register(conversationsRoutes);

  return app;
}
```

- [ ] **Step 6: Run conversation tests**

Run:

```sh
pnpm --filter @prymeira-talk/api test src/modules/conversations/conversations.service.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit conversation service**

Run:

```sh
git add apps/api/src
git commit -m "feat: add tenant-safe conversation service"
```

## Task 7: Realtime Event Hub

**Files:**

- Create: `apps/api/src/modules/realtime/realtime-hub.ts`
- Create: `apps/api/src/modules/realtime/realtime-hub.test.ts`
- Create: `apps/api/src/modules/realtime/realtime.routes.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write failing realtime hub test**

Create `apps/api/src/modules/realtime/realtime-hub.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createRealtimeHub } from "./realtime-hub";

describe("realtime hub", () => {
  it("publishes only to clients in the event workspace", () => {
    const hub = createRealtimeHub();
    const workspaceAClient = { send: vi.fn(), readyState: 1 };
    const workspaceBClient = { send: vi.fn(), readyState: 1 };

    hub.addClient("workspace_a", workspaceAClient);
    hub.addClient("workspace_b", workspaceBClient);
    hub.publish({
      type: "conversation.updated",
      workspaceId: "workspace_a",
      payload: {
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        status: "open",
        assignedUserId: null,
        departmentId: null,
        lastMessageAt: null,
        lastMessagePreview: null,
        unreadCount: 0,
        priority: "normal"
      }
    });

    expect(workspaceAClient.send).toHaveBeenCalledTimes(1);
    expect(workspaceBClient.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run realtime test to verify failure**

Run:

```sh
pnpm --filter @prymeira-talk/api test src/modules/realtime/realtime-hub.test.ts
```

Expected: FAIL because `realtime-hub` does not exist.

- [ ] **Step 3: Implement realtime hub**

Create `apps/api/src/modules/realtime/realtime-hub.ts`:

```ts
import type { RealtimeEvent } from "@prymeira-talk/shared";

type WebSocketLike = {
  readyState: number;
  send: (payload: string) => void;
};

const OPEN = 1;

export function createRealtimeHub() {
  const clientsByWorkspace = new Map<string, Set<WebSocketLike>>();

  return {
    addClient(workspaceId: string, client: WebSocketLike) {
      const clients = clientsByWorkspace.get(workspaceId) ?? new Set<WebSocketLike>();
      clients.add(client);
      clientsByWorkspace.set(workspaceId, clients);

      return () => {
        clients.delete(client);
        if (clients.size === 0) {
          clientsByWorkspace.delete(workspaceId);
        }
      };
    },

    publish(event: RealtimeEvent) {
      const clients = clientsByWorkspace.get(event.workspaceId);
      if (!clients) return;

      const payload = JSON.stringify(event);
      for (const client of clients) {
        if (client.readyState === OPEN) {
          client.send(payload);
        }
      }
    }
  };
}

export type RealtimeHub = ReturnType<typeof createRealtimeHub>;
```

- [ ] **Step 4: Implement WebSocket route**

Create `apps/api/src/modules/realtime/realtime.routes.ts`:

```ts
import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import { createRealtimeHub } from "./realtime-hub";

declare module "fastify" {
  interface FastifyInstance {
    realtime: ReturnType<typeof createRealtimeHub>;
  }
}

export const realtimeRoutes: FastifyPluginAsync = async (app) => {
  await app.register(websocket);

  const hub = createRealtimeHub();
  app.decorate("realtime", hub);

  app.get("/realtime", { websocket: true }, (socket, request) => {
    const removeClient = hub.addClient(request.talk.workspaceId, socket);
    socket.on("close", removeClient);
  });
};
```

- [ ] **Step 5: Register realtime before conversation routes**

Modify `apps/api/src/app.ts` to import and register realtime routes before `conversationsRoutes`:

```ts
import { realtimeRoutes } from "./modules/realtime/realtime.routes";
```

Then add:

```ts
await app.register(realtimeRoutes);
await app.register(conversationsRoutes);
```

- [ ] **Step 6: Run realtime tests**

Run:

```sh
pnpm --filter @prymeira-talk/api test src/modules/realtime/realtime-hub.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit realtime hub**

Run:

```sh
git add apps/api/src/modules/realtime apps/api/src/app.ts
git commit -m "feat: add workspace realtime hub"
```

## Task 8: Evolution Webhook Ingestion

**Files:**

- Create: `apps/api/src/modules/evolution/evolution.schemas.ts`
- Create: `apps/api/src/modules/evolution/evolution.routes.ts`
- Create: `apps/api/src/modules/evolution/evolution.routes.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write failing webhook validation test**

Create `apps/api/src/modules/evolution/evolution.routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evolutionWebhookSchema } from "./evolution.schemas";

describe("Evolution webhook schema", () => {
  it("normalizes an inbound text message event", () => {
    const parsed = evolutionWebhookSchema.parse({
      event: "messages.upsert",
      instance: "client-one",
      data: {
        key: { id: "provider_msg_1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
        message: { conversation: "Oi" },
        messageTimestamp: 1779300000
      }
    });

    expect(parsed.data.key.id).toBe("provider_msg_1");
  });
});
```

- [ ] **Step 2: Run webhook test to verify failure**

Run:

```sh
pnpm --filter @prymeira-talk/api test src/modules/evolution/evolution.routes.test.ts
```

Expected: FAIL because `evolution.schemas` does not exist.

- [ ] **Step 3: Implement Evolution schema**

Create `apps/api/src/modules/evolution/evolution.schemas.ts`:

```ts
import { z } from "zod";

export const evolutionWebhookSchema = z.object({
  event: z.string().min(1),
  instance: z.string().min(1),
  data: z.object({
    key: z.object({
      id: z.string().min(1),
      remoteJid: z.string().min(1),
      fromMe: z.boolean().default(false)
    }),
    message: z
      .object({
        conversation: z.string().optional()
      })
      .passthrough()
      .optional(),
    messageTimestamp: z.number().optional()
  }).passthrough()
});

export type EvolutionWebhookPayload = z.infer<typeof evolutionWebhookSchema>;
```

- [ ] **Step 4: Implement webhook route**

Create `apps/api/src/modules/evolution/evolution.routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import { evolutionWebhookSchema } from "./evolution.schemas";

function readPhoneFromJid(jid: string) {
  return jid.replace(/@.+$/, "");
}

export const evolutionRoutes: FastifyPluginAsync<{ webhookSecret: string }> = async (app, options) => {
  app.post("/webhooks/evolution/:workspaceId", async (request, reply) => {
    const signature = request.headers["x-prymeira-talk-secret"];
    if (signature !== options.webhookSecret) {
      return reply.code(401).send({ ok: false, error: "invalid_webhook_secret" });
    }

    const params = request.params as { workspaceId: string };
    const payload = evolutionWebhookSchema.parse(request.body);

    if (payload.event !== "messages.upsert") {
      return { ok: true, ignored: true };
    }

    const channel = await app.prisma.channel.findFirst({
      where: {
        workspaceId: params.workspaceId,
        provider: "evolution",
        providerKey: payload.instance
      }
    });
    if (!channel) {
      return reply.code(404).send({ ok: false, error: "channel_not_found" });
    }

    const phone = readPhoneFromJid(payload.data.key.remoteJid);
    const contact = await app.prisma.contact.upsert({
      where: {
        workspaceId_phone: {
          workspaceId: params.workspaceId,
          phone
        }
      },
      create: {
        workspaceId: params.workspaceId,
        phone
      },
      update: {}
    });

    const conversation = await app.prisma.conversation.upsert({
      where: {
        workspaceId_channelId_contactId: {
          workspaceId: params.workspaceId,
          channelId: channel.id,
          contactId: contact.id
        }
      },
      create: {
        workspaceId: params.workspaceId,
        channelId: channel.id,
        contactId: contact.id,
        status: "open",
        lastMessageAt: new Date(),
        lastMessagePreview: payload.data.message?.conversation ?? null,
        unreadCount: payload.data.key.fromMe ? 0 : 1
      },
      update: {
        lastMessageAt: new Date(),
        lastMessagePreview: payload.data.message?.conversation ?? null,
        unreadCount: payload.data.key.fromMe ? undefined : { increment: 1 }
      }
    });

    const message = await app.prisma.message.upsert({
      where: {
        workspaceId_providerMessageId: {
          workspaceId: params.workspaceId,
          providerMessageId: payload.data.key.id
        }
      },
      create: {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        providerMessageId: payload.data.key.id,
        providerEventId: `${payload.event}:${payload.instance}:${payload.data.key.id}`,
        direction: payload.data.key.fromMe ? "outbound" : "inbound",
        type: "text",
        body: payload.data.message?.conversation ?? "",
        status: payload.data.key.fromMe ? "sent" : "delivered"
      },
      update: {}
    });

    app.realtime.publish({
      type: "message.created",
      workspaceId: params.workspaceId,
      payload: {
        id: message.id,
        workspaceId: message.workspaceId,
        conversationId: message.conversationId,
        providerMessageId: message.providerMessageId,
        direction: message.direction,
        type: message.type,
        body: message.body,
        mediaUrl: message.mediaUrl,
        status: message.status,
        sentByUserId: message.sentByUserId,
        createdAt: message.createdAt.toISOString()
      }
    });

    return { ok: true };
  });
};
```

- [ ] **Step 5: Register Evolution routes**

Modify `apps/api/src/app.ts` to import and register:

```ts
import { evolutionRoutes } from "./modules/evolution/evolution.routes";
```

Register before auth-protected routes so webhooks can authenticate by secret:

```ts
await app.register(evolutionRoutes, { webhookSecret: env.EVOLUTION_WEBHOOK_SECRET });
```

- [ ] **Step 6: Run webhook checks**

Run:

```sh
pnpm --filter @prymeira-talk/api test src/modules/evolution/evolution.routes.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Evolution webhook**

Run:

```sh
git add apps/api/src
git commit -m "feat: ingest Evolution inbound messages"
```

## Task 9: Web App Scaffold And Inbox Shell

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app/api.ts`
- Create: `apps/web/src/app/auth.tsx`
- Create: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/features/inbox/InboxPage.tsx`
- Create: `apps/web/src/features/inbox/useRealtimeEvents.ts`
- Create: `apps/web/src/styles.css`

- [ ] **Step 1: Create web package**

Create `apps/web/package.json`:

```json
{
  "name": "@prymeira-talk/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 5176",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@clerk/clerk-react": "^6.36.0",
    "@prymeira-talk/shared": "workspace:*",
    "@vitejs/plugin-react": "^4.6.0",
    "lucide-react": "^0.542.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "vite": "^7.3.2"
  },
  "devDependencies": {
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "typescript": "^5.8.3",
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 2: Create web config files**

Create `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx"
  },
  "include": ["src", "vite.config.ts"]
}
```

Create `apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176
  }
});
```

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Prymeira Talk</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Implement API client**

Create `apps/web/src/app/api.ts`:

```ts
import { conversationSchema, type ConversationDto } from "@prymeira-talk/shared";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3002";

export async function apiGetConversations(getToken: () => Promise<string | null>): Promise<ConversationDto[]> {
  const token = await getToken();
  const response = await fetch(`${apiUrl}/conversations`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load conversations: ${response.status}`);
  }

  const data = await response.json();
  return conversationSchema.array().parse(data);
}

export function buildRealtimeUrl(token: string) {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/realtime";
  url.searchParams.set("token", token);
  return url.toString();
}
```

- [ ] **Step 4: Implement Clerk wrapper**

Create `apps/web/src/app/auth.tsx`:

```tsx
import { ClerkProvider, SignedIn, SignedOut, SignInButton } from "@clerk/clerk-react";
import type { PropsWithChildren } from "react";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export function AuthProvider({ children }: PropsWithChildren) {
  if (!publishableKey) {
    return <div className="center-state">Configure VITE_CLERK_PUBLISHABLE_KEY.</div>;
  }

  return <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>;
}

export function AuthGate({ children }: PropsWithChildren) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <div className="center-state">
          <h1>Prymeira Talk</h1>
          <SignInButton mode="modal">
            <button className="primary-button">Entrar</button>
          </SignInButton>
        </div>
      </SignedOut>
    </>
  );
}
```

- [ ] **Step 5: Implement app and entrypoint**

Create `apps/web/src/app/App.tsx`:

```tsx
import { AuthGate } from "./auth";
import { InboxPage } from "../features/inbox/InboxPage";

export function App() {
  return (
    <AuthGate>
      <InboxPage />
    </AuthGate>
  );
}
```

Create `apps/web/src/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { AuthProvider } from "./app/auth";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <AuthProvider>
    <App />
  </AuthProvider>
);
```

- [ ] **Step 6: Implement realtime hook**

Create `apps/web/src/features/inbox/useRealtimeEvents.ts`:

```ts
import type { RealtimeEvent } from "@prymeira-talk/shared";
import { useEffect } from "react";
import { buildRealtimeUrl } from "../../app/api";

export function useRealtimeEvents(input: {
  token: string | null;
  onEvent: (event: RealtimeEvent) => void;
}) {
  useEffect(() => {
    if (!input.token) return;

    const socket = new WebSocket(buildRealtimeUrl(input.token));
    socket.onmessage = (message) => {
      input.onEvent(JSON.parse(message.data) as RealtimeEvent);
    };

    return () => {
      socket.close();
    };
  }, [input]);
}
```

- [ ] **Step 7: Implement inbox page**

Create `apps/web/src/features/inbox/InboxPage.tsx`:

```tsx
import { useAuth } from "@clerk/clerk-react";
import { Bot, Inbox, MessageSquare, Settings, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ConversationDto, RealtimeEvent } from "@prymeira-talk/shared";
import { apiGetConversations } from "../../app/api";
import { useRealtimeEvents } from "./useRealtimeEvents";

export function InboxPage() {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? conversations[0],
    [conversations, selectedId]
  );

  useEffect(() => {
    void getToken().then(setToken);
    void apiGetConversations(getToken).then((items) => {
      setConversations(items);
      setSelectedId(items[0]?.id ?? null);
    });
  }, [getToken]);

  useRealtimeEvents({
    token,
    onEvent(event: RealtimeEvent) {
      if (event.type === "conversation.updated") {
        setConversations((current) => {
          const without = current.filter((item) => item.id !== event.payload.id);
          return [event.payload, ...without];
        });
      }
    }
  });

  return (
    <main className="talk-shell">
      <nav className="rail" aria-label="Navegacao principal">
        <div className="brand-mark">PT</div>
        <button className="rail-button active" aria-label="Inbox"><Inbox size={19} /></button>
        <button className="rail-button" aria-label="Contatos"><Users size={19} /></button>
        <button className="rail-button" aria-label="Automacoes"><Bot size={19} /></button>
        <button className="rail-button" aria-label="Configuracoes"><Settings size={19} /></button>
      </nav>

      <section className="conversation-list">
        <header>
          <h1>Conversas</h1>
          <input placeholder="Buscar conversa" />
        </header>
        <div className="filter-row">
          <button>Aberts</button>
          <button>Minhas</button>
          <button>Tags</button>
        </div>
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            className={conversation.id === selected?.id ? "conversation-row active" : "conversation-row"}
            onClick={() => setSelectedId(conversation.id)}
          >
            <span className="avatar" />
            <span>
              <strong>{conversation.lastMessagePreview ?? "Nova conversa"}</strong>
              <small>{conversation.status} · {conversation.unreadCount} nao lidas</small>
            </span>
          </button>
        ))}
      </section>

      <section className="chat-pane">
        <header className="chat-header">
          <span className="avatar" />
          <div>
            <strong>{selected?.contactId ?? "Selecione uma conversa"}</strong>
            <small>{selected?.status ?? "sem conversa"}</small>
          </div>
        </header>
        <div className="message-space">
          <div className="empty-chat">
            <MessageSquare size={32} />
            <p>As mensagens realtime entram aqui.</p>
          </div>
        </div>
        <footer className="composer">
          <input placeholder="Escreva uma mensagem" />
          <button>Enviar</button>
        </footer>
      </section>

      <aside className="contact-panel">
        <h2>Contato</h2>
        <div className="panel-card">
          <strong>Tags</strong>
          <div className="tag-row">
            <span>Lead</span>
            <span>Suporte</span>
          </div>
        </div>
        <div className="panel-card">
          <strong>Atomic CRM</strong>
          <p>Vinculo aparece aqui quando existir.</p>
        </div>
      </aside>
    </main>
  );
}
```

- [ ] **Step 8: Implement operational calm CSS**

Create `apps/web/src/styles.css`:

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: "DM Sans", ui-sans-serif, system-ui, sans-serif;
  color: #172420;
  background: #f4f8f6;
}

button,
input {
  font: inherit;
}

.center-state {
  min-height: 100vh;
  display: grid;
  place-items: center;
  gap: 16px;
}

.primary-button,
.composer button {
  border: 0;
  border-radius: 8px;
  background: #1f8f63;
  color: white;
  padding: 10px 14px;
  font-weight: 700;
}

.talk-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 68px 330px minmax(420px, 1fr) 310px;
}

.rail {
  background: #102c27;
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.brand-mark,
.rail-button {
  width: 38px;
  height: 38px;
  border-radius: 9px;
  display: grid;
  place-items: center;
}

.brand-mark {
  background: #78d9a6;
  color: #102c27;
  font-weight: 800;
}

.rail-button {
  border: 0;
  color: #d9eee6;
  background: rgba(255,255,255,.08);
}

.rail-button.active {
  background: #1f8f63;
}

.conversation-list {
  background: #fbfcfb;
  border-right: 1px solid #dce4e0;
  overflow: auto;
}

.conversation-list header {
  padding: 16px;
  border-bottom: 1px solid #e5ece8;
}

.conversation-list h1 {
  font-size: 20px;
  margin: 0 0 12px;
}

.conversation-list input,
.composer input {
  width: 100%;
  border: 1px solid #dce4e0;
  border-radius: 8px;
  background: #eef3f1;
  padding: 10px 12px;
}

.filter-row {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
}

.filter-row button {
  border: 0;
  border-radius: 999px;
  padding: 7px 10px;
  background: #e7efeb;
}

.conversation-row {
  width: 100%;
  border: 0;
  border-bottom: 1px solid #edf1ef;
  background: transparent;
  display: grid;
  grid-template-columns: 42px 1fr;
  gap: 10px;
  padding: 12px 16px;
  text-align: left;
}

.conversation-row.active {
  background: #e9f7f0;
  box-shadow: inset 3px 0 0 #22a06b;
}

.avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: #b8cbc4;
  display: inline-block;
}

.conversation-row small,
.chat-header small {
  display: block;
  color: #61756d;
  margin-top: 4px;
}

.chat-pane {
  display: grid;
  grid-template-rows: 64px 1fr 76px;
  background: #f4f8f6;
}

.chat-header,
.composer {
  background: white;
  border-bottom: 1px solid #dce4e0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
}

.composer {
  border-top: 1px solid #dce4e0;
  border-bottom: 0;
}

.message-space {
  display: grid;
  place-items: center;
}

.empty-chat {
  text-align: center;
  color: #61756d;
}

.contact-panel {
  background: white;
  border-left: 1px solid #dce4e0;
  padding: 18px;
}

.contact-panel h2 {
  font-size: 18px;
  margin: 0 0 16px;
}

.panel-card {
  border-bottom: 1px solid #edf1ef;
  padding-bottom: 16px;
  margin-bottom: 16px;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.tag-row span {
  border-radius: 999px;
  background: #d9f4e3;
  padding: 6px 10px;
  font-size: 13px;
}
```

- [ ] **Step 9: Install and typecheck web**

Run:

```sh
pnpm install
pnpm --filter @prymeira-talk/web typecheck
pnpm --filter @prymeira-talk/web build
```

Expected: PASS.

- [ ] **Step 10: Commit web shell**

Run:

```sh
git add apps/web package.json pnpm-lock.yaml
git commit -m "feat: add Talk inbox web shell"
```

## Task 10: End-To-End Local Verification

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Run full static checks**

Run:

```sh
pnpm test
pnpm typecheck
pnpm build
```

Expected: all workspace tests, typechecks, and builds pass.

- [ ] **Step 2: Start local database**

Run:

```sh
docker compose -f docker-compose.dev.yml up -d
```

Expected: `postgres` container is running and port `54329` is available.

- [ ] **Step 3: Run Prisma migration**

Run:

```sh
cp .env.example .env
pnpm prisma:migrate -- --name init
```

Expected: Prisma creates the initial migration and applies it to local Postgres.

- [ ] **Step 4: Start API and web**

Run:

```sh
pnpm dev
```

Expected:

- API starts on `http://localhost:3002`.
- Web starts on `http://localhost:5176`.

- [ ] **Step 5: Verify API health**

Run:

```sh
curl http://localhost:3002/health
```

Expected:

```json
{"ok":true,"product":"talk"}
```

- [ ] **Step 6: Verify browser renders**

Open:

```txt
http://localhost:5176
```

Expected: the page shows either the Clerk sign-in state or the configured-key warning. With a valid Clerk key and product entitlement, the app shows the Prymeira Talk inbox shell.

- [ ] **Step 7: Document current runbook**

Update `README.md` with the exact commands that succeeded locally and a note that Prymeira Account must return `workspace_id` for production-grade tenant resolution.

- [ ] **Step 8: Commit verification notes**

Run:

```sh
git add README.md apps/api/prisma/migrations
git commit -m "docs: add Talk local verification notes"
```

## Self-Review Checklist

- Spec coverage: this plan covers monorepo, auth/tenant boundary, data model, realtime, Evolution ingestion, and inbox UX foundation.
- Deliberately deferred to follow-up plans: automations, AI assistant, Atomic CRM integration, reports, deployment hardening.
- Tenant boundary: every API service and route in this plan uses `request.talk.workspaceId` or a webhook workspace path.
- Realtime: event hub filters clients by workspace.
- Type consistency: shared DTO names are `ConversationDto`, `MessageDto`, and `RealtimeEvent`; API and web import those names consistently.
- Test path: each task adds a focused test before implementation where practical, then runs typecheck/build.
