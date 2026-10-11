# JEV Commercial Decision Criteria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make JEV consult a seller for unconfirmed product variants and answer directly when an approved exclusion applies, while making the no-send replay detect both regressions.

**Architecture:** Keep the existing JEV request, response schema, fail-closed audit and knowledge selection. Tighten only the question criteria in the preflight request, then assert the complete plans in the synthetic live replay. The current Villefer package in `artifacts/agents/villefer/villefer-v1.agent-package.json` is the acceptance fixture.

**Tech Stack:** TypeScript, Vitest, tsx, pnpm, JEV SystemOne API.

---

### Task 1: Capture the decision contract in failing tests

**Files:**
- Modify: `apps/api/src/modules/agents/jev-reply-preflight.test.ts`
- Modify: `apps/api/scripts/test-jev-villefer-package-live.ts`

- [ ] **Step 1: Add a unit test for the serialized criteria**

In `jev-reply-preflight.test.ts`, call `createJevReplyPreflight({ apiKey: "jev-test", fetchImpl })` with a mocked successful preflight response, parse `fetchImpl.mock.calls[0][1].body`, and assert that `questions.commercialPath.criteria.stock` excludes specified variants outside approved ranges; `ambiguous` covers outside-range or unconfirmed material; `questions.nextAction.criteria.answer_current_request` allows a grounded not-sold refusal; `handoff` covers outside-range consultation but excludes a mere repetition of an approved refusal; and `conversationStage.criteria.qualification` covers a customer response to the agent's earlier qualification question. Use `toContain` checks for the exact distinguishing Portuguese phrases added in Task 2.

- [ ] **Step 2: Run the focused test before changing production criteria**

Run: `pnpm --filter @prymeira-talk/api test -- src/modules/agents/jev-reply-preflight.test.ts`

Expected: the new contract test fails because the current criteria only describe a family as stock and handoff as a generic risk.

- [ ] **Step 3: Tighten live replay expectations**

In `test-jev-villefer-package-live.ts`, set Ricardo's `expected` to `{ outcome: "continue", conversationStage: "qualification", commercialPath: "not_sold", nextAction: "answer_current_request", requiredKnowledge: ["approved_positive_catalog_v1"] }`; set João's to the same complete plan and required catalog source. Keep the existing outside-range bar expectation `new_quote` + `ambiguous` + `handoff` and seller-request expectation `qualification` + `handoff`. Do not weaken `assertPreflight` or make the audit use an expected plan instead of the actual preflight result.

- [ ] **Step 4: Commit the failing-test contract**

Run: `git add apps/api/src/modules/agents/jev-reply-preflight.test.ts apps/api/scripts/test-jev-villefer-package-live.ts && git commit -m 'test(agents): require grounded JEV commercial routes'`

### Task 2: Specify commercial decision criteria at the JEV boundary

**Files:**
- Modify: `apps/api/src/modules/agents/jev-reply-preflight.ts:140-180`
- Test: `apps/api/src/modules/agents/jev-reply-preflight.test.ts`

- [ ] **Step 1: Edit only the relevant question text**

Make `conversationStage.criteria.qualification` explicitly include the customer's answer to an agent qualification question on the same order; `new_quote` excludes that case. Set `commercialPath.criteria.stock` to require that supplied attributes do not contradict approved size/material/norm restrictions, without implying stock balance. Set `ambiguous` to include a known family with requested measurement outside the approved range or unconfirmed material/norm. Keep `not_sold` dependent on an explicit negative rule applicable to the described item. Set `nextAction.criteria.answer_current_request` to include a brief refusal grounded in `not_sold`, but exclude unconfirmed variants. Set `nextAction.criteria.handoff` to include outside-range or unconfirmed specification requiring seller confirmation and explicit human requests, but not an approved refusal alone. Do not change types, endpoint, transport, parser or audit logic.

- [ ] **Step 2: Run the focused unit test**

Run: `pnpm --filter @prymeira-talk/api test -- src/modules/agents/jev-reply-preflight.test.ts`

Expected: all focused tests pass.

- [ ] **Step 3: Commit the criteria change**

Run: `git add apps/api/src/modules/agents/jev-reply-preflight.ts && git commit -m 'fix(agents): distinguish unconfirmed variants from approved refusals'`

### Task 3: Verify against the real JEV without customer delivery

**Files:**
- Read: `apps/api/scripts/test-jev-villefer-package-live.ts`
- Read: `docs/superpowers/specs/2026-09-22-jev-commercial-decision-criteria-design.md`

- [ ] **Step 1: Run local and complete checks**

Run: `pnpm --filter @prymeira-talk/api test:jev-villefer-package-live --dry-run`

Run: `pnpm --filter @prymeira-talk/api test`

Run: `pnpm --filter @prymeira-talk/api typecheck`

Run: `pnpm --filter @prymeira-talk/api build:prod`

Expected: dry-run prints nine context cases without calling JEV; tests, typecheck and build exit 0.

- [ ] **Step 2: Run the JEV replay with the existing local key, without printing it**

Run from repository root: `pnpm --filter @prymeira-talk/api exec dotenv -e '/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.env' -- tsx scripts/test-jev-villefer-package-live.ts`

Expected: nine preflight plans, two follow-up decisions and six audits match, with `safetyFailures: 0` and `conservativeWarnings: 0`. No GPT, database or WhatsApp transport is invoked. If any model result disagrees, inspect the exact scenario and revise only after diagnosing it; do not declare acceptance or deploy.

- [ ] **Step 3: Verify repository state and publish only after green checks**

Run: `git diff --check && git status --short --branch && git log -3 --oneline`

If all checks are green, push `codex/release-20260922`. Do not trigger image publication or Portainer deployment in this plan; these remain a separate production action.
