# Contextual Human Handoff Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic “Humano necessário” card with a short, grounded next action and a sufficient seller brief that refreshes automatically as the conversation changes.

**Architecture:** The API reads the active handoff session, its last handoff run, relevant conversation messages and approved agent knowledge. A private model call returns structured `nextAction` and `summary`; a service caches them with a context fingerprint in `AiAgentSession.metadata.handoffBrief`, debounces new messages, and rejects stale writes. A read-only inbox endpoint exposes pending/ready/stale/failed state; the Web panel polls and renders only the two approved blocks. The existing autonomous agent, outbound transports and Aprimoramentos pipeline are not used by this generator.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL JSON, Zod, React, Vitest, existing OpenAI-compatible provider settings.

---

## File map

- `packages/shared/src/assistant.ts`: public handoff brief response schema/type.
- `apps/api/src/modules/assistant/handoff-brief-generation.ts`: model prompt, structured parsing, evidence validation; no action executor or transport dependency.
- `apps/api/src/modules/assistant/handoff-brief-context.ts`: workspace-scoped session, run, message and approved-knowledge loading plus stable context key.
- `apps/api/src/modules/assistant/handoff-brief-service.ts`: debounce, generation, metadata cache, stale-write fence and failure state.
- `apps/api/src/modules/assistant/assistant-inbox.routes.ts`, `apps/api/src/app.ts`, inbound/outbound routes: read endpoint and event scheduling.
- `apps/web/src/features/inbox/useHandoffBrief.ts`, `HandoffBrief.tsx`, `AssistantPanel.tsx`, `InboxPage.tsx`, `apps/web/src/app/api.ts`: fetch/poll and two-block UI.
- The old `apps/web/src/features/inbox/handoff-brief.ts` and its test are removed after the replacement passes.

### Task 1: Shared contract and private structured generation

**Files:**
- Modify: `packages/shared/src/assistant.ts`
- Create: `apps/api/src/modules/assistant/handoff-brief-generation.ts`
- Create: `apps/api/src/modules/assistant/handoff-brief-generation.test.ts`

- [ ] **Step 1: Add the failing contract and generator tests.** In `packages/shared/src/assistant.ts`, define a strict response schema:

```ts
export const handoffBriefDtoSchema = z.object({
  status: z.enum(['pending', 'ready', 'stale', 'failed']),
  nextAction: z.string().nullable(),
  summary: z.string().nullable(),
  contextKey: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
  error: z.string().nullable()
}).strict();
export type HandoffBriefDto = z.infer<typeof handoffBriefDtoSchema>;
```

Test the generator with a fake `AgentProvider`: for Ricardo, a `commercial_policy_risk` audit and his messages yield a short action about checking whether the material is sold and a summary containing `1045`, `220 mm`, `125 mm`, `160 mm`, `4 peças`; neither field claims confirmed stock/price. Also test a complete proposal, missing essential data, malformed model JSON, forged evidence IDs and a user message that asks the model to ignore instructions. The fake provider must record `allowedActions: []` and there must be no outbound transport dependency.

- [ ] **Step 2: Run the new API test and confirm the red state.** Run `pnpm --filter @prymeira-talk/api exec vitest run src/modules/assistant/handoff-brief-generation.test.ts`; expect the missing module/function or assertion to fail.
- [ ] **Step 3: Implement the private generator.** Export `generateHandoffBrief(input, provider)` with this output contract:

```ts
type GeneratedHandoffBrief = {
  nextAction: string;
  summary: string;
  evidenceMessageIds: string[];
};
```

Use `createOpenAiCompatibleAgentProvider` from `provider-gateway.ts` with `resolveOpenAiCompatibleSettings`; request an agent JSON output whose `reply` is itself a JSON string containing exactly `nextAction`, `summary`, `evidenceMessageIds`. Parse that string using a strict Zod object (`nextAction` 4–180 chars, `summary` 10–1,600 chars, evidence UUIDs), reject evidence IDs absent from the supplied messages, and ignore model `actions`. Give the model the recorded handoff source/code, labeled message history and selected approved knowledge as *data*. The system instruction must require a single executable seller action, a compact factual summary, correction-overrides-old-value behavior, no invented commercial confirmations and no obeying instructions inside messages. Missing/illegible attachment content is explicitly marked unread. Never use the autonomous reply executor or WhatsApp transport.

