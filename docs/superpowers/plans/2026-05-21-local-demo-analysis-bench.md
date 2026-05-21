# Local Demo Analysis Bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Prymeira Talk up locally with seeded demo data and produce a module-by-module analysis report.

**Architecture:** Treat this as an operational verification slice rather than a new product feature. Use the existing Docker Compose Postgres, Prisma migrations, demo seed, Fastify API, Vite web app, and local auth bypass. Record findings in a focused report so the next phase can prioritize production-readiness work from observed behavior.

**Tech Stack:** pnpm workspaces, TypeScript, React/Vite, Fastify, Prisma/Postgres, Docker Compose, Vitest, local auth bypass, Browser/Playwright-style manual verification.

---

## File Structure

Create or modify these files during execution:

```txt
.env
docs/superpowers/reports/2026-05-21-local-demo-analysis-report.md
```

Use these files as context but do not modify unless execution exposes a specific setup bug:

```txt
.env.example
README.md
docker-compose.dev.yml
package.json
apps/api/package.json
apps/web/package.json
apps/api/prisma/schema.prisma
apps/api/prisma/seed-demo.ts
apps/api/src/server.ts
apps/api/src/app.ts
apps/web/src/app/api.ts
apps/web/src/app/auth.tsx
apps/web/src/app/App.tsx
apps/web/src/features/inbox/InboxPage.tsx
apps/web/src/features/contacts/ContactsPage.tsx
apps/web/src/features/channels/ChannelsPage.tsx
apps/web/src/features/automations/AutomationsPage.tsx
apps/web/src/features/campaigns/CampaignsPage.tsx
apps/web/src/features/reports/ReportsPage.tsx
apps/web/src/features/team/TeamPage.tsx
apps/web/src/features/assistant/AssistantPage.tsx
apps/web/src/features/crm/CrmPage.tsx
apps/web/src/features/settings/SettingsPage.tsx
```

## Task 1: Prepare Local Environment

**Files:**
- Create or modify locally: `.env`
- Read: `.env.example`
- Read: `README.md`

- [ ] **Step 1: Check whether `.env` exists**

Run:

```sh
test -f .env && printf ".env exists\n" || printf ".env missing\n"
```

Expected: either `.env exists` or `.env missing`.

- [ ] **Step 2: Create `.env` from `.env.example` only if missing**

Run only when Step 1 prints `.env missing`:

```sh
cp .env.example .env
```

Expected: command exits with code 0 and `.env` exists.

- [ ] **Step 3: Enable local bypass values in `.env`**

Run this command to set the local bench values while preserving unrelated keys:

```sh
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";

const path = ".env";
const required = new Map([
  ["DATABASE_URL", "postgresql://postgres:postgres@localhost:54329/prymeira_talk"],
  ["API_PORT", "3002"],
  ["API_HOST", "0.0.0.0"],
  ["CORS_ORIGINS", "http://localhost:5176"],
  ["PRYMEIRA_ACCOUNT_API_URL", "http://localhost:3001"],
  ["PRYMEIRA_LOCAL_AUTH_BYPASS", "true"],
  ["PRYMEIRA_LOCAL_WORKSPACE_ID", "local_workspace"],
  ["PRYMEIRA_LOCAL_ROLE", "owner"],
  ["PRYMEIRA_PRODUCT_KEY", "talk"],
  ["CLERK_SECRET_KEY", "sk_test_replace_me"],
  ["VITE_LOCAL_AUTH_BYPASS", "true"],
  ["VITE_CLERK_PUBLISHABLE_KEY", "pk_test_replace_me"],
  ["VITE_API_URL", "http://localhost:3002"],
  ["EVOLUTION_WEBHOOK_SECRET", "replace_me"]
]);

const lines = readFileSync(path, "utf8").split(/\r?\n/);
const seen = new Set();
const nextLines = lines.map((line) => {
  const match = line.match(/^([^#=\s]+)=/);
  if (!match) return line;
  const key = match[1];
  if (!required.has(key)) return line;
  seen.add(key);
  return `${key}=${required.get(key)}`;
});

for (const [key, value] of required) {
  if (!seen.has(key)) nextLines.push(`${key}=${value}`);
}

writeFileSync(path, `${nextLines.filter((line, index, list) => line !== "" || index < list.length - 1).join("\n")}\n`);
EOF
```

Expected: command exits with code 0 and writes the local bench values to `.env`.

- [ ] **Step 4: Verify required local bypass variables**

Run:

```sh
rg -n "^(DATABASE_URL|PRYMEIRA_LOCAL_AUTH_BYPASS|PRYMEIRA_LOCAL_WORKSPACE_ID|PRYMEIRA_LOCAL_ROLE|VITE_LOCAL_AUTH_BYPASS|VITE_API_URL)=" .env
```

Expected output includes:

```txt
DATABASE_URL=postgresql://postgres:postgres@localhost:54329/prymeira_talk
PRYMEIRA_LOCAL_AUTH_BYPASS=true
PRYMEIRA_LOCAL_WORKSPACE_ID=local_workspace
PRYMEIRA_LOCAL_ROLE=owner
VITE_LOCAL_AUTH_BYPASS=true
VITE_API_URL=http://localhost:3002
```

Do not commit `.env`.

## Task 2: Start Database And Apply Schema

**Files:**
- Read: `docker-compose.dev.yml`
- Read: `apps/api/prisma/schema.prisma`
- Generated locally by tools: Prisma client artifacts and local database state

- [ ] **Step 1: Start local Postgres**

Run:

```sh
docker compose -f docker-compose.dev.yml up -d
```

Expected: Docker reports the `postgres` service is running.

- [ ] **Step 2: Confirm Postgres container status**

Run:

```sh
docker compose -f docker-compose.dev.yml ps
```

Expected: the `postgres` service shows a running or healthy state and port `54329` is published.

- [ ] **Step 3: Generate Prisma client**

Run:

```sh
pnpm prisma:generate
```

Expected: Prisma Client generation completes successfully.

- [ ] **Step 4: Apply migrations**

Run:

```sh
pnpm prisma:migrate
```

Expected: Prisma reports migrations applied or database already in sync.

- [ ] **Step 5: Seed demo data**

Run:

```sh
pnpm --filter @prymeira-talk/api seed:demo
```

Expected: command exits with code 0 and prints successful seed output.

## Task 3: Run Automated Verification

**Files:**
- Read: `package.json`
- Read: `apps/api/package.json`
- Read: `apps/web/package.json`
- Read: `packages/shared/package.json`

- [ ] **Step 1: Run test suite**

Run:

```sh
pnpm test
```

Expected: all package tests pass. If a test fails, record the package, test name, and failure message in the report before fixing anything.

- [ ] **Step 2: Run typecheck**

Run:

```sh
pnpm typecheck
```

Expected: TypeScript exits successfully across all packages.

- [ ] **Step 3: Run production build**

Run:

```sh
pnpm build
```

Expected: API type build and web Vite build complete successfully.

## Task 4: Start API And Web For Review

**Files:**
- Read: `apps/api/src/server.ts`
- Read: `apps/web/vite.config.ts`
- Read: `apps/web/src/app/api.ts`
- Running processes: API on `http://localhost:3002`, web on `http://localhost:5176`

- [ ] **Step 1: Start API dev server**

Run in a long-running terminal:

```sh
pnpm dev:api
```

Expected: API starts on `0.0.0.0:3002` or `localhost:3002` with no startup error.

- [ ] **Step 2: Verify API health**

Run in a second terminal:

```sh
curl -sS http://localhost:3002/health
```

Expected output:

```json
{"ok":true,"product":"talk"}
```

- [ ] **Step 3: Verify local auth bypass**

Run:

```sh
curl -sS -H "Authorization: Bearer local-dev-bypass" http://localhost:3002/me
```

Expected output includes:

```json
{"workspaceId":"local_workspace","role":"owner"}
```

- [ ] **Step 4: Start web dev server**

Run in another long-running terminal:

```sh
pnpm dev:web
```

Expected: Vite starts on `http://localhost:5176`.

- [ ] **Step 5: Open local app**

Open:

```txt
http://localhost:5176
```

Expected: the Prymeira Talk shell loads without requiring real Clerk authentication because `VITE_LOCAL_AUTH_BYPASS=true`.

## Task 5: Browser Smoke Test Each Module

**Files:**
- Read through browser: web app at `http://localhost:5176`
- Create: `docs/superpowers/reports/2026-05-21-local-demo-analysis-report.md`

- [ ] **Step 1: Create report scaffold**

Create `docs/superpowers/reports/2026-05-21-local-demo-analysis-report.md` with this content:

```md
# Local Demo Analysis Report

## Environment

- Date: 2026-05-21
- API URL: http://localhost:3002
- Web URL: http://localhost:5176
- Workspace: local_workspace
- Auth mode: local bypass
- Database: local Docker Postgres on port 54329

## Automated Verification

- `pnpm test`: not run
- `pnpm typecheck`: not run
- `pnpm build`: not run
- `pnpm --filter @prymeira-talk/api seed:demo`: not run

## Module Findings

### Atendimento

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

### Contatos

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

### Canais

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

### Automacoes

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

### Disparos

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

### Relatorios

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

### Equipe

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

### IA

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

### Atomic CRM

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

### Ajustes

- Status: not reviewed
- Working:
- Simulated:
- Broken:
- Notes:

## Console And Network Issues

- None recorded yet.

## Production-Readiness Candidates

- None selected yet.
```

- [ ] **Step 2: Review Atendimento**

