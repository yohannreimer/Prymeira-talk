# Prymeira Talk AI Agents Design

## Context

Prymeira Talk already has the core surfaces needed for an autonomous WhatsApp agent:

- Atendimento with conversations, messages, assignment, priority, tags, notes, departments, realtime updates, and provider-aware outbound sends.
- Automacoes with a visual flow model, inbound triggers, supported CRM/light communication actions, run history, and an execution runner.
- IA/Assistant with simulated summaries and suggested replies stored in `AiActionLog`.
- WhatsApp providers through Evolution and Meta Cloud/Via Evolution, including Meta service-window rules.
- Settings and audit logs for integration configuration.

The next product step is to create configurable AI agents that can act as autonomous attendants and become usable inside automations. The agent should be able to answer contacts, run safe internal actions, and hand off to humans when needed. A human must always be able to assume a conversation and block further AI replies until the conversation is manually released back to AI.

## Goals

- Add a first-class Agents module to Prymeira Talk.
- Let owner/manager users create autonomous agents with prompt, behavior, provider/model, knowledge sources, limits, and allowed actions.
- Let automations call an agent through a new `run_agent` / "Executar agente" block.
- Let the agent respond autonomously in Atendimento when the conversation is AI-allowed.
- Allow level 2 actions only:
  - send message replies;
  - add or remove tags;
  - change priority;
  - create internal notes;
  - assign user or department.
- Add strong human takeover:
  - "Assumir" blocks the agent for that conversation;
  - "Liberar IA" allows the agent again;
  - future inbound messages do not trigger agent replies while human controlled.
- Support hybrid knowledge:
  - prompt/instructions;
  - manual FAQs;
  - uploaded text/PDF-style documents in the initial implementation.
- Support hybrid provider strategy:
  - Prymeira-managed provider as the default;
  - workspace-owned provider credentials later.
- Create auditable logs for every agent execution.

## Non-Goals

- Do not build complex multi-agent orchestration in the first version.
- Do not let agents call arbitrary webhooks or external APIs in the first version.
- Do not let agents start campaigns or mass sends autonomously.
- Do not let agents execute financial, billing, contract, legal, or destructive operations.
- Do not replace the existing Assistant surface immediately; the current Assistant can remain as a helper/copilot surface while Agents becomes the autonomous surface.
- Do not require full vector/RAG sophistication before delivering the first controlled version.

## Recommended Approach

Build Agents as a product module, not as a thin extension of the existing Assistant action log.

The existing Assistant is action-oriented and simulated. The new Agents module needs durable configuration, conversation-level session state, knowledge sources, tool permissions, provider settings, and execution logs. Keeping it separate avoids overloading `AiActionLog` with long-lived runtime concerns while still allowing logs and UI patterns to be reused.

Automations should trigger agents through a dedicated block. Atendimento should control conversation ownership. Provider-specific WhatsApp behavior should remain inside the existing conversation send path, so the agent sends through the same guardrails as a human.

## User Experience

### Agents Module

Add a module named `Agentes` or evolve the current `IA` module into an agents hub.

The module includes:

- agent list;
- create/edit agent;
- status active/inactive;
- provider/model settings;
- prompt and personality;
- business objective;
- response style;
- knowledge sources;
- allowed actions;
- handoff rules;
- limits;
- test console;
- recent runs.

Agent fields:

- name;
- description;
- status;
- default provider mode: `prymeira_managed`;
- model key;
- system prompt;
- greeting or onboarding instruction;
- fallback/handoff instruction;
- allowed action list;
- max messages per session;
- cooldown/retry limits;
- confidence threshold;
- knowledge source selection.

### Automations

Add a new automation block:

```txt
Executar agente
```

Block configuration:

- selected agent;
- optional per-block instruction;
- whether to create a new session or resume the active session;
- optional "respond immediately" toggle, default true;
- optional stop-flow-on-handoff toggle, default true.

Example flow:

```txt
Primeira mensagem
  -> Enviar mensagem de boas-vindas fixa
  -> Executar agente: Secretaria IA
```

