# JEV Full Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give JEV the complete agent prompt, the latest 20 complete conversation messages, and relevant approved knowledge without omitting older approved sources.

**Architecture:** Keep the existing agent runtime and JEV client. Add a small decision-context helper to select and format the recent window; use its active customer turn as the primary retrieval query. Keep `selectRelevantKnowledge` as the approved-source ranker, but consider every `ready` source for the agent. Preflight and audit consume identical evidence; the GPT provider keeps its existing full prompt.

**Tech Stack:** TypeScript, Prisma, Vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-22-jev-context-and-rule-retrieval-design.md`

**Working-tree constraint:** The release checkout already has uncommitted changes in `agent-runtime.ts`, `jev-reply-preflight.ts`, their tests, and the improvement service. Preserve and integrate them; stage only task-owned paths for each commit. Do not reset, overwrite, or deploy them.

---

## File map

- Create `apps/api/src/modules/agents/agent-decision-context.ts`: one responsibility—select the last 20 customer/attendant messages and derive the active customer turn/query.
- Create `apps/api/src/modules/agents/agent-decision-context.test.ts`: window, long-message, media text, and interrupted-turn cases.
- Modify `apps/api/src/modules/agents/jev-reply-preflight.ts` and its test: serialize complete prompt, all 20 selected messages, and full selected knowledge chunks, including source IDs.
- Modify `apps/api/src/modules/agents/agent-runtime.ts` and its test: use the shared decision window in retrieval, preflight, and audit; fetch all eligible `ready` sources; add diagnostics.
- Extend `apps/api/src/modules/agents/knowledge-retrieval.test.ts`: demonstrate a fragmented request retrieves the relevant approved source and a new topic does not inherit an old category.

## Task 1: Complete JEV payload

**Files:**
- Modify `apps/api/src/modules/agents/jev-reply-preflight.ts:4-22,305-321`
- Test `apps/api/src/modules/agents/jev-reply-preflight.test.ts`

- [ ] **Step 1: Write a failing payload test.** Add a test using the existing mocked `fetchImpl` and `baseInput` pattern. Set `agentRules` to `"A".repeat(4_100) + "Não fornecemos oxicorte."`; set `conversationMessages` to 22 ordered messages, with message 21 containing `"B".repeat(2_100)`; include selected knowledge `{ id: "approved-rule", title: "Regra aprovada", content: "C".repeat(1_600) }`. After `evaluate`, parse `fetchImpl.mock.calls[0][1].body` and expect the entire trailing oxicorte rule, exactly 20 messages numbered 3–22, the entire 2.100-character body, the ID, and the entire approved content.
- [ ] **Step 2: Run the failing test.** Run `pnpm --filter @prymeira-talk/api test -- src/modules/agents/jev-reply-preflight.test.ts`; expect failure on the existing 4.000/10/2.000/1.500 limits.
- [ ] **Step 3: Apply the minimal serialization change.** Make the selected-source ID optional for existing callers/tests, and change only `toJevState`:

```ts
selectedKnowledge: Array<{ id?: string; title: string; content: string }>;

function toJevState(input: AgentReplyPreflightInput) {
  return {
    agentRules: input.agentRules ?? null,
    currentMessage: input.currentMessage,
    conversationMessages: input.conversationMessages.slice(-20).map((message) => ({
      id: message.id,
      label: message.label,
      type: message.type,
      body: message.body,
      createdAt: message.createdAt
    })),
    approvedKnowledge: input.selectedKnowledge.map((source) => ({
      id: source.id ?? null,
      title: source.title,
      content: source.content
    }))
  };
}
```

- [ ] **Step 4: Rerun the focused test and typecheck.** Both must pass. Stage and commit only the JEV client and its test with `fix(agents): give JEV complete prompt and recent messages`.

## Task 2: Shared recent decision window and active request

**Files:**
- Create `apps/api/src/modules/agents/agent-decision-context.ts`
- Create `apps/api/src/modules/agents/agent-decision-context.test.ts`

- [ ] **Step 1: Write failing tests.** Use `NormalizedConversationMessage` fixtures. Assert: (a) of 22 visible messages, IDs 3–22 remain in chronological order; (b) a 3.000-character message remains complete; (c) the current message body is replaced by processed `effectiveText`; (d) `"Barra para viga baldrame"` followed by `"10mm"` in one inbound burst yields both in `activeCustomerRequest`; (e) an intervening attendant reply resets the burst; (f) old unrelated customer text remains in `formattedHistory` but not in `activeCustomerRequest`.
- [ ] **Step 2: Run the new test to verify red.** Run `pnpm --filter @prymeira-talk/api test -- src/modules/agents/agent-decision-context.test.ts`; expect module-not-found.
- [ ] **Step 3: Implement the helper.** Export this exact interface and behavior:

```ts
import type { NormalizedConversationMessage } from "./conversation-context-builder.js";

