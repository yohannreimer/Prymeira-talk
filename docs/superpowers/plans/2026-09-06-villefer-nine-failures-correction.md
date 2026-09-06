# Villefer Nine-Failure Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the nine failed Villefer live-evaluation cases without weakening factual safeguards, then deploy and rerun the 23-case suite against the inactive test agent.

**Architecture:** Extend the deterministic safety policy with ordered intent exceptions and precise protected-commercial intents. Add one shared output normalizer so test chat and production runtime cannot disagree about handoff state. Preserve generic retrieval while shipping Villefer-specific aliases and prompt behavior in its portable agent package.

**Tech Stack:** TypeScript, Vitest, Zod, Prisma, Fastify, pnpm, Docker/Portainer, OpenAI-compatible provider.

---

### Task 1: Lock the nine failures into regression tests

**Files:**
- Modify: `apps/api/src/modules/agents/agent-safety-policy.test.ts`
- Modify: `apps/api/src/modules/agents/knowledge-retrieval.test.ts`
- Modify: `apps/api/src/modules/agents/agent-test-chat.test.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.test.ts`

- [ ] **Step 1: Add safety-policy reproductions**

Add table tests covering: desired dates in complete/incomplete quote messages; `prazo não consta`; explicit competitor loss mentioning availability; extracted prompt injection mentioning price/availability; price phrasing `quanto fica o quilo e qual o total`; tax-benefit statements; and urgent requests with and without minimum order details.

Expected decisions:

```ts
expect(decision).toMatchObject({ handoffRequired: false, outcome: "continue" });
expect(priceDecision).toMatchObject({ handoffRequired: true, protectedFact: "price" });
expect(taxDecision).toMatchObject({ handoffRequired: true, protectedFact: "tax" });
expect(lossDecision).toMatchObject({ handoffRequired: false, outcome: "close_loss" });
expect(injectionDecision).toMatchObject({ handoffRequired: false, outcome: "ignore_injection" });
expect(urgentIncomplete).toMatchObject({ handoffRequired: false, outcome: "qualify_urgent" });
expect(urgentComplete).toMatchObject({ handoffRequired: true, protectedFact: "deadline" });
```

- [ ] **Step 2: Add retrieval reproduction**

Create a source with category `product_and_specification`, alias `tubos industriais` and catalog content, then assert that the singular message `Tubo industrial.` selects it.

- [ ] **Step 3: Add output-invariant reproductions**

In both test-chat and runtime tests, make the provider return the reserved consultation acknowledgement with `handoff.required: false` and no action. Assert that the result contains `handoff.required: true` plus one `request_handoff` action.

- [ ] **Step 4: Prove the red state**

Run:

```sh
pnpm --filter @prymeira-talk/api test -- \
  src/modules/agents/agent-safety-policy.test.ts \
  src/modules/agents/knowledge-retrieval.test.ts \
  src/modules/agents/agent-test-chat.test.ts \
  src/modules/agents/agent-runtime.test.ts
```

Expected: the new tests fail for the currently observed reasons while the prior tests remain green.

- [ ] **Step 5: Commit the failing regressions**

```sh
git add apps/api/src/modules/agents/*.test.ts
git commit -m "test: reproduce Villefer agent regressions"
```

### Task 2: Make safety decisions intent-aware

**Files:**
- Modify: `apps/api/src/modules/agents/agent-safety-policy.ts`
- Test: `apps/api/src/modules/agents/agent-safety-policy.test.ts`

- [ ] **Step 1: Extend the decision vocabulary**

Add `freight`, `payment`, and `tax` to `ProtectedFact`, and add an outcome union to `AgentSafetyDecision`:

```ts
export type AgentSafetyOutcome =
  | "continue"
  | "handoff"
  | "close_loss"
  | "ignore_injection"
  | "qualify_urgent";
```

- [ ] **Step 2: Add ordered intent recognizers**

Evaluate prompt injection, explicit loss, human request, urgent completeness, direct commercial request, then ordinary qualification. A direct commercial rule must require interrogative/request language or a concrete commercial assertion, and must ignore negative/missing-field phrases such as `não consta`.

Price coverage must include:

```ts
/\b(quanto\s+(?:fica|da|d[aá])|qual\s+(?:e|é)\s+o\s+total|por\s+(?:quilo|kg))\b/i
```

Tax coverage must include:

```ts
/\b(benef[ií]cio\s+fiscal|isen[cç][aã]o|icms|ipi|substitui[cç][aã]o\s+tribut[aá]ria)\b/i
```

- [ ] **Step 3: Implement urgent completeness**

Treat an urgent request as incomplete until the current message or formatted history contains product, dimension/specification and quantity signals. Incomplete urgency returns `qualify_urgent`; complete urgency returns a deadline handoff without any promise.

- [ ] **Step 4: Run the safety tests**

```sh
pnpm --filter @prymeira-talk/api test -- src/modules/agents/agent-safety-policy.test.ts
```

Expected: all policy tests pass.

- [ ] **Step 5: Commit the policy correction**

```sh
git add apps/api/src/modules/agents/agent-safety-policy.ts apps/api/src/modules/agents/agent-safety-policy.test.ts
git commit -m "fix: classify protected commercial intent"
```

### Task 3: Enforce handoff consistency in one shared unit