The automation runner must skip this block when the conversation is human controlled. It should record a skipped action result explaining that AI is blocked by human takeover.

### Atendimento

Show a compact AI control state in the conversation header:

- `IA ativa: Secretaria IA`;
- `Humano no controle`;
- `Handoff sugerido`;
- `IA pausada`.

Actions:

- `Assumir`: sets the conversation to human controlled and pauses the active agent session.
- `Liberar IA`: allows AI again for future inbound messages.
- Optional later action: `Responder agora com IA`.

The right-side context panel can include an "Controle IA" section:

- active agent;
- session status;
- last run;
- confidence;
- last tool action;
- handoff reason;
- recent run log links.

## Conversation Flow

1. A WhatsApp inbound message arrives through Evolution or Meta.
2. The existing webhook path creates or updates contact, conversation, and message.
3. The automation runner processes matching inbound triggers.
4. If a flow reaches `Executar agente`, the runner checks the conversation AI control state.
5. If the conversation is human controlled, the agent block is skipped and logged.
6. If AI is allowed, the runner creates or resumes an `AiAgentSession`.
7. `AgentRuntime` builds context:
   - current message;
   - recent conversation history;
   - contact fields;
   - tags;
   - department and assignee;
   - primary board stage where available;
   - recent notes;
   - relevant knowledge snippets;
   - automation block instruction;
   - agent prompt and allowed actions.
8. The runtime calls the configured AI provider.
9. The provider response must be parsed into a structured action plan.
10. `AgentToolExecutor` validates and executes only allowed level 2 actions.
11. If the action plan includes a reply, the reply is sent through the existing conversation outbound service.
12. `AiAgentRun` stores input summary, response, actions, confidence, status, and error details.
13. Realtime events update Atendimento with new messages, conversation status, and AI control state.

## Handoff Rules

The MVP should automatically request human handoff only for:

- low confidence or no answer found in the knowledge/context;
- repeated question or detected irritation/frustration.

When handoff is requested:

- set session status to `handoff_requested`;
- optionally set conversation priority to high if allowed by the agent;
- create an internal note with the reason;
- publish a realtime update;
- do not keep sending autonomous replies unless explicitly configured later.

The MVP should not automatically hand off just because the topic is pricing, contracts, cancellation, legal, financial, or complaints. Those can be covered by prompts and allowed actions, but the automatic trigger list stays intentionally narrow.

## Human Takeover Rules

Human takeover is a hard conversation-level lock.

When a user clicks `Assumir`:

- set conversation AI control to `human_controlled`;
- set the active agent session to `paused_by_human`;
- store who assumed control and when;
- prevent future automation agent blocks from executing for that conversation;
- keep non-agent automation actions available only if they are already part of existing behavior.

When a user clicks `Liberar IA`:

- set conversation AI control to `agent_allowed`;
- store who released it and when;
- resume or create a session only when a new inbound message or explicit future action asks the agent to run.

This avoids the agent replying unexpectedly in the middle of a human conversation.

## Data Model

Add models to Prisma.

### AiAgent

Stores agent configuration.

Fields:

- `id`
- `workspaceId`
- `name`
- `description`
- `status`: `active` | `inactive`
- `providerMode`: `prymeira_managed` | `workspace_key`
- `provider`: `openai` | `openrouter` | later values
- `model`
- `systemPrompt`
- `behaviorConfig` JSON
- `handoffConfig` JSON
- `limitsConfig` JSON
- `allowedActions` JSON
- `createdAt`
- `updatedAt`

### AiKnowledgeSource

Stores manual FAQ/text/file sources for an agent.

Fields:

- `id`
- `workspaceId`
- `agentId`
- `type`: `faq` | `text` | `file`
- `title`
- `content`
- `fileUrl`
- `fileName`
- `mimeType`
- `status`: `ready` | `processing` | `failed`
- `metadata` JSON
- `createdAt`
- `updatedAt`

