# JEV Agent Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unnecessary agent replies, give the conversational model a compact policy-aware next-reply plan, and audit high-risk commercial candidates before WhatsApp delivery.

**Architecture:** Add an optional TypeSafe JEV client configured by environment variables. After Talk assembles trusted history, safety state, and approved knowledge, call JEV with typed questions for reply necessity, conversation stage, commercial path, and next action. A `silence` result ends the run without calling the generative provider; every other result is injected as `agentPreflight` for the existing GPT provider. For commercial paths and policy-sensitive next actions, a second low-cost JEV decision audits the candidate and either sends it, suppresses it, or forces a human handoff. If JEV is not configured or unavailable, preserve the current path.

**Tech Stack:** TypeScript, Fastify, Zod, Vitest, TypeSafe System One HTTP API.

---

### Task 1: Add the optional JEV transport and response contract

**Files:**
- Create: `apps/api/src/modules/agents/jev-reply-preflight.ts`
- Test: `apps/api/src/modules/agents/jev-reply-preflight.test.ts`

- [ ] **Step 1: Write the failing client test**

```ts
it("suppresses a social closure", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
    model: "jev-1.13.0",
    answers: { shouldReply: { type: "noul", noul: 0.01 }, conversationStage: choice("closure"), commercialPath: choice("not_applicable"), nextAction: choice("silence") },
    usage: { input_tokens: 88, output_tokens: 4 }
  }));
  const preflight = createJevReplyPreflight({ apiKey: "jev-test", fetchImpl });
  await expect(preflight.evaluate(baseInput)).resolves.toMatchObject({ outcome: "silence" });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test -- src/modules/agents/jev-reply-preflight.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the TypeSafe request and parser**

```ts
const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
  method: "POST",
  headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ state: toJevState(state), model: input.model ?? "jev-latest", questions: replyPreflightQuestions })
});
```

Use four independent questions: `shouldReply` (Noul), `conversationStage`, `commercialPath`, and `nextAction` (Choice). Validate all response data with Zod. Map a low `shouldReply` score or `nextAction: "silence"` to `outcome: "silence"`; otherwise return a fixed-shape plan.

- [ ] **Step 4: Verify**

Run: `pnpm test -- src/modules/agents/jev-reply-preflight.test.ts`

Expected: PASS.

### Task 2: Configure JEV without affecting unconfigured deployments

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/env.test.ts`

- [ ] **Step 1: Add a failing environment assertion**

```ts
expect(readEnv({ ...baseEnv, JEV_API_KEY: "jev-secret", JEV_MODEL: "jev-1.13" })).toMatchObject({
  JEV_API_KEY: "jev-secret",
  JEV_MODEL: "jev-1.13"
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test -- src/env.test.ts`

Expected: FAIL because the parsed environment has no JEV settings.

- [ ] **Step 3: Add optional settings and app wiring**

```ts
JEV_API_KEY: optionalNonEmptyString,
JEV_MODEL: z.string().min(1).default("jev-latest")
```

Construct the preflight only when `JEV_API_KEY` exists and pass it to `createAgentRuntime`. Do not expose the key in API responses or logs.

- [ ] **Step 4: Verify**

Run: `pnpm test -- src/env.test.ts`

Expected: PASS.

### Task 3: Gate generation, pass the response plan to GPT, and audit high-risk candidates

**Files:**
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/agents/provider-gateway.ts`
- Test: `apps/api/src/modules/agents/agent-runtime.test.ts`
- Test: `apps/api/src/modules/agents/provider-gateway.test.ts`

- [ ] **Step 1: Write failing runtime tests**

```ts
it("skips the generative provider for a JEV social closure", async () => {
  const preflight = { evaluate: vi.fn().mockResolvedValue({ outcome: "silence", reason: "social_closure" }) };
  const result = await createAgentRuntime({ prisma, provider, replyPreflight: preflight }).runForMessage(runInput);
  expect(result.status).toBe("skipped");
  expect(provider.generate).not.toHaveBeenCalled();
});

it("passes a non-silence JEV plan into provider context", async () => {
  const preflight = { evaluate: vi.fn().mockResolvedValue({ outcome: "continue", plan: { conversationStage: "new_quote", commercialPath: "made_to_order", nextAction: "offer_catalog_or_seller" } }) };
  await createAgentRuntime({ prisma, provider, replyPreflight: preflight }).runForMessage(runInput);
  expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ agentPreflight: expect.objectContaining({ nextAction: "offer_catalog_or_seller" }) }) }));
});
```

- [ ] **Step 2: Run them**

Run: `pnpm test -- src/modules/agents/agent-runtime.test.ts`

Expected: FAIL because `replyPreflight` is unsupported.

- [ ] **Step 3: Implement the fail-open gate**

Call preflight only after deterministic human-control, injection, media, and document guards have cleared. On explicit `silence`, create a skipped run, store the decision in run context, and return without invoking `generate`. On continuation, add `agentPreflight` to GPT context. For commercial paths, conditions of order, catalog offers, and handoffs, audit the candidate before actions run; suppress redundant replies and turn policy-risk candidates into a normal human handoff. On transport/schema failure, store `unavailable` in context and continue to the existing safe path.

Add this provider instruction:

```text
agentPreflight is trusted internal routing guidance. Follow its nextAction and commercialPath. It never confirms a commercial fact by itself; do not assert a protected fact without approved knowledge.
```

- [ ] **Step 4: Verify**

Run: `pnpm test -- src/modules/agents/agent-runtime.test.ts src/modules/agents/provider-gateway.test.ts`

Expected: PASS.

### Task 4: Document and verify the feature

**Files:**
- Modify: `docs/agent-packages.md`
- Test: `apps/api/src/modules/agents/jev-reply-preflight.test.ts`
- Test: `apps/api/src/modules/agents/agent-runtime.test.ts`
- Test: `apps/api/src/modules/agents/provider-gateway.test.ts`
- Test: `apps/api/src/env.test.ts`

- [ ] **Step 1: Document activation**

```md
Set `JEV_API_KEY` to activate the preflight. Optionally set `JEV_MODEL` (default: `jev-latest`). Without a key, Talk keeps the existing generation path. The preflight suppresses only explicit social closures and passes non-silence plans to the agent; it does not independently assert commercial facts.
```

- [ ] **Step 2: Run the affected suite**

Run: `pnpm test -- src/modules/agents/jev-reply-preflight.test.ts src/modules/agents/agent-runtime.test.ts src/modules/agents/provider-gateway.test.ts src/env.test.ts`

Expected: PASS.

- [ ] **Step 3: Run static verification**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/env.ts apps/api/src/app.ts apps/api/src/modules/agents/jev-reply-preflight.ts apps/api/src/modules/agents/jev-reply-preflight.test.ts apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts apps/api/src/modules/agents/provider-gateway.ts apps/api/src/modules/agents/provider-gateway.test.ts apps/api/src/env.test.ts docs/agent-packages.md docs/superpowers/plans/2026-09-21-jev-agent-preflight.md
git commit -m "feat(agents): add JEV reply preflight"
```