**Files:**
- Create: `apps/api/src/modules/agents/agent-output-normalizer.ts`
- Create: `apps/api/src/modules/agents/agent-output-normalizer.test.ts`
- Modify: `apps/api/src/modules/agents/agent-test-chat.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Test: `apps/api/src/modules/agents/agent-test-chat.test.ts`
- Test: `apps/api/src/modules/agents/agent-runtime.test.ts`

- [ ] **Step 1: Write the normalizer contract**

The helper accepts an `AgentOutput`. If either handoff representation exists, or the normalized reply equals the reserved acknowledgement, it returns both required representations with one coherent reason:

```ts
export function normalizeAgentHandoffOutput(output: AgentOutput): AgentOutput;
```

It must not create duplicate `request_handoff` actions.

- [ ] **Step 2: Implement the minimal normalizer**

Use the existing action reason first, then `handoff.reason`, then `Agent requested consultation.`. Preserve every non-handoff action and set the visible reply to `HANDOFF_ACKNOWLEDGEMENT` only when the normalized result requires handoff.

- [ ] **Step 3: Apply it in test chat and runtime**

Normalize provider or deterministic output before reply compaction, handoff-reason calculation and action execution. Remove the two local fragments that independently alter only the visible reply.

- [ ] **Step 4: Run unit and integration tests**

```sh
pnpm --filter @prymeira-talk/api test -- \
  src/modules/agents/agent-output-normalizer.test.ts \
  src/modules/agents/agent-test-chat.test.ts \
  src/modules/agents/agent-runtime.test.ts
```

Expected: all tests pass and the provider-generated consultation acknowledgement produces a real action in both paths.

- [ ] **Step 5: Commit the invariant**

```sh
git add apps/api/src/modules/agents/agent-output-normalizer* apps/api/src/modules/agents/agent-test-chat* apps/api/src/modules/agents/agent-runtime*
git commit -m "fix: keep handoff replies and actions consistent"
```

### Task 4: Restore catalog retrieval and Villefer behavior

**Files:**
- Modify: `apps/api/src/modules/agents/knowledge-retrieval.ts`
- Modify: `apps/api/src/modules/agents/knowledge-retrieval.test.ts`
- Modify: `apps/api/src/modules/agents/villefer-v1-definition.ts`
- Modify: `apps/api/src/modules/agents/villefer-v1-definition.test.ts`
- Modify: `artifacts/agents/villefer/villefer-v1.agent-package.json`
- Modify: `artifacts/agents/villefer/villefer-v1.evaluation-suite.json`

- [ ] **Step 1: Normalize simple inflections in retrieval**

Compare exact normalized aliases and tokens with a conservative singular form that removes final `s` only for tokens longer than four characters. This must make `tubo industrial` match `tubos industriais` without broad substring matching.

- [ ] **Step 2: Add the approved positive catalog to the production package**

Persist the source as category `product_and_specification` with explicit aliases including `tubo industrial`, `tubos industriais`, `metalon`, `perfil u`, `chapas`, `barras`, `vigas`, `inox` and `aluminio`. Keep Villefer product names out of generic runtime code.

- [ ] **Step 3: Update the Villefer prompt**

Add concise rules for ordered exception handling, grouped qualification questions, explicit-loss closure, document-injection recovery and urgent qualification. Do not authorize new facts.

- [ ] **Step 4: Align evaluation expectations**

Update `incomplete_chapa` to accept one grouped category question. Update `urgent_deadline` to expect qualification without immediate handoff when the product, specification/dimension and quantity are missing; add a complete urgent-order regression that expects handoff.

- [ ] **Step 5: Regenerate and validate portable artifacts**

```sh
VILLEFER_HISTORY_ROOT=/Users/yohannreimer/Documents/Codex/2026-09-04/eu-x20/work/evolution-source-discovery/work \
pnpm --filter @prymeira-talk/api compile:villefer-v1
pnpm --filter @prymeira-talk/api test -- \
  src/modules/agents/knowledge-retrieval.test.ts \
  src/modules/agents/villefer-v1-definition.test.ts \
  src/modules/agents/historical-training-compiler.test.ts
```

Expected: package schema passes, catalog source is present, and all targeted tests pass.

- [ ] **Step 6: Commit package and retrieval changes**

```sh
git add apps/api/src/modules/agents/knowledge-retrieval* apps/api/src/modules/agents/villefer-v1-definition* artifacts/agents/villefer
git commit -m "fix: align Villefer catalog and qualification"
```

### Task 5: Verify, deploy and retest the inactive agent

**Files:**
- Modify: `artifacts/agents/villefer/villefer-v1-live-evaluation-2026-09-06.md`

- [ ] **Step 1: Run complete local verification**

```sh
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/api typecheck
pnpm --filter @prymeira-talk/api build:prod
git diff --check
```

Expected: zero test failures, zero type errors, production bundle exit code 0 and no whitespace errors.

- [ ] **Step 2: Publish the tested revision**

Push `codex/villefer-regression-fixes`, update the Portainer stack to that exact revision and wait until API/web health checks are green. Do not activate either Villefer agent.

- [ ] **Step 3: Update only the test agent**

Import or apply the revised prompt and positive-catalog metadata to `Pré-atendimento Villefer — Teste`. Confirm category and aliases persisted after a module reload.

- [ ] **Step 4: Repeat the live suite**

Execute all 17 conversational cases using the configured real provider. Recheck the six event-dependent cases structurally and keep them labeled E2E-pending unless an event runner becomes available.

- [ ] **Step 5: Record honest results**

Update the live-evaluation report with response, handoff state, selected knowledge and any provider error for each case. A transient provider error may be retried once and must remain recorded.

- [ ] **Step 6: Commit the final evidence**

```sh
git add artifacts/agents/villefer/villefer-v1-live-evaluation-2026-09-06.md
git commit -m "docs: record Villefer regression retest"
```