The first implementation can search FAQs/text with simple ranked text matching. File ingestion can extract plain text for PDFs/text documents before moving to embeddings later.

### AiAgentSession

Stores state for one agent in one conversation.

Fields:

- `id`
- `workspaceId`
- `agentId`
- `conversationId`
- `status`: `active` | `paused_by_human` | `handoff_requested` | `closed`
- `messageCount`
- `lastRunAt`
- `handoffReason`
- `metadata` JSON
- `createdAt`
- `updatedAt`

Unique key:

- `[workspaceId, agentId, conversationId]`

### AiAgentRun

Stores every execution.

Fields:

- `id`
- `workspaceId`
- `agentId`
- `sessionId`
- `conversationId`
- `trigger`: `automation` | `manual_test` | later values
- `input` JSON
- `contextSummary` JSON
- `knowledgeMatches` JSON
- `model`
- `output` JSON
- `confidence`
- `actions` JSON
- `status`: `completed` | `handoff_requested` | `failed` | `skipped`
- `errorMessage`
- `costEstimate` JSON
- `createdAt`

### Conversation Fields

Add conversation-level AI control fields:

- `aiControlStatus`: `agent_allowed` | `human_controlled`
- `aiControlUpdatedAt`
- `aiControlUpdatedById`
- optionally `activeAgentSessionId`

Default should be `agent_allowed`.

## Backend Components

### `apps/api/src/modules/agents/agents.service.ts`

Responsibilities:

- list agents;
- create/update/archive agents;
- validate configuration;
- list and update knowledge sources;
- expose test runs;
- enforce workspace and role boundaries.

Only owner/manager should create/edit agents. Agent users may view status/logs depending on existing permission style.

### `apps/api/src/modules/agents/agent-runtime.ts`

Responsibilities:

- load agent and session;
- load conversation context;
- retrieve knowledge snippets;
- build AI prompt;
- call provider gateway;
- parse structured output;
- compute/normalize confidence;
- create `AiAgentRun`.

### `apps/api/src/modules/agents/agent-tool-executor.ts`

Executes level 2 actions only:

- `send_message`;
- `add_tag`;
- `remove_tag`;
- `change_priority`;
- `create_internal_note`;
- `assign_user`;
- `assign_department`;
- `request_handoff`.

Every action must be validated against `allowedActions` before execution.

### `apps/api/src/modules/agents/provider-gateway.ts`

Provides a stable internal interface for AI providers.

Phase 1 can use a Prymeira-managed provider configuration from environment/deployment secrets. Workspace-owned keys can reuse the same gateway later by resolving from `IntegrationConfig` or a dedicated encrypted config model.

### Automation Runner Changes

Shared automation catalog:

- add `run_agent` to integration/control category;
- mark it as `supported`;
- add inspector controls in the web automation builder.

Backend runner:

- add the agent runtime dependency to `AutomationRunnerOptions`;
- implement `run_agent`;
- skip when conversation is human controlled;
- record action result with run ID or skip reason.

### Conversation Changes

Add routes/actions for AI control:

- `POST /conversations/:id/ai-control/assume`
- `POST /conversations/:id/ai-control/release`

Alternatively extend the existing conversation action route if that pattern is already preferred.

Conversation DTO should include:

- `aiControlStatus`;
- `activeAgentName`;
- `activeAgentSessionStatus`;
- `handoffReason` where relevant.

## AI Output Contract

Require structured output from the provider. The runtime should reject unparseable output rather than improvising.

Example shape:

```json
{
  "confidence": 0.82,
  "reply": "Claro, posso te ajudar com isso...",
  "actions": [
    { "type": "add_tag", "tagName": "onboarding" },
    { "type": "create_internal_note", "body": "Cliente quer entender o plano inicial." }
  ],
  "handoff": {
    "required": false,
    "reason": null
  }
}
```

If confidence is below the configured threshold or handoff is required for the approved MVP reasons, the runtime should not send a normal autonomous reply unless the output explicitly contains a safe handoff message and the configuration permits it.

