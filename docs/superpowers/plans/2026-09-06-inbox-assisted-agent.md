# Inbox Assisted Agent Implementation Plan

> **For agentic workers:** Use `executing-plans` to implement task by task. The user explicitly chose sequential execution in this session; do not delegate. Steps use checkboxes for progress.

**Goal:** Implement the approved Talk inbox panel with automatic private reply suggestions, explicit human send, human-control pause and traceable seller edits, without activating existing channels.

**Architecture:** Keep draft generation separate from the agent's action executor and outbound transport. Add workspace-scoped channel configuration, durable per-conversation scheduling, immutable suggestion revisions and authenticated send attribution. Reuse the current provider, knowledge/media preparation and manual outbound service. Existing channels default to disabled for this feature.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Zod, React/Vite, Vitest, existing OpenAI-compatible provider and Evolution transport.

---

## Approved references and working copy

- Spec: `docs/superpowers/specs/2026-09-06-inbox-assisted-agent-design.md`.
- Visual approved by user: analysis workspace `.superpowers/brainstorm/44325-1788730450/content/talk-apoio-v1.html`. This is a local demonstration, not production code or proof of live functionality.
- Isolated branch: `codex/assisted-inbox-pilot`.
- Worktree: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk Assisted Pilot`.
- Baseline commit: `8e938fc`; preserve published Villefer corrections and existing agents.
- All commands below run at this worktree root. Use `pnpm install --frozen-lockfile`, without changing dependency versions. Missing offline tarballs can be fetched using the existing registry configuration.
- No database reset, production migration, deployment or channel activation during implementation.

## Contracts shared by all tasks

The settings endpoint exposes only these fields, never `Channel.encryptedConfig` or provider credentials:

```ts
type AssistantMode = "disabled" | "automatic" | "on_demand";
type AssistantChannelSettings = { mode: AssistantMode; agentId: string | null };
type AssistantDraftStatus = "pending" | "generating" | "ready" | "stale" | "paused" | "failed" | "sent";
type AssistantActor = {
  workspaceId: string;
  userId: string;
  role: "owner" | "manager" | "agent";
};
type AssistantSendInput = {
  suggestionId: string;
  body: string;
  requestKey: string;
  reviewedContextKey: string;
};
```

Generation jobs have no `send`, `evolution`, `executeAgentActions`, board-rule or public-note dependencies. They only generate and persist private content. Resolve an actor from authenticated `request.talk.clerkUserId` and workspace-scoped `UserProfile`; never accept a user ID from the request body. Missing actor profile returns an explicit onboarding error, not another user's ID or null attribution.

Routes for the feature, registered under the existing authenticated API:

| Method | Path | Authorization / behavior |
|---|---|---|
| GET | `/assistant/channels/:channelId/settings` | Workspace member; sanitized settings only |
| PUT | `/assistant/channels/:channelId/settings` | Owner/manager; same-workspace agent; missing mode defaults disabled |
| GET | `/assistant/conversations/:conversationId` | Owner/manager or assigned seller; current state and up to 20 revisions |
| POST | `/assistant/conversations/:conversationId/suggestions` | Same conversation permission; optional private `instruction` up to 2,000 characters; human control blocks generation |
| POST | `/assistant/conversations/:conversationId/send` | Same conversation permission; explicit manual send; validate `AssistantSendInput` |

Use 400 for malformed data, 403 for unauthorized actors, 404 for out-of-workspace references, 409 for human control/stale version/conflicting idempotency key, 422 for missing profile/configuration or invalid draft content, 429 for rate limits, and 502 for provider failure. Do not silently fall back to simulated text.

## Task 1: Domain policy and serialization

**Create:** `packages/shared/src/assistant.ts`, `packages/shared/src/assistant.test.ts`, `apps/api/src/modules/assistant/assistant-policy.ts`, `apps/api/src/modules/assistant/assistant-policy.test.ts`.
**Modify:** `packages/shared/src/index.ts`.

- [ ] Add failing schema tests for disabled defaults, required agent in enabled modes, unknown setting keys and invalid suggestion-send payloads.
- [ ] Add failing pure-policy tests for human-control pause, disabled mode, on-demand versus automatic triggers, stale context and debounce bounds.

```ts
import { describe, expect, it } from "vitest";
import { canGenerateSuggestion, nextSuggestionAt } from "./assistant-policy.js";