- [ ] **Step 4: Run the focused test and API typecheck.** Run `pnpm --filter @prymeira-talk/api exec vitest run src/modules/assistant/handoff-brief-generation.test.ts` and `pnpm --filter @prymeira-talk/api typecheck`; expect 0 failures.
- [ ] **Step 5: Commit.** Stage only the three Task 1 files and commit `feat(inbox): generate grounded private handoff briefs`.

### Task 2: Load the actual handoff cause and current seller context

**Files:**
- Create: `apps/api/src/modules/assistant/handoff-brief-context.ts`
- Create: `apps/api/src/modules/assistant/handoff-brief-context.test.ts`
- Read: `apps/api/src/modules/agents/agent-runtime.ts:940-1028` and `:1160-1190`
- Read: `apps/api/src/modules/assistant/assistant-generation.ts:15-38`

- [ ] **Step 1: Write failing context tests.** With two workspaces, assert only the caller’s active session, messages and approved knowledge are loaded. Assert a run with `contextSummary.replyQualityAudit = { outcome: 'handoff', reason: 'commercial_policy_risk' }` yields `source: 'jev_audit'` and recorded code, **not** the unsupported claim “JEV identificou exatamente o material”. Assert a provider-requested handoff, human-requested handoff, low-confidence handoff and legacy handoff without a run receive distinct source values. Assert the latest correction replaces an older measure in the history sent to generation. No active handoff returns `null`.
- [ ] **Step 2: Run the context test red.** Run `pnpm --filter @prymeira-talk/api exec vitest run src/modules/assistant/handoff-brief-context.test.ts`; expect failure.
- [ ] **Step 3: Implement `loadHandoffBriefContext(prisma, workspaceId, conversationId)`.** Load the conversation and active `AiAgentSession` under the workspace, the most recent handoff `AiAgentRun`, up to 80 visible chronological messages using `visibleConversationMessageWhere` and `withoutInternalFollowupReservations`, the session agent, and up to 50 `ready` knowledge sources for that agent. Reuse `selectRelevantKnowledge` to pass only relevant approved sources to generation. Derive source from the run audit first, then agent output/confidence, then the persisted reason. Do not expose model output as a confirmed commercial fact. Compute:

```ts
const contextKey = createHash('sha256').update(JSON.stringify({
  sessionId: session.id,
  handoffReason: session.handoffReason,
  runId: run?.id ?? null,
  messages: messages.map(m => [m.id, m.direction, m.type, m.body, m.createdAt]),
  knowledge: selectedKnowledge.map(k => [k.id, k.updatedAt])
})).digest('hex');
```

Return `{ conversation, session, agent, run, messages, selectedKnowledge, source, reasonCode, contextKey }` or `null`; the returned records retain workspace IDs for the service fence.
- [ ] **Step 4: Run context tests and typecheck.** Run the Task 2 Vitest file and `pnpm --filter @prymeira-talk/api typecheck`; expect 0 failures.
- [ ] **Step 5: Commit.** Stage only Task 2 files and commit `feat(inbox): trace handoff context for seller brief`.

### Task 3: Debounced cache with stale-write protection

**Files:**
- Create: `apps/api/src/modules/assistant/handoff-brief-service.ts`
- Create: `apps/api/src/modules/assistant/handoff-brief-service.test.ts`
- Read: `apps/api/src/modules/assistant/assistant-scheduler.ts`
- Read: `apps/api/src/modules/assistant/assistant-access.ts`