export function buildAgentDecisionContext(input: {
  messages: NormalizedConversationMessage[];
  currentMessageId: string;
  effectiveText: string;
}) {
  const visible = input.messages
    .filter((message) => message.label === "cliente" || message.label === "atendente")
    .map((message) => message.id === input.currentMessageId
      ? { ...message, body: input.effectiveText }
      : message);
  if (!visible.some((message) => message.id === input.currentMessageId)) {
    visible.push({
      id: input.currentMessageId,
      direction: "inbound",
      label: "cliente",
      type: "text",
      body: input.effectiveText,
      createdAt: null
    });
  }
  const messages = visible.slice(-20);
  const formattedHistory = messages
    .filter((message) => Boolean(message.body?.trim()))
    .map((message) => `[${message.createdAt ?? "sem data"}] ${message.label}: ${message.body?.trim()}`)
    .join("\n");
  const customerBurst: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.label !== "cliente") break;
    if (message.body?.trim()) customerBurst.unshift(message.body.trim());
    if (customerBurst.length >= 3) break;
  }
  return {
    messages,
    formattedHistory,
    activeCustomerRequest: customerBurst.join("\n") || input.effectiveText
  };
}
```

  The absent-current branch above avoids evaluating the wrong tail. The three-message burst prevents an older unrelated request in a long inbound run from dominating the current retrieval query.
- [ ] **Step 4: Rerun focused tests and typecheck.** Stage and commit only the new helper and test with `feat(agents): build one recent decision window`.

## Task 3: Wire complete evidence and all approved sources

**Files:**
- Modify `apps/api/src/modules/agents/agent-runtime.ts:774-890,949-965`
- Test `apps/api/src/modules/agents/agent-runtime.test.ts`
- Extend `apps/api/src/modules/agents/knowledge-retrieval.test.ts`

- [ ] **Step 1: Write failing runtime tests.** In the runtime test's mocked Prisma, return 51 ready knowledge sources with the only relevant one in position 51. Assert the `aiKnowledgeSource.findMany` call has `where: { workspaceId, agentId, status: "ready" }` and no `take: 50`, the relevant source is selected, both `replyPreflight.evaluate` and `.audit` receive identical IDs/content and the same 20 messages, and `provider.generate` still receives `agent.systemPrompt` unchanged. Add a test where the last two inbound messages are `"Barra para viga baldrame"` and `"10mm"` and assert the retrieval query picks up the first phrase. Keep existing uncommitted runtime tests intact.
- [ ] **Step 2: Run focused runtime tests to verify red.** Run `pnpm --filter @prymeira-talk/api test -- src/modules/agents/agent-runtime.test.ts src/modules/agents/knowledge-retrieval.test.ts`; expect failing assertions for the 50-source cap or incomplete evidence.
- [ ] **Step 3: Wire the helper and remove the silent source cap.** Import `buildAgentDecisionContext`. After `buildConversationContext`, compute the common window and use it for retrieval and both JEV calls:

```ts
const decisionContext = buildAgentDecisionContext({
  messages: conversationContext.messages,
  currentMessageId: message.id,
  effectiveText
});
const knowledgeSelection = selectRelevantKnowledge({
  latestMessage: decisionContext.activeCustomerRequest,
  conversationHistory: decisionContext.formattedHistory,
  instruction: runInput.instruction,
  taxonomy,
  sources: knowledge.map(toRetrievalSource)
});
const jevKnowledge = knowledgeSelection.selected.map((source) => ({
  id: source.id,
  title: source.title,
  content: source.content
}));
```

  At each of the existing `evaluate()` and `audit()` calls, use these exact shared properties:

```ts
agentRules: agent.systemPrompt,
conversationMessages: decisionContext.messages,
selectedKnowledge: jevKnowledge,
```

  Remove only `take: 50` from the ready-source `findMany` call; retain `workspaceId`, `agentId`, `status: "ready"`, and ordering. Keep `systemPrompt: agent.systemPrompt` on `provider.generate`.
- [ ] **Step 4: Add diagnostics without exposing conversation text.** In `contextSummary`, record counts based on the shared values:

```ts
const jevPayloadCharacters = JSON.stringify({
  agentRules: agent.systemPrompt,
  conversationMessages: decisionContext.messages,
  approvedKnowledge: jevKnowledge
}).length;
contextSummary = {
  ...contextSummary,
  jevConversationMessageCount: decisionContext.messages.length,
  jevAgentRulesCharacters: agent.systemPrompt.length,
  jevSelectedKnowledgeCharacters: jevKnowledge.reduce((sum, source) => sum + source.content.length, 0),
  jevPayloadCharacters
};
```

  Keep `knowledgeMatches` with IDs/scores/reasons. Do not log prompt or customer bodies. If source loading or provider calls fail, retain the current safe error/handoff path, never mark an incomplete JEV evaluation as successful.
- [ ] **Step 5: Rerun focused tests and typecheck.** Stage and commit only the runtime and relevant tests with `feat(agents): share complete evidence across JEV and retrieval`.

## Task 4: Retrieval and safety regression suite

**Files:**
- Extend `apps/api/src/modules/agents/knowledge-retrieval.test.ts`
- Extend `apps/api/src/modules/agents/jev-reply-preflight.test.ts`
- Extend `apps/api/src/modules/agents/agent-runtime.test.ts`

- [ ] **Step 1: Add specific regressions.** Assert: a ready improvement with metadata `{ source: "approved_agent_improvement" }` can rank for a matching request; unrelated improvements are not selected; an alias only retrieves evidence and does not itself assert `not_sold`; the full Villefer prompt (or a synthetic >4.000-character prompt with negative rule at the end) reaches both JEV calls; a 20-message João context preserves `"viga baldrame"` and `"10mm"`; a Ricardo oxicorte request receives the negative rule; a newer unrelated topic does not inherit the older category.
- [ ] **Step 2: Run focused and full checks.** Run `pnpm --filter @prymeira-talk/api test -- src/modules/agents/knowledge-retrieval.test.ts src/modules/agents/jev-reply-preflight.test.ts src/modules/agents/agent-runtime.test.ts`, then `pnpm --filter @prymeira-talk/api build` and `pnpm --filter @prymeira-talk/api test`. All must pass; report any existing unrelated failures separately.
- [ ] **Step 3: Run no-send replay if credentials are available.** Use existing `apps/api/scripts/test-jev-villefer-package-live.ts` or a local test harness with the attached agent package; inspect its behavior before running and do not send WhatsApp/customer messages. Compare João, Ricardo, end-of-prompt rule, unrelated topic, and JEV request sizes. If unavailable, mark live validation not run; do not claim it passed.
- [ ] **Step 4: Review diff and commit task-owned tests.** Check `git diff --check`, `git status --short`, and staged paths before committing. Do not push or deploy without a separate explicit request.

## Completion criteria

The JEV preflight and audit see the same full prompt, last 20 complete messages, and the same relevant approved-source text. GPT behavior is unchanged except for improved relevant knowledge retrieval. No older approved source disappears solely because it is beyond the first 50. Tests demonstrate supported negatives, ambiguous cases, and no-send behavior. Report measured payload sizes and any remaining live-test limitation.