describe("assistant policy", () => {
  it("human control always blocks generation", () => {
    expect(canGenerateSuggestion({mode:"automatic", control:"human_controlled", trigger:"inbound"})).toBe(false);
    expect(canGenerateSuggestion({mode:"on_demand", control:"human_controlled", trigger:"manual"})).toBe(false);
  });
  it("debounces 2 seconds but never extends beyond 10 seconds", () => {
    expect(nextSuggestionAt(1000, 1000)).toBe(3000);
    expect(nextSuggestionAt(1000, 15000)).toBe(11000);
  });
});
```

- [ ] Run `pnpm --filter @prymeira-talk/api exec vitest run src/modules/assistant/assistant-policy.test.ts`; expect missing-module failure before implementation.
- [ ] Implement the exact policy functions and strict shared schemas. Settings live under a dedicated `assistant` key in existing channel JSON; absent/invalid legacy configuration must be treated as disabled, not as automatic.

```ts
export function canGenerateSuggestion(input: {
  mode: "disabled" | "automatic" | "on_demand";
  control: string;
  trigger: "inbound" | "manual";
}): boolean {
  return input.control !== "human_controlled" && input.mode !== "disabled"
    && (input.mode === "automatic" || input.trigger === "manual");
}
export function nextSuggestionAt(firstPendingMs: number, lastInboundMs: number): number {
  return Math.min(lastInboundMs + 2_000, firstPendingMs + 10_000);
}
```

- [ ] Verify shared/API tests and commit only these files.

## Task 2: Durable state and actor access

**Modify:** `apps/api/prisma/schema.prisma`.
**Create:** `apps/api/prisma/migrations/20260906000100_assistant_drafts/migration.sql`, `apps/api/src/modules/assistant/assistant-repository.ts`, `apps/api/src/modules/assistant/assistant-access.ts`, their `.test.ts` files.

- [ ] Model `AssistantConversationState` keyed by workspace/conversation: monotonically increasing revision, last input message ID, first-pending time, due time, status, lease token/expiry and last error code. One row per conversation.
- [ ] Model `AssistantSuggestion`: immutable context key, agent configuration hash, suggestion body, private instruction and actor, processed-media warnings, proposed-but-unexecuted actions, creation time and revision. Add composite foreign keys scoped by workspace for conversation, agent and user, and unique workspace/conversation/revision.
- [ ] Model `AssistantSuggestionSend`: unique workspace/requestKey, suggestion relation, body hash and final text, actor, outgoing message ID and state. Use a composite workspace/message FK (add `Message`'s composite unique key). A suggestion can have one accepted manual send; retries return that record, not another outbound message.
- [ ] Add tests proving lookup by workspace, no actor impersonation, owner/manager versus assigned-seller access, changed assignment revokes access and missing profile fails closed.
- [ ] Repository uses compare-and-swap on revision plus lease token to claim/publish. Tests must show two workers cannot claim the same state and an old worker cannot overwrite a newer revision. Expired leases recover with bounded retries.

```ts
// The successful claim must update exactly one row before a provider call.
const claimed = await prisma.assistantConversationState.updateMany({
  where: { workspaceId, conversationId, revision, status: "pending", leaseToken: null },
  data: { status: "generating", leaseToken, leaseUntil }
});
if (claimed.count !== 1) return { claimed: false };
```

- [ ] Create and inspect the additive migration without applying it to production. Run Prisma validation/generation. Database integration tests use only an explicitly designated disposable local test database, never the VPS database or an inherited production URL.
- [ ] Run repository/access unit tests and migration integrity checks; commit schema, migration and typed repository together.

## Task 3: Read-only provider and media adapter

**Create:** `apps/api/src/modules/assistant/assistant-generation.ts`, `assistant-generation.test.ts`.
**Reference:** `agents/agent-test-chat.ts`, `agents/conversation-context-builder.ts`, `agents/agent-media-resolver.ts`, `agents/inbound-media.ts`, `agents/knowledge-retrieval.ts`, `agents/provider-gateway.ts`.

- [ ] Tests inject a fake provider returning reply plus handoff/actions. Assert that only the reply and proposed-action metadata are stored; zero calls to any outbound/executor service are possible.
- [ ] Build context server-side from up to 80 current conversation messages in stable chronological order. Record message IDs/content hashes and whether history was limited. Include private instructions under a separate trusted-vendor label, not as fictitious customer messages. Customer text/media never becomes policy.
- [ ] Reuse provider settings, knowledge selection and media readers. Reuse the test-chat preparation only if the adapter preserves real production conversation metadata and makes simulated fallback impossible; otherwise extract a shared pure preparation helper with existing test coverage.
- [ ] Process current relevant image/audio/PDF with the existing bounded resolver. Cache extracted content tied to the source message/content hash; mark unreadable or unsupported files in the panel and do not invent text. No arbitrary URL supplied by the browser.
- [ ] Bound context to 120,000 characters, single-message retained content to 24,000 characters, private instruction to 2,000 characters, and reply to 4,000 characters; limit concurrent jobs and use provider timeout. Provider failure becomes an inspectable failed draft without transport fallback.
- [ ] Hash the exact agent prompt/configuration/knowledge revision used. After the provider returns, recheck current context and human control before publication.

```ts
// Only the supplied read-only provider can run here; actions remain data.
const output = await provider.generate(providerInput);
const draft = {
  body: output.reply?.trim() ?? "",
  proposedActions: output.actions,
  handoff: output.handoff,
  sources: output.sources ?? []
};
if (!draft.body || draft.body.length > 4_000) throw new Error("ASSISTANT_INVALID_REPLY");
return draft;
```

- [ ] Run media retention, malicious-instruction, unavailable-file, provider failure and context-revision tests. Existing media/runtime tests must remain green; commit generation adapter separately.

## Task 4: Scheduling and autonomous-send guard

**Create:** `apps/api/src/modules/assistant/assistant-scheduler.ts`, `assistant-scheduler.test.ts`.
**Modify:** `apps/api/src/app.ts`, `modules/evolution/evolution.routes.ts`, `modules/meta/meta.webhooks.routes.ts`, `modules/conversations/conversations.routes.ts`, `modules/agents/agent-runtime.ts`, `modules/agents/agent-reply-scheduler.ts`, with adjacent tests.

- [ ] Tests cover fresh inbound events, duplicate delivery, quick message bursts, no generation when disabled/on-demand/human-controlled, working while the conversation is not open in a browser, and no retroactive replay of answered history.
- [ ] On persisted inbound messages schedule suggestions in assisted channels. Respect existing ingestion dedupe; do not wait for a model response inside webhook handling. Increment the durable context revision and retain the first pending timestamp for the capped 2s/10s debounce.
- [ ] Use a per-conversation claim/lease, at most two provider calls per process, bounded retry on network failure (maximum two attempts), and reclaim abandoned jobs after restart. New input makes an in-flight result stale and schedules the newest context.
- [ ] On human takeover increment revision, cancel due jobs and invalidate ready drafts. On release, schedule only the latest still-unanswered client input when the channel mode is automatic.
- [ ] Independently guard existing autonomous agent runtime and delayed replies for assisted channels, including legacy queued jobs. Recheck immediately before executing actions and transport. Generation mode is not permission to execute tools.
- [ ] Register scheduler start/stop in app lifecycle; do not create OS/cron automation. Default configuration does not alter any current channel.
- [ ] Add tests with a deferred provider promise: human takeover or new incoming message happens before resolution; assert no ready stale suggestion or outbound message is produced.
- [ ] Run scheduler, webhook, runtime and conversation-control suites; commit integration only after those tests pass.

## Task 5: API, explicit send and review history

**Create:** `apps/api/src/modules/assistant/assistant-inbox.routes.ts`, `assistant-inbox.service.ts`, `assistant-send.service.ts`, adjacent tests.
**Modify:** `apps/api/src/app.ts`, `modules/conversations/conversations.service.ts`, `modules/conversations/conversations.routes.ts` only where needed to reuse outbound validation/attribution.

- [ ] Implement the endpoint contract above with authenticated actor resolution and per-conversation access checks on every read/write. Settings changes preserve unrelated encrypted configuration and require owner/manager.
- [ ] In a transaction claim an explicit send by requestKey and suggestion; verify the same workspace/conversation, current context, body bounds, current actor permission and no prior accepted send. Context change returns 409 and preserves text. Human takeover disables direct suggestion-send, but ordinary manual text remains possible.
- [ ] Reuse the existing outbound service. Record the actual actor instead of `sentByUserId: null` for assisted sends. Do not mark provider acceptance as delivered. Update the attribution with outgoing message ID and subsequent status.
- [ ] Do not retry an ambiguous transport send automatically: retain the outgoing record and report uncertain state for reconciliation. A duplicate key with a different body returns 409; same key/body returns the existing send state.
- [ ] Composer sends carrying a suggestion reference use the same validation/attribution route; ordinary composer sends without a reference keep their existing behavior. When a human has taken over, preserve only attribution of the manual edit, not a blocked direct-send shortcut.
- [ ] Return history as original, revisions, orientation, final sent message and actor/status, newest first, bounded pagination. No prompt/config mutations and no cross-customer memory writes.
- [ ] Do not broadcast private text over the workspace-wide realtime hub. Use authenticated polling for the open panel, paused when hidden, plus existing message/control events to refresh. Clear state on conversation/workspace change. This avoids leaking private revisions via generic websocket messages.
- [ ] Verify real-provider-disabled, missing configuration, agent mismatch, stale body, double click, transport failure and exact final-text attribution tests; commit API/send separately.

## Task 6: Approved inbox component and settings

**Create:** `apps/web/src/features/inbox/AssistantPanel.tsx`, `useAssistantConversation.ts`, `AssistantPanel.test.tsx`, `assistant-composer-state.ts`, `assistant-composer-state.test.ts`.
**Modify:** `apps/web/src/features/inbox/InboxPage.tsx`, `apps/web/src/app/api.ts`, `apps/web/src/styles.css`, channel settings component discovered under `apps/web/src/features/channels/`.

- [ ] Reproduce approved desktop composition: tabs Contato/IA de apoio, private notice, suggestion/status, Enviar resposta, Editar no campo, private guidance and collapsed revision history. Reuse Talk typography, existing CSS variables and lucide icons; do not import the demo's fake names/messages or canned generator.
- [ ] Map API states to waiting, generating, ready, updating, human-control, failure and sent. Keep state labels human-readable and errors retryable when permitted.
- [ ] Implement mobile panel from the composer trigger; close/Escape and focus restoration; keep keyboard focus stable during background refresh. At 390px no horizontal overflow or inaccessible send/control buttons.
- [ ] Define draft provenance explicitly so editing is retained across private suggestion updates:

```ts
type ComposerSuggestionOrigin = {
  suggestionId: string;
  originalBody: string;
  contextKey: string;
} | null;
type ComposerState = { conversationId: string; body: string; origin: ComposerSuggestionOrigin };
```

- [ ] Never replace non-empty composer content without inline confirmation. Direct send warns about an existing rascunho instead of silently discarding it. New context marks a copied draft for review without overwriting; switching conversations clears provenance and ignores late requests.
- [ ] A direct-send click creates one stable requestKey until the result is known; disable repeated clicks. On failed/uncertain send preserve the text and do not invent delivery status.
- [ ] Channel settings expose disabled/automatic/on-demand and an agent selector for authorized managers. Show independent automations/campaigns as a pilot warning, not a false global guarantee. Disabled remains the initial setting.
- [ ] Test component states, private guidance, edits, linked send, stale context, human pause, drawer and role restrictions. Run web typecheck/build; commit UI separately.

## Task 7: Regression, database safety and supervised pilot handoff

**Create:** `docs/assisted-inbox-pilot.md`, `artifacts/assistant-pilot/verification.md`.

- [ ] Run `pnpm --filter @prymeira-talk/shared test`, `pnpm --filter @prymeira-talk/api test`, `pnpm --filter @prymeira-talk/web test`, `pnpm typecheck`, `pnpm --filter @prymeira-talk/api build:prod`, `pnpm --filter @prymeira-talk/web build`.
- [ ] Confirm the migration is additive and all new settings are disabled for existing channels. Verify FKs, two-worker claims, unique sends, restart recovery and message-status attribution against a disposable local database before release.
- [ ] Render the real local application with representative seeded/synthetic data; inspect desktop and mobile screenshots, test tab/focus/control/edit/send interactions and check browser errors. Do not use the approved static preview as evidence that production integration works.
- [ ] Record actual commands/results, provider-vs-simulation distinction and limitations. Preserve the original reports and agent package content.
- [ ] Prepare an activation checklist: import agent into correct workspace, choose seller/channel, confirm independent campaigns, enable assisted automatic mode, receive text/PDF/image/audio, edit/send once, assume human control, verify silence, release and receive new message.
- [ ] Keep production deployment and real-channel activation pending explicit release direction and the user's chosen chip/seller. Deliver code/test evidence without claiming the live pilot passed.

## Coverage check

| Spec area | Tasks |
|---|---|
| Per-channel configuration, defaults, human control | 1, 2, 4, 6 |
| Automatic generation, capped debounce, duplicate/restart/race safety | 1, 2, 4 |
| Real provider, knowledge and input media | 3 |
| Privacy, actor isolation and no autonomous actions | 2, 3, 4, 5 |
| Manual one-click send and preserved editor | 5, 6 |
| Revisions, orientation, exact final message and delivery state | 2, 5, 6 |
| Approved desktop/mobile visual and failure states | 6, 7 |
| No automatic learning or production activation | 3, 5, 7 |

## Execution log

- [x] User approved both revised behavior and interactive visual.
- [x] User chose sequential execution in this session.
- [x] Dedicated worktree created; baseline preserved.
- [x] Task 1: shared contracts and pure control policy verified.
- [x] Task 2: schema, scoped access, CAS leases and local database tests verified.
- [x] Task 3: read-only provider/media adapter and failure handling verified.
- [x] Task 4: transactional inbound scheduling and autonomous-runtime guards verified.
- [x] Task 5: authenticated API, explicit idempotent send and attribution verified.
- [x] Task 6: approved panel, composer provenance and channel settings implemented.
- [x] Task 7: local suites, builds, database/browser verification and pilot handoff documented.

The procedural checkboxes above preserve the original sequence; this execution log and `artifacts/assistant-pilot/verification.md` are the completion record. Tests were added alongside implementation where a separate red-green cycle was not recorded; do not claim every item was executed as strict TDD.

Implementation adjustments supported by tests: server-arrival ordering avoids second-precision provider timestamps dropping new input; queue writes share the inbound transaction; leases survive superseding revisions; explicit sends reserve an outgoing message before transport; context polling uses authenticated requests rather than workspace-wide broadcasts. Provider errors require a manual retry, while abandoned worker recovery remains capped at two attempts. All local verification is separate from the pending real-chip pilot. No production deployment occurred.