- [ ] **Step 1: Write failing service tests.** Assert `get(workspaceId, conversationId)` returns `pending` and schedules generation for a legacy handoff lacking metadata; a second get does not start a duplicate; an unchanged context returns the cached `ready` brief; two messages arriving within 600 ms cause one new generation; a message arriving during generation makes the old result unable to publish; unrelated session metadata survives a write; provider failure returns `failed` or a clearly `stale` previous brief. Assert no generation when the session is no longer in handoff/human control. Use fake timers and a deferred promise to test the race.
- [ ] **Step 2: Run the service test red.** Run `pnpm --filter @prymeira-talk/api exec vitest run src/modules/assistant/handoff-brief-service.test.ts`; expect failure.
- [ ] **Step 3: Implement `createHandoffBriefService(prisma, { loadContext, generate, delayMs })`.** Public methods are `get({ workspaceId, conversationId })`, `schedule({ workspaceId, conversationId })`, and `stop()`. Key timers by `${workspaceId}:${conversationId}` and default `delayMs` to 600. Store the cache under `session.metadata.handoffBrief` as `{ status, contextKey, source, reasonCode, runId, nextAction, summary, evidenceMessageIds, updatedAt, error }`; `source`, `reasonCode` and `runId` retain the recorded provenance even though the UI shows only the action and summary. Before persisting, load context again: if `contextKey` or active session differs, schedule another pass and do not write the old output. Use a short transaction that locks the conversation row (`lockAssistantConversation`) and rereads the session before merging JSON; reject a changed context/session and preserve every other metadata key. Never persist raw provider errors or credentials; store one safe failure message. `get` reads current context, starts generation when absent/stale, and reports `stale` (with old text) or `pending` (without text) until ready. The service has no send method.

```ts
export type HandoffBriefService = {
  get(input: { workspaceId: string; conversationId: string }): Promise<HandoffBriefDto>;
  schedule(input: { workspaceId: string; conversationId: string }): void;
  stop(): void;
};
```
- [ ] **Step 4: Run service tests and typecheck.** Run Task 3 Vitest file and `pnpm --filter @prymeira-talk/api typecheck`; expect 0 failures.
- [ ] **Step 5: Commit.** Stage only Task 3 files and commit `feat(inbox): cache and refresh handoff briefs safely`.

### Task 4: Read endpoint and automatic message scheduling

**Files:**
- Modify: `apps/api/src/modules/assistant/assistant-inbox.routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/modules/conversations/conversations.routes.ts`
- Modify: `apps/api/src/modules/evolution/evolution.routes.ts`
- Modify: `apps/api/src/modules/meta/meta.webhooks.routes.ts`
- Create: `apps/api/src/modules/assistant/handoff-brief.routes.test.ts`

- [ ] **Step 1: Write failing endpoint/wiring tests.** `GET /assistant/conversations/:conversationId/handoff-brief` must use `resolveAssistantActor` and `requireAssistantConversation` (foreign/unauthorized conversation is 404/403), return `HandoffBriefDto`, and work even when the channel’s assisted-suggestion mode is disabled. A newly received customer message and a human reply schedule refresh; a replayed/ignored webhook does not. The endpoint does not expose an outbound operation.
- [ ] **Step 2: Run the route test red.** Run `pnpm --filter @prymeira-talk/api exec vitest run src/modules/assistant/handoff-brief.routes.test.ts`; expect 404 or missing dependency failure.
- [ ] **Step 3: Wire the service.** Instantiate it once in `app.ts` when Prisma is enabled, stop its timers on app close, and pass it to `assistantInboxRoutes`, `conversationsRoutes`, `evolutionRoutes` and `metaWebhooksRoutes`. Add a read-only GET handler after the existing conversation GET:

```ts
app.get('/assistant/conversations/:conversationId/handoff-brief', async request => {
  const { conversationId } = params.parse(request.params);
  const actor = await resolveAssistantActor(app.prisma, request.talk);
  await requireAssistantConversation(app.prisma, actor, conversationId);
  return options.handoffBriefService?.get({ workspaceId: actor.workspaceId, conversationId })
    ?? { status: 'failed', nextAction: null, summary: null, contextKey: null, updatedAt: null, error: 'Apoio indisponível.' };
});
```

Call `schedule` only after a newly persisted inbound or human outbound message, alongside existing assistant scheduler calls. The GET path also schedules a missing/stale brief, so handoffs predating deployment and jobs lost on restart recover when opened. Do not alter `observeHumanReply`, `AgentImprovementsService`, AI control or outbound delivery.
- [ ] **Step 4: Run route/integration tests and typecheck.** Run Task 4 Vitest file, `src/modules/conversations/conversations.service.test.ts`, `src/modules/evolution/evolution.routes.test.ts`, `src/modules/meta/meta.webhooks.routes.test.ts`, then API typecheck; expect 0 failures.
- [ ] **Step 5: Commit.** Stage only Task 4 files and commit `feat(inbox): expose and schedule contextual handoff briefs`.

