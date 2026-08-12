# Agent Reply Timing and Loop Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make inbound agent replies wait for a workspace-configurable quiet window and stop repeated AI-to-AI exchanges silently before another provider call or WhatsApp send.

**Architecture:** Store the workspace behavior in the existing `WorkspaceMirror.limits.agentBehavior` JSON namespace and expose it as a typed settings DTO plus a dedicated update route. Make the reply scheduler resolve the wait on every inbound scheduling operation, route production `run_agent` automations through activation plus the pending-reply upsert, and add a pure bounded-history loop detector that the runtime applies before generation. Keep commercial handoff replies unchanged while automation-loop handoffs suppress all outbound text.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL JSON, React 19, Vitest, Evolution WhatsApp integration, pnpm monorepo.

---

## File map

- Create `apps/api/src/modules/settings/agent-behavior-settings.ts`: parse defaults and bounded workspace behavior from `WorkspaceMirror.limits`.
- Create `apps/api/src/modules/settings/agent-behavior-settings.test.ts`: pure parsing and merge preservation coverage.
- Modify `apps/api/src/modules/settings/settings.service.ts`: return typed behavior and persist/audit workspace updates.
- Modify `apps/api/src/modules/settings/settings.routes.ts`: add authorized `PATCH /settings/agent-behavior` validation.
- Modify `apps/api/src/modules/settings/settings.service.test.ts`: API, authorization, validation, merge, and audit tests.
- Modify `apps/api/src/modules/agents/agent-reply-scheduler.ts`: resolve wait seconds per scheduling call.
- Modify `apps/api/src/modules/agents/agent-reply-scheduler.test.ts`: dynamic delay, fallback, zero, and restart-window tests.
- Modify `apps/api/src/modules/automations/automation-runner.ts`: remove immediate production generation and use activation plus scheduling.
- Modify `apps/api/src/modules/automations/automation-runner.test.ts`: prove one scheduled response path and no immediate provider run.
- Create `apps/api/src/modules/agents/agent-loop-guard.ts`: pure normalization and deterministic repetition/rapid-exchange detection.
- Create `apps/api/src/modules/agents/agent-loop-guard.test.ts`: production sequence and false-positive boundary matrix.
- Modify `apps/api/src/modules/agents/agent-runtime.ts`: evaluate the guard, persist silent handoff state/audit, and skip provider/send.
- Modify `apps/api/src/modules/agents/agent-runtime.test.ts`: runtime stop-side effects and unchanged ordinary/commercial handoff behavior.
- Modify `apps/web/src/app/api.ts`: typed behavior DTO parser and behavior update client.
- Modify `apps/web/src/features/settings/SettingsPage.tsx`: behavior form, validation, loading, save result, and navigation item.
- Modify `apps/web/src/features/settings/SettingsPage.test.tsx`: default/saved rendering and helper copy tests.
- Modify `docs/superpowers/specs/2026-08-12-agent-reply-timing-and-loop-guard-design.md`: record the discovered immediate-run bypass.

### Task 1: Workspace behavior parsing and persistence

**Files:**
- Create: `apps/api/src/modules/settings/agent-behavior-settings.ts`
- Create: `apps/api/src/modules/settings/agent-behavior-settings.test.ts`
- Modify: `apps/api/src/modules/settings/settings.service.ts`
- Modify: `apps/api/src/modules/settings/settings.routes.ts`
- Modify: `apps/api/src/modules/settings/settings.service.test.ts`

- [ ] **Step 1: Write failing pure settings tests**

Create tests that prove the default, valid value, malformed fallback, and unrelated-key preservation:

```ts
expect(readAgentBehaviorSettings({})).toEqual({ agentReplyWaitSeconds: 40 });
expect(readAgentBehaviorSettings({ agentBehavior: { replyWaitSeconds: 10 } }))
  .toEqual({ agentReplyWaitSeconds: 10 });
expect(readAgentBehaviorSettings({ agentBehavior: { replyWaitSeconds: -1 } }))
  .toEqual({ agentReplyWaitSeconds: 40 });
expect(writeAgentBehaviorSettings({ campaignLimit: 500 }, { agentReplyWaitSeconds: 0 }))
  .toEqual({ campaignLimit: 500, agentBehavior: { replyWaitSeconds: 0 } });
```

- [ ] **Step 2: Run the pure tests and confirm the missing-module failure**

