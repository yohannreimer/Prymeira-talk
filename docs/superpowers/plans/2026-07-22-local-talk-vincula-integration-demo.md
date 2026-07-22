# Local Talk + Vincula Integration Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable SSD-hosted localhost demo in which Prymeira Talk writes a real company, contact, Kanban opportunity, and AI note to the native Vincula CRM, opens the created record directly, and resets both products together.

**Architecture:** Run the native Vincula PostgreSQL API and frontend beside Talk, using separate databases in the existing PostgreSQL cluster stored under the Talk repository on the SSD. Vincula gets an environment-gated local identity and workspace; Talk gets a server-side integration token, a deal-oriented adapter, deep links, and a coordinated reset client. Shell scripts under Talk orchestrate both sibling repositories and keep database data, logs, PIDs, and temporary files under `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local`.

**Tech Stack:** TypeScript, React 19, Vite, Fastify, Node HTTP, PostgreSQL 16, Prisma, Vitest, Node test runner, shell scripts, pnpm, npm.

---

## Repository and Runtime Map

- Talk root: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk`
- Vincula root: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM`
- PostgreSQL cluster: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local/demo-postgres/data`
- Talk database: `prymeira_talk`
- Vincula database: `prymeira_vincula_demo`
- Integrated logs: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local/integrated-demo/logs`
- Integrated temporary directory: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local/integrated-demo/tmp`
- Fixed Vincula demo workspace: `70000000-0000-4000-8000-000000000001`
- Fixed local token: `prymeira-vincula-local-demo`
- Ports: Talk API `3002`, Vincula API `3003`, Vincula web `5174`, Talk web `5176`, PostgreSQL `54329`.

## File Structure

### Vincula CRM

- Create `server/local-demo.js`: parse and validate local-demo environment; authenticate only the fixed local token outside production.
- Create `server/local-demo.test.mjs`: cover disabled, production, incorrect-token, and valid-token behavior.
- Create `server/local-demo-seed.js`: reset only the fixed workspace and seed five sellers, pipeline, neutral companies, contacts, deals, deal notes, and configuration.
- Create `server/local-demo-seed.test.mjs`: verify workspace-scoped SQL, transaction behavior, and deterministic IDs with a recording database client.
- Modify `server/index.js`: use local authentication, expose service-aware health, and add protected `POST /api/demo/reset`.
- Create `local-demo/main.tsx`: local real-data browser entrypoint.
- Create `local-demo/App.tsx`: configure the PostgreSQL data provider, local auth provider, and local demo layout.
- Create `local-demo/LocalDemoLayout.tsx`: render the native layout with a discreet demo badge.
- Create `src/components/atomic-crm/providers/postgres/localDemoAuthProvider.ts`: deterministic administrator identity for the native local frontend.
- Create `src/components/atomic-crm/providers/postgres/localDemoAuthProvider.test.ts`: verify auth and identity behavior.
- Create `vite.local-demo.config.ts`: build/serve `local-demo/main.tsx` on port `5174`.
- Modify `package.json`: add `demo:local`, `test:server`, and combined validation scripts.

### Prymeira Talk

- Modify `apps/api/src/env.ts`: add server-only Vincula token, web URL, integrated-demo strictness, reset URL, and reset token.
- Modify `apps/api/src/env.test.ts`: verify defaults and production rejection for local integrated mode.
- Modify `apps/api/src/app.ts`: pass the complete Vincula configuration into CRM and demo routes.
- Modify `apps/api/src/modules/crm/crm.routes.ts`: choose the configured server token before a browser bearer token.
- Modify `apps/api/src/modules/crm/crm.service.ts`: synchronize native Vincula deals and deal notes, preserve legacy storage fields, and return deep-link identifiers.
- Modify `apps/api/src/modules/crm/crm.service.test.ts`: cover real deal creation, update, lookup fallback, note target, server token, and strict failures.
- Create `apps/api/src/modules/demo/vincula-demo-client.ts`: call the protected Vincula reset endpoint and normalize errors.
- Create `apps/api/src/modules/demo/vincula-demo-client.test.ts`: cover success, unavailable service, and invalid response.
- Modify `apps/api/src/modules/demo/demo.routes.ts`: coordinate Talk and Vincula resets and report partial reset failures.
- Modify `apps/api/src/modules/demo/demo.routes.test.ts`: verify reset ordering and partial-result semantics.
- Modify `apps/web/src/app/api.ts`: parse coordinated reset results and expose `vinculaDealId` data.
- Modify `apps/web/src/features/crm/CrmPage.tsx`: show real-local wording and **Abrir no Vincula** deep link.
- Modify `apps/web/src/features/crm/CrmPage.test.tsx`: test deep-link generation and simulated-action suppression.
- Modify `apps/web/src/features/inbox/DemoControls.tsx`: report both-system reset success or a partial failure.
- Modify `apps/web/src/features/inbox/DemoControls.test.tsx`: cover the new reset notice.
- Modify `apps/web/src/styles.css`: style the external deep-link action without changing the existing CRM hierarchy.
- Modify `scripts/start-demo-postgres.sh`: add an opt-in local-only mode that skips Docker and guarantees the existing SSD state path.
- Create `scripts/reset-integrated-demo.sh`: prepare Talk, temporarily start or reuse Vincula API, reset Vincula, and clean up only owned processes.
- Create `scripts/start-integrated-demo.sh`: start all four app processes, write logs/PIDs under `.local`, and terminate children on exit.
- Create `scripts/check-integrated-demo.sh`: validate both health endpoints and database storage paths.
- Modify `package.json`: add `demo:reset:all`, `demo:stack`, and `demo:check`.
- Modify `.env.example`: document the new variables without placing production secrets in the file.
- Modify `docs/demo-runbook.md`: make the real Talk-to-Vincula reveal the primary presentation path.
- Modify `README.md`: document the reusable integrated-demo commands.

### No Files Outside the SSD

Every execution command in this plan must begin from one of the two SSD repository roots. Orchestration scripts export:

```sh
demo_runtime_dir="$talk_root/.local/integrated-demo"
mkdir -p "$demo_runtime_dir/tmp" "$demo_runtime_dir/logs" "$demo_runtime_dir/pids"
export TMPDIR="$demo_runtime_dir/tmp"
export XDG_CACHE_HOME="$demo_runtime_dir/cache"
```

Do not use `/tmp` for new scripts, do not create a database cluster in the user home directory, and do not move either repository off `/Volumes/SanDiskSSD`.

---

### Task 0: Confirm SSD Scope and Create Feature Branches

**Files:**
- No file changes.

- [ ] **Step 1: Confirm both repository roots are on the SSD**

```sh
case "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk" in /Volumes/SanDiskSSD/*) ;; *) exit 1 ;; esac
case "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" in /Volumes/SanDiskSSD/*) ;; *) exit 1 ;; esac
```

Expected: exit `0`.

- [ ] **Step 2: Audit both worktrees without modifying user files**

```sh
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk" status --short
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" status --short
```

Expected: Talk may show only the user's pre-existing `.DS_Store` and `tmp/`; Vincula is clean. Stop and ask the user before touching any unexpected tracked or untracked file that overlaps the plan.

- [ ] **Step 3: Create or switch to feature branches in place on the SSD**

```sh
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk" switch -c codex/local-integrated-demo
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" switch -c codex/local-integrated-demo
```

If either branch already exists, use `git switch codex/local-integrated-demo` in that repository. Do not create a worktree or temporary clone outside `/Volumes/SanDiskSSD`.

---

### Task 1: Add Vincula Local-Demo Authentication

**Files:**
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/local-demo.js`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/local-demo.test.mjs`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/index.js`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/package.json`

- [ ] **Step 1: Create the failing authentication tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readLocalDemoConfig, authenticateLocalDemo } from "./local-demo.js";

const validEnv = {
  NODE_ENV: "development",
  VINCULA_LOCAL_DEMO_ENABLED: "true",
  VINCULA_LOCAL_DEMO_TOKEN: "prymeira-vincula-local-demo",
  VINCULA_LOCAL_DEMO_WORKSPACE_ID: "70000000-0000-4000-8000-000000000001",
};

test("local demo is disabled unless explicitly enabled", () => {
  assert.equal(readLocalDemoConfig({ NODE_ENV: "development" }), null);
});

test("local demo is rejected in production", () => {
  assert.throws(
    () => readLocalDemoConfig({ ...validEnv, NODE_ENV: "production" }),
    /cannot run in production/,
  );
});

test("valid local token resolves the fixed owner workspace", () => {
  const config = readLocalDemoConfig(validEnv);
  assert.deepEqual(authenticateLocalDemo("prymeira-vincula-local-demo", config), {
    token: "prymeira-vincula-local-demo",
    workspaceId: "70000000-0000-4000-8000-000000000001",
    workspaceRole: "owner",
    productRole: "admin",
    clerkUserId: "local-demo-marina",
    email: "marina@novabase.demo",
    name: "Marina Costa",
    localDemo: true,
  });
  assert.equal(authenticateLocalDemo("wrong", config), null);
});
```

- [ ] **Step 2: Run the test and confirm it fails because the module does not exist**

Run from Vincula root:

```sh
TMPDIR="/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local/integrated-demo/tmp" node --test server/local-demo.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/local-demo.js`.

- [ ] **Step 3: Implement the environment gate and local authenticator**

```js
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readLocalDemoConfig(env = process.env) {
  if (env.VINCULA_LOCAL_DEMO_ENABLED !== "true") return null;
  if (env.NODE_ENV === "production") {
    throw new Error("Vincula local demo cannot run in production");
  }
  const token = String(env.VINCULA_LOCAL_DEMO_TOKEN || "").trim();
  const workspaceId = String(env.VINCULA_LOCAL_DEMO_WORKSPACE_ID || "").trim();
  if (!token) throw new Error("VINCULA_LOCAL_DEMO_TOKEN is required");
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new Error("VINCULA_LOCAL_DEMO_WORKSPACE_ID must be a UUID");
  }
  return { token, workspaceId };
}

export function authenticateLocalDemo(token, config) {
  if (!config || token !== config.token) return null;
  return {
    token,
    workspaceId: config.workspaceId,
    workspaceRole: "owner",
    productRole: "admin",
    clerkUserId: "local-demo-marina",
    email: "marina@novabase.demo",
    name: "Marina Costa",
    localDemo: true,
  };
}
```

In `server/index.js`, read the config before validating `PRYMEIRA_ACCOUNT_API_URL`, allow the Account API to be absent only in local-demo mode, and make `authenticate` try `authenticateLocalDemo(token, localDemoConfig)` before `checkAccess(token)`.

- [ ] **Step 4: Add and run the server test script**

Add to `package.json`:

```json
"test:server": "node --test server/*.test.mjs"
```

Run:

```sh
npm run test:server
```

Expected: all existing security tests and new local-demo tests PASS.

- [ ] **Step 5: Commit the Vincula authentication slice**

```sh
git add server/local-demo.js server/local-demo.test.mjs server/index.js package.json
git commit -m "feat: add protected Vincula local demo auth"
```

---

### Task 2: Add the Vincula Deterministic Reset and Seed

**Files:**
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/local-demo-seed.js`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/local-demo-seed.test.mjs`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/index.js`

- [ ] **Step 1: Write the failing reset isolation tests**

Use a recording client whose `query` method stores SQL and parameters. Assert that `resetLocalDemoWorkspace(client, workspaceId)`:

```js
assert.equal(calls[0].sql, "begin");
assert.ok(calls.every((call) =>
  !call.sql.toLowerCase().startsWith("delete") || call.params?.[0] === workspaceId
));
assert.ok(calls.some((call) =>
  call.sql.includes("insert into public.sales") && call.params?.includes(workspaceId)
));
assert.ok(calls.some((call) => call.sql.includes("Marina")));
assert.equal(calls.at(-1).sql, "commit");
```

Add a second test that makes one query throw and expects `rollback` with the original error rethrown.

- [ ] **Step 2: Run the test and confirm the seed module is missing**

```sh
npm run test:server
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `local-demo-seed.js`.

- [ ] **Step 3: Implement the workspace-scoped reset**

Export these constants and function from `server/local-demo-seed.js`:

```js
export const LOCAL_DEMO_SALE_IDS = [9101, 9102, 9103, 9104, 9105];
export const LOCAL_DEMO_PIPELINE_ID = 9201;

const DELETE_TABLES = [
  "proposal_items", "proposals", "proposal_template_items", "proposal_templates",
  "tasks", "stage_task_templates", "deal_notes", "deals", "contact_notes",
  "contacts", "companies", "leads", "sales_goals", "automation_runs",
  "automation_rules", "tags", "favicons_excluded_domains", "pipelines", "sales", "configuration",
];

export async function resetLocalDemoWorkspace(client, workspaceId) {
  await client.query("begin");
  try {
    for (const table of DELETE_TABLES) {
      await client.query(`delete from public.${table} where workspace_id = $1`, [workspaceId]);
    }
    await client.query(`insert into public.sales
      (id, workspace_id, clerk_user_id, first_name, last_name, email, administrator, workspace_role, product_role, disabled)
      values
      (9101, $1, 'local-demo-marina', 'Marina', 'Costa', 'marina@novabase.demo', true, 'owner', 'admin', false),
      (9102, $1, 'local-demo-rafael', 'Rafael', 'Nunes', 'rafael@novabase.demo', false, 'member', 'member', false),
      (9103, $1, 'local-demo-bia', 'Bia', 'Almeida', 'bia@novabase.demo', false, 'member', 'member', false),
      (9104, $1, 'local-demo-lucas', 'Lucas', 'Ribeiro', 'lucas@novabase.demo', false, 'member', 'member', false),
      (9105, $1, 'local-demo-fernanda', 'Fernanda', 'Lima', 'fernanda@novabase.demo', false, 'member', 'member', false)`, [workspaceId]);
    await client.query(`insert into public.pipelines (id, workspace_id, name, stages)
      values (9201, $1, 'Pipeline comercial', $2::jsonb)`, [workspaceId, JSON.stringify([
        { value: "opportunity", label: "Oportunidade" },
        { value: "proposal-sent", label: "Proposta enviada" },
        { value: "in-negociation", label: "Em negociação" },
        { value: "won", label: "Ganho" },
        { value: "lost", label: "Perdido" },
      ])]);
    await client.query(`insert into public.companies
      (id, workspace_id, name, sector, size, city, state_abbr, sales_id, description)
      values
      (9301, $1, 'Atlas Facilities', 'Serviços empresariais', 85, 'Curitiba', 'PR', 9102, 'Conta ativa de serviços corporativos.'),
      (9302, $1, 'Lumina Office', 'Mobiliário corporativo', 42, 'Florianópolis', 'SC', 9103, 'Expansão de duas unidades em análise.'),
      (9303, $1, 'Vértice Logística', 'Logística', 130, 'Joinville', 'SC', 9104, 'Operação regional em processo de digitalização.'),
      (9304, $1, 'Nexo Equipamentos', 'Equipamentos profissionais', 64, 'Porto Alegre', 'RS', 9105, 'Renovação do contrato comercial prevista para o trimestre.')`, [workspaceId]);
    await client.query(`insert into public.contacts
      (id, workspace_id, first_name, last_name, title, status, company_id, sales_id, email_jsonb, phone_jsonb)
      values
      (9401, $1, 'Ana', 'Ferreira', 'Gerente de Operações', 'active', 9301, 9102, '[{"email":"ana@atlas.demo","type":"Work"}]'::jsonb, '[{"number":"5541999001101","type":"Work"}]'::jsonb),
      (9402, $1, 'João', 'Martins', 'Diretor Comercial', 'active', 9302, 9103, '[{"email":"joao@lumina.demo","type":"Work"}]'::jsonb, '[{"number":"5548999002202","type":"Work"}]'::jsonb),
      (9403, $1, 'Camila', 'Oliveira', 'Coordenadora de Projetos', 'active', 9303, 9104, '[{"email":"camila@vertice.demo","type":"Work"}]'::jsonb, '[{"number":"5547999003303","type":"Work"}]'::jsonb),
      (9404, $1, 'Pedro', 'Nunes', 'Gestor de Suprimentos', 'active', 9304, 9105, '[{"email":"pedro@nexo.demo","type":"Work"}]'::jsonb, '[{"number":"5551999004404","type":"Work"}]'::jsonb)`, [workspaceId]);
    await client.query(`insert into public.deals
      (id, workspace_id, name, company_id, contact_ids, category, stage, description, amount, sales_id, index, deal_type, probability, source, pipeline_id)
      values
      (9501, $1, 'Expansão operacional Atlas', 9301, '{9401}', 'Serviços', 'opportunity', 'Mapeamento inicial concluído.', 48000, 9102, 0, 'consultative', 40, 'Indicação', 9201),
      (9502, $1, 'Projeto corporativo Lumina', 9302, '{9402}', 'Projeto', 'proposal-sent', 'Proposta enviada para avaliação.', 76000, 9103, 0, 'consultative', 60, 'Evento', 9201),
      (9503, $1, 'Digitalização Vértice', 9303, '{9403}', 'Implantação', 'in-negociation', 'Condições comerciais em negociação.', 124000, 9104, 0, 'consultative', 80, 'Inbound', 9201),
      (9504, $1, 'Renovação Nexo', 9304, '{9404}', 'Renovação', 'won', 'Renovação aprovada pelo cliente.', 58000, 9105, 0, 'consultative', 100, 'Carteira', 9201)`, [workspaceId]);
    await client.query(`insert into public.deal_notes
      (id, workspace_id, deal_id, type, text, sales_id)
      values
      (9601, $1, 9501, 'note', 'Cliente quer revisar escopo e cronograma na próxima reunião.', 9102),
      (9602, $1, 9502, 'note', 'Proposta apresentada com duas opções de implantação.', 9103),
      (9603, $1, 9503, 'note', 'Decisor solicitou ajuste no prazo de pagamento.', 9104),
      (9604, $1, 9504, 'note', 'Contrato aprovado e encaminhado para implantação.', 9105)`, [workspaceId]);
    await client.query(`insert into public.configuration (workspace_id, config)
      values ($1, '{}'::jsonb)`, [workspaceId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
```

- [ ] **Step 4: Add the protected API route**

In `server/index.js`, before generic records routing:

```js
if (url.pathname === "/api/demo/reset" && req.method === "POST") {
  if (!auth.localDemo || !localDemoConfig || auth.workspaceId !== localDemoConfig.workspaceId) {
    error(res, 403, "Local demo reset is not authorized");
    return;
  }
  const client = await pool.connect();
  try {
    await resetLocalDemoWorkspace(client, localDemoConfig.workspaceId);
  } finally {
    client.release();
  }
  json(res, 200, { ok: true, workspaceId: localDemoConfig.workspaceId, sales: 5 });
  return;
}
```

Change health to return `{ ok: true, service: "vincula-crm" }` so orchestration cannot mistake another process on port `3003` for Vincula.

- [ ] **Step 5: Run server tests and commit**

```sh
npm run test:server
git add server/local-demo-seed.js server/local-demo-seed.test.mjs server/index.js
git commit -m "feat: seed resettable Vincula demo workspace"
```

Expected: all server tests PASS.

---

### Task 3: Run the Native Vincula Frontend Against the Real Local API

**Files:**
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/local-demo/main.tsx`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/local-demo/App.tsx`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/local-demo/LocalDemoLayout.tsx`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/src/components/atomic-crm/providers/postgres/localDemoAuthProvider.ts`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/src/components/atomic-crm/providers/postgres/localDemoAuthProvider.test.ts`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/vite.local-demo.config.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/package.json`

- [ ] **Step 1: Write the local auth provider tests**

```ts
const auth = createLocalDemoAuthProvider();
await expect(auth.checkAuth!({})).resolves.toBeUndefined();
await expect(auth.canAccess!({ action: "delete", resource: "sales" })).resolves.toBe(true);
await expect(auth.getIdentity!()).resolves.toEqual({
  id: 9101,
  fullName: "Marina Costa",
});
```

- [ ] **Step 2: Run the focused browser test and verify failure**

```sh
npm run test:unit:app -- src/components/atomic-crm/providers/postgres/localDemoAuthProvider.test.ts
```

Expected: FAIL because `createLocalDemoAuthProvider` does not exist.

- [ ] **Step 3: Implement the provider and local entrypoint**

The provider must implement `login`, `logout`, `checkError`, `checkAuth`, `canAccess`, and `getIdentity`, always resolve local demo access, and never call Clerk or the Hub.

In `local-demo/App.tsx`:

```tsx
import { memoryStore } from "ra-core";
import { CRM } from "@/components/atomic-crm/root/CRM";
import { getDataProvider } from "@/components/atomic-crm/providers/postgres";
import { setPostgresAccessTokenProvider } from "@/components/atomic-crm/providers/postgres/authToken";
import { createLocalDemoAuthProvider } from "@/components/atomic-crm/providers/postgres/localDemoAuthProvider";
import { LocalDemoLayout } from "./LocalDemoLayout";

const token = import.meta.env.VITE_VINCULA_LOCAL_DEMO_TOKEN;
if (!token) throw new Error("VITE_VINCULA_LOCAL_DEMO_TOKEN is required");
setPostgresAccessTokenProvider(() => token);

export default function App() {
  return <CRM
    dataProvider={getDataProvider()}
    authProvider={createLocalDemoAuthProvider()}
    store={memoryStore()}
    layout={LocalDemoLayout}
    disableTelemetry
  />;
}
```

`LocalDemoLayout` wraps the existing `Layout` and renders a fixed, accessible badge with text `Ambiente de demonstração local`.

- [ ] **Step 4: Add the Vite config and package command**

Base `vite.local-demo.config.ts` on `vite.demo.config.ts`, but inject `local-demo/main.tsx`, set `VITE_IS_DEMO` to `false`, preserve aliases, and do not provide Clerk or Supabase variables.

Add:

```json
"demo:local": "vite --config vite.local-demo.config.ts --host 0.0.0.0 --port 5174 --force"
```

- [ ] **Step 5: Verify typecheck, focused tests, and build**

```sh
npm run test:unit:app -- src/components/atomic-crm/providers/postgres/localDemoAuthProvider.test.ts
npm run typecheck
VITE_CRM_API_URL=http://localhost:3003/api VITE_VINCULA_LOCAL_DEMO_TOKEN=prymeira-vincula-local-demo npm run build -- --config vite.local-demo.config.ts
```

Expected: test PASS, typecheck PASS, and Vite build completes.

- [ ] **Step 6: Commit the native local frontend**

```sh
git add local-demo src/components/atomic-crm/providers/postgres/localDemoAuthProvider.ts src/components/atomic-crm/providers/postgres/localDemoAuthProvider.test.ts vite.local-demo.config.ts package.json
git commit -m "feat: run Vincula native local demo"
```

---

### Task 4: Add Strict Server-Side Vincula Configuration to Talk

**Files:**
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/env.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/env.test.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/app.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/crm/crm.routes.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/crm/crm.service.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/crm/crm.service.test.ts`

- [ ] **Step 1: Write failing environment and token-precedence tests**

Add environment assertions for:

```ts
expect(readEnv({ ...baseEnv, VINCULA_CRM_API_TOKEN: "server-token" }).VINCULA_CRM_API_TOKEN)
  .toBe("server-token");
expect(() => readEnv({
  ...baseEnv,
  NODE_ENV: "production",
  PRYMEIRA_LOCAL_DEMO_ENABLED: "true",
  VINCULA_CRM_STRICT_REAL: "true"
})).toThrow();
```

Register `crmRoutes` with `{ vinculaApiUrl, vinculaApiToken: "server-token", vinculaWebUrl: "http://localhost:5174", strictReal: true }`, inject a create request without browser authorization, and expect the mocked Vincula request to use `Bearer server-token`.

- [ ] **Step 2: Run focused tests and verify failure**

```sh
pnpm --filter @prymeira-talk/api test -- src/env.test.ts src/modules/crm/crm.service.test.ts
```

Expected: FAIL because the new environment properties and route options are absent.

- [ ] **Step 3: Add explicit configuration**

Add these fields to `envSchema`:

```ts
VINCULA_CRM_API_TOKEN: optionalNonEmptyString,
VINCULA_CRM_WEB_URL: optionalUrl,
VINCULA_CRM_STRICT_REAL: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
VINCULA_CRM_RESET_URL: optionalUrl,
VINCULA_CRM_RESET_TOKEN: optionalNonEmptyString
```

Reject `VINCULA_CRM_STRICT_REAL` in production when local demo mode is enabled. Pass the values through `app.ts`.

In `crm.routes.ts`, resolve the token as:

```ts
const vinculaToken = options.vinculaApiToken ?? readBearerToken(request.headers.authorization);
```

Pass `strictReal`, `vinculaWebUrl`, and `environment` into `createCrmService`. In `app.ts`, set `environment` to `local-demo` only when both `PRYMEIRA_LOCAL_DEMO_ENABLED` and `VINCULA_CRM_STRICT_REAL` are true; otherwise use `external`. When strict real mode is true and URL, web URL, or token is absent, throw `VINCULA_SYNC_FAILED` with status `503`; never create a simulated success.

- [ ] **Step 4: Run focused tests and commit**

```sh
pnpm --filter @prymeira-talk/api test -- src/env.test.ts src/modules/crm/crm.service.test.ts
git add apps/api/src/env.ts apps/api/src/env.test.ts apps/api/src/app.ts apps/api/src/modules/crm
git commit -m "feat: configure strict local Vincula writes"
```

Expected: focused tests PASS.

---

### Task 5: Synchronize Native Vincula Deals and Deal Notes

**Files:**
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/crm/crm.service.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/crm/crm.service.test.ts`

- [ ] **Step 1: Replace lead expectations with failing deal expectations**

Cover these cases with ordered fetch mocks:

```ts
expect(fetchCrm).toHaveBeenCalledWith(
  "http://localhost:3003/api/records/deals",
  expect.objectContaining({
    method: "POST",
    body: expect.stringContaining('"source":"Prymeira Talk"')
  })
);
expect(fetchCrm).toHaveBeenCalledWith(
  "http://localhost:3003/api/records/deal_notes",
  expect.objectContaining({ method: "POST" })
);
expect(action.result).toMatchObject({
  mode: "real",
  dealCreated: true,
  vinculaCompanyId: "9",
  vinculaContactId: "42",
  vinculaDealId: "77",
  vinculaNoteId: "88",
  vinculaRecordUrl: "http://localhost:5174/deals/77/show",
  environment: "local-demo"
});
```

Add tests that an existing `atomicCrmLeadId: "77"` causes `PATCH /records/deals/77`, a stale `77` causes lookup by company/contact/name/source before POST, and explicit note sending writes to `/records/deal_notes` when a deal ID exists.

- [ ] **Step 2: Run the CRM tests and confirm the old lead adapter fails the new assertions**

```sh
pnpm --filter @prymeira-talk/api test -- src/modules/crm/crm.service.test.ts
```

Expected: FAIL because requests still target `/records/leads` and `/records/contact_notes`.

- [ ] **Step 3: Implement the native deal payload and lookup**

Use this payload shape:

```ts
function buildVinculaDealPayload(
  contact: ContactRecord,
  title: string,
  refs: { companyId: string; contactId: string; pipelineId: string; ownerId: string }
) {
  return {
    name: title.trim(),
    company_id: Number(refs.companyId),
    contact_ids: [Number(refs.contactId)],
    category: "Orçamento",
    deal_type: "consultative",
    probability: 75,
    source: "Prymeira Talk",
    stage: "opportunity",
    description: [
      "Oportunidade qualificada pela IA do Prymeira Talk.",
      contact.name ? `Contato: ${contact.name}` : null,
      contact.phone ? `Telefone: ${contact.phone}` : null,
      contact.company ? `Empresa: ${contact.company}` : null
    ].filter(Boolean).join("\n"),
    amount: 0,
    sales_id: Number(refs.ownerId),
    pipeline_id: Number(refs.pipelineId),
    index: 0
  };
}
```

Resolve pipeline `9201` and owner `9101` in integrated local mode through configured adapter defaults; for general real mode, query the first active pipeline and first enabled owner. Store the returned deal ID in Talk's existing `atomicCrmLeadId` field for database compatibility, but return `vinculaDealId` in action results. Build `vinculaRecordUrl` from the server-side `VINCULA_CRM_WEB_URL`, preferring `/deals/{id}/show` and falling back to `/contacts/{id}/show`. Include `environment: "local-demo"` when strict integrated mode is active.

Create initial and explicit AI notes through `/records/deal_notes` with `{ deal_id, text, sales_id: ownerId, type: "note" }`. Use `/records/contact_notes` only when no synchronized deal exists.

- [ ] **Step 4: Run focused tests and commit**

```sh
pnpm --filter @prymeira-talk/api test -- src/modules/crm/crm.service.test.ts
git add apps/api/src/modules/crm/crm.service.ts apps/api/src/modules/crm/crm.service.test.ts
git commit -m "feat: sync Talk opportunities to Vincula deals"
```

Expected: CRM service and route tests PASS.

---

### Task 6: Add Deep Links and Real-Local Status to Talk

**Files:**
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/web/src/features/crm/CrmPage.tsx`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/web/src/features/crm/CrmPage.test.tsx`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/web/src/styles.css`

- [ ] **Step 1: Write failing deep-link helper tests**

Export and test a reader that accepts only completed real actions and validated HTTP(S) URLs returned by the API:

```ts
expect(readVinculaRecordUrl({
  mode: "real",
  status: "completed",
  result: { vinculaRecordUrl: "http://localhost:5174/deals/77/show" }
})).toBe("http://localhost:5174/deals/77/show");
expect(readVinculaRecordUrl({
  mode: "simulated",
  status: "completed",
  result: { vinculaRecordUrl: "http://localhost:5174/contacts/42/show" }
})).toBeNull();
expect(readVinculaRecordUrl({
  mode: "real",
  status: "completed",
  result: { vinculaRecordUrl: "javascript:alert(1)" }
})).toBeNull();
```

Also test that simulated actions never produce an external link.

- [ ] **Step 2: Run the focused web test and verify failure**

```sh
pnpm --filter @prymeira-talk/web test -- src/features/crm/CrmPage.test.tsx
```

Expected: FAIL because `readVinculaRecordUrl` is missing.

- [ ] **Step 3: Implement real-local presentation state**

Read `vinculaDealId`, with legacy fallback from `vinculaLeadId` and `atomicCrmLeadId`. For completed real actions, render:

```tsx
<a
  className="crm-open-vincula"
  href={recordUrl}
  target="_blank"
  rel="noreferrer"
>
  Abrir no Vincula <ExternalLink size={14} />
</a>
```

Use only the API-returned `vinculaRecordUrl`; do not construct the target from untrusted identifiers in the browser. Change the success notice to `Sincronizado no Vincula local.` when the action result contains `environment: "local-demo"`. Change the guide copy so real local writes are no longer described as simulated IDs.

- [ ] **Step 4: Run web tests, typecheck, and commit**

```sh
pnpm --filter @prymeira-talk/web test -- src/features/crm/CrmPage.test.tsx
pnpm --filter @prymeira-talk/web typecheck
git add apps/web/src/features/crm/CrmPage.tsx apps/web/src/features/crm/CrmPage.test.tsx apps/web/src/styles.css
git commit -m "feat: open synchronized records in Vincula"
```

Expected: test and typecheck PASS.

---

### Task 7: Coordinate Talk and Vincula Resets

**Files:**
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/vincula-demo-client.ts`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/vincula-demo-client.test.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/demo.routes.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/demo.routes.test.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/web/src/app/api.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/web/src/features/inbox/DemoControls.tsx`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/web/src/features/inbox/DemoControls.test.tsx`

- [ ] **Step 1: Write failing reset-client tests**

```ts
const client = createVinculaDemoClient({
  resetUrl: "http://localhost:3003/api/demo/reset",
  token: "prymeira-vincula-local-demo",
  fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ok: true,
    workspaceId: "70000000-0000-4000-8000-000000000001",
    sales: 5
  }), { status: 200 })) as typeof fetch
});
await expect(client.reset()).resolves.toMatchObject({ ok: true, sales: 5 });
```

Add a `503` test for connection failure and a `502`-class normalized error for malformed or non-OK responses.

- [ ] **Step 2: Run focused demo tests and verify failure**

```sh
pnpm --filter @prymeira-talk/api test -- src/modules/demo/vincula-demo-client.test.ts src/modules/demo/demo.routes.test.ts
```

Expected: FAIL because the reset client does not exist.

- [ ] **Step 3: Implement the reset client and route coordination**

`createVinculaDemoClient` performs `POST` with `Authorization: Bearer <token>` and a five-second `AbortSignal.timeout(5000)`.

Change the Talk reset route to run Vincula reset first, then Talk reset. This ordering prevents Talk from clearing the external IDs before an external reset failure is reported. Return:

```ts
{
  ...talkResult,
  vincula: {
    ok: true,
    workspaceId: "70000000-0000-4000-8000-000000000001",
    sales: 5
  }
}
```

If Vincula fails in integrated mode, return HTTP `503` with `{ code: "VINCULA_DEMO_RESET_FAILED", talkReset: false, vinculaReset: false }` and leave Talk unchanged. If Vincula resets but Talk reset fails, return HTTP `500` with `{ code: "TALK_DEMO_RESET_FAILED", talkReset: false, vinculaReset: true }` so the UI reports the partial reset honestly. Outside integrated mode, retain the existing Talk-only reset behavior.

- [ ] **Step 4: Update the web response and notice**

Extend `DemoResetResultDto` with optional `vincula`. A successful integrated reset notice becomes:

```text
Demonstração restaurada: Talk e Vincula prontos, com 5 vendedores e 10 conversas.
```

The existing error panel displays the API failure text when the coordinated reset cannot complete.

- [ ] **Step 5: Run API and web tests and commit**

```sh
pnpm --filter @prymeira-talk/api test -- src/modules/demo/vincula-demo-client.test.ts src/modules/demo/demo.routes.test.ts
pnpm --filter @prymeira-talk/web test -- src/features/inbox/DemoControls.test.tsx
git add apps/api/src/modules/demo apps/api/src/app.ts apps/web/src/app/api.ts apps/web/src/features/inbox
git commit -m "feat: reset Talk and Vincula demo together"
```

Expected: focused API and web tests PASS.

---

### Task 8: Add SSD-Only Integrated Demo Orchestration

**Files:**
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/scripts/start-demo-postgres.sh`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/scripts/reset-integrated-demo.sh`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/scripts/start-integrated-demo.sh`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/scripts/check-integrated-demo.sh`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/package.json`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.env.example`

- [ ] **Step 1: Add an SSD-local database mode without changing Talk-only defaults**

In `start-demo-postgres.sh`, read `PRYMEIRA_DEMO_DB_MODE=${PRYMEIRA_DEMO_DB_MODE:-auto}`. Keep the current Docker-first behavior for `auto`; when the value is `local`, skip the Docker branch and start the Homebrew PostgreSQL cluster at `project_dir/.local/demo-postgres`. Reject any other value. This preserves `pnpm demo:db`, `pnpm demo:reset`, and `pnpm demo:prymeira` behavior while allowing the integrated demo to guarantee SSD storage.

- [ ] **Step 2: Implement `reset-integrated-demo.sh`**

The script must:

```sh
set -eu
talk_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
vincula_root=$(CDPATH= cd -- "$talk_root/../Vincula CRM" && pwd)
runtime_dir="$talk_root/.local/integrated-demo"
mkdir -p "$runtime_dir/tmp" "$runtime_dir/logs" "$runtime_dir/pids" "$runtime_dir/cache"
export TMPDIR="$runtime_dir/tmp"
export XDG_CACHE_HOME="$runtime_dir/cache"
test "${talk_root#"/Volumes/SanDiskSSD/"}" != "$talk_root"
test "${vincula_root#"/Volumes/SanDiskSSD/"}" != "$vincula_root"
```

Then run `PRYMEIRA_DEMO_DB_MODE=local pnpm demo:db`, verify PostgreSQL reports a `data_directory` below `/Volumes/SanDiskSSD`, create `prymeira_vincula_demo` with owner `postgres` only when it does not exist, apply Prisma and seed Talk, launch a temporary Vincula API only if `http://localhost:3003/api/health` is not already the Vincula service, wait up to 30 seconds, call protected reset, and kill only the temporary PID it created. Store its log and PID in `runtime_dir`.

- [ ] **Step 3: Implement `start-integrated-demo.sh`**

Validate that both repositories and the SSD runtime exist. Start these processes with logs under `runtime_dir/logs`:

```sh
# Vincula API
PORT=3003 DATABASE_URL=postgresql://postgres@127.0.0.1:54329/prymeira_vincula_demo \
VINCULA_LOCAL_DEMO_ENABLED=true \
VINCULA_LOCAL_DEMO_TOKEN=prymeira-vincula-local-demo \
VINCULA_LOCAL_DEMO_WORKSPACE_ID=70000000-0000-4000-8000-000000000001 \
node "$vincula_root/server/index.js"

# Vincula web
VITE_CRM_API_URL=http://localhost:3003/api \
VITE_VINCULA_LOCAL_DEMO_TOKEN=prymeira-vincula-local-demo \
npm --prefix "$vincula_root" run demo:local

# Talk API and web
VINCULA_CRM_API_URL=http://localhost:3003/api \
VINCULA_CRM_API_TOKEN=prymeira-vincula-local-demo \
VINCULA_CRM_WEB_URL=http://localhost:5174 \
VINCULA_CRM_STRICT_REAL=true \
VINCULA_CRM_RESET_URL=http://localhost:3003/api/demo/reset \
VINCULA_CRM_RESET_TOKEN=prymeira-vincula-local-demo \
pnpm --dir "$talk_root" demo:prymeira
```

Use a trap to terminate all owned child PIDs. Do not use `killall`, broad `pkill`, or PID discovery by process name.

- [ ] **Step 4: Implement health verification**

`check-integrated-demo.sh` checks:

- Talk health returns `ok: true` from `http://localhost:3002/health`.
- Vincula health returns `ok: true` and `service: vincula-crm` from `http://localhost:3003/api/health`.
- Both web URLs return HTTP 200.
- PostgreSQL `data_directory` begins with `/Volumes/SanDiskSSD/`.
- Database names `prymeira_talk` and `prymeira_vincula_demo` exist.
- Runtime logs, PIDs, cache, and temp directories begin with `/Volumes/SanDiskSSD/`.

- [ ] **Step 5: Add package commands and verify shell syntax**

Add:

```json
"demo:reset:all": "sh scripts/reset-integrated-demo.sh",
"demo:stack": "sh scripts/start-integrated-demo.sh",
"demo:check": "sh scripts/check-integrated-demo.sh"
```

Run:

```sh
sh -n scripts/start-demo-postgres.sh
sh -n scripts/reset-integrated-demo.sh
sh -n scripts/start-integrated-demo.sh
sh -n scripts/check-integrated-demo.sh
```

Expected: all commands exit `0` with no output.

- [ ] **Step 6: Commit orchestration**

```sh
git add scripts package.json .env.example
git commit -m "feat: orchestrate SSD local integration demo"
```

---

### Task 9: Verify the Real Cross-Application Data Flow

**Files:**
- Test: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/crm/crm.service.test.ts`
- Test: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/local-demo-seed.test.mjs`
- Runtime only: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local/integrated-demo`

- [ ] **Step 1: Reset both applications from a clean baseline**

```sh
pnpm demo:reset:all
```

Expected: output confirms Talk seeded 10 conversations and Vincula seeded five sellers; no files are created outside `/Volumes/SanDiskSSD`.

- [ ] **Step 2: Start the integrated stack and wait for health**

```sh
pnpm demo:stack
```

In another terminal on the SSD repository:

```sh
pnpm demo:check
```

Expected: both APIs, both web apps, both databases, and SSD storage checks PASS.

- [ ] **Step 3: Execute the first synchronization through Talk API**

Use the Talk UI or an authenticated local request to create Carlos's opportunity. Query Vincula with the local token and assert exactly one match for each:

```sh
curl -fsS -H 'Authorization: Bearer prymeira-vincula-local-demo' \
  'http://localhost:3003/api/records/companies?filter=%7B%22q%22%3A%22Construtora%20Horizonte%22%7D'
curl -fsS -H 'Authorization: Bearer prymeira-vincula-local-demo' \
  'http://localhost:3003/api/records/contacts?filter=%7B%22q%22%3A%225547999101010%22%7D'
curl -fsS -H 'Authorization: Bearer prymeira-vincula-local-demo' \
  'http://localhost:3003/api/records/deals?filter=%7B%22source%22%3A%22Prymeira%20Talk%22%7D'
```

Expected: company, contact, and deal totals are each `1`; the deal has stage `opportunity`, probability `75`, pipeline `9201`, owner `9101`, and the contact ID.

- [ ] **Step 4: Repeat synchronization and verify idempotency**

Run the same Talk action again and repeat the three queries.

Expected: totals remain `1`; the existing deal is updated and no second initial note is created.

- [ ] **Step 5: Send a second AI note**

Use Talk's **Enviar nota da IA**, then query `deal_notes` filtered by the returned deal ID.

Expected: one initial note plus one explicit AI note, both attached to the same deal.

- [ ] **Step 6: Run full automated verification in both repositories**

Talk:

```sh
pnpm test
pnpm typecheck
pnpm build
```

Vincula:

```sh
npm run test:server
npm run test:unit:app
npm run typecheck
npm run build
```

Expected: all suites PASS. Existing Vite chunk warnings are acceptable; test failures, type errors, and build errors are not.

---

### Task 10: Browser-Verify the WOW Journey and Reset

**Files:**
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/docs/demo-runbook.md`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/README.md`

- [ ] **Step 1: Verify the primary journey in a clean browser**

At `http://localhost:5176`:

1. Click **Simular novo lead**.
2. Open Carlos Mendes and confirm AI qualification, hot tag, and handoff.
3. Open the Vincula module.
4. Click **Criar oportunidade**.
5. Confirm `Sincronizado no Vincula local`, real company/contact/deal/note IDs, and **Abrir no Vincula**.
6. Click **Abrir no Vincula** and confirm the new tab URL is `http://localhost:5174/deals/{id}/show`.

Expected: the native Vincula deal page shows Construtora Horizonte, Carlos Mendes, source Prymeira Talk, 75% probability, Marina Costa, and the AI note. Browser console has no errors.

- [ ] **Step 2: Verify live note propagation**

Return to Talk, change the AI note text, click **Enviar nota da IA**, return to Vincula, and use its native refresh control.

Expected: the new note appears in the deal history without duplicate company, contact, or opportunity records.

- [ ] **Step 3: Verify coordinated restore**

In Talk, click **Restaurar** and confirm. Refresh the Vincula tab.

Expected: Talk returns to ten baseline conversations; Carlos and Construtora Horizonte disappear from Vincula; the four neutral Vincula baseline opportunities remain.

- [ ] **Step 4: Update the runbook and README**

Make these commands the primary integrated-demo preparation:

```sh
pnpm demo:reset:all
pnpm demo:stack
pnpm demo:check
```

Document the reveal: Talk qualification → real sync → **Abrir no Vincula** → native Kanban opportunity → live AI note → coordinated reset. Retain the Talk-only offline fallback section with `pnpm demo:reset` and `pnpm demo:prymeira`.

- [ ] **Step 5: Commit documentation**

```sh
git add docs/demo-runbook.md README.md
git commit -m "docs: add integrated Talk Vincula demo runbook"
```

- [ ] **Step 6: Final repository audit**

```sh
git status --short
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" status --short
find .local/integrated-demo -type f -maxdepth 3 -print
```

Expected: only the user's pre-existing untracked `.DS_Store` and `tmp/` may remain in Talk; Vincula is clean; every runtime artifact listed by `find` is under the Talk repository on `/Volumes/SanDiskSSD`.
