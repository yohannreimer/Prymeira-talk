# Local Client Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic localhost demo that connects a simulated inbound lead, AI qualification, human ownership, board state, and Vincula CRM for a five-person sales team.

**Architecture:** Keep PostgreSQL and the existing domain services as the source of truth. Add an environment-gated demo scenario module with idempotent reset/inbound operations, expose it through two owner-only API routes, and add a small web control surface. Reuse the current CRM service contract and contact notes rather than introducing demo-only frontend state.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, React, Vite, Vitest, Testing Library, pnpm.

---

## File Map

- Create `apps/api/src/modules/demo/demo-scenario.ts`: shared deterministic seed/reset and simulated-lead orchestration.
- Create `apps/api/src/modules/demo/demo.routes.ts`: environment- and workspace-gated HTTP boundary.
- Create `apps/api/src/modules/demo/demo.routes.test.ts`: route authorization and idempotent-result contract tests.
- Modify `apps/api/prisma/seed-demo.ts`: delegate to the shared scenario module.
- Modify `apps/api/src/env.ts`, `apps/api/src/env.test.ts`, and `apps/api/src/test/build-app.ts`: add explicit local-demo configuration.
- Modify `apps/api/src/app.ts`: register the demo routes with realtime access.
- Modify `.env.example`, `package.json`, `apps/web/public/runtime-config.js`, and `apps/web/docker-entrypoint.d/10-runtime-config.sh`: make the demo command reproducible.
- Modify `apps/web/src/app/runtime-config.ts` and `apps/web/src/app/api.ts`: expose local-demo configuration and typed API calls.
- Create `apps/web/src/features/inbox/DemoControls.tsx`: isolate the reset/inbound UI.
- Create `apps/web/src/features/inbox/DemoControls.test.tsx`: cover visibility, loading, confirmation, and success behavior.
- Modify `apps/web/src/features/inbox/InboxPage.tsx`: refresh/select the deterministic conversation and present AI context.
- Modify `apps/web/src/features/crm/CrmPage.tsx`: accept a contact query parameter and replace UUID-first presentation with contact selection.
- Modify `apps/web/src/features/shell/TalkSuiteShell.tsx`: preserve contact context when navigating to Vincula.
- Modify `apps/web/src/styles.css`: style the compact demo bar and intelligence card.
- Create `docs/demo-runbook.md`: one-page startup, story, fallback, and reset checklist.

### Task 1: Add the explicit local-demo gate

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/env.test.ts`
- Modify: `apps/api/src/test/build-app.ts`
- Modify: `.env.example`
- Modify: `apps/web/src/app/runtime-config.ts`
- Modify: `apps/web/public/runtime-config.js`
- Modify: `apps/web/docker-entrypoint.d/10-runtime-config.sh`

- [ ] **Step 1: Write failing environment tests**

Add assertions that `PRYMEIRA_LOCAL_DEMO_ENABLED` defaults to false and is rejected in production:

```ts
it("keeps local demo controls disabled by default", () => {
  expect(readEnv(baseProductionEnv).PRYMEIRA_LOCAL_DEMO_ENABLED).toBe(false);
});