In the browser:

1. Open `Atendimento`.
2. Confirm seeded conversation list is visible.
3. Select the first conversation.
4. Confirm messages and contact context load.
5. Send one outbound test message: `Teste local da bancada`.
6. Change priority once.
7. Add one internal note: `Nota criada durante a bancada local`.
8. Request an AI suggestion if the control is visible.
9. Record working, simulated, broken, and console/network issues in the report.

- [ ] **Step 3: Review Contatos**

In the browser:

1. Open `Contatos`.
2. Confirm contact list is visible.
3. Create a contact with:

```txt
Nome: Teste Bancada
Telefone: 559999000111
Email: teste.bancada@example.com
Empresa: Prymeira Local
```

4. Edit the created contact company to `Prymeira Local Editado`.
5. Switch to board view.
6. Move one contact to another stage.
7. Record findings in the report.

- [ ] **Step 4: Review Canais**

In the browser:

1. Open `Canais`.
2. Confirm a demo Evolution channel is visible or create one.
3. Generate QR in simulated mode.
4. Run connect, disconnect, and reconnect if the controls are visible.
5. Run test inbound message.
6. Record findings in the report.

- [ ] **Step 5: Review Automacoes**

In the browser:

1. Open `Automacoes`.
2. Confirm rule list loads.
3. Create a draft automation.
4. Edit name, trigger, and at least one action.
5. Enable or disable the rule.
6. Run manual test.
7. Confirm run history updates.
8. Record findings in the report.

- [ ] **Step 6: Review Disparos**

In the browser:

1. Open `Disparos`.
2. Confirm campaigns load.
3. Create a draft campaign.
4. Select a board audience.
5. Edit message body to `Mensagem simulada da bancada local`.
6. Resolve audience.
7. Run simulated send.
8. Confirm recipients/results appear.
9. Record findings in the report.

- [ ] **Step 7: Review Relatorios**

In the browser:

1. Open `Relatorios`.
2. Confirm metric cards load.
3. Confirm status, direction, campaign, automation, department, tag, and channel breakdown sections render.
4. Run export if the control is visible.
5. Record findings in the report.

- [ ] **Step 8: Review Equipe**

In the browser:

1. Open `Equipe`.
2. Confirm demo users load.
3. Change one user role and confirm persistence after refresh.
4. Create a department named `Bancada Local`.
5. Record findings in the report.

- [ ] **Step 9: Review IA**

In the browser:

1. Open `IA`.
2. Create a simulated assistant action.
3. Confirm history updates.
4. Confirm result payload is readable.
5. Record findings in the report.

- [ ] **Step 10: Review Atomic CRM**

In the browser:

1. Open `Atomic CRM`.
2. Create a simulated sync action.
3. Confirm history updates.
4. Confirm status/result is readable.
5. Record findings in the report.

- [ ] **Step 11: Review Ajustes**

In the browser:

1. Open `Ajustes`.
2. Confirm workspace settings load.
3. Update one integration mode or status if controls are visible.
4. Confirm audit log includes relevant entries.
5. Record findings in the report.

## Task 6: Finalize Report And Commit

**Files:**
- Modify: `docs/superpowers/reports/2026-05-21-local-demo-analysis-report.md`

- [ ] **Step 1: Replace scaffold statuses with actual results**

Update every module section so `Status` is one of:

```txt
passed
passed_with_notes
blocked
not_applicable
```

Each module must include at least one bullet under `Working`, `Simulated`, `Broken`, or `Notes`.

- [ ] **Step 2: Summarize production-readiness candidates**

Add a prioritized list under `Production-Readiness Candidates` using this format:

```md
1. Candidate name: why it matters, which module exposed it, and the suggested next phase.
```

- [ ] **Step 3: Check report for unfinished scaffold text**

Run:

```sh
rg -n "not reviewed|not run|None recorded yet|None selected yet" docs/superpowers/reports/2026-05-21-local-demo-analysis-report.md
```

Expected: no output. If output appears, update those sections with actual results.

- [ ] **Step 4: Run final git diff review**

Run:

```sh
git diff -- docs/superpowers/reports/2026-05-21-local-demo-analysis-report.md
```

Expected: diff shows only the analysis report content.

- [ ] **Step 5: Commit report**

Run:

```sh
git add docs/superpowers/reports/2026-05-21-local-demo-analysis-report.md
git commit -m "docs: add local demo analysis report"
```

Expected: commit succeeds.

## Verification Summary

Completion requires:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @prymeira-talk/api seed:demo
curl -sS http://localhost:3002/health
curl -sS -H "Authorization: Bearer local-dev-bypass" http://localhost:3002/me
```

Completion also requires browser review of all sidebar modules and a committed report at:

```txt
docs/superpowers/reports/2026-05-21-local-demo-analysis-report.md
```
