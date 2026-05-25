# Real Automation Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make enabled automation flows execute real actions from inbound Evolution webhook events.

**Architecture:** Add a focused automation runner beside the existing automation CRUD service. The runner loads enabled graph flows, matches trigger nodes against the current conversation/message state, traverses connected nodes, executes supported blocks, records `automation_runs`, and publishes realtime updates for generated messages/conversation changes.

**Tech Stack:** TypeScript, Vitest, Fastify, Prisma models already present in `apps/api/prisma/schema.prisma`, Evolution client runtime, shared automation-flow contract.

---

### Task 1: Real Runner Core

**Files:**
- Create: `apps/api/src/modules/automations/automation-runner.ts`
- Create: `apps/api/src/modules/automations/automation-runner.test.ts`

- [ ] Write failing tests for `trigger_first_message`, `trigger_reengagement`, `condition_text`, `send_message`, `send_file`, `add_tag`, `move_board_stage`, and `close_conversation`.
- [ ] Implement graph traversal with a max-step guard and branch handles (`yes`/`no`, `success`).
- [ ] Implement real side effects using existing tables and Evolution client.
- [ ] Record `automation_run` with `mode: "real"` and per-node results.

### Task 2: Evolution Webhook Integration

**Files:**
- Modify: `apps/api/src/modules/evolution/evolution.routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/modules/evolution/evolution.routes.test.ts`

- [ ] Write failing webhook test proving inbound `messages.upsert` invokes enabled automations after message ingestion.
- [ ] Pass `evolutionRuntime` into Evolution routes.
- [ ] Call the runner only for inbound messages and keep webhook success isolated from individual automation failures.

### Task 3: Builder UX Guardrails

**Files:**
- Modify: `apps/web/src/features/automations/AutomationBlockLibrary.tsx`
- Modify: `apps/web/src/features/automations/AutomationCanvas.tsx`
- Modify: relevant web tests.

- [ ] Rename block library sections to `Gatilhos`, `Mensagens`, `Decisoes`, `Tempo`, `CRM`, `Integracoes`, `Controle`.
- [ ] Add focus-mode `+ Bloco` palette and selected-node config panel so focus mode remains editable.
- [ ] Keep unsupported blocks visible but clearly disabled for active automations.