Run: `pnpm --filter @prymeira-talk/api test -- agent-behavior-settings.test.ts`

Expected: FAIL because `agent-behavior-settings.ts` does not exist.

- [ ] **Step 3: Implement the pure behavior module**

Export these exact contracts:

```ts
export const DEFAULT_AGENT_REPLY_WAIT_SECONDS = 40;
export const MAX_AGENT_REPLY_WAIT_SECONDS = 300;

export interface AgentBehaviorSettings {
  agentReplyWaitSeconds: number;
}

export function readAgentBehaviorSettings(limits: unknown): AgentBehaviorSettings;
export function writeAgentBehaviorSettings(
  limits: unknown,
  behavior: AgentBehaviorSettings
): Record<string, unknown>;
```

Accept only finite integers from 0 through 300. Merge the `agentBehavior` namespace and preserve every unrelated root and namespace key.

- [ ] **Step 4: Run the pure tests and confirm they pass**

Run: `pnpm --filter @prymeira-talk/api test -- agent-behavior-settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing settings service and route tests**

Extend settings mocks with `workspaceMirror.upsert`. Assert:

```ts
expect(result.behavior).toEqual({ agentReplyWaitSeconds: 40 });
expect(savedLimits).toMatchObject({
  existingLimit: 12,
  agentBehavior: { replyWaitSeconds: 10 }
});
expect(auditCreate).toHaveBeenCalledWith({
  data: expect.objectContaining({
    action: "settings.agent_behavior_updated",
    metadata: { previousWaitSeconds: 40, nextWaitSeconds: 10 }
  })
});
```

Add route cases for owner and manager success, agent 403, and `-1`, `301`, `10.5`, and `"10"` returning 400.

- [ ] **Step 6: Run settings tests and confirm they fail**

Run: `pnpm --filter @prymeira-talk/api test -- settings.service.test.ts`

Expected: FAIL because `behavior`, `updateAgentBehavior`, and the dedicated route do not exist.

- [ ] **Step 7: Implement settings DTO, service update, and route**

Add `behavior: AgentBehaviorSettings` to `SettingsDto`. Add:

```ts
async updateAgentBehavior(input: {
  workspaceId: string;
  agentReplyWaitSeconds: number;
}): Promise<SettingsDto>
```

Load the latest workspace row, merge limits with `writeAgentBehaviorSettings`, upsert `WorkspaceMirror`, create the audit record, and return refreshed settings. Add:

```ts
const agentBehaviorBodySchema = z.object({
  agentReplyWaitSeconds: z.number().int().min(0).max(300)
}).strict();
```

Register `PATCH /settings/agent-behavior` behind the existing owner/manager permission gate.

- [ ] **Step 8: Run settings tests and typecheck**

Run: `pnpm --filter @prymeira-talk/api test -- agent-behavior-settings.test.ts settings.service.test.ts && pnpm --filter @prymeira-talk/api typecheck`

Expected: PASS with zero TypeScript errors.

- [ ] **Step 9: Commit workspace behavior support**

```bash
git add apps/api/src/modules/settings
git commit -m "feat: persist agent reply behavior settings"
```

### Task 2: Dynamic quiet-window scheduler

**Files:**
- Modify: `apps/api/src/modules/agents/agent-reply-scheduler.ts`
- Modify: `apps/api/src/modules/agents/agent-reply-scheduler.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write failing scheduler tests for dynamic values**

Extend the Prisma mock with `workspaceMirror.findUnique`. Cover 10, 0, malformed, missing, and a different value on the next call. The central assertion is:

```ts
expect(prisma.aiAgentPendingReply.upsert).toHaveBeenLastCalledWith(
  expect.objectContaining({
    update: expect.objectContaining({
      scheduledAt: new Date("2026-07-05T12:00:10.000Z")
    })
  })
);
```

For a lookup rejection, assert scheduling still occurs at `now + 40 seconds`.

- [ ] **Step 2: Run scheduler tests and confirm they fail**

Run: `pnpm --filter @prymeira-talk/api test -- agent-reply-scheduler.test.ts`

Expected: FAIL because the scheduler never reads workspace behavior.

- [ ] **Step 3: Implement per-message delay resolution**

Add `workspaceMirror.findUnique` to `AgentReplySchedulerPrismaLike`. Replace the startup-only debounce calculation with:

```ts
async function resolveDebounceMs(workspaceId: string) {
  if (input.debounceMs !== undefined) return input.debounceMs;
  try {
    const workspace = await input.prisma.workspaceMirror.findUnique({
      where: { workspaceId },
      select: { limits: true }
    });
    return readAgentBehaviorSettings(workspace?.limits).agentReplyWaitSeconds * 1_000;
  } catch {
    return DEFAULT_AGENT_REPLY_WAIT_SECONDS * 1_000;
  }
}
```

Call it inside `scheduleActiveSessionForMessage`. Preserve the explicit `debounceMs` option as a deterministic test override.

- [ ] **Step 4: Run scheduler tests and confirm they pass**

Run: `pnpm --filter @prymeira-talk/api test -- agent-reply-scheduler.test.ts`

Expected: PASS.

- [ ] **Step 5: Typecheck the app wiring**

Run: `pnpm --filter @prymeira-talk/api typecheck`

Expected: PASS; the existing `app.prisma` object satisfies the extended scheduler interface.

- [ ] **Step 6: Commit dynamic scheduling**

```bash
git add apps/api/src/app.ts apps/api/src/modules/agents/agent-reply-scheduler.ts apps/api/src/modules/agents/agent-reply-scheduler.test.ts
git commit -m "feat: configure agent reply quiet window"
```

### Task 3: Route production automations through the scheduler

**Files:**
- Modify: `apps/api/src/modules/automations/automation-runner.ts`
- Modify: `apps/api/src/modules/automations/automation-runner.test.ts`

- [ ] **Step 1: Replace the immediate-run test with the required scheduled behavior**

For a `run_agent` node with both runtime methods available, assert:

```ts
expect(agentRuntime.activateForMessage).toHaveBeenCalledWith({
  workspaceId,
  agentId,
  conversationId,
  messageId,
  instruction: "Responda agora."
});
expect(agentRuntime.runForMessage).not.toHaveBeenCalled();
expect(agentReplyScheduler.scheduleActiveSessionForMessage).toHaveBeenCalledWith({
  workspaceId,
  conversationId,
  messageId
});
```

Also assert `replyScheduled: true` in the automation result.

- [ ] **Step 2: Run the automation test and confirm it fails**

Run: `pnpm --filter @prymeira-talk/api test -- automation-runner.test.ts`

Expected: FAIL because `runForMessage` is currently called immediately.

- [ ] **Step 3: Remove the immediate production generation branch**

In `run_agent`, always call `activateForMessage`. When activation completes, schedule with `agentReplyScheduler`. Keep activation failures/skips and graph branch semantics. Do not remove `runForMessage` from the runtime interface because the scheduler owns it.

- [ ] **Step 4: Run automation and webhook scheduling regressions**

Run: `pnpm --filter @prymeira-talk/api test -- automation-runner.test.ts evolution.routes.test.ts agent-reply-scheduler.test.ts`

Expected: PASS. Existing webhook scheduling upserts the same workspace/conversation pending row and does not create a second reply.

- [ ] **Step 5: Commit the single production reply path**

```bash
git add apps/api/src/modules/automations/automation-runner.ts apps/api/src/modules/automations/automation-runner.test.ts
git commit -m "fix: debounce inbound agent automation replies"
```

### Task 4: Pure deterministic loop detector

**Files:**
- Create: `apps/api/src/modules/agents/agent-loop-guard.ts`
- Create: `apps/api/src/modules/agents/agent-loop-guard.test.ts`

- [ ] **Step 1: Write the production-sequence failing test**

Model recent messages with inbound `Não entendi, escolha uma das opções acima, por favor.` repeated three times and two interleaved outbound messages containing `metadata: { source: "ai_agent" }`. Assert:

```ts
expect(evaluateAgentLoopGuard({ messages, now })).toEqual({
  triggered: true,
  guard: "repeated_inbound",
  inboundCount: 3,
  aiOutboundCount: 2
});
```

- [ ] **Step 2: Add the false-positive and emergency matrix**

Cover two duplicates, old duplicates, customer-only bursts, human outbound metadata, ordinary alternating conversation below threshold, and ten alternating messages with five per side producing `guard: "rapid_exchange"`.

- [ ] **Step 3: Run the tests and confirm the missing-module failure**

Run: `pnpm --filter @prymeira-talk/api test -- agent-loop-guard.test.ts`

Expected: FAIL because the detector does not exist.

- [ ] **Step 4: Implement bounded normalization and evaluation**

Export:

```ts
export type AgentLoopGuardResult =
  | { triggered: false }
  | {
      triggered: true;
      guard: "repeated_inbound" | "rapid_exchange";
      inboundCount: number;
      aiOutboundCount: number;
    };

export function normalizeLoopComparisonText(value: string): string;
export function evaluateAgentLoopGuard(input: {
  messages: readonly AgentLoopMessage[];
  now: Date;
}): AgentLoopGuardResult;
```

Filter to the last two minutes and at most 30 records, normalize at most 500 characters, count only text inbound and outbound `metadata.source === "ai_agent"`, and implement the approved thresholds exactly.

- [ ] **Step 5: Run loop detector tests and typecheck**

Run: `pnpm --filter @prymeira-talk/api test -- agent-loop-guard.test.ts && pnpm --filter @prymeira-talk/api typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the detector**

```bash
git add apps/api/src/modules/agents/agent-loop-guard.ts apps/api/src/modules/agents/agent-loop-guard.test.ts
git commit -m "feat: detect automated agent conversation loops"
```

### Task 5: Stop loops silently in the agent runtime

**Files:**
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.test.ts`

- [ ] **Step 1: Write the failing runtime stop test**

Return the production loop history from `message.findMany`. Assert:

```ts
expect(provider.generate).not.toHaveBeenCalled();
expect(evolution.client.sendText).not.toHaveBeenCalled();
expect(conversation.update).toHaveBeenCalledWith(expect.objectContaining({
  data: expect.objectContaining({ aiControlStatus: "human_controlled" })
}));
expect(aiAgentSession.update).toHaveBeenCalledWith(expect.objectContaining({
  data: expect.objectContaining({
    status: "handoff_requested",
    handoffReason: "possible_automation_loop"
  })
}));
expect(auditLog.create).toHaveBeenCalledWith({
  data: expect.objectContaining({
    action: "agent.automation_loop_stopped",
    metadata: expect.not.objectContaining({ body: expect.anything() })
  })
});
expect(result.status).toBe("handoff_requested");
```

Also assert the stored run has empty output/actions, zero-cost metadata, and the guard counts rather than message bodies.

- [ ] **Step 2: Run the targeted runtime test and confirm it fails**

Run: `pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts`

Expected: FAIL because the provider is still called and no loop state is persisted.

- [ ] **Step 3: Extend runtime persistence interfaces**

Add message `metadata`, `auditLog.create`, `aiAgentSession.update`, and a transaction-safe loop-stop helper to `AgentRuntimePrismaLike`. Load at most 30 messages from `createdAt >= now - 2 minutes` ordered ascending for guard evaluation.

- [ ] **Step 4: Apply the guard before retrieval and generation**

Immediately after validating the active conversation/message and before media/provider work:

```ts
const loopGuard = evaluateAgentLoopGuard({ messages: recentMessages, now: new Date() });
if (loopGuard.triggered) {
  return stopForAutomationLoop({ runInput, agent, conversation, loopGuard });
}
```

The helper updates session/conversation, creates a sanitized audit row and `handoff_requested` run, publishes the conversation update, and returns no customer-visible reply. Do not reuse `HANDOFF_ACKNOWLEDGEMENT` for this path.

- [ ] **Step 5: Add regressions for ordinary and commercial handoffs**

Keep a normal history test that still calls `provider.generate`. Keep the stock/price handoff assertion that Evolution receives exactly `Vou consultar essas informações e já te dou um retorno.`.

- [ ] **Step 6: Run runtime, safety, automation, and scheduler tests**

Run: `pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts agent-loop-guard.test.ts agent-reply-scheduler.test.ts automation-runner.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit silent loop stopping**

```bash
git add apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts
git commit -m "feat: stop automated agent loops silently"
```

### Task 6: Add the behavior control to Ajustes

**Files:**
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/settings/SettingsPage.tsx`
- Modify: `apps/web/src/features/settings/SettingsPage.test.tsx`

- [ ] **Step 1: Write failing DTO and page tests**

Add `behavior: { agentReplyWaitSeconds: 40 }` to settings fixtures. Assert static markup contains:

```ts
expect(html).toContain("Comportamento dos agentes");
expect(html).toContain("Tempo de espera após a última mensagem");
expect(html).toContain('min="0"');
expect(html).toContain('max="300"');
expect(html).toContain('value="40"');
expect(html).toContain("Cada nova mensagem reinicia a contagem");
```

