# Agent Reply Timing and Loop Guard Design

**Date:** 2026-08-12

**Status:** Approved design; pending implementation

## Context

Prymeira Talk currently uses a fixed 40-second debounce before an active agent replies. Each inbound message replaces the pending reply's `lastMessageId` and moves `scheduledAt`, so a sequence of short customer messages can already be combined into one agent turn. The delay is hard-coded, however, and cannot be changed during a demo or adapted to a workspace's sales motion.

A production conversation also exposed an AI-to-AI loop. An external automated menu repeatedly sent `Não entendi, escolha uma das opções acima, por favor.` The Villefer agent answered each repetition, which caused the external bot to answer again. Multiple exchanges occurred within about one minute. Prompt-only instructions are insufficient because each individual response looks reasonable; the runtime needs a deterministic circuit breaker.

## Goals

- Let an owner or manager configure the workspace-wide wait after the most recent inbound message.
- Reset that wait whenever another inbound message arrives, producing one reply after the customer becomes quiet.
- Apply a saved change to subsequent inbound messages without restarting the API.
- Detect the observed repeated automated exchange before another agent reply is sent.
- Add a broader emergency rate guard for abnormal rapid AI exchanges that are not exact repetitions.
- Stop silently, mark the conversation `Humano necessário`, and record why the guard fired.

## Non-goals

- Per-agent, per-channel, or per-contact wait settings in this release.
- Displaying a live countdown in the inbox.
- Proving with certainty that the remote participant is an AI.
- Using another model call to classify bot behavior.
- Automatically resuming a conversation stopped by the loop guard.
- Sending a final warning or fallback message after a loop is detected.

## Workspace setting

Add a workspace-level behavior configuration exposed through `GET /settings` and a dedicated authorized update path. It must not be stored as an integration-provider setting because it controls the agent runtime independently of OpenAI, Evolution, or Meta configuration.

The first setting is:

- API/storage key: `agentReplyWaitSeconds`
- UI label: `Tempo de espera após a última mensagem`
- unit: seconds
- default: `40`
- accepted range: integer `0` through `300`
- meaning of `0`: schedule immediately, subject to the scheduler's normal asynchronous processing

The setting is global to the workspace. Only owners and managers may update it. The update is audited without storing unrelated settings or secrets in audit metadata.

The UI adds a `Comportamento dos agentes` section in `Ajustes`, near the Provider de IA section. It contains a numeric field, the `segundos` suffix, helper copy explaining that each new customer message restarts the timer, and a dedicated save button. The form reports loading, validation, success, and failure without affecting other settings forms.

## Dynamic reply scheduling

When an inbound message is eligible for an active agent session, the scheduler resolves `agentReplyWaitSeconds` for that message's workspace and calculates `scheduledAt` from that value. It must resolve the setting during scheduling rather than only during API startup, so a newly saved value applies to the next inbound message without deployment or restart.

The existing pending-reply upsert remains the batching mechanism:

1. The first inbound message creates or replaces a pending reply.
2. Each later inbound message for the same conversation updates `lastMessageId` and recalculates `scheduledAt` from its own receipt time.
3. Only the final pending message runs when the quiet window expires.
4. The agent receives the normal conversation history, which includes all customer messages in the burst.

Old wake timers may fire after a later message reschedules the database row. They are harmless because processing selects only rows whose current `scheduledAt` is due. Saving a new workspace value does not retroactively change already pending replies; it applies to messages scheduled after the save.

If the workspace mirror or setting is missing, malformed, or temporarily unreadable, scheduling uses the default of 40 seconds and records a sanitized operational diagnostic. A configuration read failure must not drop the inbound message.

## Deterministic loop guard

The guard runs immediately before provider generation and before sending any new agent reply. It inspects a bounded recent history for the current conversation. It does not rely on model judgment.

### Text normalization

For comparison only, text is normalized by:

- Unicode normalization;
- lowercasing;
- trimming outer whitespace;
- collapsing repeated internal whitespace;
- removing insignificant surrounding punctuation;
- limiting comparison input to a bounded number of characters.

The original message remains unchanged and is never overwritten by the normalized form.

### Repetition guard

The repetition guard fires when all of the following are true:

- the current message is inbound text;
- the same normalized inbound text appears at least three times in the recent history, including the current message;
- those repetitions occur inside a rolling two-minute window;
- at least two AI-agent outbound messages occur between or after those inbound repetitions.

This matches the observed `Não entendi...` loop while avoiding a stop when a human simply sends one duplicate or resends a question later.

### Emergency rapid-exchange guard

As a final circuit breaker, the guard also fires when a two-minute window contains at least ten alternating inbound and AI-agent outbound text messages, with at least five messages in each direction. Only outbound messages carrying `metadata.source = "ai_agent"` count; human-sent or integration-originated outbound messages do not count toward the AI side.

The rapid guard is intentionally conservative. It catches non-identical automated menus without stopping an ordinary customer who sends several messages before the first response, because a burst of customer-only inbound messages does not alternate with AI output.

## Stop behavior

When either guard fires, Prymeira Talk performs no provider call and sends no final WhatsApp message. In one database transaction or an equivalent failure-safe sequence, it:

1. sets the active agent session status to `handoff_requested` with reason `possible_automation_loop`;
2. sets conversation AI control to `human_controlled`;
3. records an agent run with status `handoff_requested`, sanitized guard metadata, and no model cost;
4. completes the pending scheduler item so it cannot retry;
5. publishes the conversation update so the inbox shows `Humano necessário`;
6. creates an audit entry identifying the workspace, conversation, guard type, and counts, without copying full customer message bodies.

The runtime returns `handoff_requested` with an internal machine-readable reason, but suppresses the normal handoff acknowledgement for this guard. Existing commercial/technical handoffs keep sending their currently approved acknowledgement.

Releasing AI control manually does not automatically answer the message that triggered the guard. A later inbound customer message may be processed after a person deliberately releases the conversation back to the agent.

## Data and API design

Workspace behavior belongs with `WorkspaceMirror`, which already stores workspace-scoped JSON in `limits`. To avoid a migration for a single bounded configuration, the release stores the behavior value in a namespaced object inside that existing JSON column:

```json
{
  "agentBehavior": {
    "replyWaitSeconds": 40
  }
}
```

Existing unrelated `limits` keys are preserved during updates. The public settings DTO exposes a typed behavior object instead of requiring the frontend to interpret arbitrary limits:

```json
{
  "behavior": {
    "agentReplyWaitSeconds": 40
  }
}
```

Use a dedicated `PATCH /settings/agent-behavior` body:

```json
{
  "agentReplyWaitSeconds": 40
}
```

This keeps integration settings validation isolated and makes authorization, validation, and audit intent explicit.

## Failure handling and concurrency

- The settings update must merge against the latest stored `limits` value and preserve other keys.
- Concurrent saves use the database's normal last-write-wins behavior for this single field.
- Scheduler lookup is read-only and bounded to one workspace row.
- Guard history queries are bounded by both time and record count.
- If guard-state persistence fails, the runtime must not send a reply; it returns a failed run for operator visibility rather than risking another loop message.
- Duplicate webhooks remain protected by the existing provider-message uniqueness constraint.
- The guard runs before paid generation, so stopped loops do not create additional model costs.

## Testing

### Settings and UI

- `GET /settings` returns 40 when no behavior setting exists.
- Owners and managers can save integers from 0 through 300.
- Agents receive 403; decimals, strings, negatives, and values above 300 receive 400.
- Saving preserves unrelated workspace `limits` keys.
- Audit metadata contains the previous and next wait values.
- The Settings page loads, edits, validates, and saves the field independently.
- Helper text explains reset-on-each-message and immediate behavior at zero.

### Scheduler

- The default remains 40 seconds.
- A workspace value of 10, 40, or 0 produces the matching `scheduledAt`.
- A second message replaces `lastMessageId` and restarts the quiet window.
- A settings change affects the next scheduled message without recreating the scheduler.
- Missing or malformed settings fall back to 40 seconds.
- An earlier wake timer cannot process a row rescheduled by a later message.

### Loop guard

- The exact production sequence triggers before the next provider call.
- Three matching inbound messages with intervening AI replies inside two minutes trigger.
- One or two duplicates do not trigger.
- Three duplicates outside two minutes do not trigger.
- A customer burst with no alternating AI replies does not trigger.
- Human outbound messages do not count as AI replies.
- Ten rapidly alternating messages with at least five AI and five inbound messages trigger the emergency guard even when texts differ.
- A normal multi-turn human conversation below the threshold continues.
- On trigger, no provider call or Evolution send occurs, the session becomes `handoff_requested`, the conversation becomes `human_controlled`, the pending reply completes, and a sanitized audit entry is stored.
- Existing stock, price, media, and explicit human-handoff behavior retains its current acknowledgement.

### Production acceptance

1. Set the wait to 10 seconds in Ajustes, send five short WhatsApp messages in quick succession, and receive one contextual answer after the last message.
2. Change the wait to 0 and verify the next inbound message schedules immediately.
3. Restore 40 seconds and verify the next inbound message uses the new delay without restart.
4. Replay the observed external-bot repetition and verify Prymeira Talk sends no additional message after the threshold, marks `Humano necessário`, and records the guard in audit.

## Deployment and rollback

The change affects the web and API services. Publish commit-tagged images, deploy the API first, then the web app. Verify health/readiness before the production acceptance matrix.

Rollback restores the prior web and API images. The namespaced JSON value may remain in `WorkspaceMirror.limits`; older code ignores it. No destructive data rollback is required.

## Acceptance criteria

- Owners and managers can configure a workspace-wide 0–300 second quiet window in Ajustes.
- Each inbound message restarts the window, and one agent turn processes the final message with the complete conversation context.
- A saved setting affects new inbound messages without restarting or redeploying the API.
- The observed repeated bot exchange stops deterministically without another outgoing message.
- Stopped conversations show `Humano necessário` and remain stopped until a person releases AI control.
- The emergency rapid-exchange guard protects against non-identical automated loops without counting human outbound messages.
- Guard events are auditable without storing full customer text or secrets in audit metadata.
- Existing agent, media, handoff, automation, and inbox behavior does not regress.
