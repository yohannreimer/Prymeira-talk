# Evolution Template Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a template picker in Disparos for Meta official numbers connected through Evolution API.

**Architecture:** The API resolves the workspace's active Meta runtime, calls Evolution using server-side credentials, normalizes template records, and returns a safe DTO. The web app exposes an explicit `Carregar templates` action in the campaign Meta section and uses selected templates to fill the existing send fields.

**Tech Stack:** Fastify, TypeScript, Zod, React, Vitest.

---

### Task 1: Evolution Client Template Listing

**Files:**
- Modify: `apps/api/src/modules/evolution/evolution.client.ts`
- Test: `apps/api/src/modules/evolution/evolution.client.test.ts`

- [ ] Add `listTemplates(input: { instanceName: string })` to `EvolutionClient`.
- [ ] Call `GET /template/find/{instanceName}`.
- [ ] Normalize common response shapes into `EvolutionTemplateRecord[]`.
- [ ] Test array and nested response shapes.

### Task 2: Settings Route

**Files:**
- Modify: `apps/api/src/modules/settings/settings.routes.ts`
- Test: `apps/api/src/modules/settings/settings.service.test.ts`

- [ ] Add `GET /settings/meta-cloud/evolution-templates`.
- [ ] Require owner/manager permission.
- [ ] Resolve `meta_cloud` runtime for the workspace.
- [ ] Require active `evolution_official` runtime and `listTemplates`.
- [ ] Return normalized templates.

### Task 3: Web API And Picker

**Files:**
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/campaigns/CampaignsPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] Add `MetaTemplateOptionDto`.
- [ ] Add `apiListMetaEvolutionTemplates`.
- [ ] Track Meta connection mode in Campaigns.
- [ ] Add `Carregar templates` list for via-Evolution mode.
- [ ] Fill `metaTemplate.name` and `metaTemplate.language` on selection.

### Task 4: Verification

- [ ] Run targeted API tests.
- [ ] Run API and web typechecks.
- [ ] Build the app.
- [ ] Smoke test localhost UI.