Export and test a form mapper so a saved value of 10 renders as 10 and a missing behavior defaults to 40.

- [ ] **Step 2: Run the page test and confirm it fails**

Run: `pnpm --filter @prymeira-talk/web test -- SettingsPage.test.tsx`

Expected: FAIL because behavior types, form, and API client do not exist.

- [ ] **Step 3: Add the typed DTO parser and update client**

Extend `SettingsDto`:

```ts
behavior: {
  agentReplyWaitSeconds: number;
};
```

Make `parseSettings` validate/default the value to 40. Add:

```ts
export async function apiUpdateAgentBehavior(
  getToken: () => Promise<string | null>,
  body: { agentReplyWaitSeconds: number }
): Promise<SettingsDto>
```

calling `PATCH /settings/agent-behavior`.

- [ ] **Step 4: Implement the independent Settings form**

Add state initialized from `settings.behavior.agentReplyWaitSeconds`. Add nav link `#settings-agent-behavior` and a form with:

```tsx
<input
  inputMode="numeric"
  min={0}
  max={300}
  step={1}
  type="number"
  value={agentReplyWaitSeconds}
/>
```

Reject non-integers and out-of-range values before calling the API. Helper copy must say `Cada nova mensagem reinicia a contagem. Use 0 para responder imediatamente.` Save independently and show `Tempo de espera dos agentes atualizado.`.

- [ ] **Step 5: Run page tests, typecheck, and build**

Run: `pnpm --filter @prymeira-talk/web test -- SettingsPage.test.tsx && pnpm --filter @prymeira-talk/web typecheck && pnpm --filter @prymeira-talk/web build`

Expected: PASS and Vite production build exits 0.

- [ ] **Step 6: Commit the Ajustes UI**

```bash
git add apps/web/src/app/api.ts apps/web/src/features/settings/SettingsPage.tsx apps/web/src/features/settings/SettingsPage.test.tsx
git commit -m "feat: configure agent reply timing in settings"
```

### Task 7: Full verification, documentation consistency, and publication

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-agent-reply-timing-and-loop-guard-design.md`
- Create or modify deployment files only if the existing CI release workflow requires no source change.

- [ ] **Step 1: Run formatting/diff integrity checks**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional changes.

- [ ] **Step 2: Run the complete monorepo verification**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: all shared, API, and web tests pass; all typechecks and production builds exit 0.

- [ ] **Step 3: Re-read the acceptance checklist against implementation**

Confirm all of these with tests or code evidence:

```text
[ ] 0–300 seconds saved by owner/manager
[ ] each inbound resets the pending quiet window
[ ] no immediate production run_agent generation
[ ] repeated loop stops before provider/send
[ ] rapid emergency guard stops before provider/send
[ ] conversation becomes human_controlled / Humano necessário
[ ] commercial handoff acknowledgement unchanged
[ ] audit contains counts, not message bodies
```

- [ ] **Step 4: Commit the amended approved spec**

```bash
git add docs/superpowers/specs/2026-08-12-agent-reply-timing-and-loop-guard-design.md docs/superpowers/plans/2026-08-12-agent-reply-timing-and-loop-guard.md
git commit -m "docs: plan agent timing and loop protection"
```

- [ ] **Step 5: Push the release branch and wait for CI images**

Run: `git push origin codex/villefer-agent-hardening`

Expected: GitHub Actions publishes commit-tagged API and web images and completes successfully.

- [ ] **Step 6: Deploy API first, then web**

Update only the Prymeira Talk API and web services to the exact commit image tag. Verify:

```bash
curl -fsS https://talk.prymeiradigital.com.br/api/health
curl -fsS https://talk.prymeiradigital.com.br/api/ready
```

Expected from both: `{"ok":true,"product":"talk"}`.

- [ ] **Step 7: Run the production acceptance matrix**

In Ajustes, save 10 seconds. From WhatsApp, send five short messages inside the window and verify one reply after the fifth. Save 0 and verify the next message schedules immediately. Restore 40. Reproduce three matching automated inbound messages with two AI replies in the recent window and verify the agent sends nothing else, the Talk inbox shows `Humano necessário`, and audit shows `agent.automation_loop_stopped` without full message bodies.

- [ ] **Step 8: Final clean-state verification**

Run: `git status --short && git rev-parse HEAD && git ls-remote --heads origin codex/villefer-agent-hardening`

Expected: clean worktree and local/remote hashes match the deployed commit.