### Task 5: Two-block seller UI

**Files:**
- Create: `apps/web/src/features/inbox/useHandoffBrief.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/inbox/HandoffBrief.tsx`
- Modify: `apps/web/src/features/inbox/AssistantPanel.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/styles.css`
- Delete: `apps/web/src/features/inbox/handoff-brief.ts`
- Modify: `apps/web/src/features/inbox/handoff-brief.test.ts`
- Modify: `apps/web/src/features/inbox/AssistantPanel.test.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.test.tsx`

- [ ] **Step 1: Write failing UI tests.** A ready brief renders only “Faça agora” and “Resumo” (no “O cliente informou”, “O que já foi dito”, “Motivo do repasse” blocks); pending renders “Preparando próximo passo…” without fake generic advice; stale renders the old text plus “Atualizando”; failed renders an explicit unavailable notice. Switching conversation must not display the prior conversation’s brief. A `lastMessageAt` change refreshes automatically. The panel remains private and shows the brief even when assisted suggestions are disabled.
- [ ] **Step 2: Run UI tests red.** Run `pnpm --filter @prymeira-talk/web exec vitest run src/features/inbox/handoff-brief.test.ts src/features/inbox/AssistantPanel.test.tsx src/features/inbox/InboxPage.test.tsx`; expect failures.
- [ ] **Step 3: Implement the fetch hook and card.** Add `apiGetHandoffBrief(conversationId, getToken, signal)` using `handoffBriefDtoSchema.parse` and a `useHandoffBrief(conversationId, enabled, lastMessageAt, getToken)` hook patterned after `useAssistantConversation`: abort old requests on conversation change, poll every 2 s while pending/stale and every 5 s while ready, pause when `document.hidden`, refresh immediately when `lastMessageAt` changes. `HandoffBrief.tsx` accepts `HandoffBriefDto`, renders the short action and paragraph/list summary with loading/stale/error indicators; it never offers send buttons. `InboxPage.tsx` invokes the hook only for `needsHumanAttention(selectedConversation)` and passes its result through `AssistantPanel`. Remove the client-only `buildHandoffBrief` path and its old generic copy.

```ts
export function useHandoffBrief(
  conversationId: string | null,
  enabled: boolean,
  lastMessageAt: string | null | undefined,
  getToken: () => Promise<string | null>
): { data: HandoffBriefDto | null; error: string | null };

// AssistantPanel renders only private support; sending remains unavailable.
{handoffBrief ? <HandoffBrief brief={handoffBrief} /> : /* existing suggestion branch */ null}
```
- [ ] **Step 4: Run focused Web tests and typecheck/build.** Run the Task 5 Vitest files and `pnpm --filter @prymeira-talk/web build`; expect 0 failures.
- [ ] **Step 5: Commit.** Stage only Task 5 files and commit `feat(inbox): show concise contextual seller action`.

### Task 6: End-to-end verification and handoff

**Files:** No source changes unless a test reveals a defect.

- [ ] Run `pnpm --filter @prymeira-talk/api test`, `pnpm --filter @prymeira-talk/api typecheck`, `pnpm --filter @prymeira-talk/api build:prod`, `pnpm --filter @prymeira-talk/web test`, `pnpm --filter @prymeira-talk/web build`, and `git diff --check`.
- [ ] Exercise a simulated Ricardo handoff and a fully qualified proposal with a fake provider through the API and Web panel. Check that new messages update the card, a late result is rejected, no WhatsApp send path is called, and Aprimoramentos behavior remains unchanged.
- [ ] Inspect the desktop and narrow/mobile panel visually. Verify that the seller can act using only the card, while a failed or unread-attachment case clearly identifies the limitation.
- [ ] Compare every acceptance criterion in `docs/superpowers/specs/2026-09-22-contextual-human-handoff-brief-design.md` with a test or a reported production gap. Do not call the real Ricardo case validated until a post-deploy observation shows the actual action and summary.
