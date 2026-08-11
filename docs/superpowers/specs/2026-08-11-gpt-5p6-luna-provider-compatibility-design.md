# GPT-5.6 Luna Provider Compatibility Design

## Context

Prymeira Talk configures one OpenAI-compatible provider per workspace. Every
agent in that workspace resolves the same provider `baseUrl`, API key, and
`chatModel`, so changing the workspace model changes the effective model for all
agents without editing each agent.

The production workspace currently succeeds with `gpt-5.4` and the newly saved
API key, but the same simulator request returns HTTP 400 when the configured
model is `gpt-5.6-luna`. The gateway currently sends one fixed Chat Completions
payload for every model:

- `temperature: 0.2`;
- `response_format: { "type": "json_object" }`;
- no explicit reasoning effort;
- system and user messages.

It also reduces every non-successful upstream response to an HTTP status. This
hides the provider error code and rejected parameter, which makes model
compatibility failures unnecessarily difficult to diagnose.

GPT-5.6 Luna is a reasoning model. Current OpenAI documentation confirms that
it supports Chat Completions and structured outputs, while GPT-5.6 reasoning
defaults to `medium` when effort is omitted. The integration therefore needs a
model-aware request shape rather than a blind model-string replacement.

## Goals

- Make `gpt-5.6-luna` work in the agent simulator and real agent runtime.
- Use Luna as the workspace-wide model for all agents in the production
  workspace.
- Make Luna the initial model shown for newly configured AI providers.
- Preserve the working GPT-5.4 and generic OpenAI-compatible paths.
- Preserve the existing structured agent output contract and downstream
  action handling.
- Expose enough sanitized provider error metadata to diagnose future HTTP 400
  failures without exposing secrets, prompts, or customer content.
- Deliver a self-contained change that can be tested and promoted to the
  production deployment branch without including unrelated local-demo work.

## Non-Goals

- Do not migrate the agent runtime to the Responses API in this change.
- Do not add model reasoning controls to the UI.
- Do not replace the free-form model input with a full model registry.
- Do not alter agent prompts, knowledge retrieval, actions, handoff rules, or
  WhatsApp behavior.
- Do not overwrite provider settings for unrelated workspaces through a
  database migration.
- Do not remove GPT-5.4 or other provider-compatible model choices.

## Considered Approaches

### 1. Model-aware Chat Completions payload (selected)

Keep the current endpoint and response parser, but isolate request construction
and apply GPT-5.6 compatibility fields only to GPT-5.6 models.

Advantages:

- smallest production change;
- preserves the existing parser and agent output contract;
- keeps generic OpenAI-compatible providers working;
- easy to cover with focused unit tests and to roll back.

Trade-off:

- future model families may require additional capability branches.

### 2. Responses API for GPT-5.6 only

Route GPT-5.6 models to `/responses` and keep older models on
`/chat/completions`.

Advantages:

- follows OpenAI's preferred endpoint for reasoning models;
- creates a path for persisted reasoning and richer tools later.

Trade-offs:

- requires a second request and response contract;
- expands parser, state, error-handling, and regression surface immediately;
- adds demo risk without solving a measured Responses-only requirement.

### 3. Full provider/model adapter registry

Create separate adapters and capability metadata for every provider and model
family.

Advantages:

- strongest long-term extensibility.

Trade-offs:

- excessive scope for the current compatibility issue;
- increases configuration and maintenance before those capabilities are
  needed.

## Selected Architecture

### Request Builder

Extract the Chat Completions body construction from
`createOpenAiCompatibleAgentProvider` into a small deterministic function. Its
inputs are the configured model, rendered system prompt, and rendered user
content. Its output is the JSON body sent to the provider.

The request builder has two paths:

1. Models whose normalized ID starts with `gpt-5.6`:
   - set `reasoning_effort: "none"` explicitly;
   - omit `temperature` so the baseline request does not combine a sampling
     control with the model's default reasoning mode;
   - retain `response_format: { "type": "json_object" }`;
   - retain the current system and user messages.
2. Every other model:
   - preserve the current `temperature: 0.2` behavior;
   - retain the current response format and messages;
   - do not add GPT-5.6-only fields.

Explicit `none` preserves the latency-sensitive, cost-sensitive role selected
for customer support and avoids silently accepting GPT-5.6's default `medium`
reasoning. Reasoning quality can be evaluated separately after the compatibility
baseline is stable.

The matcher is intentionally limited to the GPT-5.6 family. It must not guess
capabilities for arbitrary model names from other OpenAI-compatible providers.

### Provider Error Metadata

When the provider returns a non-2xx response, the gateway will attempt to parse
the standard error envelope. Only these fields may cross the provider boundary:

- HTTP status;
- `error.type`;
- `error.code`;
- `error.param`.

The API key, request headers, request body, prompts, messages, customer content,
and raw provider response are never included in the thrown error. If the body is
not valid JSON or does not match the expected envelope, the gateway falls back
to the current status-only error.

This is sufficient to distinguish an unsupported parameter, unavailable model,
rate limit, and authentication failure while preserving the current security
boundary.

### Workspace Default

The frontend's empty AI-provider form will use `gpt-5.6-luna` instead of
`gpt-4.1-mini`. This affects only workspaces that do not already have a saved
model.

The production workspace already has a persisted provider configuration, so a
code default alone cannot change it. After the compatible backend is deployed
and smoke-tested, the authenticated settings screen will be used to set its
single workspace-level `chatModel` to `gpt-5.6-luna`. Since both simulator and
runtime resolve that provider setting, all agents in the workspace will inherit
Luna.

No database migration will rewrite other workspaces.

## Data Flow

1. Simulator or inbound WhatsApp message starts an agent run.
2. The runtime resolves the workspace's OpenAI-compatible provider settings.
3. The provider gateway renders the existing system and user content.
4. The request builder selects the GPT-5.6 or legacy payload shape.
5. The gateway sends the request to `{baseUrl}/chat/completions`.
6. On success, the existing Chat Completions parser reads
   `choices[0].message.content` and validates the agent JSON contract.
7. On provider failure, only allowlisted error metadata is surfaced.
8. The agent runtime continues its existing reply, action, handoff, and logging
   flow unchanged.

## Testing Strategy

### Provider Unit Tests

- `gpt-5.6-luna` sends `reasoning_effort: "none"`.
- `gpt-5.6-luna` omits `temperature`.
- `gpt-5.6-luna` retains JSON mode and both messages.
- another GPT-5.6 family ID follows the same compatibility path.
- a legacy or generic model retains `temperature: 0.2` and receives no
  `reasoning_effort` field.
- a structured upstream error exposes status, type, code, and param only.
- malformed or non-JSON upstream errors remain status-only.
- no test error contains the configured API key, request prompt, or raw body.
- all existing output parsing tests continue to pass.

### Frontend Tests

- an unconfigured AI-provider form defaults to `gpt-5.6-luna`.
- a workspace with a saved model continues to display its persisted value.

### Repository Verification

- run the focused provider and settings tests;
- run API and web type checks;
- run the relevant API and web test suites;
- build the production API and web images or equivalent production builds;
- confirm the working tree contains no accidental secret or unrelated change.

### Production Smoke Tests

Run these checks in order:

1. Confirm `/api/health` after the new API image is running.
2. Keep the persisted workspace model on GPT-5.4 and verify one simulator
   response, proving backward compatibility after deployment.
3. Change the workspace model to `gpt-5.6-luna` once.
4. Verify the Villefer simulator returns a valid agent reply without HTTP 400.
5. Send a real WhatsApp message through the already connected test number and
   confirm an automated reply arrives.
6. Exercise at least one knowledge-bound question, one out-of-scope question,
   and one human-handoff scenario.
7. Inspect agent-run status and provider metadata for errors.

If the live provider still rejects the baseline request, use the newly exposed
`code` and `param` to make one isolated compatibility adjustment. Do not stack
multiple speculative parameter changes.

## Deployment and Rollback

The image-publishing workflow monitors `codex/prymeira-talk-foundation`, while
the current working branch contains additional local-demo commits. The Luna
implementation must therefore be kept in self-contained commits and promoted
to the deployment branch without merging unrelated local-demo work.

Deployment sequence:

1. complete tests and production builds locally;
2. isolate the Luna compatibility commits;
3. apply those commits to a branch based on the monitored deployment branch;
4. push the deployment branch and wait for both GHCR images to publish;
5. update/redeploy the Portainer stack using the new `latest` images;
6. run the ordered smoke tests;
7. only then save `gpt-5.6-luna` as the production workspace model.

Rollback is configuration-first: restore the workspace model to `gpt-5.4`.
If the release itself regresses older models, redeploy the previous immutable
image SHA. No provider key change is required for either rollback.

## Acceptance Criteria

- Luna produces a valid simulator response through the production provider.
- A real Villefer WhatsApp test receives an agent response using Luna.
- Every agent in the production workspace resolves `gpt-5.6-luna` through the
  single workspace provider configuration.
- GPT-5.4 remains functional after the code change.
- Existing agent output, action, handoff, and knowledge contracts remain
  unchanged.
- Provider failures identify safe diagnostic metadata without exposing secrets
  or conversation content.
- Production deployment includes only the intended Luna compatibility changes.