## Knowledge Strategy

Phase 1 should keep knowledge useful but simple:

- manual FAQ pairs;
- pasted text blocks;
- uploaded files with extracted text when extraction is reliable;
- simple text ranking over workspace/agent knowledge;
- store matched snippets in `AiAgentRun`.

Phase 2 can add embeddings, chunking, source citations, website crawling, and better document parsing.

## Security And Guardrails

- Never return workspace-owned provider secrets to the frontend.
- Keep all agent routes scoped by workspace.
- Only owner/manager can create/edit agents and knowledge.
- Validate tool calls against allowed actions before executing.
- Block agent execution when `aiControlStatus = human_controlled`.
- Use existing provider-aware conversation sending so Meta service-window rules still apply.
- Rate limit agent execution per workspace/conversation.
- Limit max messages per session.
- Store execution logs for audit and debugging.
- Make provider failures visible in runs without retry loops that could spam contacts.
- Avoid logging raw secrets or full provider credentials.

## Error Handling

Handle these cases explicitly:

- agent not found;
- agent inactive;
- invalid prompt/configuration;
- no AI provider configured;
- provider timeout/failure;
- malformed structured output;
- knowledge source not ready;
- blocked by human takeover;
- unsupported tool requested;
- tool not allowed for this agent;
- conversation not found;
- Meta service window closed;
- outbound send failure.

Errors should be visible in agent run logs and automation run results. User-facing errors in Atendimento should be concise and operational.

## Testing

Backend tests:

- create/update/list agents by workspace;
- reject invalid agent config;
- create/update knowledge source;
- run agent with mocked provider;
- parse valid structured output;
- reject malformed output;
- execute allowed level 2 actions;
- reject disallowed tools;
- skip execution when conversation is human controlled;
- request handoff for low confidence;
- request handoff for repetition/irritation;
- automation `run_agent` block creates a run;
- conversation assume/release updates AI control;
- provider-aware send path still enforces Meta service-window rules.

Frontend tests:

- Agents module lists and edits agents;
- automation block library shows `Executar agente`;
- inspector can select an agent;
- Atendimento shows AI status;
- `Assumir` changes the UI to human controlled;
- `Liberar IA` changes it back to allowed;
- run logs render status/error details.

Manual verification:

- create a Secretaria IA agent;
- add FAQ and text knowledge;
- create automation: first message -> welcome -> execute agent;
- send a test inbound message through simulated channel;
- verify autonomous reply;
- verify tag/note/priority action;
- click Assumir;
- send another inbound message and verify agent does not reply;
- click Liberar IA;
- send another inbound message and verify agent can reply again;
- simulate low confidence and verify handoff_requested.

## Implementation Phases

### Phase 1: Foundation

- Add Prisma models and shared schemas.
- Add backend agents service.
- Add agent list/create/edit API.
- Add basic knowledge source storage.
- Add provider gateway with mocked/simulated provider first.
- Add UI module shell for Agents.

### Phase 2: Runtime And Automations

- Add `AgentRuntime`.
- Add structured output parsing.
- Add `AgentToolExecutor`.
- Add automation block `Executar agente`.
- Execute agent from inbound automation runner.
- Store `AiAgentRun`.

### Phase 3: Atendimento Control

- Add conversation AI control fields.
- Add assume/release routes.
- Add Atendimento badges/buttons.
- Block agent execution when human controlled.
- Add realtime updates for session/control state.

### Phase 4: Provider And Knowledge Upgrade

- Connect Prymeira-managed real provider.
- Add workspace-owned provider config later.
- Add file text extraction.
- Improve knowledge ranking and source traces.

## Open Decisions For Implementation Planning

- Exact model/provider names for the first Prymeira-managed provider.
- Whether `Agentes` is a new sidebar item or an evolution of the existing `IA` item.
- Whether file extraction should support only text/PDF first or also DOCX.
- Whether agents can be assigned globally to channels outside automations in a later phase.

These are implementation planning decisions and do not change the approved MVP shape.