it("rejects local demo mode in production", () => {
  expect(() => readEnv({
    ...baseProductionEnv,
    PRYMEIRA_LOCAL_DEMO_ENABLED: "true"
  })).toThrow(/PRYMEIRA_LOCAL_DEMO_ENABLED/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @prymeira-talk/api test -- src/env.test.ts`

Expected: FAIL because the parsed environment has no `PRYMEIRA_LOCAL_DEMO_ENABLED` field.

- [ ] **Step 3: Add server and web runtime configuration**

Add this field to `envSchema`:

```ts
PRYMEIRA_LOCAL_DEMO_ENABLED: z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true"),
```

Add a production validation issue equivalent to the existing local-auth bypass rule. Add `PRYMEIRA_LOCAL_DEMO_ENABLED: false` to `buildApp`. Add `VITE_LOCAL_DEMO_ENABLED?: string` to `RuntimeConfig`, expose it from `runtime-config.js`, and pass it through the Docker entrypoint. Document both variables in `.env.example`.

- [ ] **Step 4: Run the focused test and verify success**

Run: `pnpm --filter @prymeira-talk/api test -- src/env.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the gate**

```bash
git add .env.example apps/api/src/env.ts apps/api/src/env.test.ts apps/api/src/test/build-app.ts apps/web/src/app/runtime-config.ts apps/web/public/runtime-config.js apps/web/docker-entrypoint.d/10-runtime-config.sh
git commit -m "feat: gate local demo controls"
```

### Task 2: Build the deterministic scenario service

**Files:**
- Create: `apps/api/src/modules/demo/demo-scenario.ts`
- Modify: `apps/api/prisma/seed-demo.ts`
- Test: `apps/api/src/modules/demo/demo.routes.test.ts`

- [ ] **Step 1: Write the scenario contract test**

Define a fake scenario service whose second simulated-lead call returns the same IDs:

```ts
const result = {
  workspaceId: "demo_workspace",
  conversationId: "50000000-0000-4000-8000-000000000010",
  contactId: "60000000-0000-4000-8000-000000000010",
  created: true
};

expect(await service.simulateLead("demo_workspace")).toMatchObject(result);
expect(await service.simulateLead("demo_workspace")).toMatchObject({
  ...result,
  created: false
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @prymeira-talk/api test -- src/modules/demo/demo.routes.test.ts`

Expected: FAIL because the demo module does not exist.

- [ ] **Step 3: Implement shared scenario functions**

Export this public boundary:

```ts
export interface DemoResetResult {
  workspaceId: string;
  users: number;
  conversations: number;
  contacts: number;
  agents: number;
}

export interface DemoLeadResult {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  created: boolean;
}

export interface DemoRealtime {
  publish(event: RealtimeEvent): void;
}

export function createDemoScenarioService(prisma: PrismaClient, realtime?: DemoRealtime) {
  return {
    reset(workspaceId: string): Promise<DemoResetResult>,
    simulateLead(workspaceId: string): Promise<DemoLeadResult>
  };
}
```

Use stable UUIDs. Reset seeds `Nova Base Suprimentos`, five users, Sales/Support/Finance departments, ten contacts/conversations, a connected commercial channel, the five-stage board, quick replies, tags, `Assistente Comercial IA`, FAQ knowledge, and simulated CRM history. Carlos exists in a closed baseline conversation so the active queue remains unchanged until simulation.

`simulateLead` updates Carlos to open/high/unread, refreshes timestamps, replaces its scripted messages, creates an `AiAgentSession` with `handoff_requested`, attaches it as `activeAgentSessionId`, applies `Orçamento quente`, creates the AI summary note, moves the primary board membership to `Qualificado`, and emits the normal conversation/message realtime events. A repeated call updates the same stable records and returns `created: false`.

Replace the body of `seed-demo.ts` with:

```ts
const prisma = new PrismaClient();
const workspaceId = process.env.PRYMEIRA_LOCAL_WORKSPACE_ID ?? "local_workspace";

createDemoScenarioService(prisma)
  .reset(workspaceId)
  .then((result) => console.log(`Seeded ${result.conversations} demo conversations for ${workspaceId}.`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 4: Verify database reset twice**

Run:

```bash
PRYMEIRA_LOCAL_WORKSPACE_ID=demo_workspace pnpm --filter @prymeira-talk/api seed:demo
PRYMEIRA_LOCAL_WORKSPACE_ID=demo_workspace pnpm --filter @prymeira-talk/api seed:demo
```

Expected both times: `Seeded 10 demo conversations for demo_workspace.`

- [ ] **Step 5: Commit the scenario service**

```bash
git add apps/api/src/modules/demo/demo-scenario.ts apps/api/prisma/seed-demo.ts
git commit -m "feat: seed deterministic sales demo"
```

### Task 3: Expose protected demo operations

**Files:**
- Create: `apps/api/src/modules/demo/demo.routes.ts`
- Create: `apps/api/src/modules/demo/demo.routes.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write failing route protection tests**

Cover disabled mode, wrong workspace, non-owner access, reset, and duplicate inbound calls. Assert exact error codes:

```ts
expect(response.statusCode).toBe(403);
expect(response.json()).toMatchObject({ code: "LOCAL_DEMO_DISABLED" });

expect(wrongWorkspace.statusCode).toBe(403);
expect(wrongWorkspace.json()).toMatchObject({ code: "LOCAL_DEMO_WORKSPACE_MISMATCH" });
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @prymeira-talk/api test -- src/modules/demo/demo.routes.test.ts`

Expected: FAIL because `demoRoutes` is missing.

- [ ] **Step 3: Implement and register routes**

Export:

```ts
type DemoScenarioService = ReturnType<typeof createDemoScenarioService>;

interface DemoRoutesOptions {
  enabled: boolean;
  demoWorkspaceId: string;
  service?: Pick<DemoScenarioService, "reset" | "simulateLead">;
}

function requireDemoAccess(request: FastifyRequest, reply: FastifyReply) {
  if (!options.enabled) {
    reply.code(403).send({ code: "LOCAL_DEMO_DISABLED", error: "Local demo mode is disabled." });
    return false;
  }
  if (request.talk.workspaceId !== options.demoWorkspaceId) {
    reply.code(403).send({
      code: "LOCAL_DEMO_WORKSPACE_MISMATCH",
      error: "The active workspace is not the configured demo workspace."
    });
    return false;
  }
  if (request.talk.role !== "owner") {
    reply.code(403).send({ code: "LOCAL_DEMO_OWNER_REQUIRED", error: "Owner access is required." });
    return false;
  }
  return true;
}

app.post("/demo/reset", async (request, reply) => {
  if (!requireDemoAccess(request, reply)) return reply;
  return service.reset(request.talk.workspaceId);
});

app.post("/demo/simulate-lead", async (request, reply) => {
  if (!requireDemoAccess(request, reply)) return reply;
  return service.simulateLead(request.talk.workspaceId);
});
```

Register after realtime setup:

```ts
await app.register(demoRoutes, {
  enabled: env.PRYMEIRA_LOCAL_DEMO_ENABLED,
  demoWorkspaceId: env.PRYMEIRA_LOCAL_WORKSPACE_ID
});
```

The route constructs the real service from `app.prisma` when the injected test service is absent.

- [ ] **Step 4: Run tests and verify success**

Run: `pnpm --filter @prymeira-talk/api test -- src/modules/demo/demo.routes.test.ts src/env.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the API boundary**

```bash
git add apps/api/src/app.ts apps/api/src/modules/demo/demo.routes.ts apps/api/src/modules/demo/demo.routes.test.ts
git commit -m "feat: expose protected demo controls"
```

### Task 4: Add typed demo controls to Atendimento

**Files:**
- Modify: `apps/web/src/app/api.ts`
- Create: `apps/web/src/features/inbox/DemoControls.tsx`
- Create: `apps/web/src/features/inbox/DemoControls.test.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing component tests**

Render the control with injected handlers and assert that simulate does not request confirmation, reset does, busy state disables both buttons, and success passes the returned conversation ID to `onScenarioChanged`.

```tsx
render(<DemoControls enabled onSimulateLead={simulate} onReset={reset} onScenarioChanged={changed} />);
await user.click(screen.getByRole("button", { name: /simular novo lead/i }));
expect(changed).toHaveBeenCalledWith({ conversationId: DEMO_CONVERSATION_ID });
```

- [ ] **Step 2: Run the component test and verify failure**

Run: `pnpm --filter @prymeira-talk/web test -- DemoControls.test.tsx`

Expected: FAIL because `DemoControls` does not exist.

- [ ] **Step 3: Add typed client calls and component**

Add:

```ts
export interface DemoLeadResultDto {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  created: boolean;
}

export interface DemoResetResultDto {
  workspaceId: string;
  users: number;
  conversations: number;
  contacts: number;
  agents: number;
}

export const localDemoEnabled = readConfigValue("VITE_LOCAL_DEMO_ENABLED") === "true";
export function apiSimulateDemoLead(getToken: () => Promise<string | null>) {
  return fetchJson(
    getToken,
    "/demo/simulate-lead",
    { method: "POST" },
    (data) => asRecord(data) as unknown as DemoLeadResultDto,
    "Failed to simulate demo lead"
  );
}

export function apiResetDemo(getToken: () => Promise<string | null>) {
  return fetchJson(
    getToken,
    "/demo/reset",
    { method: "POST" },
    (data) => asRecord(data) as unknown as DemoResetResultDto,
    "Failed to reset demo"
  );
}
```

`DemoControls` renders only when enabled. It owns loading/error/notice state and calls `window.confirm("Restaurar todos os dados da demonstração?")` before reset.

- [ ] **Step 4: Integrate the control with inbox refresh**

Place the demo bar after the queue summary. On scenario change, clear channel/queue filters to `all`, reload conversations, select the returned conversation ID, and refresh messages/context through the existing state keys. Show an intelligence card above notes when `handoffReason` or a note beginning with `Resumo da IA:` is present.

- [ ] **Step 5: Run component and inbox tests**

Run: `pnpm --filter @prymeira-talk/web test -- DemoControls.test.tsx InboxPage.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the inbox demo surface**

```bash
git add apps/web/src/app/api.ts apps/web/src/features/inbox/DemoControls.tsx apps/web/src/features/inbox/DemoControls.test.tsx apps/web/src/features/inbox/InboxPage.tsx apps/web/src/styles.css
git commit -m "feat: add local demo controls to inbox"
```

### Task 5: Make Vincula contact-oriented

**Files:**
- Modify: `apps/web/src/features/crm/CrmPage.tsx`
- Modify: `apps/web/src/features/shell/TalkSuiteShell.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/app/api.test.ts`

- [ ] **Step 1: Write failing contact-context tests**

Add pure helper tests for reading and preserving `contact`:

```ts
expect(readCrmContactId("?module=atomic_crm&contact=60000000-0000-4000-8000-000000000010"))
  .toBe("60000000-0000-4000-8000-000000000010");
```

Assert that a module URL keeps `contact` only for `atomic_crm`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @prymeira-talk/web test -- api.test.ts`

Expected: FAIL because the URL helpers are missing.

- [ ] **Step 3: Implement navigation and selected-contact UI**

Add an **Abrir no Vincula** action in Atendimento that navigates to `?module=atomic_crm&contact=<contactId>` and dispatches `popstate`. In `CrmPage`, load contacts with the existing `apiGetContacts`, select the query-string contact when present, and render a select using `name · company · phone`. Keep manual link ID fields inside the existing advanced details panel.

Initialize lead title to `Orçamento — <company or contact name>`. Initialize note body from the newest internal note beginning with `Resumo da IA:` when the conversation context is available; otherwise retain the existing generic note. Buttons use the selected contact ID and the activity list filters automatically.

- [ ] **Step 4: Run CRM and API tests**

Run: `pnpm --filter @prymeira-talk/web test -- api.test.ts InboxPage.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit CRM ergonomics**

```bash
git add apps/web/src/features/crm/CrmPage.tsx apps/web/src/features/shell/TalkSuiteShell.tsx apps/web/src/features/inbox/InboxPage.tsx apps/web/src/styles.css apps/web/src/app/api.test.ts
git commit -m "feat: connect inbox contact to Vincula"
```

### Task 6: Add the runbook and verify the full demo

**Files:**
- Modify: `package.json`
- Create: `docs/demo-runbook.md`
- Modify: `README.md`

- [ ] **Step 1: Add deterministic commands**

Update `demo:prymeira` to set both demo flags and keep `demo:reset` targeted at `demo_workspace`:

```json
"demo:prymeira": "PRYMEIRA_LOCAL_AUTH_BYPASS=true PRYMEIRA_LOCAL_DEMO_ENABLED=true PRYMEIRA_LOCAL_WORKSPACE_ID=demo_workspace PRYMEIRA_LOCAL_ROLE=owner VITE_LOCAL_AUTH_BYPASS=true VITE_LOCAL_DEMO_ENABLED=true VITE_API_URL=http://localhost:3002 pnpm --parallel dev",
"demo:reset": "docker compose -f docker-compose.dev.yml up -d && pnpm prisma:generate && pnpm --filter @prymeira-talk/api prisma db push && PRYMEIRA_LOCAL_WORKSPACE_ID=demo_workspace pnpm --filter @prymeira-talk/api seed:demo"
```

- [ ] **Step 2: Write the presenter runbook**

Document exact startup commands, URLs, the ten-step primary story, the optional module tour, real WhatsApp/Vincula prerequisites, offline fallback, reset procedure, and a pre-meeting checklist. Link it from README.

- [ ] **Step 3: Run automated verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm demo:reset
```

Expected: all commands exit 0 and reset reports ten conversations for `demo_workspace`.

- [ ] **Step 4: Run browser smoke verification**

Start `pnpm demo:prymeira`, open `http://localhost:5176`, and verify:

1. **Simular novo lead** surfaces Carlos in Atendimento.
2. Message history, AI summary, hot tag, and handoff reason are visible.
3. **Assumir** transfers control to the local user.
4. Board movement persists in Contatos.
5. **Abrir no Vincula** selects Carlos without UUID input.
6. Opportunity and AI-note actions create simulated completed rows.
7. Reports reflect the operations.
8. **Restaurar demo** returns the baseline and simulation works again.

Expected: no uncaught console errors and no failed API requests.

- [ ] **Step 5: Commit documentation and commands**

```bash
git add package.json README.md docs/demo-runbook.md
git commit -m "docs: add local demo runbook"
```

### Task 7: Final regression and handoff

**Files:**
- Verify all modified files

- [ ] **Step 1: Inspect the worktree**

Run: `git status --short && git diff --check HEAD~6..HEAD`

Expected: only the pre-existing `.DS_Store` and `tmp/` remain untracked; no whitespace errors.

- [ ] **Step 2: Run the final suite once more**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: exit 0.

- [ ] **Step 3: Record the exact presentation commands**

Use:

```bash
pnpm demo:reset
pnpm demo:prymeira
```

Open `http://localhost:5176`. Keep the browser at 1440×900 or larger so the three-panel Atendimento layout remains visible.
